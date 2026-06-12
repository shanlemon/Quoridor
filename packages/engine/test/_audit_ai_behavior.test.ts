/**
 * AUDIT: bot behavior sanity for chooseBotAction (packages/engine/src/ai.ts).
 *
 * Properties under test:
 *  1. medium/hard take an immediate winning move even when a fence scores
 *     higher under the greedy margin heuristic.
 *  2. hard does not pick a strictly dominated fence from its top-6 when a
 *     clearly better racing move is in the top-6 (forced construction).
 *  3. a bot never returns an action that applyAction rejects — in particular
 *     never 'pass' while a legal move OR legal fence exists.
 *  4. bot-vs-bot games terminate (no livelock), across seeded rngs AND
 *     degenerate constant rngs.
 *  5. every fence a bot returns passes checkWallPlacement (never traps).
 *  6. 3p/4p: medium/hard respond to an opponent one step from winning.
 */
import { describe, expect, it } from 'vitest';
import {
  applyAction,
  checkWallPlacement,
  chooseBotAction,
  createGame,
  getLegalMoves,
  getLegalWallSlots,
  shortestPathLength,
  WALL_GRID,
} from '../src/index';
import type { Action, BotLevel, GameState, Wall } from '../src/index';
import { makeState } from './helpers';

/** Deterministic PRNG (same as ai.test.ts) so runs are reproducible. */
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

const constRng = (v: number) => (): number => v;

/** Apply, asserting the engine accepts the bot's action (property 3 + 5). */
function mustApply(state: GameState, action: Action): GameState {
  if (action.type === 'wall') {
    // Property 5: the bot must never even RETURN a fence the engine rejects.
    const check = checkWallPlacement(state, action.wall, state.current);
    if (!check.legal) {
      throw new Error(
        `bot returned illegal fence ${JSON.stringify(action.wall)}: ${check.reason}`,
      );
    }
  }
  if (action.type === 'pass') {
    // Property 3: pass is only legal when no move and no fence exists.
    const moves = getLegalMoves(state, state.current).length;
    const slots = getLegalWallSlots(state, state.current).length;
    if (moves > 0 || slots > 0) {
      throw new Error(
        `bot chose 'pass' with ${moves} legal moves and ${slots} legal fences available`,
      );
    }
  }
  const res = applyAction(state, action);
  if (!res.ok) {
    throw new Error(`engine rejected bot action ${JSON.stringify(action)}: ${res.error}`);
  }
  return res.state;
}

/** Play a full bot-vs-bot game; throws on illegal action or ply-bound overrun. */
async function playGame(
  levels: BotLevel[],
  rng: () => number,
  maxPlies = 600,
  players: 2 | 3 | 4 = 2,
): Promise<GameState> {
  let state = createGame(players);
  let plies = 0;
  while (state.status === 'playing') {
    if (++plies > maxPlies) {
      const pos = state.players.map((p) => `${p.character}@(${p.pos.x},${p.pos.y})`).join(' ');
      throw new Error(`LIVELOCK: game did not terminate within ${maxPlies} plies [${pos}]`);
    }
    state = mustApply(state, chooseBotAction(state, levels[state.current], rng));
    // Yield so long CPU-bound games don't starve the vitest worker heartbeat.
    if (plies % 5 === 0) await new Promise((r) => setImmediate(r));
  }
  return state;
}

function allWallSlots(): Wall[] {
  const out: Wall[] = [];
  for (const o of ['h', 'v'] as const) {
    for (let y = 0; y < WALL_GRID; y++) {
      for (let x = 0; x < WALL_GRID; x++) out.push({ x, y, o });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. Immediate win beats a higher-scoring fence
// ---------------------------------------------------------------------------
describe('immediate win takes priority over a heuristically better fence', () => {
  // Bot (seat 0, goal north) stands at (4,1): one step from winning.
  // Opponent (seat 1, goal south) stands at (0,7) next to a pre-placed
  // fence v(0,6); the fence h(0,7) would corral them into a 7-step detour.
  // Greedy score of that fence = 7 - 1 - 0.35 = 5.65, far above the winning
  // move's score of 1 — so a bot that forgets the win-check would fence.
  const trapState = (): GameState =>
    makeState(
      [
        { pos: { x: 4, y: 1 }, goal: 'north' },
        { pos: { x: 0, y: 7 }, goal: 'south' },
      ],
      { walls: [{ x: 0, y: 6, o: 'v' }] },
    );

  it('precondition: the trap fence is legal and scores above the winning move', () => {
    const s = trapState();
    expect(shortestPathLength(s, 0)).toBe(1);
    expect(shortestPathLength(s, 1)).toBe(1);
    const fence: Wall = { x: 0, y: 7, o: 'h' };
    expect(checkWallPlacement(s, fence, 0).legal).toBe(true);
    const res = applyAction(s, { type: 'wall', wall: fence });
    if (!res.ok) throw new Error('precondition broke');
    // fence score (newOpp - newMy - 0.35) must beat the win move score (oppDist = 1)
    expect(shortestPathLength(res.state, 1) - 1 - 0.35).toBeGreaterThan(1);
  });

  it.each([
    ['easy', 1],
    ['easy', 2],
    ['medium', 1],
    ['medium', 2],
    ['hard', 1],
    ['hard', 2],
  ] as const)('%s (seed %i) plays the winning move', (level, seed) => {
    const action = chooseBotAction(trapState(), level, mulberry32(seed));
    expect(action).toEqual({ type: 'move', to: { x: 4, y: 0 } });
  });

  it.each([0, 0.49, 0.99] as const)('every level wins even with constant rng %f', (c) => {
    for (const level of ['easy', 'medium', 'hard'] as const) {
      const action = chooseBotAction(trapState(), level, constRng(c));
      expect(action).toEqual({ type: 'move', to: { x: 4, y: 0 } });
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Hard must not pick a strictly dominated fence from its top-6
// ---------------------------------------------------------------------------
describe('hard avoids fences that help the opponent more than itself', () => {
  // Opponent (seat 1, goal south) races down a column-8 corridor at (8,6),
  // 2 steps from home. Pre-placed fences v(7,6) and h(6,7) make BOTH fence
  // slots that could slow them (h(7,6), h(7,7)) structurally illegal, so
  // EVERY legal fence is dead weight: it cannot slow the opponent, while the
  // bot (seat 0, goal north, 7 steps out at (4,7)) loses a tempo placing it.
  // Race margin is -5 (<= 2) so hard's one-ply lookahead is active, and its
  // top-6 contains both racing moves and dead fences. The unique
  // value-maximizing candidate is the racing move north to (4,6).
  const corridorState = (): GameState =>
    makeState(
      [
        { pos: { x: 4, y: 7 }, goal: 'north' },
        { pos: { x: 8, y: 6 }, goal: 'south' },
      ],
      {
        walls: [
          { x: 7, y: 6, o: 'v' },
          { x: 6, y: 7, o: 'h' },
        ],
      },
    );

  it('precondition: no legal fence can slow the opponent, but legal fences exist', () => {
    const s = corridorState();
    expect(shortestPathLength(s, 0)).toBe(7);
    expect(shortestPathLength(s, 1)).toBe(2);
    let legalFences = 0;
    for (const w of allWallSlots()) {
      if (!checkWallPlacement(s, w, 0).legal) continue;
      legalFences++;
      const res = applyAction(s, { type: 'wall', wall: w });
      if (!res.ok) throw new Error('precondition broke');
      expect(shortestPathLength(res.state, 1)).toBe(2); // opponent never slowed
    }
    expect(legalFences).toBeGreaterThan(0);
  });

  it('hard races instead of burning a useless fence', () => {
    const s = corridorState();
    const action = chooseBotAction(s, 'hard', mulberry32(9));
    expect(action.type).toBe('move');
    const after = mustApply(s, action);
    expect(shortestPathLength(after, 0)).toBe(6); // strictly closed the gap
  });
});

// ---------------------------------------------------------------------------
// 3. Never return 'pass' (or any action) the engine rejects
// ---------------------------------------------------------------------------
describe("a bot never chooses 'pass' while something legal exists", () => {
  // Boxed-in pawn: seat 0 at (4,4) has NO legal pawn move (fenced W/E/S,
  // double-stacked pawns N) — but it still holds 10 fences and many fence
  // placements are legal, so applyAction rejects 'pass' (PASS_NOT_ALLOWED).
  const boxedWithFences = (): GameState =>
    makeState(
      [
        { pos: { x: 4, y: 4 }, goal: 'north', wallsLeft: 10 },
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

  it('precondition: no moves, but legal fences exist (so pass is illegal)', () => {
    const s = boxedWithFences();
    expect(getLegalMoves(s, 0)).toHaveLength(0);
    expect(getLegalWallSlots(s, 0).length).toBeGreaterThan(0);
    expect(applyAction(s, { type: 'pass' })).toEqual({ ok: false, error: 'PASS_NOT_ALLOWED' });
    // medium/hard fence gate: opponents are MORE than myDist+2 away, which is
    // exactly the regime where candidates() skips fences entirely.
    const myDist = shortestPathLength(s, 0);
    expect(Math.min(shortestPathLength(s, 1), shortestPathLength(s, 2))).toBeGreaterThan(
      myDist + 2,
    );
  });

  it.each(['easy', 'medium', 'hard'] as const)(
    '%s returns an action the engine accepts when boxed in with fences left',
    (level) => {
      const s = boxedWithFences();
      const action = chooseBotAction(s, level, mulberry32(3));
      const res = applyAction(s, action);
      expect(res, `engine rejected ${JSON.stringify(action)}`).toMatchObject({ ok: true });
    },
  );
});

// ---------------------------------------------------------------------------
// 4. Termination / livelock + 5. all returned actions are engine-legal
// ---------------------------------------------------------------------------
describe('bot-vs-bot games terminate and stay legal', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const)(
    'easy vs easy terminates within 600 plies (seed %i)',
    { timeout: 60_000 },
    async (seed) => {
      const final = await playGame(['easy', 'easy'], mulberry32(seed));
      expect(final.status).toBe('finished');
      expect(final.winner).not.toBeNull();
    },
  );

  // Degenerate rngs are still valid rngs (always in [0,1)). A constant below
  // the 0.25 wander threshold makes easy "wander" EVERY turn with a fixed
  // pick — the bot must still make progress eventually, not shuffle forever.
  it.each([0, 0.1, 0.2, 0.3, 0.5, 0.75, 0.99] as const)(
    'easy vs easy terminates with constant rng %f',
    { timeout: 60_000 },
    async (c) => {
      const final = await playGame(['easy', 'easy'], constRng(c));
      expect(final.status).toBe('finished');
    },
  );

  it.each([11, 12, 13, 14, 15] as const)(
    'medium vs medium terminates within 600 plies (seed %i)',
    { timeout: 60_000 },
    async (seed) => {
      const final = await playGame(['medium', 'medium'], mulberry32(seed));
      expect(final.status).toBe('finished');
    },
  );

  it('medium vs medium terminates with constant rng 0.5 (zero noise)', { timeout: 60_000 }, async () => {
    const final = await playGame(['medium', 'medium'], constRng(0.5));
    expect(final.status).toBe('finished');
  });

  it('hard vs hard (deterministic) terminates within 600 plies', { timeout: 60_000 }, async () => {
    const final = await playGame(['hard', 'hard'], constRng(0.5));
    expect(final.status).toBe('finished');
  });

  it.each([
    [['easy', 'medium'], 21],
    [['medium', 'hard'], 22],
    [['hard', 'easy'], 23],
  ] as [BotLevel[], number][])(
    'mixed pairing %j stays fully legal to the end (seed %i)',
    { timeout: 60_000 },
    async (levels, seed) => {
      const final = await playGame(levels, mulberry32(seed));
      expect(final.status).toBe('finished');
    },
  );

  it('4-player mixed game stays legal and terminates', { timeout: 60_000 }, async () => {
    const final = await playGame(['medium', 'easy', 'hard', 'easy'], mulberry32(31), 800, 4);
    expect(final.status).toBe('finished');
  });
});

// ---------------------------------------------------------------------------
// 6. 3p/4p threat response: an opponent one step from winning
// ---------------------------------------------------------------------------
describe('responding to an opponent one step from winning', () => {
  // 4p: seat 2 (goal south) stands at (4,7) — wins on their next turn unless
  // fenced. The bot (seat 0, goal north) is 4 steps out, so racing CANNOT
  // beat the threat (seat 2 moves before seat 0 reaches home). The only
  // non-losing reply is a fence that lengthens seat 2's path.
  const fourPlayerThreat = (): GameState =>
    makeState(
      [
        { pos: { x: 4, y: 4 }, goal: 'north' }, // bot to act, dist 4
        { pos: { x: 1, y: 4 }, goal: 'east' }, // far, dist 7
        { pos: { x: 4, y: 7 }, goal: 'south' }, // THREAT, dist 1
        { pos: { x: 7, y: 4 }, goal: 'west' }, // far, dist 7
      ],
      { current: 0 },
    );

  it('precondition: threat is real and blockable', () => {
    const s = fourPlayerThreat();
    expect(shortestPathLength(s, 2)).toBe(1);
    expect(shortestPathLength(s, 0)).toBe(4);
    // At least one legal fence lengthens seat 2's path.
    const blocking = allWallSlots().filter((w) => {
      if (!checkWallPlacement(s, w, 0).legal) return false;
      const res = applyAction(s, { type: 'wall', wall: w });
      return res.ok && shortestPathLength(res.state, 2) > 1;
    });
    expect(blocking.length).toBeGreaterThan(0);
  });

  it.each([
    ['medium', constRng(0.5)], // zero noise -> deterministic heuristic choice
    ['medium', mulberry32(41)],
    ['hard', mulberry32(42)],
  ] as const)('4p %s fences the opponent who is one step from home', (level, rng) => {
    const s = fourPlayerThreat();
    const action = chooseBotAction(s, level, rng);
    const after = mustApply(s, action);
    expect(action.type, `bot ignored the 1-step threat: ${JSON.stringify(action)}`).toBe('wall');
    expect(shortestPathLength(after, 2)).toBeGreaterThan(1);
  });

  // Same defect class in 2p: with zero noise, medium prefers a racing move
  // (score 2 - myDist) over the best blocking fence (score 2 - myDist - 0.35)
  // even though the move loses ON THE SPOT.
  it('2p medium (noise-free) does not hand the opponent the win', () => {
    const s = makeState([
      { pos: { x: 4, y: 4 }, goal: 'north' },
      { pos: { x: 4, y: 7 }, goal: 'south' },
    ]);
    expect(shortestPathLength(s, 1)).toBe(1);
    const action = chooseBotAction(s, 'medium', constRng(0.5));
    const after = mustApply(s, action);
    expect(action.type, `medium ignored the 1-step threat: ${JSON.stringify(action)}`).toBe(
      'wall',
    );
    expect(shortestPathLength(after, 1)).toBeGreaterThan(1);
  });
});
