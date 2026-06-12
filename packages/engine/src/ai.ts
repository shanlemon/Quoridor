import type { Action, Edge, GameState, PlayerState } from './types';
import { WALL_GRID } from './types';
import { cellEq, isGoalCell, wallKey, wallSetOf } from './board';
import { getLegalMoves } from './moves';
import { checkWallPlacement } from './walls';
import { bestAutoMove, distanceField } from './path';
import { applyAction } from './game';

/**
 * Bot difficulty ladder:
 * - easy   ("Sprout"): races its own shortest path, never places fences,
 *           occasionally wanders — beatable by kids.
 * - medium ("Smart"):  greedy margin heuristic over every move and fence,
 *           with a little noise so games vary.
 * - hard   ("Genius"): same heuristic, no noise, plus a one-ply look-ahead
 *           against the opponent's best greedy reply when the race is tight.
 */
export type BotLevel = 'easy' | 'medium' | 'hard';

interface Candidate {
  readonly action: Action;
  score: number;
}

/** Distance to goal for a player given a wall set, with per-goal field caching. */
function distOf(
  walls: ReadonlySet<string>,
  p: PlayerState,
  cache: Map<Edge, number[][]>,
): number {
  let field = cache.get(p.goal);
  if (!field) {
    field = distanceField(walls, p.goal);
    cache.set(p.goal, field);
  }
  return field[p.pos.y][p.pos.x];
}

/** Margin from `seat`'s perspective: closest opponent's distance minus ours. */
function margin(state: GameState, seat: number): number {
  const walls = wallSetOf(state.walls);
  const cache = new Map<Edge, number[][]>();
  const myDist = distOf(walls, state.players[seat], cache);
  let oppDist = Infinity;
  for (const p of state.players) {
    if (p.seat !== seat) oppDist = Math.min(oppDist, distOf(walls, p, cache));
  }
  return oppDist - myDist;
}

/** Flat cost for spending a fence — keeps bots from burning walls on +1 detours. */
const WALL_SPEND_COST = 0.35;

/**
 * Score every candidate action for `seat`. Moves are scored by the resulting
 * race margin; fences additionally pay WALL_SPEND_COST. Fences are only
 * considered when the race is close (not comfortably ahead) — pure racing is
 * stronger when far in front, and it conserves fences for the endgame.
 */
function candidates(state: GameState, seat: number): Candidate[] {
  const walls = wallSetOf(state.walls);
  const me = state.players[seat];
  const cache = new Map<Edge, number[][]>();
  const myField = distanceField(walls, me.goal);
  cache.set(me.goal, myField);
  const myDist = myField[me.pos.y][me.pos.x];
  let oppDist = Infinity;
  for (const p of state.players) {
    if (p.seat !== seat) oppDist = Math.min(oppDist, distOf(walls, p, cache));
  }

  const out: Candidate[] = [];
  for (const m of getLegalMoves(state, seat)) {
    out.push({ action: { type: 'move', to: m }, score: oppDist - myField[m.y][m.x] });
  }

  // Fences are considered when the race is close — or ALWAYS when there is no
  // pawn move at all (a pawn-boxed bot with fences in hand may not pass).
  const considerWalls = me.wallsLeft > 0 && (out.length === 0 || oppDist <= myDist + 2);
  if (considerWalls) {
    for (const o of ['h', 'v'] as const) {
      for (let y = 0; y < WALL_GRID; y++) {
        for (let x = 0; x < WALL_GRID; x++) {
          const wall = { x, y, o };
          if (!checkWallPlacement(state, wall, seat).legal) continue;
          const withWall = new Set(walls);
          withWall.add(wallKey(wall));
          const wallCache = new Map<Edge, number[][]>();
          const newMyDist = distOf(withWall, me, wallCache);
          let newOppDist = Infinity;
          for (const p of state.players) {
            if (p.seat !== seat) newOppDist = Math.min(newOppDist, distOf(withWall, p, wallCache));
          }
          out.push({
            action: { type: 'wall', wall },
            score: newOppDist - newMyDist - WALL_SPEND_COST,
          });
        }
      }
    }
  }
  return out;
}

/** Stable ordering: best score first; moves before fences on ties. */
function byScore(a: Candidate, b: Candidate): number {
  if (b.score !== a.score) return b.score - a.score;
  const rank = (c: Candidate): number => (c.action.type === 'move' ? 0 : 1);
  return rank(a) - rank(b);
}

function bestGreedy(state: GameState): Action | null {
  const cands = candidates(state, state.current);
  if (cands.length === 0) return null;
  cands.sort(byScore);
  return cands[0].action;
}

/**
 * Urgent defense: if any opponent can win on their very next turn (distance 1
 * — and every opponent moves before we act again), pure margin scoring can
 * still prefer a racing move that loses on the spot. Return the fence that
 * maximizes the closest threat's new distance (tie-break: hurt ourselves
 * least), or null when no fence improves the situation.
 */
function bestDefensiveWall(state: GameState, seat: number): Action | null {
  const me = state.players[seat];
  if (me.wallsLeft === 0) return null;
  const walls = wallSetOf(state.walls);
  const cache = new Map<Edge, number[][]>();
  const threats = state.players.filter(
    (p) => p.seat !== seat && distOf(walls, p, cache) <= 1,
  );
  if (threats.length === 0) return null;

  let best: Action | null = null;
  let bestScore = -Infinity;
  for (const o of ['h', 'v'] as const) {
    for (let y = 0; y < WALL_GRID; y++) {
      for (let x = 0; x < WALL_GRID; x++) {
        const wall = { x, y, o };
        if (!checkWallPlacement(state, wall, seat).legal) continue;
        const withWall = new Set(walls);
        withWall.add(wallKey(wall));
        const wallCache = new Map<Edge, number[][]>();
        let minThreat = Infinity;
        for (const t of threats) minThreat = Math.min(minThreat, distOf(withWall, t, wallCache));
        if (minThreat <= 1) continue; // doesn't defuse the threat
        const score = minThreat * 100 - distOf(withWall, me, wallCache);
        if (score > bestScore) {
          bestScore = score;
          best = { type: 'wall', wall };
        }
      }
    }
  }
  return best;
}

/**
 * Pick an action for the CURRENT player. Always returns an action that
 * `applyAction` will accept ('pass' only when nothing else is legal).
 */
export function chooseBotAction(
  state: GameState,
  level: BotLevel,
  rng: () => number = Math.random,
): Action {
  const seat = state.current;
  const me = state.players[seat];
  const moves = getLegalMoves(state, seat);

  // Take an immediate win at every level.
  for (const m of moves) {
    if (isGoalCell(m, me.goal)) return { type: 'move', to: m };
  }

  if (level === 'easy') {
    const mv = bestAutoMove(state, seat);
    if (!mv) {
      // Boxed in: easy normally never fences, but pass is only legal when no
      // fence is placeable either — fall back to the least-bad legal fence.
      const stuck = candidates(state, seat);
      if (stuck.length === 0) return { type: 'pass' };
      stuck.sort(byScore);
      return stuck[0].action;
    }
    // Wander sometimes — but never backwards, and never on every-3rd turn
    // (the forced-progress beat guarantees termination even under degenerate
    // rngs that would otherwise make the bot shuffle forever).
    const mayWander = state.turnSeq % 3 !== 0 && rng() < 0.25;
    if (mayWander && moves.length > 1) {
      const walls = wallSetOf(state.walls);
      const field = distanceField(walls, me.goal);
      const myDist = field[me.pos.y][me.pos.x];
      const sideways = moves.filter((c) => !cellEq(c, mv) && field[c.y][c.x] <= myDist);
      if (sideways.length > 0) {
        return { type: 'move', to: sideways[Math.floor(rng() * sideways.length)] };
      }
    }
    return { type: 'move', to: mv };
  }

  // Forced defense beats greedy scoring: an opponent at distance 1 wins
  // before our next turn unless a fence stops them.
  const defense = bestDefensiveWall(state, seat);
  if (defense) return defense;

  const cands = candidates(state, seat);
  if (cands.length === 0) return { type: 'pass' };
  if (level === 'medium') {
    for (const c of cands) c.score += (rng() - 0.5) * 0.6;
  }
  cands.sort(byScore);

  // Hard: when the race is tight, re-rank the top candidates by the margin
  // AFTER the opponent's best greedy reply (one-ply minimax on margins).
  if (level === 'hard' && margin(state, seat) <= 2) {
    const top = cands.slice(0, 6);
    let best = top[0];
    let bestVal = -Infinity;
    for (const c of top) {
      const res = applyAction(state, c.action);
      if (!res.ok) continue;
      let val: number;
      if (res.state.status === 'finished') {
        val = Infinity;
      } else {
        const reply = bestGreedy(res.state);
        const replied = reply ? applyAction(res.state, reply) : null;
        const evalState = replied && replied.ok ? replied.state : res.state;
        val = evalState.status === 'finished' ? -Infinity : margin(evalState, seat);
      }
      if (val > bestVal) {
        bestVal = val;
        best = c;
      }
    }
    return best.action;
  }

  return cands[0].action;
}
