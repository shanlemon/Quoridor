/**
 * Adversarial audit of wall placement legality (walls.ts) against the official
 * Quoridor rules. Every expectation below is hand-derived from the rules and
 * the documented coordinate system — NOT from the implementation.
 *
 * Coordinates: cells (x,y), x 0-8 west->east, y 0-8 north->south.
 * Wall (x,y,o), x,y in 0..7 at intersection (x,y):
 *   'h' blocks crossings between rows y/y+1 for columns x and x+1.
 *   'v' blocks crossings between columns x/x+1 for rows y and y+1.
 */
import { describe, expect, it } from 'vitest';
import {
  applyAction,
  checkWallPlacement,
  createGame,
  getLegalWallSlots,
  hasPathToGoal,
  shortestPathLength,
  wallConflicts,
  wallInBounds,
  wallSetOf,
} from '../src/index';
import type { GameState, Wall, WallCheck } from '../src/index';
import { makeState } from './helpers';

const H = (x: number, y: number): Wall => ({ x, y, o: 'h' });
const V = (x: number, y: number): Wall => ({ x, y, o: 'v' });

/** Neutral 2p state with pawns far from the action so only geometry matters. */
function neutral2p(walls: Wall[] = []): GameState {
  return makeState(
    [
      { pos: { x: 4, y: 8 }, goal: 'north' },
      { pos: { x: 4, y: 0 }, goal: 'south' },
    ],
    { walls },
  );
}

function reasonOf(check: WallCheck): string {
  return check.legal ? 'legal' : check.reason;
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------
describe('bounds', () => {
  const outOfBounds: Wall[] = [
    H(-1, 0), H(0, -1), H(-1, -1), H(8, 0), H(0, 8), H(8, 8), H(8, 7), H(7, 8),
    V(-1, 0), V(0, -1), V(8, 0), V(0, 8), V(8, 8), V(-1, -1), V(8, 7), V(7, 8),
  ];

  it('rejects every wall with x or y outside 0..7 (both orientations)', () => {
    const s = createGame(2);
    for (const w of outOfBounds) {
      expect(wallInBounds(w), JSON.stringify(w)).toBe(false);
      const check = checkWallPlacement(s, w);
      expect(reasonOf(check), JSON.stringify(w)).toBe('WALL_OUT_OF_BOUNDS');
      if (!check.legal) expect(check.trapped).toEqual([]);
      expect(applyAction(s, { type: 'wall', wall: w })).toEqual({
        ok: false,
        error: 'WALL_OUT_OF_BOUNDS',
      });
    }
  });

  it('accepts all four extreme in-bounds intersections, both orientations', () => {
    for (const w of [H(0, 0), H(7, 0), H(0, 7), H(7, 7), V(0, 0), V(7, 0), V(0, 7), V(7, 7)]) {
      expect(wallInBounds(w), JSON.stringify(w)).toBe(true);
      expect(reasonOf(checkWallPlacement(createGame(2), w)), JSON.stringify(w)).toBe('legal');
    }
  });
});

// ---------------------------------------------------------------------------
// Overlap / crossing geometry
// ---------------------------------------------------------------------------
describe('overlap geometry around an existing horizontal wall H(3,4)', () => {
  const base = neutral2p([H(3, 4)]);
  const set = wallSetOf([H(3, 4)]);

  it.each([
    [H(3, 4), 'same slot h/h'],
    [H(2, 4), 'h one slot west shares column 3 span'],
    [H(4, 4), 'h one slot east shares column 4 span'],
    [V(3, 4), 'v crossing at the same intersection'],
  ])('rejects %o (%s) as WALL_OVERLAPS', (w, _desc) => {
    expect(wallConflicts(set, w)).toBe(true);
    const check = checkWallPlacement(base, w);
    expect(reasonOf(check)).toBe('WALL_OVERLAPS');
    if (!check.legal) expect(check.trapped).toEqual([]);
  });

  it.each([
    [H(1, 4), 'end-to-end west, 2 apart'],
    [H(5, 4), 'end-to-end east, 2 apart'],
    [H(3, 3), 'parallel, adjacent row above'],
    [H(3, 5), 'parallel, adjacent row below'],
    [H(2, 3), 'diagonal neighbor NW'],
    [H(4, 3), 'diagonal neighbor NE'],
    [H(2, 5), 'diagonal neighbor SW'],
    [H(4, 5), 'diagonal neighbor SE'],
    [V(2, 4), 'perpendicular at neighboring intersection west'],
    [V(4, 4), 'perpendicular at neighboring intersection east'],
    [V(3, 3), 'T-junction: v ending on the h midpoint from above'],
    [V(3, 5), 'T-junction: v ending on the h midpoint from below'],
  ])('allows %o (%s)', (w, _desc) => {
    expect(wallConflicts(set, w)).toBe(false);
    expect(reasonOf(checkWallPlacement(base, w))).toBe('legal');
  });
});

describe('overlap geometry around an existing vertical wall V(5,2)', () => {
  const base = neutral2p([V(5, 2)]);
  const set = wallSetOf([V(5, 2)]);

  it.each([
    [V(5, 2), 'same slot v/v'],
    [V(5, 1), 'v one slot north shares row 2 span'],
    [V(5, 3), 'v one slot south shares row 3 span'],
    [H(5, 2), 'h crossing at the same intersection'],
  ])('rejects %o (%s) as WALL_OVERLAPS', (w, _desc) => {
    expect(wallConflicts(set, w)).toBe(true);
    expect(reasonOf(checkWallPlacement(base, w))).toBe('WALL_OVERLAPS');
  });

  it.each([
    [V(5, 0), 'end-to-end north, 2 apart'],
    [V(5, 4), 'end-to-end south, 2 apart'],
    [V(4, 2), 'parallel, adjacent column west'],
    [V(6, 2), 'parallel, adjacent column east'],
    [H(5, 1), 'perpendicular at neighboring intersection above'],
    [H(5, 3), 'perpendicular at neighboring intersection below'],
    [H(4, 2), 'T-junction: h ending on the v midpoint from the west'],
    [H(6, 2), 'T-junction: h ending on the v midpoint from the east'],
  ])('allows %o (%s)', (w, _desc) => {
    expect(wallConflicts(set, w)).toBe(false);
    expect(reasonOf(checkWallPlacement(base, w))).toBe('legal');
  });
});

// ---------------------------------------------------------------------------
// Trap rule: a wall is illegal iff it removes the LAST path of ANY player
// ---------------------------------------------------------------------------
describe('trap rule: far-away sealing wall (2p labyrinth)', () => {
  // h(0,1),h(2,1),h(4,1),h(6,1) block all row-1 -> row-2 crossings for
  // columns 0..7. Only escape from rows 0-1 is via column 8: (8,1)->(8,2).
  const rowWalls = [H(0, 1), H(2, 1), H(4, 1), H(6, 1)];
  // Pawn trapped at the far WEST corner; the sealing wall is at the far EAST.
  const s = makeState(
    [
      { pos: { x: 0, y: 0 }, goal: 'south' },
      { pos: { x: 4, y: 4 }, goal: 'north' },
    ],
    { walls: rowWalls },
  );

  it('rejects v(7,0), seven columns away from the pawn it seals in', () => {
    const check = checkWallPlacement(s, V(7, 0));
    expect(reasonOf(check)).toBe('WALL_BLOCKS_PATH');
    if (!check.legal) expect(check.trapped).toEqual([0]);
    expect(applyAction(s, { type: 'wall', wall: V(7, 0) })).toEqual({
      ok: false,
      error: 'WALL_BLOCKS_PATH',
    });
  });

  it('hasPathToGoal confirms the sealed pocket directly', () => {
    const sealed = wallSetOf([...rowWalls, V(7, 0)]);
    expect(hasPathToGoal(sealed, { x: 0, y: 0 }, 'south')).toBe(false);
    expect(hasPathToGoal(sealed, { x: 4, y: 4 }, 'north')).toBe(true);
  });

  it('one slot lower, v(7,1), leaves the (7,0)->(8,0) escape and is legal', () => {
    expect(reasonOf(checkWallPlacement(s, V(7, 1)))).toBe('legal');
  });

  it('any full-height cut of the 2-row pocket east of the pawn traps it', () => {
    const sMid = makeState(
      [
        { pos: { x: 4, y: 0 }, goal: 'south' },
        { pos: { x: 4, y: 8 }, goal: 'north' },
      ],
      { walls: rowWalls },
    );
    for (const w of [V(4, 0), V(5, 0), V(6, 0), V(7, 0)]) {
      const check = checkWallPlacement(sMid, w);
      expect(reasonOf(check), JSON.stringify(w)).toBe('WALL_BLOCKS_PATH');
      if (!check.legal) expect(check.trapped).toEqual([0]);
    }
    // West of the pawn the passage stays reachable -> legal.
    for (const w of [V(0, 0), V(1, 0), V(2, 0), V(3, 0)]) {
      expect(reasonOf(checkWallPlacement(sMid, w)), JSON.stringify(w)).toBe('legal');
    }
  });
});

describe('trap rule: walls that merely lengthen a path stay legal', () => {
  it('a wall row forcing a 12-step detour (from 8) is legal', () => {
    const s = makeState(
      [
        { pos: { x: 4, y: 8 }, goal: 'north' },
        { pos: { x: 4, y: 0 }, goal: 'south' },
      ],
      { walls: [H(0, 1), H(2, 1), H(4, 1)] },
    );
    // Cols 0-5 blocked at the rows-1/2 boundary; nearest open col is 6:
    // 2 lateral + 8 vertical = 10.
    expect(shortestPathLength(s, 1)).toBe(10);
    const res = applyAction(s, { type: 'wall', wall: H(6, 1) });
    expect(res.ok).toBe(true);
    if (res.ok) {
      // Only route now: into row 1, east to col 8, down: 1 + 4 + 7 = 12.
      expect(shortestPathLength(res.state, 1)).toBe(12);
      expect(res.state.status).toBe('playing');
    }
  });
});

describe('trap rule: third/fourth players and multi-trap reporting', () => {
  // NW 2x2 pocket = cells (0,0),(1,0),(0,1),(1,1).
  // h(0,1) seals its south side; v(1,0) seals its east side.
  it('4p: traps the WEST (goal east) and NORTH (goal south) players together', () => {
    const s = makeState(
      [
        { pos: { x: 4, y: 8 }, goal: 'north' }, // seat 0 south player
        { pos: { x: 1, y: 1 }, goal: 'east' }, // seat 1 west player, inside pocket
        { pos: { x: 0, y: 0 }, goal: 'south' }, // seat 2 north player, inside pocket
        { pos: { x: 8, y: 4 }, goal: 'west' }, // seat 3 east player
      ],
      { walls: [H(0, 1)], current: 0 },
    );
    const check = checkWallPlacement(s, V(1, 0));
    expect(reasonOf(check)).toBe('WALL_BLOCKS_PATH');
    if (!check.legal) expect([...check.trapped].sort()).toEqual([1, 2]);
    expect(applyAction(s, { type: 'wall', wall: V(1, 0) })).toEqual({
      ok: false,
      error: 'WALL_BLOCKS_PATH',
    });
  });

  it('4p: same wall is legal when the pocket players can still reach goals inside it', () => {
    const s = makeState(
      [
        { pos: { x: 4, y: 8 }, goal: 'north' },
        { pos: { x: 1, y: 1 }, goal: 'north' }, // pocket contains row 0 -> fine
        { pos: { x: 0, y: 0 }, goal: 'west' }, // already standing on x=0 -> fine
        { pos: { x: 8, y: 4 }, goal: 'west' },
      ],
      { walls: [H(0, 1)], current: 0 },
    );
    expect(reasonOf(checkWallPlacement(s, V(1, 0)))).toBe('legal');
  });

  it('sealing an EMPTY pocket is legal', () => {
    const s = makeState(
      [
        { pos: { x: 4, y: 8 }, goal: 'north' },
        { pos: { x: 4, y: 0 }, goal: 'south' },
      ],
      { walls: [H(0, 1)] },
    );
    expect(reasonOf(checkWallPlacement(s, V(1, 0)))).toBe('legal');
  });

  it('3p: traps only the WEST player in a side pocket, trapped=[1]', () => {
    // Pocket {(0,4),(1,4)}: h(0,3) above, h(0,4) below, v(1,3) seals the east.
    const s = makeState(
      [
        { pos: { x: 4, y: 8 }, goal: 'north', wallsLeft: 7 },
        { pos: { x: 0, y: 4 }, goal: 'east', wallsLeft: 7 },
        { pos: { x: 4, y: 0 }, goal: 'south', wallsLeft: 7 },
      ],
      { walls: [H(0, 3), H(0, 4)], current: 2 },
    );
    const check = checkWallPlacement(s, V(1, 3));
    expect(reasonOf(check)).toBe('WALL_BLOCKS_PATH');
    if (!check.legal) expect(check.trapped).toEqual([1]);
    // One slot lower leaves (1,4)->(2,4) open -> legal.
    expect(reasonOf(checkWallPlacement(s, V(1, 5)))).toBe('legal');
  });

  it('rejects trapping YOURSELF (current player) too', () => {
    const s = makeState(
      [
        { pos: { x: 0, y: 0 }, goal: 'south' },
        { pos: { x: 4, y: 4 }, goal: 'north' },
      ],
      { walls: [H(0, 1)], current: 0 },
    );
    const res = applyAction(s, { type: 'wall', wall: V(1, 0) });
    expect(res).toEqual({ ok: false, error: 'WALL_BLOCKS_PATH' });
  });
});

describe('trap rule near the south-east edges (walls spanning row/column 8)', () => {
  // SE 2x2 pocket = cells (7,7),(8,7),(7,8),(8,8).
  // h(7,6) blocks (7,6)-(7,7) AND (8,6)-(8,7) (its span covers column 8).
  // v(6,7) blocks (6,7)-(7,7) AND (6,8)-(7,8) (its span covers row 8).
  it('h then v: the v wall seals the corner and is rejected', () => {
    const s = makeState(
      [
        { pos: { x: 8, y: 8 }, goal: 'north' },
        { pos: { x: 4, y: 4 }, goal: 'south' },
      ],
      { walls: [H(7, 6)] },
    );
    const check = checkWallPlacement(s, V(6, 7));
    expect(reasonOf(check)).toBe('WALL_BLOCKS_PATH');
    if (!check.legal) expect(check.trapped).toEqual([0]);
  });

  it('v then h: same pocket, opposite placement order', () => {
    const s = makeState(
      [
        { pos: { x: 7, y: 8 }, goal: 'west' },
        { pos: { x: 4, y: 4 }, goal: 'south' },
      ],
      { walls: [V(6, 7)] },
    );
    const check = checkWallPlacement(s, H(7, 6));
    expect(reasonOf(check)).toBe('WALL_BLOCKS_PATH');
    if (!check.legal) expect(check.trapped).toEqual([0]);
  });
});

// ---------------------------------------------------------------------------
// getLegalWallSlots — independently counted
// ---------------------------------------------------------------------------
describe('getLegalWallSlots counts (hand-counted)', () => {
  it('empty 2p board: 8*8*2 = 128 slots', () => {
    expect(getLegalWallSlots(createGame(2))).toHaveLength(128);
  });

  it('corner wall H(0,0) removes only 3 slots (one neighbor is off-board): 125', () => {
    const res = applyAction(createGame(2), { type: 'wall', wall: H(0, 0) });
    if (!res.ok) throw new Error('setup failed');
    // Removed: h(0,0) itself, h(1,0), v(0,0). h(-1,0) does not exist.
    expect(getLegalWallSlots(res.state)).toHaveLength(125);
  });

  it('corner wall V(7,7) removes only 3 slots: 125', () => {
    const res = applyAction(createGame(2), { type: 'wall', wall: V(7, 7) });
    if (!res.ok) throw new Error('setup failed');
    // Removed: v(7,7), v(7,6), h(7,7). v(7,8) does not exist.
    expect(getLegalWallSlots(res.state)).toHaveLength(125);
  });

  it('mid-board V(3,3) removes 4 slots: 124', () => {
    const res = applyAction(createGame(2), { type: 'wall', wall: V(3, 3) });
    if (!res.ok) throw new Error('setup failed');
    // Removed: v(3,3), v(3,2), v(3,4), h(3,3).
    expect(getLegalWallSlots(res.state)).toHaveLength(124);
  });

  it('pocketed pawn: H(0,0) + pawn at (0,0): 128 - 3 structural - 1 trap = 124', () => {
    const s = makeState(
      [
        { pos: { x: 0, y: 0 }, goal: 'south' },
        { pos: { x: 8, y: 8 }, goal: 'north' },
      ],
      { walls: [H(0, 0)] },
    );
    // Structural: h(0,0), h(1,0), v(0,0). Trap: v(1,0) seals {(0,0),(1,0)}.
    const slots = getLegalWallSlots(s, 0);
    expect(slots).toHaveLength(124);
    expect(slots.some((w) => w.o === 'v' && w.x === 1 && w.y === 0)).toBe(false);
  });

  it('labyrinth: 4 row-walls + pawn at (4,0): 128 - 12 structural - 4 traps = 112', () => {
    const s = makeState(
      [
        { pos: { x: 4, y: 8 }, goal: 'north' },
        { pos: { x: 4, y: 0 }, goal: 'south' },
      ],
      { walls: [H(0, 1), H(2, 1), H(4, 1), H(6, 1)] },
    );
    // Structural (12): h(0..7,1) [8] + v(0,1),v(2,1),v(4,1),v(6,1) [4].
    // Traps (4): v(4,0),v(5,0),v(6,0),v(7,0) — each cuts the 2-row pocket
    // between the pawn (col 4) and the only exit at column 8.
    const slots = getLegalWallSlots(s, 0);
    expect(slots).toHaveLength(112);
    for (const x of [4, 5, 6, 7]) {
      expect(
        slots.some((w) => w.o === 'v' && w.x === x && w.y === 0),
        `v(${x},0) must be excluded`,
      ).toBe(false);
    }
    for (const x of [0, 1, 2, 3]) {
      expect(
        slots.some((w) => w.o === 'v' && w.x === x && w.y === 0),
        `v(${x},0) must be included`,
      ).toBe(true);
    }
  });

  it('every slot returned by getLegalWallSlots is individually legal and vice versa', () => {
    const s = makeState(
      [
        { pos: { x: 4, y: 8 }, goal: 'north' },
        { pos: { x: 4, y: 0 }, goal: 'south' },
      ],
      { walls: [H(0, 1), H(2, 1), H(4, 1), H(6, 1)] },
    );
    const listed = new Set(getLegalWallSlots(s, 0).map((w) => `${w.o}${w.x},${w.y}`));
    for (const o of ['h', 'v'] as const) {
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const legal = checkWallPlacement(s, { x, y, o }, 0).legal;
          expect(listed.has(`${o}${x},${y}`), `${o}(${x},${y})`).toBe(legal);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Wall exhaustion: place all 10, then NO_WALLS_LEFT
// ---------------------------------------------------------------------------
describe('wall exhaustion over a real game', () => {
  it('player 0 places all 10 walls via applyAction; the 11th fails NO_WALLS_LEFT', () => {
    // Non-conflicting, never-trapping walls (column 8 corridor always open).
    const tenWalls = [
      H(0, 0), H(2, 0), H(4, 0), H(6, 0),
      H(0, 2), H(2, 2), H(4, 2), H(6, 2),
      H(0, 4), H(2, 4),
    ];
    let s = createGame(2); // p0 at (4,8) goal north, p1 at (4,0) goal south
    let p1AtStart = true; // p1 oscillates (4,0) <-> (3,0)
    for (const wall of tenWalls) {
      const wr = applyAction(s, { type: 'wall', wall });
      expect(wr.ok, `wall ${JSON.stringify(wall)} should be legal`).toBe(true);
      if (!wr.ok) return;
      s = wr.state;
      const to = p1AtStart ? { x: 3, y: 0 } : { x: 4, y: 0 };
      const mr = applyAction(s, { type: 'move', to });
      expect(mr.ok, `p1 move to ${JSON.stringify(to)} should be legal`).toBe(true);
      if (!mr.ok) return;
      s = mr.state;
      p1AtStart = !p1AtStart;
    }
    expect(s.players[0].wallsLeft).toBe(0);
    expect(s.players[1].wallsLeft).toBe(10);
    expect(s.walls).toHaveLength(10);
    expect(s.current).toBe(0);

    // 11th wall: a perfectly placeable slot, refused only for lack of walls.
    const check = checkWallPlacement(s, H(4, 4), 0);
    expect(reasonOf(check)).toBe('NO_WALLS_LEFT');
    if (!check.legal) expect(check.trapped).toEqual([]);
    expect(applyAction(s, { type: 'wall', wall: H(4, 4) })).toEqual({
      ok: false,
      error: 'NO_WALLS_LEFT',
    });
    expect(getLegalWallSlots(s, 0)).toEqual([]);
    // The opponent still has all 10 walls and plenty of slots.
    expect(getLegalWallSlots(s, 1).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// API hygiene around the checks
// ---------------------------------------------------------------------------
describe('check side effects', () => {
  it('checkWallPlacement never mutates the input state', () => {
    const walls = [H(0, 1)];
    const s = makeState(
      [
        { pos: { x: 0, y: 0 }, goal: 'south' },
        { pos: { x: 4, y: 4 }, goal: 'north' },
      ],
      { walls },
    );
    checkWallPlacement(s, V(1, 0)); // illegal (trap)
    checkWallPlacement(s, V(5, 5)); // legal
    expect(s.walls).toHaveLength(1);
    expect(s.walls[0]).toEqual(H(0, 1));
    expect(s.players[0].pos).toEqual({ x: 0, y: 0 });
  });

  it('failed wall actions leave applyAction input usable (original unchanged)', () => {
    const s = neutral2p([H(3, 4)]);
    const bad = applyAction(s, { type: 'wall', wall: H(3, 4) });
    expect(bad.ok).toBe(false);
    const good = applyAction(s, { type: 'wall', wall: H(0, 0) });
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.state.walls).toHaveLength(2);
      expect(s.walls).toHaveLength(1);
    }
  });
});
