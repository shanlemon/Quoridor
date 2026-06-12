import { describe, expect, it } from 'vitest';
import {
  applyAction,
  chooseBotAction,
  createGame,
  shortestPathLength,
} from '../src/index';
import type { Action, BotLevel, GameState } from '../src/index';
import { makeState } from './helpers';

/** Deterministic PRNG so bot tests are reproducible. */
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

function mustApply(state: GameState, action: Action): GameState {
  const res = applyAction(state, action);
  if (!res.ok) throw new Error(`bot chose illegal action ${JSON.stringify(action)}: ${res.error}`);
  return res.state;
}

/** Play a full bot-vs-bot game; returns the final state. Throws on any illegal action. */
async function playGame(
  levels: BotLevel[],
  seed: number,
  maxPlies = 400,
  players: 2 | 3 | 4 = 2,
): Promise<GameState> {
  const rng = mulberry32(seed);
  let state = createGame(players);
  let plies = 0;
  while (state.status === 'playing') {
    if (++plies > maxPlies) throw new Error(`game did not terminate within ${maxPlies} plies`);
    const action = chooseBotAction(state, levels[state.current], rng);
    state = mustApply(state, action);
    // Yield so long CPU-bound games don't starve the vitest worker heartbeat.
    if (plies % 5 === 0) await new Promise((r) => setImmediate(r));
  }
  return state;
}

describe('chooseBotAction basics', () => {
  it('always takes an immediate winning move (every level)', () => {
    for (const level of ['easy', 'medium', 'hard'] as const) {
      const s = makeState([
        { pos: { x: 6, y: 1 }, goal: 'north' },
        { pos: { x: 0, y: 4 }, goal: 'south' },
      ]);
      const action = chooseBotAction(s, level, mulberry32(1));
      expect(action).toEqual({ type: 'move', to: { x: 6, y: 0 } });
    }
  });

  it('easy never places fences', () => {
    const rng = mulberry32(7);
    let state = createGame(2);
    for (let i = 0; i < 60 && state.status === 'playing'; i++) {
      const action = chooseBotAction(state, 'easy', rng);
      expect(action.type).not.toBe('wall');
      state = mustApply(state, action);
    }
  });

  it('is deterministic for a fixed rng seed', () => {
    const a = chooseBotAction(createGame(2), 'medium', mulberry32(42));
    const b = chooseBotAction(createGame(2), 'medium', mulberry32(42));
    expect(a).toEqual(b);
  });

  it('passes when completely stuck', () => {
    // Same boxed scenario as game.test.ts: no moves, no walls left.
    const s = makeState(
      [
        { pos: { x: 4, y: 4 }, goal: 'north', wallsLeft: 0 },
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
    for (const level of ['easy', 'medium', 'hard'] as const) {
      expect(chooseBotAction(s, level, mulberry32(3))).toEqual({ type: 'pass' });
    }
  });

  it('plays a legal FENCE when pawn-boxed but still holding fences (pass would be illegal)', () => {
    // Same boxed shape as above, but the stuck player kept their 10 fences:
    // the engine forbids passing while a fence is placeable.
    const s = makeState(
      [
        { pos: { x: 4, y: 4 }, goal: 'north' }, // wallsLeft defaults to 10
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
    for (const level of ['easy', 'medium', 'hard'] as const) {
      const action = chooseBotAction(s, level, mulberry32(9));
      expect(action.type).toBe('wall');
      expect(applyAction(s, action).ok).toBe(true);
    }
  });

  it('hard blocks an opponent who is one step from winning', () => {
    // Opponent (seat 1, goal south) sits at (4,7) — one hop from home.
    // The bot (seat 0) is far away; the only good play is a fence.
    const s = makeState([
      { pos: { x: 4, y: 4 }, goal: 'north' },
      { pos: { x: 4, y: 7 }, goal: 'south' },
    ]);
    const action = chooseBotAction(s, 'hard', mulberry32(5));
    expect(action.type).toBe('wall');
    const after = mustApply(s, action);
    expect(shortestPathLength(after, 1)).toBeGreaterThan(1);
  });
});

describe('bot-vs-bot games', () => {
  it.each([
    ['easy', 'easy', 11],
    ['medium', 'medium', 22],
    ['medium', 'easy', 33],
  ] as const)(
    '%s vs %s terminates legally with a winner (seed %i)',
    { timeout: 60_000 },
    async (a, b, seed) => {
      const final = await playGame([a, b], seed);
      expect(final.status).toBe('finished');
      expect(final.winner).not.toBeNull();
    },
  );

  it('hard vs easy: hard wins from either seat', { timeout: 60_000 }, async () => {
    const first = await playGame(['hard', 'easy'], 101);
    expect(first.winner).toBe(0);
    const second = await playGame(['easy', 'hard'], 102);
    expect(second.winner).toBe(1);
  });

  it('medium beats easy in at least 3 of 4 seeded games', { timeout: 60_000 }, async () => {
    let mediumWins = 0;
    for (const [seed, mediumSeat] of [
      [201, 0],
      [202, 1],
      [203, 0],
      [204, 1],
    ] as const) {
      const levels: BotLevel[] = mediumSeat === 0 ? ['medium', 'easy'] : ['easy', 'medium'];
      const final = await playGame(levels, seed);
      if (final.winner === mediumSeat) mediumWins++;
    }
    expect(mediumWins).toBeGreaterThanOrEqual(3);
  });

  it('a 4-player all-bot game terminates legally', { timeout: 60_000 }, async () => {
    const final = await playGame(['medium', 'easy', 'medium', 'easy'], 301, 600, 4);
    expect(final.status).toBe('finished');
  });
});
