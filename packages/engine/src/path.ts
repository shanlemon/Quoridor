import type { Cell, Edge, GameState } from './types';
import { BOARD_SIZE } from './types';
import { addCells, DIRS, inBounds, isBlocked, isGoalCell, wallSetOf } from './board';
import { getLegalMoves } from './moves';

/**
 * Distance (in pawn steps, ignoring pawns) from every cell to the given goal edge.
 * Unreachable cells are Infinity. Indexed as field[y][x].
 */
export function distanceField(walls: ReadonlySet<string>, goal: Edge): number[][] {
  const field: number[][] = Array.from({ length: BOARD_SIZE }, () =>
    new Array<number>(BOARD_SIZE).fill(Infinity),
  );
  const queue: Cell[] = [];
  for (let y = 0; y < BOARD_SIZE; y++) {
    for (let x = 0; x < BOARD_SIZE; x++) {
      const c = { x, y };
      if (isGoalCell(c, goal)) {
        field[y][x] = 0;
        queue.push(c);
      }
    }
  }
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    for (const d of DIRS) {
      const nxt = addCells(cur, d);
      if (!inBounds(nxt) || isBlocked(walls, cur, nxt)) continue;
      if (field[nxt.y][nxt.x] !== Infinity) continue;
      field[nxt.y][nxt.x] = field[cur.y][cur.x] + 1;
      queue.push(nxt);
    }
  }
  return field;
}

/** Shortest number of pawn steps (ignoring pawns) from a player's position to their goal edge. */
export function shortestPathLength(state: GameState, playerIndex: number): number {
  const me = state.players[playerIndex];
  if (!me) throw new RangeError(`shortestPathLength: no player at index ${playerIndex}`);
  const field = distanceField(wallSetOf(state.walls), me.goal);
  return field[me.pos.y][me.pos.x];
}

/**
 * The legal pawn move that gets the player closest to their goal — used for
 * turn-timer auto-moves and the disconnect AI. Deterministic tie-break
 * (first in N/E/S/W + jump enumeration order). Null if the player cannot move.
 */
export function bestAutoMove(state: GameState, playerIndex: number): Cell | null {
  const moves = getLegalMoves(state, playerIndex);
  if (moves.length === 0) return null;
  const me = state.players[playerIndex];
  const field = distanceField(wallSetOf(state.walls), me.goal);
  let best = moves[0];
  for (const m of moves) {
    if (field[m.y][m.x] < field[best.y][best.x]) best = m;
  }
  return best;
}
