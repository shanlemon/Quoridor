import type { Cell, GameState } from './types';
import { addCells, cellKey, DIRS, inBounds, isBlocked, wallSetOf } from './board';

/**
 * All legal pawn destinations for `playerIndex`, including straight jumps over an
 * adjacent pawn and the diagonal side-steps used when a straight jump is impossible
 * (wall behind, board edge behind, or a second pawn behind — no double jumps).
 */
export function getLegalMoves(state: GameState, playerIndex: number): Cell[] {
  if (state.status !== 'playing') return [];
  const me = state.players[playerIndex];
  if (!me) throw new RangeError(`getLegalMoves: no player at index ${playerIndex}`);

  const walls = wallSetOf(state.walls);
  const occupied = new Set(state.players.map((p) => cellKey(p.pos)));

  const out: Cell[] = [];
  const seen = new Set<string>();
  const push = (c: Cell): void => {
    const k = cellKey(c);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(c);
    }
  };

  for (const d of DIRS) {
    const adj = addCells(me.pos, d);
    if (!inBounds(adj) || isBlocked(walls, me.pos, adj)) continue;

    if (!occupied.has(cellKey(adj))) {
      push(adj);
      continue;
    }

    // A pawn faces us: try the straight jump first.
    const beyond = addCells(adj, d);
    if (inBounds(beyond) && !isBlocked(walls, adj, beyond) && !occupied.has(cellKey(beyond))) {
      push(beyond);
      continue;
    }

    // Straight jump impossible — diagonal side-steps beside the facing pawn.
    const perps: readonly Cell[] =
      d.x === 0
        ? [
            { x: 1, y: 0 },
            { x: -1, y: 0 },
          ]
        : [
            { x: 0, y: 1 },
            { x: 0, y: -1 },
          ];
    for (const p of perps) {
      const diag = addCells(adj, p);
      if (!inBounds(diag)) continue;
      if (isBlocked(walls, adj, diag)) continue;
      if (occupied.has(cellKey(diag))) continue;
      push(diag);
    }
  }

  return out;
}
