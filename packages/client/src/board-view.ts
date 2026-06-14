import { Application, Container, Graphics, Point, Text } from 'pixi.js';
import type { FederatedPointerEvent } from 'pixi.js';
import type { Cell, CharacterId, GameState, Orientation, Wall, WallCheck } from '@quori/engine';
import { animate, clearAnimations, delay, easings, lerp, tickAnimations } from './anim';
import { CHARACTER_META, createCharacter } from './characters';

/**
 * Isometric renderer. All game/hit-test MATH lives in flat "board units"
 * (the same 780×780 space as before: 9 cells of 64 + 8 grooves of 14 +
 * margins of 46); only DRAWING projects through a classic 2:1 isometric
 * transform. Pointer input is inverse-projected back into board units, so
 * cell/wall-slot picking is identical to the flat renderer.
 */
const CELL = 64;
const GAP = 14;
const MARGIN = 46;
const PITCH = CELL + GAP;
const BOARDU = MARGIN * 2 + CELL * 9 + GAP * 8; // 780 board units square
const CHAR_SIZE = 54;

// --- projection ------------------------------------------------------------
const KX = 0.7; // screen x per board unit of (u - v)
const KY = 0.35; // screen y per board unit of (u + v)  → 2:1 diamond
const ISO_W = 2 * KX * BOARDU; // 1092
const ISO_DIAMOND_H = 2 * KY * BOARDU; // 546
const TOP_PAD = 96; // room for characters/banners above the far corner
const BOTTOM_PAD = 44; // room for tile extrusion below the near corner
const ISO_H = ISO_DIAMOND_H + TOP_PAD + BOTTOM_PAD;

const TILE_DEPTH = 12;
const WALL_H = 30;
const FENCE_DROP = 44; // px the fence drops from when placed
const SHADOW_INK = 0x4d3a2a; // shared ground-shadow color
const MAX_ZOOM = 2.4;
const MIN_PAN_DRAG = 8;
const FENCE_TOUCH_RADIUS = 68;
const FENCE_MOUSE_RADIUS = 28;

function iso(u: number, v: number, z = 0): { x: number; y: number } {
  return { x: (u - v) * KX, y: (u + v) * KY - z };
}

function unIso(x: number, y: number): { u: number; v: number } {
  const a = x / KX; // u - v
  const b = y / KY; // u + v
  return { u: (a + b) / 2, v: (b - a) / 2 };
}

/** Flat polygon at elevation z from board-space corner list [[u,v],...]. */
function flatPoly(corners: Array<[number, number]>, z: number): number[] {
  const out: number[] = [];
  for (const [u, v] of corners) {
    const p = iso(u, v, z);
    out.push(p.x, p.y);
  }
  return out;
}

/** Vertical quad standing between board points a→b, from elevation z0 up to z1. */
function vquad(au: number, av: number, bu: number, bv: number, z0: number, z1: number): number[] {
  const p1 = iso(au, av, z0);
  const p2 = iso(bu, bv, z0);
  const p3 = iso(bu, bv, z1);
  const p4 = iso(au, av, z1);
  return [p1.x, p1.y, p2.x, p2.y, p3.x, p3.y, p4.x, p4.y];
}

/** Axis-aligned board-space rectangle at elevation z (corners u0,v0 -> u1,v1). */
function rectPoly(u0: number, v0: number, u1: number, v1: number, z: number): number[] {
  return flatPoly(
    [
      [u0, v0],
      [u1, v0],
      [u1, v1],
      [u0, v1],
    ],
    z,
  );
}

export type BoardMode = 'move' | 'wall';

export interface BoardHooks {
  onMoveTap(cell: Cell): void;
  onWallConfirm(wall: Wall): void;
  checkWall(wall: Wall): WallCheck;
  onWallPreviewChange?(wall: Wall | null, check: WallCheck | null): void;
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

export class BoardView {
  private app!: Application;
  private world = new Container();
  /** Origin of iso space: centered horizontally, padded from the top. */
  private isoRoot = new Container();
  private tileLayer = new Container();
  private highlightLayer = new Container();
  /** Depth-sorted layer: pawns, fences, banners (zIndex = u + v). */
  private sceneLayer = new Container();
  private ghostLayer = new Container();
  private fxLayer = new Container();

  private pawns = new Map<number, Pawn>();
  private crown = new Graphics();
  private crownBaseY = 0;
  private dots: Graphics[] = [];
  private lastMoveMark: Graphics | null = null;
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
  private viewportW = 1;
  private viewportH = 1;
  private fitScale = 1;
  private userZoom = 1;
  private pan = { x: 0, y: 0 };
  private activePointers = new Map<number, { x: number; y: number }>();
  private dragPointer: number | null = null;
  private dragStart: { x: number; y: number; panX: number; panY: number } | null = null;
  private didPan = false;
  private lastPanAt = 0;
  private pinch:
    | { contentX: number; contentY: number; startDistance: number; startZoom: number }
    | null = null;
  private cameraControls: HTMLDivElement | null = null;
  private readonly onCanvasWheel = (e: WheelEvent) => this.onWheel(e);

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

    this.sceneLayer.sortableChildren = true;
    this.isoRoot.addChild(this.tileLayer, this.highlightLayer, this.sceneLayer, this.ghostLayer, this.fxLayer);
    this.world.addChild(this.isoRoot);
    this.isoRoot.position.set(ISO_W / 2, TOP_PAD);
    this.app.stage.addChild(this.world);

    this.drawBoard(state);
    for (const p of state.players) this.spawnPawn(p.seat, p.character, p.pos);
    this.drawCrown();
    for (const w of state.walls) this.sceneLayer.addChild(...this.buildFenceHalves(w));

    // input
    this.app.stage.eventMode = 'static';
    this.app.stage.hitArea = this.app.screen;
    this.app.stage.on('pointerdown', (e: FederatedPointerEvent) => this.onPointerDown(e));
    this.app.stage.on('pointermove', (e: FederatedPointerEvent) => this.onPointerMove(e));
    this.app.stage.on('pointerup', (e: FederatedPointerEvent) => this.onPointerUp(e));
    this.app.stage.on('pointerupoutside', (e: FederatedPointerEvent) => this.onPointerUp(e));
    this.app.stage.on('pointercancel', (e: FederatedPointerEvent) => this.onPointerUp(e));
    this.app.stage.on('pointertap', (e: FederatedPointerEvent) => this.onPointerTap(e));
    this.app.canvas.addEventListener('wheel', this.onCanvasWheel, { passive: false });
    this.app.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.hooks.onCancel();
    });
    this.mountCameraControls();

    this.app.ticker.add((ticker) => this.tick(ticker.deltaMS));

    this.resizeObs = new ResizeObserver(() => this.layout());
    this.resizeObs.observe(this.host);
    this.layout();
  }

  // ---------- layout & projection helpers ----------

  private layout(): void {
    if (this.destroyed) return;
    this.viewportW = Math.max(1, this.host.clientWidth);
    this.viewportH = Math.max(1, this.host.clientHeight);
    this.app.renderer.resize(this.viewportW, this.viewportH);
    this.fitScale = Math.min(this.viewportW / ISO_W, this.viewportH / ISO_H);
    this.clampPan();
    this.applyCamera();
  }

  private basePosition(zoom = this.userZoom): { x: number; y: number } {
    const scale = this.fitScale * zoom;
    return {
      x: (this.viewportW - ISO_W * scale) / 2,
      y: (this.viewportH - ISO_H * scale) / 2,
    };
  }

  private clampPan(): void {
    const scale = this.fitScale * this.userZoom;
    const rangeX = Math.max(0, (ISO_W * scale - this.viewportW) / 2);
    const rangeY = Math.max(0, (ISO_H * scale - this.viewportH) / 2);
    this.pan.x = clamp(this.pan.x, -rangeX, rangeX);
    this.pan.y = clamp(this.pan.y, -rangeY, rangeY);
  }

  private applyCamera(shakeX = 0, shakeY = 0): void {
    const scale = this.fitScale * this.userZoom;
    const base = this.basePosition();
    this.world.scale.set(scale);
    this.world.position.set(base.x + this.pan.x + shakeX, base.y + this.pan.y + shakeY);
  }

  private zoomAt(anchor: { x: number; y: number }, nextZoom: number): void {
    const clampedZoom = clamp(nextZoom, 1, MAX_ZOOM);
    const oldScale = this.fitScale * this.userZoom;
    const oldBase = this.basePosition();
    const contentX = (anchor.x - oldBase.x - this.pan.x) / oldScale;
    const contentY = (anchor.y - oldBase.y - this.pan.y) / oldScale;

    this.userZoom = clampedZoom;
    const newScale = this.fitScale * this.userZoom;
    const newBase = this.basePosition();
    this.pan.x = anchor.x - newBase.x - contentX * newScale;
    this.pan.y = anchor.y - newBase.y - contentY * newScale;
    this.clampPan();
    this.applyCamera();
  }

  private zoomBy(factor: number, anchor = { x: this.viewportW / 2, y: this.viewportH / 2 }): void {
    this.zoomAt(anchor, this.userZoom * factor);
  }

  private resetCamera(): void {
    this.userZoom = 1;
    this.pan.x = 0;
    this.pan.y = 0;
    this.applyCamera();
  }

  private mountCameraControls(): void {
    const controls = document.createElement('div');
    controls.className = 'board-camera-controls';
    controls.setAttribute('aria-label', 'Board zoom controls');

    const addButton = (label: string, title: string, onClick: () => void): void => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.title = title;
      btn.setAttribute('aria-label', title);
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      });
      controls.appendChild(btn);
    };

    addButton('+', 'Zoom in', () => this.zoomBy(1.25));
    addButton('-', 'Zoom out', () => this.zoomBy(1 / 1.25));
    addButton('1x', 'Reset board view', () => this.resetCamera());

    this.host.appendChild(controls);
    this.cameraControls = controls;
  }

  /** Cell center in board units. */
  private cellU(c: Cell): { u: number; v: number } {
    return {
      u: MARGIN + c.x * PITCH + CELL / 2,
      v: MARGIN + c.y * PITCH + CELL / 2,
    };
  }

  /** Wall (intersection) center in board units. */
  private wallU(w: Wall): { u: number; v: number } {
    return {
      u: MARGIN + (w.x + 1) * PITCH - GAP / 2,
      v: MARGIN + (w.y + 1) * PITCH - GAP / 2,
    };
  }

  private cellIso(c: Cell): { x: number; y: number } {
    const { u, v } = this.cellU(c);
    return iso(u, v);
  }

  /** Canvas (CSS px) position of a cell center — used by tests/tooling. */
  cellClientPoint(c: Cell): { x: number; y: number } {
    const p = this.cellIso(c);
    const g = this.isoRoot.toGlobal(new Point(p.x, p.y));
    return { x: g.x, y: g.y };
  }

  /** Canvas position near a wall slot, biased so slotAt resolves the orientation. */
  wallClientPoint(w: Wall): { x: number; y: number } {
    const c = this.wallU(w);
    const u = w.o === 'h' ? c.u + 20 : c.u;
    const v = w.o === 'v' ? c.v + 20 : c.v;
    const p = iso(u, v);
    const g = this.isoRoot.toGlobal(new Point(p.x, p.y));
    return { x: g.x, y: g.y };
  }

  // ---------- static board ----------

  private drawBoard(state: GameState): void {
    const g = new Graphics();
    // garden mat: one big extruded block under everything
    const m0 = MARGIN - 16;
    const m1 = BOARDU - MARGIN + 16;
    g.poly(rectPoly(m0, m0, m1, m1, -TILE_DEPTH)).fill(0xb6dd94);
    g.poly(vquad(m0, m1, m1, m1, -TILE_DEPTH - 16, -TILE_DEPTH)).fill(0x8aa968);
    g.poly(vquad(m1, m1, m1, m0, -TILE_DEPTH - 16, -TILE_DEPTH)).fill(0x79965b);

    // cells as floating garden blocks
    for (let y = 0; y < 9; y++) {
      for (let x = 0; x < 9; x++) {
        const u0 = MARGIN + x * PITCH;
        const v0 = MARGIN + y * PITCH;
        const u1 = u0 + CELL;
        const v1 = v0 + CELL;
        const top = (x + y) % 2 === 0 ? 0xdcf3b7 : 0xd2ecab;
        g.poly(vquad(u0, v1, u1, v1, -TILE_DEPTH, 0)).fill(0xa3c47e); // lower-left face
        g.poly(vquad(u1, v1, u1, v0, -TILE_DEPTH, 0)).fill(0x8fb06c); // lower-right face
        g.poly(rectPoly(u0, v0, u1, v1, 0)).fill(top);
      }
    }
    this.tileLayer.addChild(g);

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
        const u0 = MARGIN + c.x * PITCH;
        const v0 = MARGIN + c.y * PITCH;
        tint
          .poly(rectPoly(u0, v0, u0 + CELL, v0 + CELL, 0))
          .fill({ color: meta.color, alpha: 0.18 });
      }
      this.tileLayer.addChild(tint);
      this.sceneLayer.addChild(this.buildBanner(p.character, p.goal));
    }
  }

  private buildBanner(charId: CharacterId, goal: GameState['players'][number]['goal']): Container {
    const meta = CHARACTER_META[charId];
    const mid = MARGIN + 4 * PITCH + CELL / 2;
    const off = 16;
    const pos =
      goal === 'north'
        ? { u: mid, v: off }
        : goal === 'south'
          ? { u: mid, v: BOARDU - off }
          : goal === 'west'
            ? { u: off, v: mid }
            : { u: BOARDU - off, v: mid };

    const banner = new Container();
    banner.zIndex = pos.u + pos.v;
    const pole = new Graphics();
    pole.poly(vquad(pos.u - 2, pos.v, pos.u + 2, pos.v, 0, 44)).fill(0x9a7b53);
    const base = iso(pos.u, pos.v, 0);
    pole.ellipse(base.x, base.y, 9, 4.5).fill({ color: SHADOW_INK, alpha: 0.25 });
    banner.addChild(pole);

    const badgeAt = iso(pos.u, pos.v, 52);
    const badge = new Graphics();
    badge.circle(badgeAt.x, badgeAt.y, 15).fill(meta.color).stroke({ width: 3, color: 0xffffff });
    banner.addChild(badge);
    const face = new Text({ text: meta.emoji, style: { fontSize: 16 } });
    face.anchor.set(0.5);
    face.position.set(badgeAt.x, badgeAt.y);
    banner.addChild(face);
    const icon = new Text({
      text: meta.icon,
      style: { fontSize: 11, fill: 0xffffff, fontWeight: 'bold' },
    });
    icon.anchor.set(0.5);
    icon.position.set(badgeAt.x, badgeAt.y + 21);
    banner.addChild(icon);
    return banner;
  }

  // ---------- pawns ----------

  private spawnPawn(seat: number, charId: CharacterId, cell: Cell): void {
    const root = new Container();
    const p = this.cellIso(cell);
    root.position.set(p.x, p.y);
    const { u, v } = this.cellU(cell);
    root.zIndex = u + v;

    const shadow = new Graphics();
    shadow.ellipse(0, 2, CHAR_SIZE * 0.42, CHAR_SIZE * 0.16).fill({ color: SHADOW_INK, alpha: 0.3 });
    root.addChild(shadow);

    const body = new Container();
    const art = createCharacter(charId, CHAR_SIZE);
    body.addChild(art);
    root.addChild(body);

    this.sceneLayer.addChild(root);
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
      const { u, v } = this.cellU(cell);
      const c = iso(u, v, 1);
      const half = CELL / 2 - 10;
      // drawn relative to the cell center so the pulse scales in place
      const abs = rectPoly(u - half, v - half, u + half, v + half, 1);
      const pts = abs.map((n, i) => (i % 2 === 0 ? n - c.x : n - c.y));
      const dot = new Graphics();
      dot.poly(pts).fill({ color, alpha: 0.22 }).stroke({ width: 2.5, color, alpha: 0.85 });
      dot.ellipse(0, 0, 9, 4.5).fill({ color, alpha: 0.9 }).stroke({ width: 2, color: 0xffffff });
      dot.position.set(c.x, c.y);
      this.highlightLayer.addChild(dot);
      this.dots.push(dot);
    }
  }

  setLastMove(from: Cell | null): void {
    this.lastMoveMark?.destroy();
    this.lastMoveMark = null;
    if (!from) return;
    const { u, v } = this.cellU(from);
    const c = iso(u, v, 1);
    const ring = new Graphics();
    ring.ellipse(c.x, c.y, 16, 8).stroke({ width: 3.5, color: 0xffffff, alpha: 0.75 });
    ring.ellipse(c.x, c.y, 16, 8).stroke({ width: 1.5, color: 0xc9b181, alpha: 0.6 });
    this.highlightLayer.addChild(ring);
    this.lastMoveMark = ring;
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
    this.ghostLayer.position.set(0, 0);
    this.ghostLayer.removeChildren().forEach((ch) => ch.destroy({ children: true }));
    this.hooks.onWallPreviewChange?.(null, null);
  }

  private showGhost(slot: Wall): void {
    const check = this.hooks.checkWall(slot);
    this.ghost = slot;
    this.ghostLayer.removeChildren().forEach((ch) => ch.destroy({ children: true }));
    const halo = this.buildGhostHalo(slot, check.legal);
    const fence = this.buildFence(slot);
    fence.alpha = 0.75;
    fence.tint = check.legal ? 0x8be08b : 0xff8080;
    this.ghostLayer.addChild(halo, fence);
    this.hooks.onWallPreviewChange?.(slot, check);
  }

  private buildGhostHalo(w: Wall, legal: boolean): Graphics {
    const center = this.wallU(w);
    const len = CELL * 2 + GAP;
    const pad = this.small ? 34 : 22;
    const color = legal ? 0x60c96d : 0xff6c80;
    const poly =
      w.o === 'h'
        ? rectPoly(center.u - len / 2, center.v - pad, center.u + len / 2, center.v + pad, 3)
        : rectPoly(center.u - pad, center.v - len / 2, center.u + pad, center.v + len / 2, 3);
    return new Graphics()
      .poly(poly)
      .fill({ color, alpha: this.small ? 0.28 : 0.18 })
      .stroke({ width: this.small ? 5 : 3, color, alpha: 0.75 });
  }

  // ---------- fences ----------

  /**
   * A picket fence spanning 2 cells, standing upright in iso space, built as
   * TWO half-span containers so each half depth-sorts by its own midpoint.
   * (A single full-span fence ties a pawn one cell nearer on zIndex, and the
   * stable sort then resolves the tie by insertion order — fence over pawn.)
   * Drawn in WHITE so ghost tinting works multiplicatively.
   */
  private buildFenceHalves(w: Wall): [Container, Container] {
    const center = this.wallU(w);
    const len = CELL * 2 + GAP;
    const along: { du: number; dv: number } = w.o === 'h' ? { du: 1, dv: 0 } : { du: 0, dv: 1 };
    const su = center.u - (along.du * len) / 2;
    const sv = center.v - (along.dv * len) / 2;
    const eu = center.u + (along.du * len) / 2;
    const ev = center.v + (along.dv * len) / 2;

    const buildHalf = (
      au: number,
      av: number,
      bu: number,
      bv: number,
      postTs: readonly number[],
    ): Container => {
      const cont = new Container();
      // depth-sort by this half's own midpoint
      cont.zIndex = (au + bu) / 2 + (av + bv) / 2;
      const g = new Graphics();

      // soft ground shadow (this half-span only)
      const sh0 = iso(au, av, 0);
      const sh1 = iso(bu, bv, 0);
      g.moveTo(sh0.x, sh0.y)
        .lineTo(sh1.x, sh1.y)
        .stroke({ width: 9, color: SHADOW_INK, alpha: 0.18, cap: 'round' });

      // rails (two horizontal slats along this half-span)
      for (const [z0, z1] of [
        [9, 15],
        [19, 25],
      ] as const) {
        g.poly(vquad(au, av, bu, bv, z0, z1))
          .fill(0xfffaf2)
          .stroke({ width: 1.4, color: 0xd9c4a4 });
      }

      // posts: small boxes at the given fractions of the FULL span
      const half = 4;
      for (const t of postTs) {
        const pu = su + (eu - su) * t;
        const pv = sv + (ev - sv) * t;
        // two visible faces + top
        g.poly(vquad(pu - half, pv + half, pu + half, pv + half, 0, WALL_H))
          .fill(0xffffff)
          .stroke({ width: 1.2, color: 0xd9c4a4 });
        g.poly(vquad(pu + half, pv + half, pu + half, pv - half, 0, WALL_H))
          .fill(0xe8ddc8)
          .stroke({ width: 1.2, color: 0xd9c4a4 });
        g.poly(rectPoly(pu - half, pv - half, pu + half, pv + half, WALL_H))
          .fill(0xffffff)
          .stroke({ width: 1.2, color: 0xd9c4a4 });
      }

      cont.addChild(g);
      return cont;
    };

    return [
      buildHalf(su, sv, center.u, center.v, [0.06, 0.37]),
      buildHalf(center.u, center.v, eu, ev, [0.63, 0.94]),
    ];
  }

  /** One-container fence wrapper — used only for the ghost preview, which must tint/wiggle as a unit. */
  private buildFence(w: Wall): Container {
    const cont = new Container();
    cont.addChild(...this.buildFenceHalves(w));
    return cont;
  }

  async animateWall(w: Wall): Promise<void> {
    if (this.destroyed) return;
    this.busy = true;
    this.clearGhost();
    const halves = this.buildFenceHalves(w);
    for (const h of halves) {
      h.alpha = 0;
      h.position.y = -FENCE_DROP;
      this.sceneLayer.addChild(h);
    }
    await animate(
      240,
      (k) => {
        for (const h of halves) {
          h.position.y = -FENCE_DROP * (1 - k);
          h.alpha = Math.min(1, k * 2);
        }
      },
      easings.inQuad,
    );
    if (this.destroyed) return; // torn down mid-drop
    const c = this.wallU(w);
    const p = iso(c.u, c.v, 0);
    this.dustPuff(p.x, p.y, 7);
    this.shakeAmp = 3;
    await animate(170, (k) => {
      this.shakeAmp = 3 * (1 - k);
    });
    if (this.destroyed) return;
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

    const from = this.cellIso(pawn.cell);
    const dest = this.cellIso(to);
    const dist = Math.hypot(to.x - pawn.cell.x, to.y - pawn.cell.y);
    const arc = 34 + 16 * Math.max(0, dist - 1);
    pawn.cell = to;
    const { u, v } = this.cellU(to);
    pawn.root.zIndex = u + v; // sort by destination for the duration of the hop

    // anticipate (squash)
    await animate(70, (k) => pawn.body.scale.set(1 + 0.13 * k, 1 - 0.2 * k), easings.outQuad);
    if (this.destroyed) return; // teardown resolves tweens early — don't chain the next one
    // leap
    await animate(
      170 + 70 * dist,
      (k) => {
        const hop = Math.sin(Math.PI * k) * arc;
        pawn.root.position.set(lerp(from.x, dest.x, k), lerp(from.y, dest.y, k) - hop);
        pawn.body.scale.set(1 - 0.18 * Math.sin(Math.PI * k), 1 + 0.22 * Math.sin(Math.PI * k));
        pawn.shadow.scale.set(1 - 0.3 * Math.sin(Math.PI * k));
        pawn.shadow.alpha = 1 - 0.5 * Math.sin(Math.PI * k);
      },
      easings.inOutSine,
    );
    if (this.destroyed) return;
    // land (squash + recover)
    this.dustPuff(dest.x, dest.y, 4);
    await animate(60, (k) => pawn.body.scale.set(1 + 0.16 * k, 1 - 0.22 * k), easings.outQuad);
    if (this.destroyed) return;
    await animate(
      170,
      (k) => {
        pawn.body.scale.set(lerp(1.16, 1, k), lerp(0.78, 1, k));
      },
      easings.outBack,
    );
    if (this.destroyed) return;
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
      winner.root.zIndex = 10_000; // front and center
      const center = iso(BOARDU / 2, BOARDU / 2, 0);
      const start = { x: winner.root.position.x, y: winner.root.position.y };
      await animate(
        550,
        (k) => {
          winner.root.position.set(lerp(start.x, center.x, k), lerp(start.y, center.y, k));
          winner.root.scale.set(1 + 0.6 * k);
        },
        easings.outCubic,
      );
      if (this.destroyed) return; // teardown resolves tweens early — don't chain the next one
      this.confettiBurst(center.x, center.y - 80);
      for (let i = 0; i < 3; i++) {
        await animate(190, (k) => {
          winner.root.position.y = center.y - 26 * Math.sin(Math.PI * k);
          winner.body.scale.set(1 - 0.1 * Math.sin(Math.PI * k), 1 + 0.14 * Math.sin(Math.PI * k));
        });
        if (this.destroyed) return;
      }
      this.confettiBurst(center.x, center.y - 60);
      await delay(420);
    }
    // stays busy — game is over, board input is done
  }

  // ---------- particles ----------

  private dustPuff(x: number, y: number, n: number): void {
    for (let i = 0; i < n; i++) {
      const g = new Graphics();
      g.circle(0, 0, 4 + Math.random() * 4).fill({ color: 0xfff6e3, alpha: 0.85 });
      g.position.set(x + (Math.random() - 0.5) * 26, y + (Math.random() - 0.5) * 8);
      this.fxLayer.addChild(g);
      const a = Math.random() * Math.PI * 2;
      this.particles.push({
        g,
        vx: Math.cos(a) * 1.3,
        vy: Math.sin(a) * 0.5 - 0.6,
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
    leaf.position.set((Math.random() - 0.5) * (ISO_W - 120), -TOP_PAD - 10);
    this.fxLayer.addChild(leaf);
    this.leaves.push(leaf);
  }

  // ---------- frame tick ----------

  private tick(dt: number): void {
    tickAnimations(dt);
    this.elapsed += dt;
    const t = this.elapsed;

    if (this.shakeAmp > 0.05) {
      this.applyCamera(
        (Math.random() - 0.5) * 2 * this.shakeAmp,
        (Math.random() - 0.5) * 2 * this.shakeAmp,
      );
    }

    for (const pawn of this.pawns.values()) {
      if (this.busy) continue;
      const active = pawn.seat === this.activeSeat;
      pawn.body.position.y = -Math.abs(Math.sin(t * 0.0028 + pawn.phase)) * (active ? 4.5 : 2.5);
      if (active) pawn.body.rotation = 0.05 * Math.sin(t * 0.004 + pawn.phase);
      else if (this.activeSeat !== null) pawn.body.rotation *= 0.92;
    }

    if (this.crown.visible) {
      this.crown.position.y = this.crownBaseY - 4 * Math.abs(Math.sin(t * 0.0035));
      this.crown.rotation = 0.08 * Math.sin(t * 0.002);
    }

    this.dots.forEach((d, i) => {
      d.scale.set(1 + 0.1 * Math.sin(t * 0.006 + i * 0.8));
    });

    const f = dt / 16.7; // 60fps frame normalizer
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life += dt;
      p.g.position.x += p.vx * f;
      p.g.position.y += p.vy * f;
      p.vy += 0.22 * f;
      p.g.rotation += p.vr * f;
      p.g.alpha = Math.max(0, 1 - p.life / p.maxLife);
      if (p.life >= p.maxLife || p.g.position.y > ISO_DIAMOND_H + 80) {
        p.g.destroy();
        this.particles.splice(i, 1);
      }
    }

    if (t > this.nextLeafAt) {
      this.spawnLeaf();
      this.nextLeafAt = t + 4500 + Math.random() * 4000;
    }
    for (let i = this.leaves.length - 1; i >= 0; i--) {
      const leaf = this.leaves[i];
      leaf.position.y += 0.55 * f;
      leaf.position.x += Math.sin(t * 0.0012 + i * 2) * 0.5;
      leaf.rotation = 0.6 * Math.sin(t * 0.0015 + i);
      if (leaf.position.y > ISO_DIAMOND_H + 40) {
        leaf.destroy();
        this.leaves.splice(i, 1);
      }
    }
  }

  // ---------- input ----------

  /** Camera gestures run before board move/fence input. */
  private onPointerDown(e: FederatedPointerEvent): void {
    if (e.button > 0) return;
    const id = e.pointerId ?? 1;
    this.activePointers.set(id, { x: e.global.x, y: e.global.y });

    if (this.activePointers.size >= 2) {
      const snap = this.pinchSnapshot();
      if (snap) {
        this.beginPinch(snap);
        this.didPan = true;
        this.lastPanAt = performance.now();
      }
      this.dragPointer = null;
      this.dragStart = null;
      return;
    }

    this.dragPointer = id;
    this.dragStart = { x: e.global.x, y: e.global.y, panX: this.pan.x, panY: this.pan.y };
    this.didPan = false;
    this.pinch = null;
  }

  private onPointerUp(e: FederatedPointerEvent): void {
    const id = e.pointerId ?? 1;
    this.activePointers.delete(id);
    if (this.didPan) this.lastPanAt = performance.now();
    this.pinch = null;

    if (this.activePointers.size === 1) {
      const [nextId, point] = [...this.activePointers.entries()][0];
      this.dragPointer = nextId;
      this.dragStart = { x: point.x, y: point.y, panX: this.pan.x, panY: this.pan.y };
      this.didPan = false;
      return;
    }

    this.dragPointer = null;
    this.dragStart = null;
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const rect = this.app.canvas.getBoundingClientRect();
    this.zoomBy(Math.exp(-e.deltaY * 0.0015), {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
  }

  private pinchSnapshot(): { center: { x: number; y: number }; distance: number } | null {
    const points = [...this.activePointers.values()];
    if (points.length < 2) return null;
    const [a, b] = points;
    return {
      center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
    };
  }

  private beginPinch(snap: { center: { x: number; y: number }; distance: number }): void {
    const scale = this.fitScale * this.userZoom;
    const base = this.basePosition();
    this.pinch = {
      contentX: (snap.center.x - base.x - this.pan.x) / scale,
      contentY: (snap.center.y - base.y - this.pan.y) / scale,
      startDistance: snap.distance,
      startZoom: this.userZoom,
    };
  }

  private handleCameraGesture(e: FederatedPointerEvent): boolean {
    const id = e.pointerId ?? 1;
    if (this.activePointers.has(id)) this.activePointers.set(id, { x: e.global.x, y: e.global.y });

    if (this.activePointers.size >= 2) {
      const snap = this.pinchSnapshot();
      if (!snap) return false;
      if (!this.pinch) this.beginPinch(snap);
      if (!this.pinch) return false;

      this.userZoom = clamp(this.pinch.startZoom * (snap.distance / this.pinch.startDistance), 1, MAX_ZOOM);
      const scale = this.fitScale * this.userZoom;
      const base = this.basePosition();
      this.pan.x = snap.center.x - base.x - this.pinch.contentX * scale;
      this.pan.y = snap.center.y - base.y - this.pinch.contentY * scale;
      this.clampPan();
      this.applyCamera();
      this.didPan = true;
      this.lastPanAt = performance.now();
      return true;
    }

    if (this.dragStart && this.dragPointer === id) {
      const dx = e.global.x - this.dragStart.x;
      const dy = e.global.y - this.dragStart.y;
      if (this.didPan || Math.hypot(dx, dy) >= MIN_PAN_DRAG) {
        this.pan.x = this.dragStart.panX + dx;
        this.pan.y = this.dragStart.panY + dy;
        this.clampPan();
        this.applyCamera();
        this.didPan = true;
        this.lastPanAt = performance.now();
        return true;
      }
    }

    return false;
  }

  /** Pointer -> board units via the inverse isometric projection. */
  private toBoardUnits(e: FederatedPointerEvent): { u: number; v: number } {
    const p = this.isoRoot.toLocal(e.global);
    return unIso(p.x, p.y);
  }

  private cellAt(p: { u: number; v: number }): Cell | null {
    const rx = p.u - MARGIN;
    const ry = p.v - MARGIN;
    if (rx < -GAP || ry < -GAP) return null;
    const x = clamp(Math.floor(rx / PITCH), 0, 8);
    const y = clamp(Math.floor(ry / PITCH), 0, 8);
    if (rx > 9 * PITCH || ry > 9 * PITCH) return null;
    return { x, y };
  }

  private slotDistance(p: { u: number; v: number }, w: Wall): number {
    const center = this.wallU(w);
    const len = CELL * 2 + GAP;
    const nearest =
      w.o === 'h'
        ? { u: clamp(p.u, center.u - len / 2, center.u + len / 2), v: center.v }
        : { u: center.u, v: clamp(p.v, center.v - len / 2, center.v + len / 2) };
    return Math.hypot(p.u - nearest.u, p.v - nearest.v);
  }

  private nearestSlotAt(p: { u: number; v: number }, radius: number): Wall | null {
    let best: Wall | null = null;
    let bestDist = Infinity;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        for (const o of ['h', 'v'] as const) {
          const wall = { x, y, o };
          const dist = this.slotDistance(p, wall);
          if (dist < bestDist) {
            bestDist = dist;
            best = wall;
          }
        }
      }
    }
    return best && bestDist <= radius ? best : null;
  }

  private slotAt(p: { u: number; v: number }, forgiving = false): Wall | null {
    const nearest = this.nearestSlotAt(p, forgiving ? FENCE_TOUCH_RADIUS : FENCE_MOUSE_RADIUS);
    if (nearest) return nearest;
    if (forgiving) return null;

    const rx = p.u - MARGIN;
    const ry = p.v - MARGIN;
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
    if (this.handleCameraGesture(e)) return;
  }

  private onPointerTap(e: FederatedPointerEvent): void {
    if (this.busy) return;
    if (e.button > 0) return; // right/middle click must never move or build
    if (performance.now() - this.lastPanAt < 220) return;
    const local = this.toBoardUnits(e);
    if (this.mode === 'move') {
      const cell = this.cellAt(local);
      if (cell) this.hooks.onMoveTap(cell);
      return;
    }
    const slot = this.slotAt(local, e.pointerType === 'touch');
    if (!slot) return;
    this.showGhost(slot);
  }

  private wiggleGhost(): void {
    const ghost = this.ghostLayer;
    if (ghost.children.length === 0) return;
    const baseX = ghost.position.x;
    void animate(220, (k) => {
      if (ghost.destroyed) return; // ghost may be cleared mid-wiggle (ESC, mode switch)
      ghost.position.x = baseX + Math.sin(k * Math.PI * 4) * 4 * (1 - k);
    });
  }

  isBusy(): boolean {
    return this.busy;
  }

  hasWallPreview(): boolean {
    return this.ghost !== null;
  }

  rotateWallPreview(): boolean {
    if (this.busy || this.mode !== 'wall' || !this.ghost) return false;
    this.showGhost({
      ...this.ghost,
      o: this.ghost.o === 'h' ? 'v' : 'h',
    });
    return true;
  }

  confirmWallPreview(): boolean {
    if (this.busy || this.mode !== 'wall' || !this.ghost) return false;
    const slot = this.ghost;
    const check = this.hooks.checkWall(slot);
    if (!check.legal) {
      this.hooks.onInvalidWallConfirm(check);
      this.wiggleGhost();
      this.hooks.onWallPreviewChange?.(slot, check);
      return false;
    }
    this.hooks.onWallConfirm(slot);
    return true;
  }

  destroy(): void {
    // Drain the module-global tween registry first: pending tweens would
    // otherwise be ticked by the NEXT board against destroyed objects.
    clearAnimations();
    this.destroyed = true;
    this.app.canvas.removeEventListener('wheel', this.onCanvasWheel);
    this.cameraControls?.remove();
    this.cameraControls = null;
    this.resizeObs.disconnect();
    this.app.destroy({ removeView: true }, { children: true, texture: true });
  }
}
