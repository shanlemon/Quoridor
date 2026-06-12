import type { GameState } from './types';
import { BOARD_SIZE } from './types';
import { isBlocked, wallSetOf } from './board';

/**
 * Render the board as text for the CLI playtest and debugging.
 * Pawns are 1-based seat digits; walls draw as │ and ─── segments.
 */
export function renderAscii(state: GameState): string {
  const walls = wallSetOf(state.walls);
  const pawnAt = new Map<string, number>();
  for (const p of state.players) pawnAt.set(`${p.pos.x},${p.pos.y}`, p.seat + 1);

  const lines: string[] = [];
  for (let y = 0; y < BOARD_SIZE; y++) {
    let row = `${BOARD_SIZE - y} `.padStart(3);
    for (let x = 0; x < BOARD_SIZE; x++) {
      const pawn = pawnAt.get(`${x},${y}`);
      row += ` ${pawn ?? '·'} `;
      if (x < BOARD_SIZE - 1) {
        row += isBlocked(walls, { x, y }, { x: x + 1, y }) ? '│' : ' ';
      }
    }
    lines.push(row);
    if (y < BOARD_SIZE - 1) {
      let sep = '   ';
      for (let x = 0; x < BOARD_SIZE; x++) {
        sep += isBlocked(walls, { x, y }, { x, y: y + 1 }) ? '───' : '   ';
        if (x < BOARD_SIZE - 1) sep += ' ';
      }
      lines.push(sep);
    }
  }
  let footer = '   ';
  for (let x = 0; x < BOARD_SIZE; x++) footer += ` ${'abcdefghi'[x]}  `;
  lines.push(footer.trimEnd());
  return lines.join('\n');
}
