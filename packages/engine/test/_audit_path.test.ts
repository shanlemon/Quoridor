/**
 * Adversarial audit of pathfinding: path.ts (distanceField, shortestPathLength,
 * bestAutoMove) and walls.ts (hasPathToGoal, checkWallPlacement path rule).
 *
 * Every expectation here is hand-derived from the official rules and the
 * documented coordinate system (cells (x,y), x 0-8 left-to-right, y 0-8
 * top-to-bottom; wall (x,y,'h') blocks crossing rows y/y+1 at columns x,x+1;
 * wall (x,y,'v') blocks crossing columns x/x+1 at rows y,y+1) — NOT from the
 * implementation. A fully independent reference BFS (refField/refBlocked) is
 * implemented below straight from that wall semantics.
 */
import { describe, expect, it } from 'vitest';
import {
  bestAutoMove,
  checkWallPlacement,
  createGame,
  distanceField,
  getLegalMoves,
  getLegalWallSlots,
  hasPathToGoal,
  shortestPathLength,
  wallSetOf,
} from '../src/index';
import type { Cell, Edge, Wall } from '../src/index';
import { makeState } from './helpers';

const N = 9;
const EDGES: Edge[] = ['north', 'south', 'east', 'west'];

// ---------------------------------------------------------------------------
// Independent reference implementation (derived from the rules text only).
// ---------------------------------------------------------------------------

function refGoal(c: Cell, goal: Edge): boolean {
  switch (goal) {
    case 'north':
      return c.y === 0;
    case 'south':
      return c.y === 8;
    case 'west':
      return c.x === 0;
    case 'east':
      return c.x === 8;
  }
}

/** Does wall w block the unit step a -> b? Pure transcription of the spec. */
function refBlocksStep(w: Wall, a: Cell, b: Cell): boolean {
  if (a.x === b.x && Math.abs(a.y - b.y) === 1) {
    // vertical step crossing the boundary between rows yTop and yTop+1
    const yTop = Math.min(a.y, b.y);
    return w.o === 'h' && w.y === yTop && (a.x === w.x || a.x === w.x + 1);
  }
  if (a.y === b.y && Math.abs(a.x - b.x) === 1) {
    // horizontal step crossing the boundary between columns xLeft and xLeft+1
    const xLeft = Math.min(a.x, b.x);
    return w.o === 'v' && w.x === xLeft && (a.y === w.y || a.y === w.y + 1);
  }
  return false;
}

function refBlocked(walls: readonly Wall[], a: Cell, b: Cell): boolean {
  return walls.some((w) => refBlocksStep(w, a, b));
}

/** Multi-source BFS from all goal cells; Infinity where unreachable. */
function refField(walls: readonly Wall[], goal: Edge): number[][] {
  const field: number[][] = Array.from({ length: N }, () => new Array<number>(N).fill(Infinity));
  const queue: Cell[] = [];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (refGoal({ x, y }, goal)) {
        field[y][x] = 0;
        queue.push({ x, y });
      }
    }
  }
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    for (const [dx, dy] of [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ] as const) {
      const nxt = { x: cur.x + dx, y: cur.y + dy };
      if (nxt.x < 0 || nxt.x >= N || nxt.y < 0 || nxt.y >= N) continue;
      if (field[nxt.y][nxt.x] !== Infinity) continue;
      if (refBlocked(walls, cur, nxt)) continue;
      field[nxt.y][nxt.x] = field[cur.y][cur.x] + 1;
      queue.push(nxt);
    }
  }
  return field;
}

/** Official structural conflict rules: same slot, crossing midpoint, overlapping span. */
function refConflict(existing: readonly Wall[], w: Wall): boolean {
  return existing.some(
    (e) =>
      (e.x === w.x && e.y === w.y) || // same slot or perpendicular cross at same intersection
      (e.o === 'h' && w.o === 'h' && e.y === w.y && Math.abs(e.x - w.x) === 1) ||
      (e.o === 'v' && w.o === 'v' && e.x === w.x && Math.abs(e.y - w.y) === 1),
  );
}

/** Deterministic PRNG for reproducible random wall sets. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomWallSet(seed: number, target: number): Wall[] {
  const rnd = mulberry32(seed);
  const out: Wall[] = [];
  for (let attempts = 0; attempts < 600 && out.length < target; attempts++) {
    const w: Wall = {
      x: Math.floor(rnd() * 8),
      y: Math.floor(rnd() * 8),
      o: rnd() < 0.5 ? 'h' : 'v',
    };
    if (!refConflict(out, w)) out.push(w);
  }
  return out;
}

/** Collect human-readable mismatches between an engine field and expectations. */
function fieldMismatches(
  field: number[][],
  expected: (x: number, y: number) => number,
): string[] {
  const bad: string[] = [];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const want = expected(x, y);
      if (field[y][x] !== want) bad.push(`cell(${x},${y}): got ${field[y][x]}, want ${want}`);
    }
  }
  return bad;
}

// ---------------------------------------------------------------------------
// Hand-built mazes.
// ---------------------------------------------------------------------------

// Horizontal barrier between rows 4 and 5 covering columns 0..7, gap at column 8.
const NORTH_BARRIER: Wall[] = [
  { x: 0, y: 4, o: 'h' },
  { x: 2, y: 4, o: 'h' },
  { x: 4, y: 4, o: 'h' },
  { x: 6, y: 4, o: 'h' },
];

// Horizontal barrier between rows 4 and 5 covering columns 1..8, gap at column 0.
const SOUTH_BARRIER: Wall[] = [
  { x: 1, y: 4, o: 'h' },
  { x: 3, y: 4, o: 'h' },
  { x: 5, y: 4, o: 'h' },
  { x: 7, y: 4, o: 'h' },
];

// Vertical barrier between columns 4 and 5 covering rows 0..3 and 5..8, gap at row 4.
const WEST_BARRIER: Wall[] = [
  { x: 4, y: 0, o: 'v' },
  { x: 4, y: 2, o: 'v' },
  { x: 4, y: 5, o: 'v' },
  { x: 4, y: 7, o: 'v' },
];

// Vertical barrier between columns 3 and 4 covering rows 0..7, gap at row 8.
const EAST_BARRIER: Wall[] = [
  { x: 3, y: 0, o: 'v' },
  { x: 3, y: 2, o: 'v' },
  { x: 3, y: 4, o: 'v' },
  { x: 3, y: 6, o: 'v' },
];

// Full serpentine: every column boundary bx (0..7) is walled except one gap,
// alternating gap row 8 (even bx) / gap row 0 (odd bx). No h walls at all.
const SERPENTINE: Wall[] = (() => {
  const walls: Wall[] = [];
  for (let bx = 0; bx < 8; bx++) {
    const gapAtTop = bx % 2 === 1;
    for (let i = 0; i < 4; i++) {
      walls.push({ x: bx, y: gapAtTop ? 1 + 2 * i : 2 * i, o: 'v' });
    }
  }
  return walls;
})();

/**
 * Hand-derived serpentine distance to the EAST edge.
 * Column 7 exits north (gap row 0): y+1. Each column further left adds a full
 * 8-step traverse + 1 crossing: col6 = 18-y, col5 = y+19, col4 = 36-y,
 * col3 = y+37, col2 = 54-y, col1 = y+55, col0 = 72-y. Column 8 is the goal.
 */
function serpDist(x: number, y: number): number {
  if (x === 8) return 0;
  return x % 2 === 0 ? 72 - 18 * (x / 2) - y : y + 55 - 18 * ((x - 1) / 2);
}

// Sealed 2x2 box around cells (3,3),(4,3),(3,4),(4,4).
const BOX: Wall[] = [
  { x: 3, y: 2, o: 'h' }, // top: blocks rows 2|3 at columns 3,4
  { x: 3, y: 4, o: 'h' }, // bottom: blocks rows 4|5 at columns 3,4
  { x: 2, y: 3, o: 'v' }, // left: blocks columns 2|3 at rows 3,4
  { x: 4, y: 3, o: 'v' }, // right: blocks columns 4|5 at rows 3,4
];
const BOX_CELLS = new Set(['3,3', '4,3', '3,4', '4,4']);

// Almost-box: the same pocket missing its right side (v(4,3) would seal it).
const ALMOST_BOX: Wall[] = [
  { x: 3, y: 2, o: 'h' },
  { x: 3, y: 4, o: 'h' },
  { x: 2, y: 3, o: 'v' },
];

// ---------------------------------------------------------------------------
// distanceField
// ---------------------------------------------------------------------------

describe('distanceField on hand-built mazes', () => {
  it('open board: field is exactly the rank distance to each edge, all 81 cells', () => {
    const empty = wallSetOf([]);
    expect(fieldMismatches(distanceField(empty, 'north'), (_x, y) => y)).toEqual([]);
    expect(fieldMismatches(distanceField(empty, 'south'), (_x, y) => 8 - y)).toEqual([]);
    expect(fieldMismatches(distanceField(empty, 'west'), (x) => x)).toEqual([]);
    expect(fieldMismatches(distanceField(empty, 'east'), (x) => 8 - x)).toEqual([]);
  });

  it('north goal, single-gap barrier (gap at column 8): detour distances exact', () => {
    // Above the barrier (y<=4): straight up = y.
    // Below (y>=5): walk to column 8, cross at (8,4)<->(8,5), then up = (8-x)+y.
    const field = distanceField(wallSetOf(NORTH_BARRIER), 'north');
    expect(fieldMismatches(field, (x, y) => (y <= 4 ? y : 8 - x + y))).toEqual([]);
  });

  it('south goal, single-gap barrier (gap at column 0): detour distances exact', () => {
    // Below the barrier (y>=5): 8-y. Above (y<=4): west to column 0 then down = x+(8-y).
    const field = distanceField(wallSetOf(SOUTH_BARRIER), 'south');
    expect(fieldMismatches(field, (x, y) => (y >= 5 ? 8 - y : x + (8 - y)))).toEqual([]);
  });

  it('west goal, single-gap barrier (gap at row 4): detour distances exact', () => {
    // Left of the barrier (x<=4): x. Right (x>=5): to (5,4), cross, 4 more west = x+|y-4|.
    const field = distanceField(wallSetOf(WEST_BARRIER), 'west');
    expect(fieldMismatches(field, (x, y) => (x <= 4 ? x : x + Math.abs(y - 4)))).toEqual([]);
  });

  it('east goal, single-gap barrier (gap at row 8): detour distances exact', () => {
    // Right of the barrier (x>=4): 8-x. Left (x<=3): to (3,8), cross, 4 east = 16-x-y.
    const field = distanceField(wallSetOf(EAST_BARRIER), 'east');
    expect(fieldMismatches(field, (x, y) => (x >= 4 ? 8 - x : 16 - x - y))).toEqual([]);
  });

  it('full serpentine to the east edge: all 81 distances match the hand-derived formula', () => {
    const field = distanceField(wallSetOf(SERPENTINE), 'east');
    expect(fieldMismatches(field, serpDist)).toEqual([]);
    // Spot checks of the formula itself, re-counted by hand:
    expect(field[0][0]).toBe(72); // (0,0): 8 down +1 +8 up +1 ... 8 crossings, 64 steps
    expect(field[8][0]).toBe(64); // (0,8) skips the first descent
    expect(field[0][7]).toBe(1); // (7,0) crosses the final gap immediately
    expect(field[4][3]).toBe(41); // (3,4): 4 up to (3,0) + 37
  });

  it('sealed 2x2 box is Infinity for every goal edge, and only the box', () => {
    const walls = wallSetOf(BOX);
    for (const goal of EDGES) {
      const field = distanceField(walls, goal);
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const inBox = BOX_CELLS.has(`${x},${y}`);
          if (inBox) {
            expect(field[y][x], `goal ${goal} cell (${x},${y}) should be sealed`).toBe(Infinity);
          } else {
            expect(
              Number.isFinite(field[y][x]),
              `goal ${goal} cell (${x},${y}) should be reachable`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it('cells hugging the sealed box pay the exact detour (goal north)', () => {
    const field = distanceField(wallSetOf(BOX), 'north');
    // (3,5): blocked straight up by h(3,4); 1 west to (2,5) then 5 up = 6.
    expect(field[5][3]).toBe(6);
    // (4,5): 1 east to (5,5) then 5 up = 6 (column 5 is fully open).
    expect(field[5][4]).toBe(6);
  });

  it('matches an independent reference BFS on seeded random wall sets (all 4 goals)', () => {
    for (const seed of [1, 7, 42, 1337, 90210, 424242]) {
      const walls = randomWallSet(seed, 18);
      const ws = wallSetOf(walls);
      for (const goal of EDGES) {
        expect(distanceField(ws, goal), `seed ${seed} goal ${goal}`).toEqual(
          refField(walls, goal),
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// hasPathToGoal + consistency with distanceField
// ---------------------------------------------------------------------------

describe('hasPathToGoal', () => {
  it('is true through the full serpentine and false only from sealed cells', () => {
    const serp = wallSetOf(SERPENTINE);
    expect(hasPathToGoal(serp, { x: 0, y: 0 }, 'east')).toBe(true);
    expect(hasPathToGoal(serp, { x: 0, y: 0 }, 'west')).toBe(true); // already on west edge

    const box = wallSetOf(BOX);
    for (const goal of EDGES) {
      expect(hasPathToGoal(box, { x: 3, y: 3 }, goal), `box (3,3) -> ${goal}`).toBe(false);
      expect(hasPathToGoal(box, { x: 4, y: 4 }, goal), `box (4,4) -> ${goal}`).toBe(false);
      expect(hasPathToGoal(box, { x: 5, y: 4 }, goal), `outside (5,4) -> ${goal}`).toBe(true);
    }
  });

  it('a cell sealed inside a pocket ON its goal edge still has a path (it is the goal)', () => {
    // h(0,0)+v(1,0) seal {(0,0),(1,0)} from the rest of the board.
    const walls = wallSetOf([
      { x: 0, y: 0, o: 'h' },
      { x: 1, y: 0, o: 'v' },
    ]);
    expect(hasPathToGoal(walls, { x: 0, y: 0 }, 'north')).toBe(true); // on the north edge
    expect(hasPathToGoal(walls, { x: 0, y: 0 }, 'west')).toBe(true); // on the west edge
    expect(hasPathToGoal(walls, { x: 0, y: 0 }, 'south')).toBe(false);
    expect(hasPathToGoal(walls, { x: 0, y: 0 }, 'east')).toBe(false);
    expect(hasPathToGoal(walls, { x: 1, y: 0 }, 'north')).toBe(true);
    expect(hasPathToGoal(walls, { x: 1, y: 0 }, 'west')).toBe(true); // pocket-mate (0,0) IS the west edge
    expect(hasPathToGoal(walls, { x: 1, y: 0 }, 'south')).toBe(false);
    expect(hasPathToGoal(walls, { x: 1, y: 0 }, 'east')).toBe(false);
  });

  it('agrees with distanceField finiteness for every cell, goal and wall set', () => {
    const sets: Wall[][] = [
      [],
      BOX,
      SERPENTINE,
      NORTH_BARRIER,
      [
        { x: 0, y: 0, o: 'h' },
        { x: 1, y: 0, o: 'v' },
      ],
      randomWallSet(99, 18),
      randomWallSet(555, 18),
    ];
    for (const walls of sets) {
      const ws = wallSetOf(walls);
      for (const goal of EDGES) {
        const field = distanceField(ws, goal);
        for (let y = 0; y < N; y++) {
          for (let x = 0; x < N; x++) {
            expect(
              hasPathToGoal(ws, { x, y }, goal),
              `walls[${walls.length}] goal ${goal} cell (${x},${y})`,
            ).toBe(Number.isFinite(field[y][x]));
          }
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// shortestPathLength
// ---------------------------------------------------------------------------

describe('shortestPathLength', () => {
  it('is 72 through the full serpentine and ignores pawns parked in the corridor', () => {
    const s = makeState(
      [
        { pos: { x: 0, y: 0 }, goal: 'east' },
        { pos: { x: 0, y: 1 }, goal: 'west' }, // sits right in player 0's forced corridor
      ],
      { walls: SERPENTINE },
    );
    expect(shortestPathLength(s, 0)).toBe(72);
    expect(shortestPathLength(s, 1)).toBe(0); // already on the west edge
  });

  it('returns Infinity for a sealed player', () => {
    const s = makeState(
      [
        { pos: { x: 3, y: 3 }, goal: 'north' },
        { pos: { x: 8, y: 0 }, goal: 'south' },
      ],
      { walls: BOX },
    );
    expect(shortestPathLength(s, 0)).toBe(Infinity);
    expect(shortestPathLength(s, 1)).toBe(8);
  });

  it('both 2p players pay the exact detour around a single-gap barrier', () => {
    // NORTH_BARRIER walls block rows 4|5 except column 8.
    const s = makeState(
      [
        { pos: { x: 4, y: 8 }, goal: 'north' },
        { pos: { x: 4, y: 0 }, goal: 'south' },
      ],
      { walls: NORTH_BARRIER },
    );
    expect(shortestPathLength(s, 0)).toBe(12); // (8-4)+8
    expect(shortestPathLength(s, 1)).toBe(12); // (8-4)+(8-0): same gap from the other side
  });
});

// ---------------------------------------------------------------------------
// bestAutoMove
// ---------------------------------------------------------------------------

describe('bestAutoMove', () => {
  it('takes the winning step onto the goal edge', () => {
    const s = makeState([
      { pos: { x: 4, y: 1 }, goal: 'north' },
      { pos: { x: 0, y: 8 }, goal: 'south' },
    ]);
    expect(bestAutoMove(s, 0)).toEqual({ x: 4, y: 0 });
  });

  it('4p east seat steps west from the start', () => {
    expect(bestAutoMove(createGame(4), 3)).toEqual({ x: 7, y: 4 });
  });

  it('picks the diagonal jump when it is strictly best', () => {
    // Me (4,4)->north, opponent at (4,3), wall h(4,2) blocks the straight jump.
    // Diagonals (3,3) [dist 3] and (5,3) [dist 4, its column is walled at rows 2|3];
    // side steps (3,4)=4, (5,4)=5, retreat (4,5)=6. Unique best: (3,3).
    const s = makeState(
      [
        { pos: { x: 4, y: 4 }, goal: 'north' },
        { pos: { x: 4, y: 3 }, goal: 'south' },
      ],
      { walls: [{ x: 4, y: 2, o: 'h' }] },
    );
    expect(bestAutoMove(s, 0)).toEqual({ x: 3, y: 3 });
  });

  it('crosses serpentine gaps instead of pacing the corridor', () => {
    // At (0,8) the gap to column 1 is open: (1,8) has dist 63 vs (0,7) at 65.
    const s1 = makeState(
      [
        { pos: { x: 0, y: 8 }, goal: 'east' },
        { pos: { x: 8, y: 8 }, goal: 'west' },
      ],
      { walls: SERPENTINE },
    );
    expect(bestAutoMove(s1, 0)).toEqual({ x: 1, y: 8 });

    // At (7,0) the final gap leads straight onto the east edge.
    const s2 = makeState(
      [
        { pos: { x: 7, y: 0 }, goal: 'east' },
        { pos: { x: 8, y: 8 }, goal: 'west' },
      ],
      { walls: SERPENTINE },
    );
    expect(bestAutoMove(s2, 0)).toEqual({ x: 8, y: 0 });
  });

  it('returns the least-bad move when every legal move increases the distance', () => {
    // Width-1 walled corridor in column 4 (rows 3-4 sealed east+west). Two pawns
    // ahead of me in a line: straight jump lands on the second pawn (forbidden),
    // both diagonals are walled. Only legal move is the retreat (4,5), whose
    // distance (5) is strictly worse than mine (4). Must return it, not null.
    const s = makeState(
      [
        { pos: { x: 4, y: 4 }, goal: 'north' },
        { pos: { x: 4, y: 3 }, goal: 'south' },
        { pos: { x: 4, y: 2 }, goal: 'south' },
      ],
      {
        walls: [
          { x: 3, y: 3, o: 'v' },
          { x: 4, y: 3, o: 'v' },
        ],
      },
    );
    expect(getLegalMoves(s, 0)).toEqual([{ x: 4, y: 5 }]); // precondition of this scenario
    expect(bestAutoMove(s, 0)).toEqual({ x: 4, y: 5 });
  });

  it('inside a sealed pocket (all distances Infinity) still moves, deterministically', () => {
    // (3,3) sealed in the BOX with goal north: legal moves are east (4,3) and
    // south (3,4), both Infinity. Documented tie-break = first in N/E/S/W order.
    const s = makeState(
      [
        { pos: { x: 3, y: 3 }, goal: 'north' },
        { pos: { x: 8, y: 0 }, goal: 'south' },
      ],
      { walls: BOX },
    );
    const first = bestAutoMove(s, 0);
    expect(first).toEqual({ x: 4, y: 3 });
    expect(bestAutoMove(s, 0)).toEqual(first); // repeat call: identical
  });

  it('is null only when there is no legal move at all', () => {
    const finished = makeState(
      [
        { pos: { x: 4, y: 0 }, goal: 'north' },
        { pos: { x: 4, y: 8 }, goal: 'south' },
      ],
      { status: 'finished', winner: 0 },
    );
    expect(bestAutoMove(finished, 1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checkWallPlacement / getLegalWallSlots path rule (driven by hasPathToGoal)
// ---------------------------------------------------------------------------

describe('wall placement path rule', () => {
  it('rejects the wall that seals the placing player, reporting the trapped seat', () => {
    const s = makeState(
      [
        { pos: { x: 3, y: 3 }, goal: 'north' },
        { pos: { x: 8, y: 0 }, goal: 'south' },
      ],
      { walls: ALMOST_BOX },
    );
    const check = checkWallPlacement(s, { x: 4, y: 3, o: 'v' });
    expect(check.legal).toBe(false);
    if (!check.legal) {
      expect(check.reason).toBe('WALL_BLOCKS_PATH');
      expect(check.trapped).toEqual([0]);
    }
  });

  it('rejects a wall that traps only the OPPONENT (official rule: every player keeps a path)', () => {
    const s = makeState(
      [
        { pos: { x: 0, y: 8 }, goal: 'north' },
        { pos: { x: 3, y: 3 }, goal: 'south' },
      ],
      { walls: ALMOST_BOX },
    );
    const check = checkWallPlacement(s, { x: 4, y: 3, o: 'v' });
    expect(check.legal).toBe(false);
    if (!check.legal) {
      expect(check.reason).toBe('WALL_BLOCKS_PATH');
      expect(check.trapped).toEqual([1]);
    }
  });

  it('reports BOTH trapped seats when one wall seals two pawns', () => {
    const s = makeState(
      [
        { pos: { x: 3, y: 3 }, goal: 'north' },
        { pos: { x: 4, y: 4 }, goal: 'south' },
      ],
      { walls: ALMOST_BOX },
    );
    const check = checkWallPlacement(s, { x: 4, y: 3, o: 'v' });
    expect(check.legal).toBe(false);
    if (!check.legal) {
      expect(check.reason).toBe('WALL_BLOCKS_PATH');
      expect(check.trapped).toEqual([0, 1]);
    }
  });

  it('allows a wall that merely forces a huge detour (one gap left open)', () => {
    // Three barrier walls already placed; the fourth leaves the column-8 gap.
    const s = makeState(
      [
        { pos: { x: 4, y: 8 }, goal: 'north' },
        { pos: { x: 4, y: 0 }, goal: 'south' },
      ],
      { walls: NORTH_BARRIER.slice(0, 3) },
    );
    expect(checkWallPlacement(s, { x: 6, y: 4, o: 'h' })).toEqual({ legal: true });
  });

  it('rejects sealing the 2p south player into a row-8 pocket', () => {
    // Pocket {(3..6, 8)}: h(3,7) and h(5,7) wall off the ceiling, v(2,7) the west
    // side; the candidate v(6,7) closes the east side.
    const s = makeState(
      [
        { pos: { x: 4, y: 8 }, goal: 'north' },
        { pos: { x: 4, y: 0 }, goal: 'south' },
      ],
      {
        walls: [
          { x: 3, y: 7, o: 'h' },
          { x: 5, y: 7, o: 'h' },
          { x: 2, y: 7, o: 'v' },
        ],
      },
    );
    const check = checkWallPlacement(s, { x: 6, y: 7, o: 'v' });
    expect(check.legal).toBe(false);
    if (!check.legal) {
      expect(check.reason).toBe('WALL_BLOCKS_PATH');
      expect(check.trapped).toEqual([0]);
    }
    // Direct hasPathToGoal cross-check with the hypothetical final wall set:
    const sealed = wallSetOf([...s.walls, { x: 6, y: 7, o: 'v' }]);
    expect(hasPathToGoal(sealed, { x: 4, y: 8 }, 'north')).toBe(false);
    expect(hasPathToGoal(sealed, { x: 2, y: 8 }, 'north')).toBe(true);
  });

  it('getLegalWallSlots is exactly the reference-legal set (bounds+conflicts+paths)', () => {
    const states = [
      makeState(
        [
          { pos: { x: 3, y: 3 }, goal: 'north' },
          { pos: { x: 8, y: 0 }, goal: 'south' },
        ],
        { walls: ALMOST_BOX },
      ),
      makeState(
        [
          { pos: { x: 4, y: 5 }, goal: 'north', wallsLeft: 3 },
          { pos: { x: 3, y: 2 }, goal: 'south', wallsLeft: 3 },
        ],
        {
          walls: [
            { x: 3, y: 4, o: 'h' },
            { x: 5, y: 1, o: 'v' },
            { x: 0, y: 0, o: 'h' },
            { x: 7, y: 6, o: 'v' },
          ],
        },
      ),
    ];
    for (const s of states) {
      const engine = new Set(getLegalWallSlots(s).map((w) => `${w.o}${w.x},${w.y}`));
      for (const o of ['h', 'v'] as const) {
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 8; x++) {
            const w: Wall = { x, y, o };
            let refLegal = !refConflict(s.walls as Wall[], w);
            if (refLegal) {
              const hypothetical = [...s.walls, w];
              refLegal = s.players.every(
                (p) => refField(hypothetical, p.goal)[p.pos.y][p.pos.x] !== Infinity,
              );
            }
            expect(engine.has(`${o}${x},${y}`), `slot ${o}(${x},${y})`).toBe(refLegal);
          }
        }
      }
    }
  });
});
