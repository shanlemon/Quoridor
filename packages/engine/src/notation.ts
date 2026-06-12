import type { Action, Cell, Wall } from './types';
import { BOARD_SIZE, WALL_GRID } from './types';

const COLS = 'abcdefghi';

/**
 * Cells use chess-like notation: column letter a–i (x 0–8 left to right),
 * row number 1–9 counting from the SOUTH edge (so y=8 is row 1, y=0 is row 9).
 */
export function cellToNotation(c: Cell): string {
  return `${COLS[c.x]}${BOARD_SIZE - c.y}`;
}

export function parseCell(s: string): Cell | null {
  const m = /^([a-i])([1-9])$/.exec(s.trim().toLowerCase());
  if (!m) return null;
  return { x: COLS.indexOf(m[1]), y: BOARD_SIZE - Number(m[2]) };
}

/**
 * Walls: column letter of the LEFT column of the span (a–h), row number of the
 * SOUTHERN row of the span (1–8), then 'h' or 'v'. E.g. "e3h".
 */
export function wallToNotation(w: Wall): string {
  return `${COLS[w.x]}${WALL_GRID - w.y}${w.o}`;
}

export function parseWall(s: string): Wall | null {
  const m = /^([a-h])([1-8])([hv])$/.exec(s.trim().toLowerCase());
  if (!m) return null;
  return { x: COLS.indexOf(m[1]), y: WALL_GRID - Number(m[2]), o: m[3] as Wall['o'] };
}

export function actionToNotation(action: Action): string {
  switch (action.type) {
    case 'move':
      return cellToNotation(action.to);
    case 'wall':
      return wallToNotation(action.wall);
    case 'pass':
      return 'pass';
  }
}
