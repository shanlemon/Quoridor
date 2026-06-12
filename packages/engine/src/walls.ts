import type { Cell, Edge, GameState, Wall } from './types';
import { WALL_GRID } from './types';
import { addCells, cellKey, DIRS, inBounds, isBlocked, isGoalCell, wallKey, wallSetOf } from './board';

export function wallInBounds(w: Wall): boolean {
  return w.x >= 0 && w.x < WALL_GRID && w.y >= 0 && w.y < WALL_GRID;
}

/** Structural conflicts only: same slot, crossing at the same intersection, or overlapping span. */
export function wallConflicts(existing: ReadonlySet<string>, w: Wall): boolean {
  if (existing.has(wallKey(w))) return true;
  // A perpendicular wall on the same intersection would cross it.
  if (existing.has(`${w.o === 'h' ? 'v' : 'h'}${w.x},${w.y}`)) return true;
  // Same-orientation walls one slot over share a cell span.
  if (w.o === 'h') {
    return existing.has(`h${w.x - 1},${w.y}`) || existing.has(`h${w.x + 1},${w.y}`);
  }
  return existing.has(`v${w.x},${w.y - 1}`) || existing.has(`v${w.x},${w.y + 1}`);
}

/** BFS over cells (walls block, pawns are ignored) to any cell of the goal edge. */
export function hasPathToGoal(walls: ReadonlySet<string>, from: Cell, goal: Edge): boolean {
  if (isGoalCell(from, goal)) return true;
  const visited = new Set<string>([cellKey(from)]);
  const queue: Cell[] = [from];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    for (const d of DIRS) {
      const nxt = addCells(cur, d);
      if (!inBounds(nxt)) continue;
      const k = cellKey(nxt);
      if (visited.has(k) || isBlocked(walls, cur, nxt)) continue;
      if (isGoalCell(nxt, goal)) return true;
      visited.add(k);
      queue.push(nxt);
    }
  }
  return false;
}

export type WallCheck =
  | { readonly legal: true }
  | {
      readonly legal: false;
      readonly reason: 'NO_WALLS_LEFT' | 'WALL_OUT_OF_BOUNDS' | 'WALL_OVERLAPS' | 'WALL_BLOCKS_PATH';
      /** Seats that would lose all paths to their goal (only for WALL_BLOCKS_PATH). */
      readonly trapped: readonly number[];
    };

/**
 * Full legality check for placing `wall` as `playerIndex` (defaults to the current player):
 * walls remaining, bounds, structural conflicts, and a path-to-goal check for EVERY player.
 */
export function checkWallPlacement(
  state: GameState,
  wall: Wall,
  playerIndex: number = state.current,
): WallCheck {
  const me = state.players[playerIndex];
  if (!me || me.wallsLeft <= 0) return { legal: false, reason: 'NO_WALLS_LEFT', trapped: [] };
  if (!wallInBounds(wall)) return { legal: false, reason: 'WALL_OUT_OF_BOUNDS', trapped: [] };

  const walls = wallSetOf(state.walls);
  if (wallConflicts(walls, wall)) return { legal: false, reason: 'WALL_OVERLAPS', trapped: [] };

  walls.add(wallKey(wall));
  const trapped = state.players
    .filter((p) => !hasPathToGoal(walls, p.pos, p.goal))
    .map((p) => p.seat);
  if (trapped.length > 0) return { legal: false, reason: 'WALL_BLOCKS_PATH', trapped };

  return { legal: true };
}

/** Every wall the given player (defaults to current) could legally place right now. */
export function getLegalWallSlots(state: GameState, playerIndex: number = state.current): Wall[] {
  const out: Wall[] = [];
  const me = state.players[playerIndex];
  if (state.status !== 'playing' || !me || me.wallsLeft <= 0) return out;
  for (const o of ['h', 'v'] as const) {
    for (let y = 0; y < WALL_GRID; y++) {
      for (let x = 0; x < WALL_GRID; x++) {
        const w: Wall = { x, y, o };
        if (checkWallPlacement(state, w, playerIndex).legal) out.push(w);
      }
    }
  }
  return out;
}
