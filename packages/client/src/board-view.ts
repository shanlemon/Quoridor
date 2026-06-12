import { Application, Container, Graphics, Text } from 'pixi.js';
import type { FederatedPointerEvent } from 'pixi.js';
import type { Cell, CharacterId, GameState, Orientation, Wall, WallCheck } from '@quori/engine';
import { animate, delay, easings, lerp, tickAnimations } from './anim';
import { CHARACTER_META, createCharacter } from './characters';

/** Unit-space board metrics — the world container is scaled to fit the host element. */
const CELL = 64;
const GAP = 14;
const MARGIN = 46;
const PITCH = CELL + GAP;
const BOARD = MARGIN * 2 + CELL * 9 + GAP * 8; // 780
const CHAR_SIZE = 54;

export type BoardMode = 'move' | 'wall';

export interface BoardHooks {
  onMoveTap(cell: Cell): void;
  onWallConfirm(wall: Wall): void;
  checkWall(wall: Wall): WallCheck;
  /** Tap confirmed an invalid ghost — show feedback. */
  onInvalidWallConfirm(check: WallCheck): void;
  /** Right-click / ESC equivalent from the canvas. */
  onCancel(): void;
}

interface Pawn {
  seat: number;
  charId: CharacterId;
  root: Container;
  body: Container;
  art: Graphics;
  shadow: Graphics;
  cell: Cell;
  phase: number;
}

interface Particle {
  g: Graphics;
  vx: number;
  vy: number;
  vr: number;
  life: number;
  maxLife: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function sameWall(a: Wall, b: Wall): boolean {
  return a.x === b.x && a.y === b.y && a.o === b.o;
}

export class BoardView {
  private app!: Application;
  private world = new Container();
  private boardLayer = new Container();
  private lastMoveLayer = new Container();
  private wallLayer = new Container();
  private highlightLayer = new Container();
  private pawnLayer = new Container();
  private ghostLayer = new Container();
  private fxLayer = new Container();

  private pawns = new Map<number, Pawn>();
  private crown = new Graphics();
  private crownBaseY = 0;
  private dots: Graphics[] = [];
  private ghost: Wall | null = null;
  private mode: BoardMode = 'move';
  private activeSeat: number | null = null;
  private busy = false;
  private elapsed = 0;
  private nextLeafAt = 3000;
  private particles: Particle[] = [];
  private leaves: Container[] = [];
  private shakeAmp = 0;
  private resizeObs!: ResizeObserver;
  private destroyed = false;
  private readonly small = window.matchMedia('(max-width: 860px)').matches;

  private constructor(
    private host: HTMLElement,
    private hooks: BoardHooks,
  ) {}

  static async create(host: HTMLElement, state: GameState, hooks: BoardHooks): Promise<BoardView> {
    const view = new BoardView(host, hooks);
    await view.init(state);
    return view;
  }

  private async init(state: GameState): Promise<void> {
    this.app = new Application();
    await this.app.init({
      background: '#fdf3e3',
      antialias: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
    });
    this.host.appendChild(this.app.canvas);

    this.world.addChild(
      this.boardLayer,
      this.lastMoveLayer,
      this.wallLayer,
      this.highlightLayer,
      this.pawnLayer,
      this.ghostLayer,
      this.fxLayer,
    );
    this.app.stage.addChild(this.world);

    this.drawBoard(state);
    for (const p of state.players) this.spawnPawn(p.seat, p.character, p.pos);
    this.drawCrown();
    for (const w of state.walls) this.wallLayer.addChild(this.buildFence(w));

    // input
    this.app.stage.eventMode = 'static';
    this.app.stage.hitArea = this.app.screen;
    this.app.stage.on('pointermove', (e: FederatedPointerEvent) => this.onPointerMove(e));
    this.app.stage.on('pointertap', (e: FederatedPointerEvent) => this.onPointerTap(e));
    this.app.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.hooks.onCancel();
    });

    // ticker
    this.app.ticker.add((ticker) => this.tick(ticker.deltaMS));

    // responsive scaling
    this.resizeObs = new ResizeObserver(() => this.layout());
    this.resizeObs.observe(this.host);
    this.layout();
  }

  // ---------- layout & static drawing ----------

  private layout(): void {
    if (this.destroyed) return;
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.app.renderer.resize(w, h);
    const scale = Math.min(w, h) / BOARD;
    this.world.scale.set(scale);
    this.world.position.set((w - BOARD * scale) / 2, (h - BOARD * scale) / 2);
  }

  private cellCenter(c: Cell): { x: number; y: number } {
    return {
      x: MARGIN + c.x * PITCH + CELL / 2,
      y: MARGIN + c.y * PITCH + CELL / 2,
    };
  }

  private wallCenter(w: Wall): { x: number; y: number } {
    return {
      x: MARGIN + (w.x + 1) * PITCH - GAP / 2,
      y: MARGIN + (w.y + 1) * PITCH - GAP / 2,
    };
  }

  private drawBoard(state: GameState): void {
    const g = new Graphics();
    // garden mat
    g.roundRect(4, 4, BOARD - 8, BOARD - 8, 34)
      .fill(0xb6dd94)
      .stroke({ width: 5, color: 0x96c274 });
    g.roundRect(MARGIN - 14, MARGIN - 14, BOARD - 2 * MARGIN + 28, BOARD - 2 * MARGIN + 28, 22).fill(
      0xc8e6a6,
    );
    // cells with soft drop shadows and a subtle checker tint
    for (let y = 0; y < 9; y++) {
      for (let x = 0; x < 9; x++) {
        const px = MARGIN + x * PITCH;
        const py = MARGIN + y * PITCH;
        g.roundRect(px, py + 3, CELL, CELL, 12).fill({ color: 0x7da05f, alpha: 0.35 });
        g.roundRect(px, py, CELL, CELL, 12).fill((x + y) % 2 === 0 ? 0xdcf3b7 : 0xd2ecab);
      }
    }
    this.boardLayer.addChild(g);

    // goal tints + banners
    for (const p of state.players) {
      const meta = CHARACTER_META[p.character];
      const tint = new Graphics();
      for (let i = 0; i < 9; i++) {
        const c =
          p.goal === 'north'
            ? { x: i, y: 0 }
            : p.goal === 'south'
              ? { x: i, y: 8 }
              : p.goal === 'west'
                ? { x: 0, y: i }
                : { x: 8, y: i };
        const px = MARGIN + c.x * PITCH;
        const py = MARGIN + c.y * PITCH;
        tint.roundRect(px, py, CELL, CELL, 12).fill({ color: meta.color, alpha: 0.16 });
      }
      this.boardLayer.addChild(tint);
      this.boardLayer.addChild(this.buildBanner(p.character, p.goal));
    }
  }

  private buildBanner(charId: CharacterId, goal: GameState['players'][number]['goal']): Container {
    const meta = CHARACTER_META[charId];
    const mid = MARGIN + 4 * PITCH + CELL / 2;
    const off = MARGIN / 2 - 3;
    const pos =
      goal === 'north'
        ? { x: mid, y: off }
        : goal === 'south'
          ? { x: mid, y: BOARD - off }
          : goal === 'west'
            ? { x: off, y: mid }
            : { x: BOARD - off, y: mid };

    const banner = new Container();
    banner.position.set(pos.x, pos.y);
    const badge = new Graphics();
    badge.circle(0, 0, 15).fill(meta.color).stroke({ width: 3, color: 0xffffff });
    banner.addChild(badge);
    const face = new Text({ text: meta.emoji, style: { fontSize: 16 } });
    face.anchor.set(0.5);
    banner.addChild(face);
    // color-blind-safe shape icon beside the face
    const icon = new Text({
      text: meta.icon,
      style: { fontSize: 11, fill: 0xffffff, fontWeight: 'bold' },
    });
    icon.anchor.set(0.5);
    icon.position.set(goal === 'west' || goal === 'east' ? 0 : 22, goal === 'west' || goal === 'east' ? 22 : 0);
    banner.addChild(icon);
    return banner;
  }

  // ---------- pawns ----------

  private spawnPawn(seat: number, charId: CharacterId, cell: Cell): void {
    const root = new Container();
    const c = this.cellCenter(cell);
    root.position.set(c.x, c.y + CELL * 0.36);

    const shadow = new Graphics();
    shadow.ellipse(0, 2, CHAR_SIZE * 0.4, CHAR_SIZE * 0.14).fill({ color: 0x4d3a2a, alpha: 0.28 });
    root.addChild(shadow);

    const body = new Container();
    const art = createCharacter(charId, CHAR_SIZE);
    body.addChild(art);
    root.addChild(body);

    this.pawnLayer.addChild(root);
    this.pawns.set(seat, { seat, charId, root, body, art, shadow, cell, phase: seat * 1.7 });
  }

  private drawCrown(): void {
    this.crown
      .poly([-11, 0, -11, -9, -5.5, -3.5, 0, -11, 5.5, -3.5, 11, -9, 11, 0])
      .fill(0xffd24a)
      .stroke({ width: 2, color: 0xe0a93a });
    this.crown.circle(0, -12, 2.5).fill(0xff8da1);
    this.crown.visible = false;
    this.crownBaseY = -CHAR_SIZE * 1.32;
  }

  setActiveSeat(seat: number | null): void {
    this.activeSeat = seat;
    this.crown.removeFromParent();
    if (seat === null) {
      this.crown.visible = false;
      return;
    }
    const pawn = this.pawns.get(seat);
    if (!pawn) return;
    this.crown.visible = true;
    this.crown.position.set(0, this.crownBaseY);
    pawn.root.addChild(this.crown);
  }

  // ---------- highlights, ghost, last move ----------

  setHighlights(cells: readonly Cell[], color: number): void {
    for (const d of this.dots) d.destroy();
    this.dots = [];
    for (const cell of cells) {
      const c = this.cellCenter(cell);
      const dot = new Graphics();
      dot.circle(0, 0, 16).fill({ color, alpha: 0.28 });
      dot.circle(0, 0, 8).fill({ color, alpha: 0.85 }).stroke({ width: 2, color: 0xffffff });
      dot.position.set(c.x, c.y);
      this.highlightLayer.addChild(dot);
      this.dots.push(dot);
    }
  }

  setLastMove(from: Cell | null): void {
    this.lastMoveLayer.removeChildren().forEach((ch) => ch.destroy());
    if (!from) return;
    const c = this.cellCenter(from);
    const ring = new Graphics();
    ring.circle(c.x, c.y, 14).stroke({ width: 3.5, color: 0xffffff, alpha: 0.75 });
    ring.circle(c.x, c.y, 14).stroke({ width: 1.5, color: 0xc9b181, alpha: 0.6 });
    this.lastMoveLayer.addChild(ring);
  }

  setMode(mode: BoardMode): void {
    this.mode = mode;
    if (mode !== 'wall') this.clearGhost();
  }

  getMode(): BoardMode {
    return this.mode;
  }

  clearGhost(): void {
    this.ghost = null;
    this.ghostLayer.removeChildren().forEach((ch) => ch.destroy({ children: true }));
  }

  private showGhost(slot: Wall): void {
    const check = this.hooks.checkWall(slot);
    this.ghost = slot;
    this.ghostLayer.removeChildren().forEach((ch) => ch.destroy({ children: true }));
    const fence = this.buildFence(slot, true);
    fence.alpha = 0.72;
    fence.tint = check.legal ? 0x8be08b : 0xff8080;
    this.ghostLayer.addChild(fence);
  }

  // ---------- fences ----------

  /** A white picket fence spanning 2 cells, centered on the wall's intersection. */
  private buildFence(w: Wall, ghost = false): Container {
    const c = new Container();
    const len = CELL * 2 + GAP;
    const g = new Graphics();
    if (!ghost) {
      g.roundRect(-len / 2 + 3, -2, len - 6, 10, 5).fill({ color: 0x67804f, alpha: 0.3 });
    }
    // pickets
    const n = 5;
    for (let i = 0; i < n; i++) {
      const px = -len / 2 + 7 + (i * (len - 24)) / (n - 1);
      g.roundRect(px, -12, 10, 24, 5)
        .fill(0xffffff)
        .stroke({ width: 1.6, color: 0xd9c4a4 });
    }
    // rail
    g.roundRect(-len / 2, -4.5, len, 9, 4.5)
      .fill(0xfffaf2)
      .stroke({ width: 1.6, color: 0xd9c4a4 });
    c.addChild(g);
    const pos = this.wallCenter(w);
    c.position.set(pos.x, pos.y);
    if (w.o === 'v') c.rotation = Math.PI / 2;
    return c;
  }

  async animateWall(w: Wall): Promise<void> {
    if (this.destroyed) return;
    this.busy = true;
    this.clearGhost();
    const fence = this.buildFence(w);
    const targetY = fence.position.y;
    fence.position.y = targetY - 44;
    fence.alpha = 0;
    this.wallLayer.addChild(fence);
    await animate(
      240,
      (k) => {
        fence.position.y = targetY - 44 * (1 - k);
        fence.alpha = Math.min(1, k * 2);
      },
      easings.inQuad,
    );
    // impact: dust + tiny shake
    const c = this.wallCenter(w);
    this.dustPuff(c.x, c.y, 7);
    this.shakeAmp = 3;
    await animate(170, (k) => {
      this.shakeAmp = 3 * (1 - k);
    });
    this.shakeAmp = 0;
    this.layout(); // restore the exact centered world position after the shake
    this.busy = false;
  }

  // ---------- pawn movement ----------

  async animateMove(seat: number, to: Cell): Promise<void> {
    if (this.destroyed) return;
    const pawn = this.pawns.get(seat);
    if (!pawn) return;
    this.busy = true;
    this.clearGhost();

    const from = this.cellCenter(pawn.cell);
    const dest = this.cellCenter(to);
    const dist = Math.hypot(to.x - pawn.cell.x, to.y - pawn.cell.y);
    const arc = 30 + 16 * Math.max(0, dist - 1);
    pawn.cell = to;

    const baseY = CELL * 0.36;

    // anticipate (squash)
    await animate(70, (k) => pawn.body.scale.set(1 + 0.13 * k, 1 - 0.2 * k), easings.outQuad);
    // leap
    await animate(
      170 + 70 * dist,
      (k) => {
        const hop = Math.sin(Math.PI * k) * arc;
        pawn.root.position.set(
          lerp(from.x, dest.x, k),
          lerp(from.y + baseY, dest.y + baseY, k) - hop,
        );
        pawn.body.scale.set(1 - 0.18 * Math.sin(Math.PI * k), 1 + 0.22 * Math.sin(Math.PI * k));
        pawn.shadow.scale.set(1 - 0.3 * Math.sin(Math.PI * k));
        pawn.shadow.alpha = 1 - 0.5 * Math.sin(Math.PI * k);
      },
      easings.inOutSine,
    );
    // land (squash + recover)
    this.dustPuff(dest.x, dest.y + baseY, 4);
    await animate(60, (k) => pawn.body.scale.set(1 + 0.16 * k, 1 - 0.22 * k), easings.outQuad);
    await animate(170, (k) => {
      pawn.body.scale.set(lerp(1.16, 1, k), lerp(0.78, 1, k));
    }, easings.outBack);
    pawn.body.scale.set(1, 1);
    pawn.shadow.scale.set(1);
    pawn.shadow.alpha = 1;
    this.busy = false;
  }

  // ---------- celebration ----------

  async celebrateWin(winnerSeat: number): Promise<void> {
    if (this.destroyed) return;
    this.busy = true;
    this.setHighlights([], 0xffffff);
    this.clearGhost();
    this.setActiveSeat(null);

    for (const [seat, pawn] of this.pawns) {
      if (seat !== winnerSeat) {
        pawn.art.tint = 0xb9b2ac;
        void animate(500, (k) => {
          pawn.body.rotation = 0.14 * k * (seat % 2 === 0 ? 1 : -1);
        });
      }
    }

    const winner = this.pawns.get(winnerSeat);
    if (winner) {
      this.pawnLayer.addChild(winner.root); // bring to front
      const start = { x: winner.root.position.x, y: winner.root.position.y };
      const target = { x: BOARD / 2, y: BOARD / 2 + CELL * 0.3 };
      await animate(
        550,
        (k) => {
          winner.root.position.set(lerp(start.x, target.x, k), lerp(start.y, target.y, k));
          winner.root.scale.set(1 + 0.6 * k);
        },
        easings.outCubic,
      );
      this.confettiBurst(BOARD / 2, BOARD / 2 - 60);
      for (let i = 0; i < 3; i++) {
        await animate(190, (k) => {
          winner.root.position.y = target.y - 26 * Math.sin(Math.PI * k);
          winner.body.scale.set(1 - 0.1 * Math.sin(Math.PI * k), 1 + 0.14 * Math.sin(Math.PI * k));
        });
      }
      this.confettiBurst(BOARD / 2, BOARD / 2 - 40);
      await delay(420);
    }
    // stays busy — game is over, board input is done
  }

  // ---------- particles ----------

  private dustPuff(x: number, y: number, n: number): void {
    for (let i = 0; i < n; i++) {
      const g = new Graphics();
      g.circle(0, 0, 4 + Math.random() * 4).fill({ color: 0xfff6e3, alpha: 0.85 });
      g.position.set(x + (Math.random() - 0.5) * 22, y + (Math.random() - 0.5) * 8);
      this.fxLayer.addChild(g);
      const a = Math.random() * Math.PI * 2;
      this.particles.push({
        g,
        vx: Math.cos(a) * 1.2,
        vy: Math.sin(a) * 0.7 - 0.6,
        vr: 0,
        life: 0,
        maxLife: 320 + Math.random() * 160,
      });
    }
  }

  private confettiBurst(x: number, y: number): void {
    const colors = [0xf06ba8, 0x4cb04f, 0xf09030, 0x4a90e2, 0xffd24a, 0xffffff];
    const n = this.small ? 50 : 100;
    for (let i = 0; i < n; i++) {
      const g = new Graphics();
      g.roundRect(-4, -6, 8, 12, 2).fill(colors[i % colors.length]);
      g.position.set(x + (Math.random() - 0.5) * 90, y + (Math.random() - 0.5) * 30);
      g.rotation = Math.random() * Math.PI;
      this.fxLayer.addChild(g);
      this.particles.push({
        g,
        vx: (Math.random() - 0.5) * 7,
        vy: -4 - Math.random() * 5,
        vr: (Math.random() - 0.5) * 0.3,
        life: 0,
        maxLife: 2400 + Math.random() * 800,
      });
    }
  }

  private spawnLeaf(): void {
    const cap = this.small ? 2 : 3;
    if (this.leaves.length >= cap) return;
    const leaf = new Container();
    const g = new Graphics();
    const colors = [0xa8d878, 0xffc9dd, 0xffe3a0];
    g.ellipse(0, 0, 7, 3.5).fill(colors[Math.floor(Math.random() * colors.length)]);
    leaf.addChild(g);
    leaf.position.set(MARGIN + Math.random() * (BOARD - 2 * MARGIN), -16);
    this.fxLayer.addChild(leaf);
    this.leaves.push(leaf);
  }

  // ---------- frame tick ----------

  private tick(dt: number): void {
    tickAnimations(dt);
    this.elapsed += dt;
    const t = this.elapsed;

    // shake
    if (this.shakeAmp > 0.05) {
      const w = Math.max(1, this.host.clientWidth);
      const h = Math.max(1, this.host.clientHeight);
      const scale = Math.min(w, h) / BOARD;
      this.world.position.set(
        (w - BOARD * scale) / 2 + (Math.random() - 0.5) * 2 * this.shakeAmp,
        (h - BOARD * scale) / 2 + (Math.random() - 0.5) * 2 * this.shakeAmp,
      );
    }

    // idle bobbing (skip pawns mid-tween: their body scale is driven by animate)
    for (const pawn of this.pawns.values()) {
      if (this.busy) continue;
      const active = pawn.seat === this.activeSeat;
      pawn.body.position.y = -Math.abs(Math.sin(t * 0.0028 + pawn.phase)) * (active ? 4.5 : 2.5);
      if (active) pawn.body.rotation = 0.05 * Math.sin(t * 0.004 + pawn.phase);
      else if (this.activeSeat !== null) pawn.body.rotation *= 0.92;
    }

    // crown bob
    if (this.crown.visible) {
      this.crown.position.y = this.crownBaseY - 4 * Math.abs(Math.sin(t * 0.0035));
      this.crown.rotation = 0.08 * Math.sin(t * 0.002);
    }

    // highlight pulse
    this.dots.forEach((d, i) => {
      d.scale.set(1 + 0.16 * Math.sin(t * 0.006 + i * 0.8));
    });

    // particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life += dt;
      p.g.position.x += p.vx * (dt / 16.7);
      p.g.position.y += p.vy * (dt / 16.7);
      p.vy += 0.22 * (dt / 16.7);
      p.g.rotation += p.vr * (dt / 16.7);
      p.g.alpha = Math.max(0, 1 - p.life / p.maxLife);
      if (p.life >= p.maxLife || p.g.position.y > BOARD + 60) {
        p.g.destroy();
        this.particles.splice(i, 1);
      }
    }

    // ambient leaves
    if (t > this.nextLeafAt) {
      this.spawnLeaf();
      this.nextLeafAt = t + 4500 + Math.random() * 4000;
    }
    for (let i = this.leaves.length - 1; i >= 0; i--) {
      const leaf = this.leaves[i];
      leaf.position.y += 0.55 * (dt / 16.7);
      leaf.position.x += Math.sin(t * 0.0012 + i * 2) * 0.5;
      leaf.rotation = 0.6 * Math.sin(t * 0.0015 + i);
      if (leaf.position.y > BOARD + 20) {
        leaf.destroy();
        this.leaves.splice(i, 1);
      }
    }
  }

  // ---------- input ----------

  private toLocal(e: FederatedPointerEvent): { x: number; y: number } {
    const p = this.world.toLocal(e.global);
    return { x: p.x, y: p.y };
  }

  private cellAt(p: { x: number; y: number }): Cell | null {
    const rx = p.x - MARGIN;
    const ry = p.y - MARGIN;
    if (rx < -GAP || ry < -GAP) return null;
    const x = clamp(Math.floor(rx / PITCH), 0, 8);
    const y = clamp(Math.floor(ry / PITCH), 0, 8);
    if (rx > 9 * PITCH || ry > 9 * PITCH) return null;
    return { x, y };
  }

  private slotAt(p: { x: number; y: number }): Wall | null {
    const rx = p.x - MARGIN;
    const ry = p.y - MARGIN;
    const span = CELL * 9 + GAP * 8;
    if (rx < -GAP || ry < -GAP || rx > span + GAP || ry > span + GAP) return null;
    // Intersection i is centered at (i+1)*PITCH - GAP/2; the +GAP/2 puts the
    // snap boundary exactly midway between adjacent intersections.
    const ix = clamp(Math.round((rx + GAP / 2) / PITCH) - 1, 0, 7);
    const iy = clamp(Math.round((ry + GAP / 2) / PITCH) - 1, 0, 7);
    const gx = (ix + 1) * PITCH - GAP / 2;
    const gy = (iy + 1) * PITCH - GAP / 2;
    const o: Orientation = Math.abs(ry - gy) <= Math.abs(rx - gx) ? 'h' : 'v';
    return { x: ix, y: iy, o };
  }

  private onPointerMove(e: FederatedPointerEvent): void {
    if (this.busy || this.mode !== 'wall') return;
    if (e.pointerType === 'touch') return; // touch: tap-to-preview, tap-again-to-confirm
    const slot = this.slotAt(this.toLocal(e));
    if (!slot) {
      this.clearGhost();
      return;
    }
    if (!this.ghost || !sameWall(this.ghost, slot)) this.showGhost(slot);
  }

  private onPointerTap(e: FederatedPointerEvent): void {
    if (this.busy) return;
    if (e.button > 0) return; // right/middle click must never move or build
    const local = this.toLocal(e);
    if (this.mode === 'move') {
      const cell = this.cellAt(local);
      if (cell) this.hooks.onMoveTap(cell);
      return;
    }
    // wall mode
    const slot = this.slotAt(local);
    if (!slot) return;
    if (this.ghost && sameWall(this.ghost, slot)) {
      const check = this.hooks.checkWall(slot);
      if (check.legal) {
        this.hooks.onWallConfirm(slot);
      } else {
        this.hooks.onInvalidWallConfirm(check);
        this.wiggleGhost();
      }
    } else {
      this.showGhost(slot);
    }
  }

  private wiggleGhost(): void {
    const ghost = this.ghostLayer.children[0];
    if (!ghost) return;
    const baseX = ghost.position.x;
    void animate(220, (k) => {
      if (ghost.destroyed) return; // ghost may be cleared mid-wiggle (ESC, mode switch)
      ghost.position.x = baseX + Math.sin(k * Math.PI * 4) * 4 * (1 - k);
    });
  }

  isBusy(): boolean {
    return this.busy;
  }

  destroy(): void {
    this.destroyed = true;
    this.resizeObs.disconnect();
    this.app.destroy({ removeView: true }, { children: true, texture: true });
  }
}
