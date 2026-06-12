import { describe, expect, it } from 'vitest';
import {
  actionToNotation,
  cellToNotation,
  parseCell,
  parseWall,
  wallToNotation,
} from '../src/index';
import type { Cell, Wall } from '../src/index';

describe('cell notation', () => {
  it('maps corners and start cells correctly', () => {
    expect(cellToNotation({ x: 4, y: 8 })).toBe('e1'); // P1 start (south)
    expect(cellToNotation({ x: 4, y: 0 })).toBe('e9'); // P2 start (north)
    expect(cellToNotation({ x: 0, y: 0 })).toBe('a9');
    expect(cellToNotation({ x: 8, y: 8 })).toBe('i1');
  });

  it('round-trips every cell', () => {
    for (let x = 0; x < 9; x++) {
      for (let y = 0; y < 9; y++) {
        const c: Cell = { x, y };
        expect(parseCell(cellToNotation(c))).toEqual(c);
      }
    }
  });

  it('rejects malformed cells', () => {
    expect(parseCell('z3')).toBeNull();
    expect(parseCell('e0')).toBeNull();
    expect(parseCell('e10')).toBeNull();
    expect(parseCell('')).toBeNull();
  });
});

describe('wall notation', () => {
  it('round-trips every wall slot', () => {
    for (const o of ['h', 'v'] as const) {
      for (let x = 0; x < 8; x++) {
        for (let y = 0; y < 8; y++) {
          const w: Wall = { x, y, o };
          expect(parseWall(wallToNotation(w))).toEqual(w);
        }
      }
    }
  });

  it('rejects malformed walls', () => {
    expect(parseWall('i3h')).toBeNull();
    expect(parseWall('e9h')).toBeNull();
    expect(parseWall('e3x')).toBeNull();
  });
});

describe('actionToNotation', () => {
  it('formats all action types', () => {
    expect(actionToNotation({ type: 'move', to: { x: 4, y: 7 } })).toBe('e2');
    expect(actionToNotation({ type: 'wall', wall: { x: 4, y: 5, o: 'h' } })).toBe('e3h');
    expect(actionToNotation({ type: 'pass' })).toBe('pass');
  });
});
