/**
 * AUDIT: bot action LEGALITY under adversarial states.
 *
 * Every action chooseBotAction returns must be accepted by applyAction
 * (its own doc comment promises exactly that). This file:
 *   1. fuzzes bot-vs-bot games (2p/3p/4p, mixed levels incl. hard) with a
 *      seeded PRNG, asserting every action is legal and games terminate;
 *   2. constructs adversarial edge states (0 walls, win-in-1 with adjacent
 *      opponent, jump-only, forced-backward, walls-only-legal, pass-only);
 *   3. spies on applyAction to prove hard's lookahead never dispatches an
 *      action that is illegal for the state's current player;
 *   4. drives easy's wander branch with degenerate rngs (const 0,
 *      const 0.999999, alternating) to hunt out-of-bounds indexing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Wrap (not replace) applyAction so we can observe every internal call the
// AI makes during deliberation. Behavior is unchanged.
vi.mock('../src/game', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, applyAction: vi.fn(actual.applyAction as (...a: never[]) => unknown) };
});

import {
  applyAction,
  chooseBotAction,
  createGame,
  getLegalMoves,
  getLegalWallSlots,
  isGoalCell,
} from '../src/index';
import type { Action, ActionResult, BotLevel, GameState, PlayerCount } from '../src/index';
import { makeState } from './helpers';

const applySpy = vi.mocked(applyAction);

beforeEach(() => {
  applySpy.mockClear();
});

/** Deterministic PRNG in [0, 1) so every run is reproducible. */
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

function fmt(a: Action): string {
  return JSON.stringify(a);
}

/** Apply or fail the test with full context. */
function mustApply(state: GameState, action: Action, ctx: string): GameState {
  const res = applyAction(state, action);
  if (!res.ok) {
    expect.fail(
      `${ctx}: bot returned ${fmt(action)} but applyAction rejected it with ${res.error}. ` +
        `legalMoves=${JSON.stringify(getLegalMoves(state, state.current))} ` +
        `wallSlots=${getLegalWallSlots(state, state.current).length} ` +
        `wallsLeft=${state.players[state.current].wallsLeft}`,
    );
  }
  return res.state;
}

interface GameSpec {
  players: PlayerCount;
  levels: BotLevel[];
  seed: number;
  maxPlies: number;
  wallsPerPlayer?: number;
}

/** Play a full bot-vs-bot game; every action must be legal; must terminate. */
async function playGame(spec: GameSpec): Promise<GameState> {
  const rng = mulberry32(spec.seed);
  let state = createGame(spec.players, { wallsPerPlayer: spec.wallsPerPlayer });
  let plies = 0;
  const tag = `[${spec.players}p ${spec.levels.join('/')} seed=${spec.seed}]`;
  while (state.status === 'playing') {
    plies++;
    if (plies > spec.maxPlies) {
      expect.fail(`${tag} game did not terminate within ${spec.maxPlies} plies`);
    }
    const level = spec.levels[state.current];
    const action = chooseBotAction(state, level, rng);
    state = mustApply(state, action, `${tag} ply ${plies} seat ${state.current} (${level})`);
    // Yield so long CPU-bound games don't starve the vitest worker heartbeat.
    if (plies % 5 === 0) await new Promise((r) => setImmediate(r));
  }
  expect(state.winner, `${tag} finished without a winner`).not.toBeNull();
  return state;
}

// ---------------------------------------------------------------------------
// 1. Seeded fuzz: bot-vs-bot games across player counts and level mixes.
// ---------------------------------------------------------------------------

describe('fuzz: every bot action is legal and games terminate', () => {
  const games2p: GameSpec[] = [
    { players: 2, levels: ['hard', 'hard'], seed: 1, maxPlies: 1000 },
    { players: 2, levels: ['hard', 'easy'], seed: 2, maxPlies: 1000 },
    { players: 2, levels: ['easy', 'hard'], seed: 3, maxPlies: 1000 },
    { players: 2, levels: ['hard', 'medium'], seed: 4, maxPlies: 1000 },
    { players: 2, levels: ['medium', 'hard'], seed: 5, maxPlies: 1000 },
    { players: 2, levels: ['medium', 'medium'], seed: 6, maxPlies: 1000 },
    { players: 2, levels: ['medium', 'medium'], seed: 7, maxPlies: 1000 },
    { players: 2, levels: ['easy', 'medium'], seed: 8, maxPlies: 1000 },
    { players: 2, levels: ['easy', 'easy'], seed: 9, maxPlies: 1000 },
    { players: 2, levels: ['easy', 'easy'], seed: 10, maxPlies: 1000 },
    { players: 2, levels: ['hard', 'hard'], seed: 11, maxPlies: 1000, wallsPerPlayer: 3 },
    { players: 2, levels: ['medium', 'hard'], seed: 12, maxPlies: 1000, wallsPerPlayer: 0 },
    { players: 2, levels: ['medium', 'hard'], seed: 13, maxPlies: 1000, wallsPerPlayer: 1 },
  ];
  const games3p: GameSpec[] = [
    { players: 3, levels: ['easy', 'medium', 'hard'], seed: 21, maxPlies: 1200 },
    { players: 3, levels: ['hard', 'easy', 'medium'], seed: 22, maxPlies: 1200 },
    { players: 3, levels: ['medium', 'hard', 'easy'], seed: 23, maxPlies: 1200 },
    { players: 3, levels: ['hard', 'hard', 'hard'], seed: 24, maxPlies: 1200 },
  ];
  const games4p: GameSpec[] = [
    { players: 4, levels: ['easy', 'medium', 'hard', 'medium'], seed: 31, maxPlies: 1600 },
    { players: 4, levels: ['hard', 'easy', 'medium', 'easy'], seed: 32, maxPlies: 1600 },
    { players: 4, levels: ['medium', 'hard', 'easy', 'hard'], seed: 33, maxPlies: 1600 },
  ];

  it.each([...games2p, ...games3p, ...games4p].map((g) => [
    `${g.players}p ${g.levels.join('/')} seed=${g.seed} walls=${g.wallsPerPlayer ?? 'default'}`,
    g,
  ] as const))('%s', { timeout: 60_000 }, async (_name, spec) => {
    await playGame(spec);
  });
});

// ---------------------------------------------------------------------------
// 2. Constructed edge states.
// ---------------------------------------------------------------------------

const LEVELS = ['easy', 'medium', 'hard'] as const;

/**
 * Pawn box used by the engine's own tests: seat 0 at (4,4) cannot move.
 * North (4,3) and (4,2) hold pawns (jump landing occupied), walls v3,3 / v4,3
 * block west+east and both diagonals, h3,4 blocks south.
 */
function boxedState(goal: 'north' | 'south', wallsLeft: number): GameState {
  return makeState(
    [
      { pos: { x: 4, y: 4 }, goal, wallsLeft },
      { pos: { x: 4, y: 3 }, goal: 'south' },
      { pos: { x: 4, y: 2 }, goal: 'south' },
    ],
    {
      walls: [
        { x: 3, y: 3, o: 'v' },
        { x: 4, y: 3, o: 'v' },
        { x: 3, y: 4, o: 'h' },
      ],
    },
  );
}

describe('edge: boxed-in bot still holding fences (pass would be ILLEGAL)', () => {
  // goal:'north' => myDist=4, oppDist=7 > myDist+2, so medium/hard skip wall
  // enumeration entirely; easy never walls. All three return 'pass', but the
  // rules say pass is only legal when no move AND no wall exists.
  it.each(LEVELS)(
    '%s returns an action applyAction accepts when boxed with walls in hand (opponents far)',
    (level) => {
      const s = boxedState('north', 2);
      expect(getLegalMoves(s, 0)).toHaveLength(0); // boxed: no pawn moves
      expect(getLegalWallSlots(s, 0).length).toBeGreaterThan(0); // fences ARE legal
      const action = chooseBotAction(s, level, mulberry32(101));
      mustApply(s, action, `boxed-with-fences (opponents far, ${level})`);
    },
  );

  it.each(LEVELS)(
    '%s returns an action applyAction accepts when boxed with walls in hand (race tight)',
    (level) => {
      // goal:'south' => myDist=9, oppDist=7 <= myDist+2: wall gate is OPEN for
      // medium/hard, so they find a legal fence. Easy still has no fallback.
      const s = boxedState('south', 2);
      expect(getLegalMoves(s, 0)).toHaveLength(0);
      expect(getLegalWallSlots(s, 0).length).toBeGreaterThan(0);
      const action = chooseBotAction(s, level, mulberry32(102));
      mustApply(s, action, `boxed-with-fences (race tight, ${level})`);
    },
  );
});

describe('edge: only legal action is pass (boxed, zero fences)', () => {
  it.each(LEVELS)('%s passes and the engine accepts it', (level) => {
    const s = boxedState('north', 0);
    expect(getLegalMoves(s, 0)).toHaveLength(0);
    expect(getLegalWallSlots(s, 0)).toHaveLength(0);
    const action = chooseBotAction(s, level, mulberry32(103));
    expect(action).toEqual({ type: 'pass' });
    mustApply(s, action, `pass-only (${level})`);
  });
});

describe('edge: bot with 0 walls never tries to place one', () => {
  it.each(LEVELS)('%s plays only legal non-wall actions through a full 2p game', (level) => {
    const rng = mulberry32(104);
    let state = createGame(2, { wallsPerPlayer: 0 });
    let plies = 0;
    while (state.status === 'playing' && plies < 400) {
      plies++;
      const action = chooseBotAction(state, level, rng);
      expect(action.type, `0-wall game ply ${plies}`).not.toBe('wall');
      state = mustApply(state, action, `0-wall game ply ${plies} (${level})`);
    }
    expect(state.status).toBe('finished');
  });

  it.each(LEVELS)('%s stays legal mid-game with 0 walls and adjacent opponent', (level) => {
    const s = makeState([
      { pos: { x: 4, y: 4 }, goal: 'north', wallsLeft: 0 },
      { pos: { x: 4, y: 3 }, goal: 'south', wallsLeft: 0 },
    ]);
    const action = chooseBotAction(s, level, mulberry32(105));
    expect(action.type).not.toBe('wall');
    mustApply(s, action, `0-wall adjacent (${level})`);
  });
});

describe('edge: one step from goal with opponent adjacent (win via diagonal)', () => {
  it.each(LEVELS)('%s takes a legal immediate win', (level) => {
    // Opponent sits ON the goal row directly ahead; straight jump is off-board,
    // so the wins are the diagonal side-steps (3,0)/(5,0).
    const s = makeState([
      { pos: { x: 4, y: 1 }, goal: 'north' },
      { pos: { x: 4, y: 0 }, goal: 'south' },
    ]);
    const action = chooseBotAction(s, level, mulberry32(106));
    expect(action.type).toBe('move');
    if (action.type !== 'move') return;
    expect(isGoalCell(action.to, 'north')).toBe(true);
    const after = mustApply(s, action, `win-in-1 (${level})`);
    expect(after.status).toBe('finished');
    expect(after.winner).toBe(0);
  });
});

describe('edge: jump-only position (single legal move is a straight jump)', () => {
  function jumpOnly(wallsLeft: number): GameState {
    // Seat 0 at (4,4): E/W/S and both diagonals walled, north pawn forces the
    // straight jump to (4,2) — the ONLY legal move.
    return makeState(
      [
        { pos: { x: 4, y: 4 }, goal: 'north', wallsLeft },
        { pos: { x: 4, y: 3 }, goal: 'south' },
      ],
      {
        walls: [
          { x: 3, y: 3, o: 'v' },
          { x: 4, y: 3, o: 'v' },
          { x: 3, y: 4, o: 'h' },
        ],
      },
    );
  }

  it('the position really has exactly one move: the jump', () => {
    expect(getLegalMoves(jumpOnly(0), 0)).toEqual([{ x: 4, y: 2 }]);
  });

  it.each(LEVELS)('%s (no fences) plays the jump', (level) => {
    const s = jumpOnly(0);
    const action = chooseBotAction(s, level, mulberry32(107));
    expect(action).toEqual({ type: 'move', to: { x: 4, y: 2 } });
    mustApply(s, action, `jump-only (${level})`);
  });

  it.each(LEVELS)('%s (with fences) still returns a legal action', (level) => {
    const s = jumpOnly(5);
    const action = chooseBotAction(s, level, mulberry32(108));
    mustApply(s, action, `jump-only-with-fences (${level})`);
  });
});

describe('edge: forced-backward position (goal-ward fully blocked by pawn + walls)', () => {
  function forcedBack(wallsLeft: number): GameState {
    // Seat 0 at (4,1) goal north; opponent on (4,0); straight jump off-board;
    // v3,0 / v4,0 block both diagonals AND east/west. Only move: south (4,2).
    return makeState(
      [
        { pos: { x: 4, y: 1 }, goal: 'north', wallsLeft },
        { pos: { x: 4, y: 0 }, goal: 'south' },
      ],
      {
        walls: [
          { x: 3, y: 0, o: 'v' },
          { x: 4, y: 0, o: 'v' },
        ],
      },
    );
  }

  it('the position really has exactly one move: backward', () => {
    expect(getLegalMoves(forcedBack(0), 0)).toEqual([{ x: 4, y: 2 }]);
  });

  it.each(LEVELS)('%s (no fences) retreats legally', (level) => {
    const s = forcedBack(0);
    const action = chooseBotAction(s, level, mulberry32(109));
    expect(action).toEqual({ type: 'move', to: { x: 4, y: 2 } });
    mustApply(s, action, `forced-backward (${level})`);
  });

  it.each(LEVELS)('%s (with fences) still returns a legal action', (level) => {
    const s = forcedBack(5);
    const action = chooseBotAction(s, level, mulberry32(110));
    mustApply(s, action, `forced-backward-with-fences (${level})`);
  });
});

// ---------------------------------------------------------------------------
// 3. Hard's lookahead: every internal applyAction call must be legal for the
//    state's CURRENT player (no wrong-seat dispatch).
// ---------------------------------------------------------------------------

describe("hard lookahead: internal applyAction calls match each state's current seat", () => {
  function assertAllInternalCallsLegal(ctx: string): void {
    expect(applySpy.mock.calls.length, `${ctx}: lookahead made no applyAction calls`)
      .toBeGreaterThan(0);
    for (let i = 0; i < applySpy.mock.calls.length; i++) {
      const [st, act] = applySpy.mock.calls[i];
      const result = applySpy.mock.results[i];
      expect(st.status, `${ctx}: applyAction called on a finished state`).toBe('playing');
      expect(result.type).toBe('return');
      const value = result.value as ActionResult;
      if (!value.ok) {
        expect.fail(
          `${ctx}: lookahead applied ${fmt(act)} to a state whose current seat is ` +
            `${st.current} and the engine rejected it with ${value.error} — ` +
            `the action was generated for the wrong seat or stale state`,
        );
      }
    }
  }

  it.each([2, 3, 4] as const)(
    'fresh %ip game (margin 0 forces the lookahead): all internal calls legal',
    (n) => {
      const s = createGame(n);
      applySpy.mockClear();
      const action = chooseBotAction(s, 'hard', mulberry32(201));
      assertAllInternalCallsLegal(`${n}p opening`);
      applySpy.mockClear();
      mustApply(s, action, `${n}p opening (hard)`);
    },
  );

  it('tight mid-game 2p position with adjacent pawns: all internal calls legal', () => {
    // Pawns face off mid-board; margin is 0 so the lookahead runs, and the
    // opponent's greedy reply involves jump geometry.
    const s = makeState([
      { pos: { x: 4, y: 4 }, goal: 'north', wallsLeft: 3 },
      { pos: { x: 4, y: 3 }, goal: 'south', wallsLeft: 3 },
    ]);
    applySpy.mockClear();
    const action = chooseBotAction(s, 'hard', mulberry32(202));
    assertAllInternalCallsLegal('2p face-off');
    applySpy.mockClear();
    mustApply(s, action, '2p face-off (hard)');
  });

  it(
    '4p mid-game reached by play: all internal calls legal on every hard turn',
    { timeout: 60_000 },
    async () => {
      const rng = mulberry32(203);
      let state = createGame(4);
      let plies = 0;
      while (state.status === 'playing' && plies < 24) {
        plies++;
        applySpy.mockClear();
        const action = chooseBotAction(state, 'hard', rng);
        // Only assert when the lookahead actually ran (it made internal calls).
        if (applySpy.mock.calls.length > 0) assertAllInternalCallsLegal(`4p ply ${plies}`);
        applySpy.mockClear();
        state = mustApply(state, action, `4p all-hard ply ${plies}`);
        // Yield so this CPU-heavy loop doesn't starve the worker heartbeat.
        await new Promise((r) => setImmediate(r));
      }
    },
  );
});

// ---------------------------------------------------------------------------
// 4. rng edge values: easy's wander branch indexing.
// ---------------------------------------------------------------------------

describe('rng edge values: easy wander branch never indexes out of bounds', () => {
  const rngZero = (): number => 0;
  const rngMax = (): number => 0.999999;
  /** First call 0 (forces the wander branch), second 0.999999 (max index). */
  function cycle(values: number[]): () => number {
    let i = 0;
    return () => values[i++ % values.length];
  }

  const states: Array<[string, GameState]> = [
    ['2p opening', createGame(2)],
    ['4p opening', createGame(4)],
    [
      '2p face-off (jump among moves)',
      makeState([
        { pos: { x: 4, y: 4 }, goal: 'north' },
        { pos: { x: 4, y: 3 }, goal: 'south' },
      ]),
    ],
    [
      'two legal moves only',
      // Seat 0 at (0,1) goal south, opponent at (0,2) ahead; jump to (0,3),
      // diagonal (1,2), plus (1,1) and (0,0) — prune with walls to keep it tight.
      makeState(
        [
          { pos: { x: 0, y: 1 }, goal: 'south' },
          { pos: { x: 0, y: 2 }, goal: 'north' },
        ],
        { walls: [{ x: 0, y: 0, o: 'v' }] },
      ),
    ],
  ];

  it.each(states.map(([name, s]) => [name, s] as const))(
    'rng=0 / rng=0.999999 / alternating on %s: action is legal',
    (_name, s) => {
      for (const [label, rng] of [
        ['const 0', rngZero],
        ['const 0.999999', rngMax],
        ['alternating 0, 0.999999', cycle([0, 0.999999])],
        ['alternating 0.999999, 0', cycle([0.999999, 0])],
      ] as const) {
        const action = chooseBotAction(s, 'easy', rng);
        expect(action.type, `easy must not pass when moves exist (rng ${label})`).toBe('move');
        if (action.type === 'move') {
          expect(action.to, `easy picked an undefined cell (rng ${label})`).toBeDefined();
          expect(Number.isInteger(action.to.x) && Number.isInteger(action.to.y)).toBe(true);
        }
        mustApply(s, action, `easy rng ${label}`);
      }
    },
  );

  it('easy stays legal for 200 plies with degenerate rngs (termination not required)', () => {
    for (const rng of [rngZero, rngMax, cycle([0, 0.999999])]) {
      let state = createGame(2);
      for (let i = 0; i < 200 && state.status === 'playing'; i++) {
        const action = chooseBotAction(state, 'easy', rng);
        state = mustApply(state, action, `degenerate-rng ply ${i + 1}`);
      }
    }
  });

  it('medium stays legal with constant-extreme rngs', () => {
    for (const rng of [rngZero, rngMax]) {
      let state = createGame(2);
      for (let i = 0; i < 60 && state.status === 'playing'; i++) {
        const action = chooseBotAction(state, 'medium', rng);
        state = mustApply(state, action, `medium const-rng ply ${i + 1}`);
      }
    }
  });
});
