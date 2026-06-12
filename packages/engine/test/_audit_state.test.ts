/**
 * Adversarial audit: game state machine (createGame, applyAction, rankPlayers).
 *
 * Every expectation below is hand-derived from the official Quoridor rules
 * (Gigamic) + the documented project decisions; nothing is copied from the
 * implementation.
 *
 * Coordinates: (x,y), x 0-8 left-to-right, y 0-8 top-to-bottom.
 * north = y0, south = y8, west = x0, east = x8.
 * Wall (x,y,'h') blocks rows y/y+1 for columns x and x+1.
 * Wall (x,y,'v') blocks columns x/x+1 for rows y and y+1.
 */
import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  getLegalMoves,
  getLegalWallSlots,
  rankPlayers,
} from '../src/index';
import type { Action, GameState } from '../src/index';
import { makeState } from './helpers';

function mustApply(state: GameState, action: Action): GameState {
  const res = applyAction(state, action);
  if (!res.ok) throw new Error(`expected ok, got ${res.error}`);
  return res.state;
}

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const value of Object.values(obj as object)) deepFreeze(value);
  }
  return obj;
}

const snap = (s: GameState): string => JSON.stringify(s);

/**
 * P0 (seat 0, current) sits on the west edge with NO legal pawn move but every
 * player keeps a path to goal (pathfinding ignores pawns).
 *
 * P0 at (0,4), goal east.
 *  - west: off board.
 *  - north (0,3): pawn P1. Straight jump to (0,2) blocked by h(0,2)
 *    (blocks rows 2/3, cols 0-1). Diagonals beside P1: (-1,3) off board,
 *    (1,3) blocked by v(0,3) (blocks cols 0/1, rows 3-4).
 *  - east (1,4): blocked by v(0,3) (row 4 span).
 *  - south (0,5): pawn P2. Straight jump to (0,6) blocked by h(0,5)
 *    (blocks rows 5/6, cols 0-1). Diagonals beside P2: (-1,5) off board,
 *    (1,5) occupied by P3.
 * Path check (pawns ignored): P0 (0,4)->(0,5)->(1,5)->... east edge reachable.
 */
function boxedWestState(wallsLeftP0: number): GameState {
  return makeState(
    [
      { pos: { x: 0, y: 4 }, goal: 'east', wallsLeft: wallsLeftP0 },
      { pos: { x: 0, y: 3 }, goal: 'south' },
      { pos: { x: 0, y: 5 }, goal: 'north' },
      { pos: { x: 1, y: 5 }, goal: 'south' },
    ],
    {
      walls: [
        { x: 0, y: 2, o: 'h' },
        { x: 0, y: 3, o: 'v' },
        { x: 0, y: 5, o: 'h' },
      ],
    },
  );
}

describe('audit: createGame layouts', () => {
  it('2p: south/north edge centers, opposite goals, 10 walls, clean initial fields', () => {
    const s = createGame(2);
    expect(s.players).toHaveLength(2);
    expect(s.players[0]).toEqual({
      seat: 0,
      character: 'mochi',
      pos: { x: 4, y: 8 },
      wallsLeft: 10,
      goal: 'north',
    });
    expect(s.players[1]).toEqual({
      seat: 1,
      character: 'pebble',
      pos: { x: 4, y: 0 },
      wallsLeft: 10,
      goal: 'south',
    });
    expect(s.walls).toEqual([]);
    expect(s.current).toBe(0);
    expect(s.turnSeq).toBe(0);
    expect(s.status).toBe('playing');
    expect(s.winner).toBeNull();
  });

  it('3p: 4p layout minus east seat, 7 walls each, goals opposite each start', () => {
    const s = createGame(3);
    expect(s.players.map((p) => p.pos)).toEqual([
      { x: 4, y: 8 },
      { x: 0, y: 4 },
      { x: 4, y: 0 },
    ]);
    expect(s.players.map((p) => p.goal)).toEqual(['north', 'east', 'south']);
    expect(s.players.map((p) => p.wallsLeft)).toEqual([7, 7, 7]);
    expect(s.players.map((p) => p.seat)).toEqual([0, 1, 2]);
    expect(s.players.map((p) => p.character)).toEqual(['mochi', 'pebble', 'biscuit']);
  });

  it('4p: all four edge centers clockwise (S,W,N,E), opposite goals, 5 walls each', () => {
    const s = createGame(4);
    expect(s.players.map((p) => p.pos)).toEqual([
      { x: 4, y: 8 },
      { x: 0, y: 4 },
      { x: 4, y: 0 },
      { x: 8, y: 4 },
    ]);
    expect(s.players.map((p) => p.goal)).toEqual(['north', 'east', 'south', 'west']);
    expect(s.players.map((p) => p.wallsLeft)).toEqual([5, 5, 5, 5]);
    expect(s.players.map((p) => p.character)).toEqual(['mochi', 'pebble', 'biscuit', 'tofu']);
    // every player's goal is the edge opposite their start
    expect(s.players[0].pos.y).toBe(8); // starts south, goal north
    expect(s.players[3].pos.x).toBe(8); // starts east, goal west
  });

  it('rejects invalid player counts and wall overrides', () => {
    expect(() => createGame(1 as never)).toThrow(RangeError);
    expect(() => createGame(5 as never)).toThrow(RangeError);
    expect(() => createGame(2, { wallsPerPlayer: -1 })).toThrow(RangeError);
    expect(() => createGame(2, { wallsPerPlayer: 1.5 })).toThrow(RangeError);
    expect(() => createGame(2, { wallsPerPlayer: NaN })).toThrow(RangeError);
    expect(() => createGame(2, { wallsPerPlayer: Infinity })).toThrow(RangeError);
    // zero is a valid edge value (pure race)
    expect(createGame(2, { wallsPerPlayer: 0 }).players.map((p) => p.wallsLeft)).toEqual([0, 0]);
  });
});

describe('audit: clockwise turn rotation and turnSeq', () => {
  it('4p: current cycles 0->1->2->3->0 across moves AND wall placements, turnSeq +1 each', () => {
    let s = createGame(4);
    // four pawn moves, one per seat
    const moves: Action[] = [
      { type: 'move', to: { x: 4, y: 7 } }, // P0 south seat steps north
      { type: 'move', to: { x: 1, y: 4 } }, // P1 west seat steps east
      { type: 'move', to: { x: 4, y: 1 } }, // P2 north seat steps south
      { type: 'move', to: { x: 7, y: 4 } }, // P3 east seat steps west
    ];
    const expectedCurrent = [1, 2, 3, 0];
    moves.forEach((a, i) => {
      s = mustApply(s, a);
      expect(s.current).toBe(expectedCurrent[i]);
      expect(s.turnSeq).toBe(i + 1);
    });
    // four wall placements, one per seat (row 6/7 boundary, column 8 stays open)
    const walls: Action[] = [
      { type: 'wall', wall: { x: 0, y: 6, o: 'h' } },
      { type: 'wall', wall: { x: 2, y: 6, o: 'h' } },
      { type: 'wall', wall: { x: 4, y: 6, o: 'h' } },
      { type: 'wall', wall: { x: 6, y: 6, o: 'h' } },
    ];
    walls.forEach((a, i) => {
      s = mustApply(s, a);
      expect(s.current).toBe(expectedCurrent[i]);
      expect(s.turnSeq).toBe(5 + i);
    });
    expect(s.turnSeq).toBe(8);
    expect(s.current).toBe(0);
    expect(s.players.map((p) => p.wallsLeft)).toEqual([4, 4, 4, 4]);
    expect(s.walls).toHaveLength(4);
    expect(s.status).toBe('playing');
  });

  it('3p: current cycles 0->1->2->0', () => {
    let s = createGame(3);
    s = mustApply(s, { type: 'move', to: { x: 4, y: 7 } });
    expect(s.current).toBe(1);
    s = mustApply(s, { type: 'move', to: { x: 1, y: 4 } });
    expect(s.current).toBe(2);
    s = mustApply(s, { type: 'move', to: { x: 4, y: 1 } });
    expect(s.current).toBe(0);
    expect(s.turnSeq).toBe(3);
  });

  it('rejected actions leave current, turnSeq and the whole state untouched', () => {
    const s = createGame(2);
    const before = snap(s);
    const rejected: Array<[Action, string]> = [
      [{ type: 'move', to: { x: 4, y: 6 } }, 'ILLEGAL_MOVE'], // two steps
      [{ type: 'move', to: { x: 5, y: 7 } }, 'ILLEGAL_MOVE'], // diagonal
      [{ type: 'wall', wall: { x: 8, y: 0, o: 'h' } }, 'WALL_OUT_OF_BOUNDS'],
      [{ type: 'wall', wall: { x: -1, y: 3, o: 'v' } }, 'WALL_OUT_OF_BOUNDS'],
      [{ type: 'pass' }, 'PASS_NOT_ALLOWED'],
    ];
    for (const [action, error] of rejected) {
      expect(applyAction(s, action)).toEqual({ ok: false, error });
      expect(snap(s)).toBe(before);
      expect(s.turnSeq).toBe(0);
      expect(s.current).toBe(0);
    }
  });
});

describe('audit: deep immutability', () => {
  it('move on a deeply frozen state succeeds and never mutates the input', () => {
    const s0 = deepFreeze(createGame(2));
    const before = snap(s0);
    const s1 = mustApply(s0, { type: 'move', to: { x: 4, y: 7 } });
    expect(snap(s0)).toBe(before);
    expect(s1).not.toBe(s0);
    expect(s0.players[0].pos).toEqual({ x: 4, y: 8 });
    expect(s0.current).toBe(0);
    expect(s0.turnSeq).toBe(0);
    expect(s1.players[0].pos).toEqual({ x: 4, y: 7 });
  });

  it('wall placement on a deeply frozen state succeeds and never mutates the input', () => {
    const s0 = deepFreeze(createGame(2));
    const before = snap(s0);
    const s1 = mustApply(s0, { type: 'wall', wall: { x: 3, y: 4, o: 'h' } });
    expect(snap(s0)).toBe(before);
    expect(s0.walls).toHaveLength(0);
    expect(s0.players[0].wallsLeft).toBe(10);
    expect(s1.walls).toEqual([{ x: 3, y: 4, o: 'h' }]);
    expect(s1.players[0].wallsLeft).toBe(9);
    expect(s1.players[1].wallsLeft).toBe(10);
  });

  it('pass on a deeply frozen state succeeds and never mutates the input', () => {
    const s0 = deepFreeze(boxedWestState(0));
    const before = snap(s0);
    const s1 = mustApply(s0, { type: 'pass' });
    expect(snap(s0)).toBe(before);
    expect(s1.current).toBe(1);
    expect(s1.turnSeq).toBe(1);
  });

  it('rejected actions on a deeply frozen state do not throw or mutate', () => {
    const s0 = deepFreeze(createGame(2));
    const before = snap(s0);
    expect(applyAction(s0, { type: 'move', to: { x: 0, y: 0 } }).ok).toBe(false);
    expect(applyAction(s0, { type: 'pass' }).ok).toBe(false);
    expect(snap(s0)).toBe(before);
  });

  it('a winning move does not mutate the pre-win state at any nesting level', () => {
    const s0 = deepFreeze(
      makeState([
        { pos: { x: 2, y: 1 }, goal: 'north' },
        { pos: { x: 6, y: 6 }, goal: 'south' },
      ]),
    );
    const before = snap(s0);
    const s1 = mustApply(s0, { type: 'move', to: { x: 2, y: 0 } });
    expect(snap(s0)).toBe(before);
    expect(s0.status).toBe('playing');
    expect(s0.winner).toBeNull();
    expect(s1.status).toBe('finished');
  });
});

describe('audit: win detection on every edge', () => {
  it.each([
    ['north', { x: 2, y: 1 }, { x: 2, y: 0 }],
    ['south', { x: 7, y: 7 }, { x: 7, y: 8 }],
    ['east', { x: 7, y: 5 }, { x: 8, y: 5 }],
    ['west', { x: 1, y: 3 }, { x: 0, y: 3 }],
  ] as const)('goal %s: stepping onto the edge finishes the game for seat 0', (goal, from, to) => {
    const s = makeState([
      { pos: from, goal },
      { pos: { x: 6, y: 6 }, goal: 'south' },
    ]);
    const res = applyAction(s, { type: 'move', to });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.state.status).toBe('finished');
      expect(res.state.winner).toBe(0);
      expect(res.state.current).toBe(0); // winner keeps current
      expect(res.state.turnSeq).toBe(1); // win still bumps the sequence
      expect(res.state.players[0].pos).toEqual(to);
    }
  });

  it('a corner cell counts as the goal edge', () => {
    const s = makeState([
      { pos: { x: 0, y: 1 }, goal: 'north' },
      { pos: { x: 6, y: 6 }, goal: 'south' },
    ]);
    const res = applyAction(s, { type: 'move', to: { x: 0, y: 0 } });
    expect(res.ok && res.state.winner === 0).toBe(true);
  });

  it('a non-seat-0 player wins for themselves: winner and current = their seat (4p)', () => {
    const s = makeState(
      [
        { pos: { x: 4, y: 4 }, goal: 'north' },
        { pos: { x: 1, y: 1 }, goal: 'east' },
        { pos: { x: 6, y: 7 }, goal: 'south' },
        { pos: { x: 7, y: 2 }, goal: 'west' },
      ],
      { current: 2 },
    );
    const res = applyAction(s, { type: 'move', to: { x: 6, y: 8 } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.state.status).toBe('finished');
      expect(res.state.winner).toBe(2);
      expect(res.state.current).toBe(2);
    }
  });

  it.each([
    // goal north, stepping onto the WEST edge: not a win
    ['west edge with north goal', { x: 1, y: 4 }, { x: 0, y: 4 }, 'north'],
    // goal east, stepping onto the SOUTH edge: not a win
    ['south edge with east goal', { x: 4, y: 7 }, { x: 4, y: 8 }, 'east'],
    // goal north, stepping back onto own start (south) edge: not a win
    ['own start edge with north goal', { x: 2, y: 7 }, { x: 2, y: 8 }, 'north'],
  ] as const)('reaching a wrong edge does not win: %s', (_label, from, to, goal) => {
    const s = makeState([
      { pos: from, goal },
      { pos: { x: 7, y: 0 }, goal: 'south' },
    ]);
    const res = applyAction(s, { type: 'move', to });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.state.status).toBe('playing');
      expect(res.state.winner).toBeNull();
      expect(res.state.current).toBe(1); // turn advances normally
    }
  });
});

describe('audit: everything is rejected after the game finishes', () => {
  // build a genuinely finished game through the API
  const finished = mustApply(
    makeState([
      { pos: { x: 3, y: 1 }, goal: 'north' },
      { pos: { x: 5, y: 7 }, goal: 'south' },
    ]),
    { type: 'move', to: { x: 3, y: 0 } },
  );

  it('the finished state looks right', () => {
    expect(finished.status).toBe('finished');
    expect(finished.winner).toBe(0);
    expect(finished.current).toBe(0);
  });

  it.each([
    [{ type: 'move', to: { x: 3, y: 1 } } as Action],
    [{ type: 'wall', wall: { x: 3, y: 3, o: 'h' } } as Action],
    [{ type: 'pass' } as Action],
  ])('rejects %j with GAME_OVER and leaves the state untouched', (action) => {
    const before = snap(finished);
    expect(applyAction(finished, action)).toEqual({ ok: false, error: 'GAME_OVER' });
    expect(snap(finished)).toBe(before);
  });

  it('legal-move / legal-wall queries are empty after the finish', () => {
    expect(getLegalMoves(finished, 0)).toEqual([]);
    expect(getLegalMoves(finished, 1)).toEqual([]);
    expect(getLegalWallSlots(finished, 1)).toEqual([]);
  });
});

describe('audit: pass legality (own boxed-on-the-edge scenario)', () => {
  it('the boxed player really has zero legal moves', () => {
    const s = boxedWestState(0);
    expect(getLegalMoves(s, 0)).toEqual([]);
    // and a sample of plausible destinations is all rejected
    for (const to of [
      { x: 0, y: 3 }, // occupied
      { x: 0, y: 5 }, // occupied
      { x: 1, y: 4 }, // walled off (v 0,3)
      { x: 0, y: 2 }, // straight jump blocked by h(0,2)
      { x: 0, y: 6 }, // straight jump blocked by h(0,5)
      { x: 1, y: 3 }, // diagonal blocked by v(0,3)
      { x: 1, y: 5 }, // diagonal occupied
    ]) {
      expect(applyAction(s, { type: 'move', to })).toEqual({ ok: false, error: 'ILLEGAL_MOVE' });
    }
  });

  it('pass is legal with no moves and no walls left; turn advances, nothing else changes', () => {
    const s = boxedWestState(0);
    const res = applyAction(s, { type: 'pass' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.state.current).toBe(1);
      expect(res.state.turnSeq).toBe(1);
      expect(res.state.status).toBe('playing');
      expect(res.state.winner).toBeNull();
      expect(res.state.players).toEqual(s.players); // pawns and wall counts untouched
      expect(res.state.walls).toEqual(s.walls);
    }
  });

  it('pass is rejected when the boxed player still holds a wall (a wall move exists)', () => {
    const s = boxedWestState(1);
    expect(getLegalWallSlots(s, 0).length).toBeGreaterThan(0);
    expect(applyAction(s, { type: 'pass' })).toEqual({ ok: false, error: 'PASS_NOT_ALLOWED' });
  });

  it('pass is rejected whenever a pawn move exists, even with zero walls', () => {
    const s = createGame(2, { wallsPerPlayer: 0 });
    expect(applyAction(s, { type: 'pass' })).toEqual({ ok: false, error: 'PASS_NOT_ALLOWED' });
  });

  it('wall action by the boxed player with zero walls reports NO_WALLS_LEFT', () => {
    const s = boxedWestState(0);
    expect(applyAction(s, { type: 'wall', wall: { x: 6, y: 6, o: 'h' } })).toEqual({
      ok: false,
      error: 'NO_WALLS_LEFT',
    });
  });
});

describe('audit: wallsLeft floors at 0 (wallsPerPlayer override = 2)', () => {
  it('counts down per-player and refuses to go below zero', () => {
    let s = createGame(2, { wallsPerPlayer: 2 });
    s = mustApply(s, { type: 'wall', wall: { x: 0, y: 0, o: 'h' } }); // P0 -> 1
    s = mustApply(s, { type: 'wall', wall: { x: 2, y: 0, o: 'h' } }); // P1 -> 1
    s = mustApply(s, { type: 'wall', wall: { x: 4, y: 0, o: 'h' } }); // P0 -> 0
    s = mustApply(s, { type: 'wall', wall: { x: 6, y: 0, o: 'h' } }); // P1 -> 0
    expect(s.players.map((p) => p.wallsLeft)).toEqual([0, 0]);
    expect(s.current).toBe(0);
    expect(s.turnSeq).toBe(4);

    // P0 (current) tries a fifth wall: rejected, wallsLeft stays exactly 0
    const before = snap(s);
    expect(applyAction(s, { type: 'wall', wall: { x: 0, y: 4, o: 'v' } })).toEqual({
      ok: false,
      error: 'NO_WALLS_LEFT',
    });
    expect(snap(s)).toBe(before);
    expect(s.players[0].wallsLeft).toBe(0);
    expect(getLegalWallSlots(s, 0)).toEqual([]);

    // P0 must move instead; then P1's wall attempt is rejected too
    s = mustApply(s, { type: 'move', to: { x: 4, y: 7 } });
    expect(s.current).toBe(1);
    expect(applyAction(s, { type: 'wall', wall: { x: 0, y: 4, o: 'v' } })).toEqual({
      ok: false,
      error: 'NO_WALLS_LEFT',
    });
    expect(s.players[1].wallsLeft).toBe(0);
  });
});

describe('audit: wallsPerPlayer = 0 is a pure pawn race', () => {
  it('walls are impossible from turn one and the race plays to a win', () => {
    let s = createGame(2, { wallsPerPlayer: 0 });
    expect(applyAction(s, { type: 'wall', wall: { x: 3, y: 4, o: 'h' } })).toEqual({
      ok: false,
      error: 'NO_WALLS_LEFT',
    });
    expect(getLegalWallSlots(s, 0)).toEqual([]);
    expect(getLegalWallSlots(s, 1)).toEqual([]);

    // P0 runs straight up column 4 (8 moves). P1 sidesteps to column 3 then
    // runs south (never finishing first). P0 wins on overall action #15.
    const script: Array<{ to: { x: number; y: number } }> = [
      { to: { x: 4, y: 7 } }, // P0
      { to: { x: 3, y: 0 } }, // P1 sidestep west
      { to: { x: 4, y: 6 } }, // P0
      { to: { x: 3, y: 1 } }, // P1
      { to: { x: 4, y: 5 } }, // P0
      { to: { x: 3, y: 2 } }, // P1
      { to: { x: 4, y: 4 } }, // P0
      { to: { x: 3, y: 3 } }, // P1
      { to: { x: 4, y: 3 } }, // P0
      { to: { x: 3, y: 4 } }, // P1
      { to: { x: 4, y: 2 } }, // P0
      { to: { x: 3, y: 5 } }, // P1
      { to: { x: 4, y: 1 } }, // P0
      { to: { x: 3, y: 6 } }, // P1
      { to: { x: 4, y: 0 } }, // P0 reaches the north edge: WIN
    ];
    script.forEach((m, i) => {
      expect(s.current).toBe(i % 2);
      s = mustApply(s, { type: 'move', to: m.to });
      expect(s.turnSeq).toBe(i + 1);
    });
    expect(s.status).toBe('finished');
    expect(s.winner).toBe(0);
    expect(s.current).toBe(0);
    expect(s.turnSeq).toBe(15);
    expect(s.players[0].pos).toEqual({ x: 4, y: 0 });
    expect(s.players[1].pos).toEqual({ x: 3, y: 6 });

    // ranking after the race: P0 dist 0 rank 1; P1 at (3,6) goal south dist 2 rank 2
    expect(rankPlayers(s)).toEqual([
      { seat: 0, rank: 1, distance: 0 },
      { seat: 1, rank: 2, distance: 2 },
    ]);
  });
});

describe('audit: rankPlayers orderings', () => {
  it('fresh 2p game: both 8 away, tied at rank 1, seat order as tiebreak', () => {
    expect(rankPlayers(createGame(2))).toEqual([
      { seat: 0, rank: 1, distance: 8 },
      { seat: 1, rank: 1, distance: 8 },
    ]);
  });

  it('finished 2p: winner rank 1 distance 0, loser rank 2', () => {
    const s = makeState(
      [
        { pos: { x: 3, y: 0 }, goal: 'north' },
        { pos: { x: 5, y: 6 }, goal: 'south' },
      ],
      { status: 'finished', winner: 0 },
    );
    expect(rankPlayers(s)).toEqual([
      { seat: 0, rank: 1, distance: 0 },
      { seat: 1, rank: 2, distance: 2 },
    ]);
  });

  it('4p finished, three-way tie behind the winner: ranks 1,2,2,2', () => {
    const s = makeState(
      [
        { pos: { x: 1, y: 3 }, goal: 'north' }, // dist 3
        { pos: { x: 5, y: 4 }, goal: 'east' }, // dist 3
        { pos: { x: 6, y: 8 }, goal: 'south' }, // winner, dist 0
        { pos: { x: 3, y: 2 }, goal: 'west' }, // dist 3
      ],
      { status: 'finished', winner: 2 },
    );
    expect(rankPlayers(s)).toEqual([
      { seat: 2, rank: 1, distance: 0 },
      { seat: 0, rank: 2, distance: 3 },
      { seat: 1, rank: 2, distance: 3 },
      { seat: 3, rank: 2, distance: 3 },
    ]);
  });

  it('unfinished 4p: ordered purely by remaining distance, ties share rank (1,2,2,2)', () => {
    const s = makeState([
      { pos: { x: 4, y: 4 }, goal: 'north' }, // 4
      { pos: { x: 2, y: 4 }, goal: 'east' }, // 6
      { pos: { x: 4, y: 2 }, goal: 'south' }, // 6
      { pos: { x: 6, y: 4 }, goal: 'west' }, // 6
    ]);
    expect(rankPlayers(s)).toEqual([
      { seat: 0, rank: 1, distance: 4 },
      { seat: 1, rank: 2, distance: 6 },
      { seat: 2, rank: 2, distance: 6 },
      { seat: 3, rank: 2, distance: 6 },
    ]);
  });

  it('unfinished 3p with a leading tie: ranks 1,1,3 (competition ranking)', () => {
    const s = makeState([
      { pos: { x: 4, y: 2 }, goal: 'north' }, // 2
      { pos: { x: 6, y: 4 }, goal: 'east' }, // 2
      { pos: { x: 4, y: 3 }, goal: 'south' }, // 5
    ]);
    expect(rankPlayers(s)).toEqual([
      { seat: 0, rank: 1, distance: 2 },
      { seat: 1, rank: 1, distance: 2 },
      { seat: 2, rank: 3, distance: 5 },
    ]);
  });

  it('distances account for walls on the board', () => {
    // h(3,0) blocks rows 0/1 for columns 3 and 4.
    // P0 at (4,1) goal north: (4,0) and (3,1)->(3,0) blocked; best is
    // (4,1)->(5,1)->(5,0) = 2 steps. P1 at (4,7) goal south: 1 step.
    const s = makeState(
      [
        { pos: { x: 4, y: 1 }, goal: 'north' },
        { pos: { x: 4, y: 7 }, goal: 'south' },
      ],
      { walls: [{ x: 3, y: 0, o: 'h' }] },
    );
    expect(rankPlayers(s)).toEqual([
      { seat: 1, rank: 1, distance: 1 },
      { seat: 0, rank: 2, distance: 2 },
    ]);
  });
});
