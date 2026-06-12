/**
 * AUDIT: differential testing against an independent reference implementation.
 *
 * The reference below is written from the OFFICIAL rules text only:
 *  - Board: 9x9 cells, (x,y), x 0-8 left-to-right, y 0-8 top-to-bottom.
 *  - Move: one cell orthogonally, not through walls, not onto a pawn.
 *  - Jump: if an adjacent pawn faces you, jump straight over it to the cell
 *    beyond. If that cell is off-board, walled off, or occupied, you may instead
 *    move diagonally to either cell beside the blocking pawn (that diagonal step
 *    must itself not be walled off from the blocking pawn's cell, must be on the
 *    board, and must be empty). No double jumps.
 *  - Wall (x,y,o), x,y in 0..7 at intersection (x,y):
 *      'h' blocks crossing between rows y/y+1 for columns x and x+1.
 *      'v' blocks crossing between columns x/x+1 for rows y and y+1.
 *    Walls may not overlap (share a blocked groove segment), may not cross
 *    (h+v at the same intersection), may not extend off the board, and may not
 *    cut off ANY player's last path to their goal edge (BFS, ignoring pawns).
 *
 * It deliberately uses a different data representation than the engine
 * (an explicit set of blocked cell-adjacency EDGES) so that a shared bug is
 * unlikely to hide in both implementations.
 */
import { describe, expect, it } from 'vitest';
import type { Cell, Edge, GameState, Wall } from '../src/index';
import { CHARACTERS, checkWallPlacement, getLegalMoves, renderAscii } from '../src/index';

// ---------------------------------------------------------------------------
// Reference implementation (independent of engine internals)
// ---------------------------------------------------------------------------

const N = 9; // board size
const W = 8; // wall grid size

function inBoard(c: Cell): boolean {
  return c.x >= 0 && c.x < N && c.y >= 0 && c.y < N;
}

function ckey(c: Cell): string {
  return `${c.x},${c.y}`;
}

/** Normalized key for the edge between two orthogonally adjacent cells. */
function edgeKey(a: Cell, b: Cell): string {
  if (a.y < b.y || (a.y === b.y && a.x < b.x)) return `${a.x},${a.y}|${b.x},${b.y}`;
  return `${b.x},${b.y}|${a.x},${a.y}`;
}

/** The two cell-adjacency edges a wall blocks, straight from the rules text. */
function wallEdges(w: Wall): string[] {
  if (w.o === 'h') {
    // blocks crossing between rows y / y+1 for columns x and x+1
    return [
      edgeKey({ x: w.x, y: w.y }, { x: w.x, y: w.y + 1 }),
      edgeKey({ x: w.x + 1, y: w.y }, { x: w.x + 1, y: w.y + 1 }),
    ];
  }
  // 'v' blocks crossing between columns x / x+1 for rows y and y+1
  return [
    edgeKey({ x: w.x, y: w.y }, { x: w.x + 1, y: w.y }),
    edgeKey({ x: w.x, y: w.y + 1 }, { x: w.x + 1, y: w.y + 1 }),
  ];
}

function blockedEdgeSet(walls: readonly Wall[]): Set<string> {
  const s = new Set<string>();
  for (const w of walls) for (const e of wallEdges(w)) s.add(e);
  return s;
}

function onGoalEdge(c: Cell, goal: Edge): boolean {
  switch (goal) {
    case 'north':
      return c.y === 0;
    case 'south':
      return c.y === N - 1;
    case 'west':
      return c.x === 0;
    case 'east':
      return c.x === N - 1;
  }
}

const REF_DIRS: readonly Cell[] = [
  { x: 0, y: -1 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 1, y: 0 },
];

interface RefPlayer {
  pos: Cell;
  goal: Edge;
}

/** Reference legal pawn destinations, per the official move/jump/diagonal rules. */
function refLegalMoves(players: readonly RefPlayer[], walls: readonly Wall[], idx: number): Cell[] {
  const blocked = blockedEdgeSet(walls);
  const occ = new Set(players.map((p) => ckey(p.pos)));
  const me = players[idx].pos;
  const dests = new Map<string, Cell>();

  for (const d of REF_DIRS) {
    const adj = { x: me.x + d.x, y: me.y + d.y };
    if (!inBoard(adj)) continue;
    if (blocked.has(edgeKey(me, adj))) continue;

    if (!occ.has(ckey(adj))) {
      dests.set(ckey(adj), adj);
      continue;
    }

    // A pawn sits on the adjacent cell. Try the straight jump.
    const beyond = { x: adj.x + d.x, y: adj.y + d.y };
    const straightPossible =
      inBoard(beyond) && !blocked.has(edgeKey(adj, beyond)) && !occ.has(ckey(beyond));
    if (straightPossible) {
      dests.set(ckey(beyond), beyond);
      continue;
    }

    // Straight jump impossible -> the two diagonal cells beside the blocking pawn.
    const sides: readonly Cell[] =
      d.x === 0
        ? [
            { x: -1, y: 0 },
            { x: 1, y: 0 },
          ]
        : [
            { x: 0, y: -1 },
            { x: 0, y: 1 },
          ];
    for (const s of sides) {
      const diag = { x: adj.x + s.x, y: adj.y + s.y };
      if (!inBoard(diag)) continue;
      if (blocked.has(edgeKey(adj, diag))) continue;
      if (occ.has(ckey(diag))) continue;
      dests.set(ckey(diag), diag);
    }
  }
  return [...dests.values()];
}

/** BFS, ignoring pawns, over a precomputed blocked-edge set. */
function refHasPath(blocked: ReadonlySet<string>, from: Cell, goal: Edge): boolean {
  if (onGoalEdge(from, goal)) return true;
  const seen = new Set<string>([ckey(from)]);
  const queue: Cell[] = [from];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    for (const d of REF_DIRS) {
      const nxt = { x: cur.x + d.x, y: cur.y + d.y };
      if (!inBoard(nxt)) continue;
      const k = ckey(nxt);
      if (seen.has(k)) continue;
      if (blocked.has(edgeKey(cur, nxt))) continue;
      if (onGoalEdge(nxt, goal)) return true;
      seen.add(k);
      queue.push(nxt);
    }
  }
  return false;
}

/**
 * Reference wall-placement legality: bounds, no overlap (shared blocked groove
 * segment), no crossing (h+v at the same intersection), and every player keeps
 * a path to their goal edge.
 */
function refWallLegal(players: readonly RefPlayer[], walls: readonly Wall[], w: Wall): boolean {
  if (!Number.isInteger(w.x) || !Number.isInteger(w.y)) return false;
  if (w.x < 0 || w.x >= W || w.y < 0 || w.y >= W) return false;

  // Crossing: a horizontal and a vertical wall centered on the same intersection.
  for (const e of walls) {
    if (e.o !== w.o && e.x === w.x && e.y === w.y) return false;
  }
  // Overlap: the two walls would block at least one common groove segment.
  const existingEdges = blockedEdgeSet(walls);
  for (const eg of wallEdges(w)) {
    if (existingEdges.has(eg)) return false;
  }

  const after = new Set(existingEdges);
  for (const eg of wallEdges(w)) after.add(eg);
  for (const p of players) {
    if (!refHasPath(after, p.pos, p.goal)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) and random state generation
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;

function irand(rng: Rng, n: number): number {
  return Math.floor(rng() * n);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Goals per seat, matching the documented layouts (2p/3p/4p). */
const GOALS_BY_COUNT: Record<number, readonly Edge[]> = {
  2: ['north', 'south'],
  3: ['north', 'east', 'south'],
  4: ['north', 'east', 'south', 'west'],
};

interface GenState {
  state: GameState;
  refPlayers: RefPlayer[];
}

function generateState(stateIndex: number): GenState {
  const rng = mulberry32(0x51ab2e7 ^ Math.imul(stateIndex + 1, 0x9e3779b1));
  const count = 2 + irand(rng, 3); // 2..4
  const goals = GOALS_BY_COUNT[count];

  // Half the states cluster all pawns together to exercise jump/diagonal rules.
  const cluster = rng() < 0.5;
  const cx = 1 + irand(rng, 7);
  const cy = 1 + irand(rng, 7);

  const positions: Cell[] = [];
  const taken = new Set<string>();
  for (let i = 0; i < count; i++) {
    const goal = goals[i];
    let placed: Cell | null = null;
    for (let attempt = 0; attempt < 400 && !placed; attempt++) {
      let c: Cell;
      if (cluster && attempt < 200) {
        c = {
          x: clamp(cx - 2 + irand(rng, 5), 0, N - 1),
          y: clamp(cy - 2 + irand(rng, 5), 0, N - 1),
        };
      } else {
        c = { x: irand(rng, N), y: irand(rng, N) };
      }
      if (taken.has(ckey(c))) continue;
      if (onGoalEdge(c, goal)) continue; // never start a state with a winner
      placed = c;
    }
    if (!placed) throw new Error('could not place pawn');
    taken.add(ckey(placed));
    positions.push(placed);
  }

  const refPlayers: RefPlayer[] = positions.map((pos, i) => ({ pos, goal: goals[i] }));

  // Build a random set of legal walls incrementally, each accepted by the
  // REFERENCE checker (so all players remain un-trapped).
  const walls: Wall[] = [];
  const targetWalls = irand(rng, 13); // 0..12
  for (let attempt = 0; attempt < targetWalls * 12 && walls.length < targetWalls; attempt++) {
    let wx: number;
    let wy: number;
    if (rng() < 0.6) {
      // near a random pawn, to make jump-relevant wall geometry common
      const p = positions[irand(rng, positions.length)];
      wx = clamp(p.x - 2 + irand(rng, 4), 0, W - 1);
      wy = clamp(p.y - 2 + irand(rng, 4), 0, W - 1);
    } else {
      wx = irand(rng, W);
      wy = irand(rng, W);
    }
    const cand: Wall = { x: wx, y: wy, o: rng() < 0.5 ? 'h' : 'v' };
    if (refWallLegal(refPlayers, walls, cand)) walls.push(cand);
  }

  const wallsLeft = 1 + irand(rng, 9); // always >0 so NO_WALLS_LEFT never interferes
  const state: GameState = {
    players: refPlayers.map((p, i) => ({
      seat: i,
      character: CHARACTERS[i],
      pos: p.pos,
      wallsLeft,
      goal: p.goal,
    })),
    walls,
    current: irand(rng, count),
    turnSeq: 0,
    status: 'playing',
    winner: null,
  };
  return { state, refPlayers };
}

/** Candidate walls for the legality comparison: jittered, near-pawn, and uniform (incl. out-of-bounds). */
function generateCandidateWall(rng: Rng, state: GameState): Wall {
  const r = rng();
  if (r < 0.35 && state.walls.length > 0) {
    const e = state.walls[irand(rng, state.walls.length)];
    return {
      x: e.x - 1 + irand(rng, 3),
      y: e.y - 1 + irand(rng, 3),
      o: rng() < 0.5 ? e.o : e.o === 'h' ? 'v' : 'h',
    };
  }
  if (r < 0.7) {
    const p = state.players[irand(rng, state.players.length)].pos;
    return {
      x: clamp(p.x - 2 + irand(rng, 4), 0, W - 1),
      y: clamp(p.y - 2 + irand(rng, 4), 0, W - 1),
      o: rng() < 0.5 ? 'h' : 'v',
    };
  }
  return { x: irand(rng, 10) - 1, y: irand(rng, 10) - 1, o: rng() < 0.5 ? 'h' : 'v' };
}

// ---------------------------------------------------------------------------
// Reporting helpers
// ---------------------------------------------------------------------------

function sortKeys(cells: readonly Cell[]): string[] {
  return cells.map(ckey).sort();
}

function describeState(stateIndex: number, state: GameState): string {
  const players = state.players
    .map((p) => `  seat ${p.seat}: pos=(${p.pos.x},${p.pos.y}) goal=${p.goal} wallsLeft=${p.wallsLeft}`)
    .join('\n');
  const walls = state.walls.map((w) => `{x:${w.x},y:${w.y},o:'${w.o}'}`).join(', ');
  return [
    `state #${stateIndex} (current=${state.current})`,
    players,
    `  walls: [${walls}]`,
    renderAscii(state),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Sanity checks for the reference itself (hand-computed from official rules)
// ---------------------------------------------------------------------------

describe('reference implementation sanity (hand-computed)', () => {
  it('open center cell: 4 orthogonal moves', () => {
    const players: RefPlayer[] = [
      { pos: { x: 4, y: 4 }, goal: 'north' },
      { pos: { x: 0, y: 0 }, goal: 'south' },
    ];
    expect(sortKeys(refLegalMoves(players, [], 0))).toEqual(
      ['4,3', '4,5', '3,4', '5,4'].sort(),
    );
  });

  it('face-to-face: straight jump replaces the blocked step', () => {
    // me at (4,4), opponent directly north at (4,3): jump to (4,2)
    const players: RefPlayer[] = [
      { pos: { x: 4, y: 4 }, goal: 'north' },
      { pos: { x: 4, y: 3 }, goal: 'south' },
    ];
    expect(sortKeys(refLegalMoves(players, [], 0))).toEqual(
      ['4,2', '4,5', '3,4', '5,4'].sort(),
    );
  });

  it('wall behind the opponent: the two diagonals instead of the straight jump', () => {
    // opponent at (4,3); h wall at (4,2) blocks (4,3)->(4,2); diagonals (3,3),(5,3)
    const players: RefPlayer[] = [
      { pos: { x: 4, y: 4 }, goal: 'north' },
      { pos: { x: 4, y: 3 }, goal: 'south' },
    ];
    const walls: Wall[] = [{ x: 4, y: 2, o: 'h' }];
    expect(sortKeys(refLegalMoves(players, walls, 0))).toEqual(
      ['3,3', '5,3', '4,5', '3,4', '5,4'].sort(),
    );
  });

  it('two pawns in a line: no double jump, diagonals around the first pawn', () => {
    // me (4,4), pawns at (4,3) and (4,2): cannot jump to (4,1); diagonals (3,3),(5,3)
    const players: RefPlayer[] = [
      { pos: { x: 4, y: 4 }, goal: 'north' },
      { pos: { x: 4, y: 3 }, goal: 'south' },
      { pos: { x: 4, y: 2 }, goal: 'east' },
    ];
    expect(sortKeys(refLegalMoves(players, [], 0))).toEqual(
      ['3,3', '5,3', '4,5', '3,4', '5,4'].sort(),
    );
  });

  it('board edge behind the opponent: diagonals', () => {
    // me (4,1), opponent (4,0): straight jump off-board; diagonals (3,0),(5,0)
    const players: RefPlayer[] = [
      { pos: { x: 4, y: 1 }, goal: 'north' },
      { pos: { x: 4, y: 0 }, goal: 'south' },
    ];
    expect(sortKeys(refLegalMoves(players, [], 0))).toEqual(
      ['3,0', '5,0', '4,2', '3,1', '5,1'].sort(),
    );
  });

  it('wall overlap / cross detection', () => {
    const players: RefPlayer[] = [
      { pos: { x: 4, y: 8 }, goal: 'north' },
      { pos: { x: 4, y: 0 }, goal: 'south' },
    ];
    const base: Wall[] = [{ x: 3, y: 3, o: 'h' }];
    expect(refWallLegal(players, base, { x: 3, y: 3, o: 'h' })).toBe(false); // same slot
    expect(refWallLegal(players, base, { x: 2, y: 3, o: 'h' })).toBe(false); // overlaps span
    expect(refWallLegal(players, base, { x: 4, y: 3, o: 'h' })).toBe(false); // overlaps span
    expect(refWallLegal(players, base, { x: 3, y: 3, o: 'v' })).toBe(false); // crosses
    expect(refWallLegal(players, base, { x: 5, y: 3, o: 'h' })).toBe(true); // end-to-end ok
    expect(refWallLegal(players, base, { x: 2, y: 3, o: 'v' })).toBe(true); // touching ok
    expect(refWallLegal(players, base, { x: 4, y: 3, o: 'v' })).toBe(true); // touching ok
    expect(refWallLegal(players, base, { x: 8, y: 0, o: 'h' })).toBe(false); // out of bounds
    expect(refWallLegal(players, base, { x: 0, y: -1, o: 'v' })).toBe(false); // out of bounds
  });

  it('wall that traps a player is illegal; the same wall elsewhere is legal', () => {
    // Box in a pawn at (0,0): walls h(0, 0) blocks south exits of (0,0),(1,0);
    // v(1,0) blocks east of column 1 rows 0..1. Then v(0,0) would seal (0,0)
    // for a north-goal pawn? A north-goal pawn at (0,0) is ON its goal... use a
    // south-goal pawn at (0,0) instead and seal it completely.
    const players: RefPlayer[] = [
      { pos: { x: 0, y: 0 }, goal: 'south' },
      { pos: { x: 4, y: 8 }, goal: 'north' },
    ];
    const base: Wall[] = [{ x: 0, y: 0, o: 'h' }]; // blocks (0,0)-(0,1) and (1,0)-(1,1)
    // v wall at (1,0) blocks (1,0)-(2,0) and (1,1)-(2,1): pawn could still go
    // (0,0)->(1,0) then... (1,0)->(2,0) blocked, (1,0)->(1,1) blocked by h. Trapped.
    expect(refWallLegal(players, base, { x: 1, y: 0, o: 'v' })).toBe(false);
    // Far away it is fine.
    expect(refWallLegal(players, base, { x: 5, y: 5, o: 'v' })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The differential fuzz itself
// ---------------------------------------------------------------------------

const STATE_COUNT = 2000;
const WALL_CANDIDATES_PER_STATE = 20;
const MAX_REPORTS = 3;

describe('differential fuzz: engine vs independent reference', () => {
  it(
    `agrees on getLegalMoves and checkWallPlacement across ${STATE_COUNT} random states`,
    () => {
      const reports: string[] = [];
      let moveChecks = 0;
      let wallChecks = 0;

      for (let k = 0; k < STATE_COUNT; k++) {
        const { state, refPlayers } = generateState(k);

        // --- moves: every player ---
        for (let i = 0; i < state.players.length; i++) {
          moveChecks++;
          const engineMoves = sortKeys(getLegalMoves(state, i));
          const referenceMoves = sortKeys(refLegalMoves(refPlayers, state.walls, i));
          if (JSON.stringify(engineMoves) !== JSON.stringify(referenceMoves)) {
            reports.push(
              [
                `MOVE MISMATCH for player ${i}`,
                describeState(k, state),
                `engine:    [${engineMoves.join(' | ')}]`,
                `reference: [${referenceMoves.join(' | ')}]`,
                `repro: const { state } = generateState(${k}); getLegalMoves(state, ${i});`,
              ].join('\n'),
            );
            if (reports.length >= MAX_REPORTS) break;
          }
        }
        if (reports.length >= MAX_REPORTS) break;

        // --- wall legality: ~20 candidates, judged for the current player ---
        const wallRng = mulberry32(0xc0ffee ^ Math.imul(k + 1, 0x85ebca6b));
        for (let j = 0; j < WALL_CANDIDATES_PER_STATE; j++) {
          wallChecks++;
          const cand = generateCandidateWall(wallRng, state);
          const engineCheck = checkWallPlacement(state, cand, state.current);
          const engineLegal = engineCheck.legal;
          const referenceLegal = refWallLegal(refPlayers, state.walls, cand);
          if (engineLegal !== referenceLegal) {
            reports.push(
              [
                `WALL MISMATCH for candidate {x:${cand.x},y:${cand.y},o:'${cand.o}'} (player ${state.current})`,
                describeState(k, state),
                `engine:    legal=${engineLegal}${engineLegal ? '' : ` reason=${(engineCheck as { reason: string }).reason}`}`,
                `reference: legal=${referenceLegal}`,
                `repro: const { state } = generateState(${k}); checkWallPlacement(state, {x:${cand.x},y:${cand.y},o:'${cand.o}'}, ${state.current});`,
              ].join('\n'),
            );
            if (reports.length >= MAX_REPORTS) break;
          }
        }
        if (reports.length >= MAX_REPORTS) break;
      }

      if (reports.length > 0) {
        throw new Error(
          `differential fuzz found ${reports.length}+ mismatches ` +
            `(after ${moveChecks} move checks, ${wallChecks} wall checks):\n\n` +
            reports.join('\n\n========================================\n\n'),
        );
      }
      // Make the volume of comparisons visible in the assertion.
      // (Measured coverage on this corpus: 961 player-states offered a jump or
      // diagonal move; wall candidates split into 23006 legal / 10217 overlap-or-
      // cross / 6327 out-of-bounds / 450 path-blocking.)
      expect(moveChecks).toBeGreaterThanOrEqual(STATE_COUNT * 2);
      expect(wallChecks).toBe(STATE_COUNT * WALL_CANDIDATES_PER_STATE);
    },
    180_000,
  );
});
