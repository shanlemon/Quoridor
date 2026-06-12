import { describe, expect, it } from 'vitest';
import {
  applyAction,
  checkWallPlacement,
  createGame,
  getLegalWallSlots,
  hasPathToGoal,
  wallConflicts,
  wallSetOf,
} from '../src/index';
import type { Wall } from '../src/index';
import { makeState } from './helpers';

const H = (x: number, y: number): Wall => ({ x, y, o: 'h' });
const V = (x: number, y: number): Wall => ({ x, y, o: 'v' });

describe('structural wall conflicts', () => {
  const placed = wallSetOf([H(3, 4)]);

  it('rejects the exact same slot', () => {
    expect(wallConflicts(placed, H(3, 4))).toBe(true);
  });

  it('rejects overlapping horizontal neighbors', () => {
    expect(wallConflicts(placed, H(2, 4))).toBe(true);
    expect(wallConflicts(placed, H(4, 4))).toBe(true);
  });

  it('rejects a crossing perpendicular wall at the same intersection', () => {
    expect(wallConflicts(placed, V(3, 4))).toBe(true);
  });

  it('allows end-to-end horizontal walls two slots apart', () => {
    expect(wallConflicts(placed, H(5, 4))).toBe(false);
    expect(wallConflicts(placed, H(1, 4))).toBe(false);
  });

  it('allows touching but non-crossing perpendicular walls', () => {
    expect(wallConflicts(placed, V(2, 4))).toBe(false);
    expect(wallConflicts(placed, V(4, 4))).toBe(false);
  });

  it('rejects overlapping vertical neighbors', () => {
    const vs = wallSetOf([V(3, 3)]);
    expect(wallConflicts(vs, V(3, 2))).toBe(true);
    expect(wallConflicts(vs, V(3, 4))).toBe(true);
    expect(wallConflicts(vs, V(3, 5))).toBe(false);
    expect(wallConflicts(vs, V(3, 1))).toBe(false);
    expect(wallConflicts(vs, H(3, 3))).toBe(true); // cross
  });
});

describe('wall bounds', () => {
  it('rejects out-of-range coordinates via applyAction', () => {
    for (const wall of [H(-1, 0), H(8, 0), H(0, -1), H(0, 8), V(8, 3)]) {
      const res = applyAction(createGame(2), { type: 'wall', wall });
      expect(res).toEqual({ ok: false, error: 'WALL_OUT_OF_BOUNDS' });
    }
  });
});

describe('path-blocking detection', () => {
  // Pocket: pawn at (0,0); h(0,0) seals the south side of (0,0)+(1,0);
  // v(1,0) would seal the east side of (1,0) — trapping the pawn entirely.
  const trapBase = makeState(
    [
      { pos: { x: 0, y: 0 }, goal: 'south' },
      { pos: { x: 8, y: 8 }, goal: 'north' },
    ],
    { walls: [H(0, 0)], current: 1 },
  );

  it('hasPathToGoal returns false for a sealed pocket', () => {
    const walls = wallSetOf([H(0, 0), V(1, 0)]);
    expect(hasPathToGoal(walls, { x: 0, y: 0 }, 'south')).toBe(false);
    expect(hasPathToGoal(walls, { x: 8, y: 8 }, 'north')).toBe(true);
  });

  it('hasPathToGoal is true when already standing on the goal edge', () => {
    expect(hasPathToGoal(wallSetOf([]), { x: 3, y: 8 }, 'south')).toBe(true);
  });

  it('rejects a wall that traps an OPPONENT and reports who', () => {
    const res = applyAction(trapBase, { type: 'wall', wall: V(1, 0) });
    expect(res).toEqual({ ok: false, error: 'WALL_BLOCKS_PATH' });
    const check = checkWallPlacement(trapBase, V(1, 0));
    expect(check.legal).toBe(false);
    if (!check.legal) expect(check.trapped).toEqual([0]);
  });

  it('rejects a wall that traps YOURSELF', () => {
    const selfTrap = { ...trapBase, current: 0 };
    const res = applyAction(selfTrap, { type: 'wall', wall: V(1, 0) });
    expect(res).toEqual({ ok: false, error: 'WALL_BLOCKS_PATH' });
  });

  it('accepts a nearby wall that does not trap anyone', () => {
    const res = applyAction(trapBase, { type: 'wall', wall: V(1, 1) });
    expect(res.ok).toBe(true);
  });
});

describe('getLegalWallSlots', () => {
  it('returns all 128 slots on an empty 2p board', () => {
    expect(getLegalWallSlots(createGame(2))).toHaveLength(128);
  });

  it('placing one wall removes exactly 4 slots (3 same-orientation + 1 cross)', () => {
    const res = applyAction(createGame(2), { type: 'wall', wall: H(3, 4) });
    if (!res.ok) throw new Error('setup failed');
    expect(getLegalWallSlots(res.state)).toHaveLength(124);
  });

  it('is empty when the player has no walls left', () => {
    const s = makeState([
      { pos: { x: 4, y: 8 }, goal: 'north', wallsLeft: 0 },
      { pos: { x: 4, y: 0 }, goal: 'south' },
    ]);
    expect(getLegalWallSlots(s, 0)).toEqual([]);
    const check = checkWallPlacement(s, H(3, 4), 0);
    expect(check.legal).toBe(false);
    if (!check.legal) expect(check.reason).toBe('NO_WALLS_LEFT');
  });

  it('is empty when the game is finished', () => {
    const s = makeState(
      [
        { pos: { x: 4, y: 0 }, goal: 'north' },
        { pos: { x: 4, y: 8 }, goal: 'south' },
      ],
      { status: 'finished', winner: 0 },
    );
    expect(getLegalWallSlots(s, 1)).toEqual([]);
  });
});
