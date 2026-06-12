import type { Cell, Edge, GameState, Wall } from '../src/index';
import { CHARACTERS } from '../src/index';

export interface PlayerSpec {
  pos: Cell;
  goal: Edge;
  wallsLeft?: number;
}

/** Build an arbitrary mid-game state for scenario tests (no legality checks applied). */
export function makeState(
  players: PlayerSpec[],
  opts: { walls?: Wall[]; current?: number; status?: GameState['status']; winner?: number | null } = {},
): GameState {
  return {
    players: players.map((p, i) => ({
      seat: i,
      character: CHARACTERS[i],
      pos: p.pos,
      wallsLeft: p.wallsLeft ?? 10,
      goal: p.goal,
    })),
    walls: opts.walls ?? [],
    current: opts.current ?? 0,
    turnSeq: 0,
    status: opts.status ?? 'playing',
    winner: opts.winner ?? null,
  };
}

export function sortCells(cells: readonly Cell[]): string[] {
  return cells.map((c) => `${c.x},${c.y}`).sort();
}

export function cells(...pairs: Array<[number, number]>): string[] {
  return sortCells(pairs.map(([x, y]) => ({ x, y })));
}
