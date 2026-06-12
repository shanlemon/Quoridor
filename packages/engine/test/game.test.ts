import { describe, expect, it } from 'vitest';
import { applyAction, createGame, rankPlayers } from '../src/index';
import type { GameState } from '../src/index';
import { makeState } from './helpers';

function mustApply(state: GameState, action: Parameters<typeof applyAction>[1]): GameState {
  const res = applyAction(state, action);
  if (!res.ok) throw new Error(`expected ok, got ${res.error}`);
  return res.state;
}

describe('createGame', () => {
  it('2 players: north/south centers, 10 walls, opposite goals', () => {
    const s = createGame(2);
    expect(s.players).toHaveLength(2);
    expect(s.players[0]).toMatchObject({ pos: { x: 4, y: 8 }, goal: 'north', wallsLeft: 10 });
    expect(s.players[1]).toMatchObject({ pos: { x: 4, y: 0 }, goal: 'south', wallsLeft: 10 });
    expect(s.current).toBe(0);
    expect(s.turnSeq).toBe(0);
    expect(s.status).toBe('playing');
  });

  it('4 players: all four edge centers in clockwise order, 5 walls', () => {
    const s = createGame(4);
    expect(s.players.map((p) => p.pos)).toEqual([
      { x: 4, y: 8 },
      { x: 0, y: 4 },
      { x: 4, y: 0 },
      { x: 8, y: 4 },
    ]);
    expect(s.players.map((p) => p.goal)).toEqual(['north', 'east', 'south', 'west']);
    expect(s.players.every((p) => p.wallsLeft === 5)).toBe(true);
    expect(new Set(s.players.map((p) => p.character)).size).toBe(4);
  });

  it('3 players: 4p layout minus the east seat, 7 walls each', () => {
    const s = createGame(3);
    expect(s.players.map((p) => p.goal)).toEqual(['north', 'east', 'south']);
    expect(s.players.every((p) => p.wallsLeft === 7)).toBe(true);
  });

  it('supports a wall-count override and rejects bad values', () => {
    expect(createGame(2, { wallsPerPlayer: 3 }).players[0].wallsLeft).toBe(3);
    expect(() => createGame(2, { wallsPerPlayer: -1 })).toThrow(RangeError);
    expect(() => createGame(2, { wallsPerPlayer: 2.5 })).toThrow(RangeError);
    expect(() => createGame(5 as never)).toThrow(RangeError);
  });
});

describe('applyAction', () => {
  it('moves rotate turns and bump turnSeq; state is not mutated', () => {
    const s0 = createGame(2);
    const s1 = mustApply(s0, { type: 'move', to: { x: 4, y: 7 } });
    expect(s1.current).toBe(1);
    expect(s1.turnSeq).toBe(1);
    expect(s1.players[0].pos).toEqual({ x: 4, y: 7 });
    // original untouched
    expect(s0.players[0].pos).toEqual({ x: 4, y: 8 });
    expect(s0.turnSeq).toBe(0);

    const s2 = mustApply(s1, { type: 'move', to: { x: 4, y: 1 } });
    expect(s2.current).toBe(0);
    expect(s2.turnSeq).toBe(2);
  });

  it('rejects illegal moves: occupied, diagonal, too far, out of bounds', () => {
    const s = makeState([
      { pos: { x: 4, y: 4 }, goal: 'north' },
      { pos: { x: 4, y: 3 }, goal: 'south' },
    ]);
    for (const to of [
      { x: 4, y: 3 }, // occupied
      { x: 5, y: 5 }, // diagonal without jump
      { x: 4, y: 6 }, // two steps
      { x: 9, y: 4 }, // out of bounds
      { x: 4, y: 4 }, // own cell
    ]) {
      expect(applyAction(s, { type: 'move', to })).toEqual({ ok: false, error: 'ILLEGAL_MOVE' });
    }
  });

  it('wall placement decrements the wall count and advances the turn', () => {
    const s1 = mustApply(createGame(2), { type: 'wall', wall: { x: 3, y: 4, o: 'h' } });
    expect(s1.players[0].wallsLeft).toBe(9);
    expect(s1.players[1].wallsLeft).toBe(10);
    expect(s1.walls).toEqual([{ x: 3, y: 4, o: 'h' }]);
    expect(s1.current).toBe(1);
  });

  it('rejects wall placement with zero walls left', () => {
    const s = makeState([
      { pos: { x: 4, y: 8 }, goal: 'north', wallsLeft: 0 },
      { pos: { x: 4, y: 0 }, goal: 'south' },
    ]);
    expect(applyAction(s, { type: 'wall', wall: { x: 3, y: 4, o: 'h' } })).toEqual({
      ok: false,
      error: 'NO_WALLS_LEFT',
    });
  });

  it('rejects any action after the game is finished', () => {
    const s = makeState(
      [
        { pos: { x: 4, y: 0 }, goal: 'north' },
        { pos: { x: 4, y: 8 }, goal: 'south' },
      ],
      { status: 'finished', winner: 0 },
    );
    expect(applyAction(s, { type: 'move', to: { x: 4, y: 1 } })).toEqual({
      ok: false,
      error: 'GAME_OVER',
    });
    expect(applyAction(s, { type: 'pass' })).toEqual({ ok: false, error: 'GAME_OVER' });
  });
});

describe('win detection', () => {
  it.each([
    ['north', { x: 3, y: 1 }, { x: 3, y: 0 }],
    ['south', { x: 6, y: 7 }, { x: 6, y: 8 }],
    ['east', { x: 7, y: 2 }, { x: 8, y: 2 }],
    ['west', { x: 1, y: 6 }, { x: 0, y: 6 }],
  ] as const)('wins by reaching the %s edge', (goal, from, to) => {
    const s = makeState([
      { pos: from, goal },
      { pos: { x: 4, y: 4 }, goal: 'south' },
    ]);
    const res = applyAction(s, { type: 'move', to });
    if (!res.ok) throw new Error(res.error);
    expect(res.state.status).toBe('finished');
    expect(res.state.winner).toBe(0);
    expect(res.state.current).toBe(0); // turn does not advance past the winner
  });

  it('wins by jumping onto the goal edge', () => {
    const s = makeState([
      { pos: { x: 4, y: 2 }, goal: 'north' },
      { pos: { x: 4, y: 1 }, goal: 'south' },
    ]);
    const res = applyAction(s, { type: 'move', to: { x: 4, y: 0 } });
    if (!res.ok) throw new Error(res.error);
    expect(res.state.winner).toBe(0);
  });

  it('reaching a NON-goal edge does not win', () => {
    const s = makeState([
      { pos: { x: 4, y: 7 }, goal: 'north' },
      { pos: { x: 0, y: 0 }, goal: 'south' },
    ]);
    const res = applyAction(s, { type: 'move', to: { x: 4, y: 8 } }); // own start edge
    if (!res.ok) throw new Error(res.error);
    expect(res.state.status).toBe('playing');
  });
});

describe('pass', () => {
  // P0 has no legal MOVES (two pawns in a line block the jump, walls block every
  // diagonal and side step) but still has a PATH to goal, because pathfinding
  // ignores pawns. So the position is legal, yet P0 cannot move a pawn.
  const boxed = makeState(
    [
      { pos: { x: 4, y: 4 }, goal: 'north', wallsLeft: 0 },
      { pos: { x: 4, y: 3 }, goal: 'south' },
      { pos: { x: 4, y: 2 }, goal: 'south' },
    ],
    {
      walls: [
        { x: 3, y: 3, o: 'v' }, // blocks west step and west diagonal
        { x: 4, y: 3, o: 'v' }, // blocks east step and east diagonal
        { x: 3, y: 4, o: 'h' }, // blocks south step
      ],
    },
  );

  it('the boxed scenario really has no moves but keeps a path', () => {
    expect(applyAction(boxed, { type: 'move', to: { x: 4, y: 3 } }).ok).toBe(false);
  });

  it('is allowed only when no move and no wall is available', () => {
    const res = applyAction(boxed, { type: 'pass' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.state.current).toBe(1);
      expect(res.state.turnSeq).toBe(1);
    }
  });

  it('is rejected when a move exists', () => {
    expect(applyAction(createGame(2), { type: 'pass' })).toEqual({
      ok: false,
      error: 'PASS_NOT_ALLOWED',
    });
  });

  it('is rejected when only a wall placement exists', () => {
    const withWalls = {
      ...boxed,
      players: boxed.players.map((p, i) => (i === 0 ? { ...p, wallsLeft: 1 } : p)),
    };
    expect(applyAction(withWalls, { type: 'pass' })).toEqual({
      ok: false,
      error: 'PASS_NOT_ALLOWED',
    });
  });
});

describe('rankPlayers', () => {
  it('ranks the winner first, then by remaining distance with shared ties', () => {
    const s = makeState(
      [
        { pos: { x: 4, y: 3 }, goal: 'north' }, // dist 3
        { pos: { x: 4, y: 8 }, goal: 'south' }, // winner
        { pos: { x: 3, y: 3 }, goal: 'north' }, // dist 3
        { pos: { x: 4, y: 3 }, goal: 'south' }, // dist 5
      ],
      { status: 'finished', winner: 1 },
    );
    expect(rankPlayers(s)).toEqual([
      { seat: 1, rank: 1, distance: 0 },
      { seat: 0, rank: 2, distance: 3 },
      { seat: 2, rank: 2, distance: 3 },
      { seat: 3, rank: 4, distance: 5 },
    ]);
  });
});
