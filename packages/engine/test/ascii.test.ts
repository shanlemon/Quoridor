import { describe, expect, it } from 'vitest';
import { applyAction, createGame, renderAscii } from '../src/index';

describe('renderAscii', () => {
  it('shows pawns, axes, and wall segments', () => {
    const s0 = createGame(2);
    const res = applyAction(s0, { type: 'wall', wall: { x: 4, y: 4, o: 'h' } });
    if (!res.ok) throw new Error(res.error);
    const res2 = applyAction(res.state, { type: 'wall', wall: { x: 2, y: 2, o: 'v' } });
    if (!res2.ok) throw new Error(res2.error);

    const text = renderAscii(res2.state);
    expect(text).toContain('1'); // pawn for seat 0 (and row numbers)
    expect(text).toContain('2');
    expect(text).toContain('───'); // horizontal wall segment
    expect(text).toContain('│'); // vertical wall segment
    expect(text).toContain('a'); // column footer
    expect(text.split('\n')).toHaveLength(18); // 9 cell rows + 8 separators + footer
  });
});
