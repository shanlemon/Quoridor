import type { Action, ActionResult, Cell, Edge, GameState } from './types';
import { CHARACTERS } from './types';
import { cellEq, isGoalCell, wallSetOf } from './board';
import { getLegalMoves } from './moves';
import { checkWallPlacement, getLegalWallSlots } from './walls';
import { distanceField } from './path';

export type PlayerCount = 2 | 3 | 4;

export interface GameOptions {
  /** Override the per-rules default wall count (2p: 10, 3p: 7, 4p: 5). */
  readonly wallsPerPlayer?: number;
}

interface SeatSpec {
  readonly pos: Cell;
  readonly goal: Edge;
}

const SOUTH: SeatSpec = { pos: { x: 4, y: 8 }, goal: 'north' };
const WEST: SeatSpec = { pos: { x: 0, y: 4 }, goal: 'east' };
const NORTH: SeatSpec = { pos: { x: 4, y: 0 }, goal: 'south' };
const EAST: SeatSpec = { pos: { x: 8, y: 4 }, goal: 'west' };

/** Seats are in clockwise turn order. 3p is the 4p layout minus the east seat. */
const LAYOUTS: Record<PlayerCount, readonly SeatSpec[]> = {
  2: [SOUTH, NORTH],
  3: [SOUTH, WEST, NORTH],
  4: [SOUTH, WEST, NORTH, EAST],
};

const DEFAULT_WALLS: Record<PlayerCount, number> = { 2: 10, 3: 7, 4: 5 };

export function createGame(numPlayers: PlayerCount, options: GameOptions = {}): GameState {
  const layout = LAYOUTS[numPlayers];
  if (!layout) throw new RangeError(`createGame: numPlayers must be 2, 3 or 4 (got ${numPlayers})`);
  const wallsPerPlayer = options.wallsPerPlayer ?? DEFAULT_WALLS[numPlayers];
  if (!Number.isInteger(wallsPerPlayer) || wallsPerPlayer < 0) {
    throw new RangeError(`createGame: invalid wallsPerPlayer ${wallsPerPlayer}`);
  }
  return {
    players: layout.map((spec, i) => ({
      seat: i,
      character: CHARACTERS[i],
      pos: spec.pos,
      wallsLeft: wallsPerPlayer,
      goal: spec.goal,
    })),
    walls: [],
    current: 0,
    turnSeq: 0,
    status: 'playing',
    winner: null,
  };
}

/**
 * Validate and apply an action for the CURRENT player. Returns a new state
 * (the input state is never mutated) or a typed error.
 */
export function applyAction(state: GameState, action: Action): ActionResult {
  if (state.status !== 'playing') return { ok: false, error: 'GAME_OVER' };
  const idx = state.current;
  const me = state.players[idx];
  const nextIdx = (idx + 1) % state.players.length;

  switch (action.type) {
    case 'move': {
      const legal = getLegalMoves(state, idx).some((c) => cellEq(c, action.to));
      if (!legal) return { ok: false, error: 'ILLEGAL_MOVE' };
      const players = state.players.map((p, i) => (i === idx ? { ...p, pos: action.to } : p));
      const won = isGoalCell(action.to, me.goal);
      return {
        ok: true,
        state: {
          ...state,
          players,
          current: won ? idx : nextIdx,
          turnSeq: state.turnSeq + 1,
          status: won ? 'finished' : 'playing',
          winner: won ? idx : null,
        },
      };
    }
    case 'wall': {
      const check = checkWallPlacement(state, action.wall, idx);
      if (!check.legal) return { ok: false, error: check.reason };
      const players = state.players.map((p, i) =>
        i === idx ? { ...p, wallsLeft: p.wallsLeft - 1 } : p,
      );
      return {
        ok: true,
        state: {
          ...state,
          players,
          walls: [...state.walls, action.wall],
          current: nextIdx,
          turnSeq: state.turnSeq + 1,
        },
      };
    }
    case 'pass': {
      if (getLegalMoves(state, idx).length > 0 || getLegalWallSlots(state, idx).length > 0) {
        return { ok: false, error: 'PASS_NOT_ALLOWED' };
      }
      return {
        ok: true,
        state: { ...state, current: nextIdx, turnSeq: state.turnSeq + 1 },
      };
    }
  }
}

export interface Ranking {
  readonly seat: number;
  /** 1-based; tied players (same remaining distance) share a rank. */
  readonly rank: number;
  /** Remaining shortest-path distance to goal (0 for the winner). */
  readonly distance: number;
}

/** Final placements: winner first, everyone else by remaining shortest-path distance. */
export function rankPlayers(state: GameState): Ranking[] {
  const walls = wallSetOf(state.walls);
  const entries = state.players.map((p) => ({
    seat: p.seat,
    distance: distanceField(walls, p.goal)[p.pos.y][p.pos.x],
    isWinner: state.winner === p.seat,
  }));
  entries.sort((a, b) => {
    if (a.isWinner !== b.isWinner) return a.isWinner ? -1 : 1;
    if (a.distance !== b.distance) return a.distance - b.distance;
    return a.seat - b.seat;
  });
  const out: Ranking[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const prev = entries[i - 1];
    const prevRank = out[i - 1]?.rank ?? 1;
    const tied = prev && !prev.isWinner && !e.isWinner && prev.distance === e.distance;
    out.push({ seat: e.seat, rank: tied ? prevRank : i + 1, distance: e.distance });
  }
  return out;
}
