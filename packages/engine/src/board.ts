import type { Cell, Edge, Wall } from './types';
import { BOARD_SIZE } from './types';

/** North, east, south, west — in that order (deterministic for tie-breaks). */
export const DIRS: readonly Cell[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

export function inBounds(c: Cell): boolean {
  return c.x >= 0 && c.x < BOARD_SIZE && c.y >= 0 && c.y < BOARD_SIZE;
}

export function cellEq(a: Cell, b: Cell): boolean {
  return a.x === b.x && a.y === b.y;
}

export function cellKey(c: Cell): string {
  return `${c.x},${c.y}`;
}

export function addCells(a: Cell, b: Cell): Cell {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function wallKey(w: Wall): string {
  return `${w.o}${w.x},${w.y}`;
}

export function wallSetOf(walls: readonly Wall[]): Set<string> {
  return new Set(walls.map(wallKey));
}

/**
 * Whether a wall blocks stepping from `from` to `to`.
 * The two cells MUST be orthogonally adjacent and in bounds.
 */
export function isBlocked(walls: ReadonlySet<string>, from: Cell, to: Cell): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dy === 1 && dx === 0) {
    return walls.has(`h${from.x - 1},${from.y}`) || walls.has(`h${from.x},${from.y}`);
  }
  if (dy === -1 && dx === 0) {
    return walls.has(`h${from.x - 1},${to.y}`) || walls.has(`h${from.x},${to.y}`);
  }
  if (dx === 1 && dy === 0) {
    return walls.has(`v${from.x},${from.y - 1}`) || walls.has(`v${from.x},${from.y}`);
  }
  if (dx === -1 && dy === 0) {
    return walls.has(`v${to.x},${from.y - 1}`) || walls.has(`v${to.x},${from.y}`);
  }
  throw new Error(`isBlocked: cells are not adjacent: ${cellKey(from)} -> ${cellKey(to)}`);
}

export function isGoalCell(c: Cell, goal: Edge): boolean {
  switch (goal) {
    case 'north':
      return c.y === 0;
    case 'south':
      return c.y === BOARD_SIZE - 1;
    case 'west':
      return c.x === 0;
    case 'east':
      return c.x === BOARD_SIZE - 1;
  }
}
