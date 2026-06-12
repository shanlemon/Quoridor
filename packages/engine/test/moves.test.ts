import { describe, expect, it } from 'vitest';
import { createGame, getLegalMoves } from '../src/index';
import { cells, makeState, sortCells } from './helpers';

describe('basic pawn movement', () => {
  it('allows 4 orthogonal moves from an open center cell', () => {
    const s = makeState([
      { pos: { x: 4, y: 4 }, goal: 'north' },
      { pos: { x: 0, y: 0 }, goal: 'south' },
    ]);
    expect(sortCells(getLegalMoves(s, 0))).toEqual(cells([3, 4], [5, 4], [4, 3], [4, 5]));
  });

  it('clips moves at board corners', () => {
    const s = makeState([
      { pos: { x: 0, y: 0 }, goal: 'south' },
      { pos: { x: 8, y: 8 }, goal: 'north' },
    ]);
    expect(sortCells(getLegalMoves(s, 0))).toEqual(cells([1, 0], [0, 1]));
  });

  it('walls block movement in all four directions', () => {
    const s = makeState(
      [
        { pos: { x: 4, y: 4 }, goal: 'north' },
        { pos: { x: 0, y: 0 }, goal: 'south' },
      ],
      {
        walls: [
          { x: 4, y: 3, o: 'h' }, // blocks north (rows 3|4, cols 4-5)
          { x: 3, y: 4, o: 'h' }, // blocks south? no — rows 4|5, cols 3-4 → blocks south
          { x: 4, y: 4, o: 'v' }, // blocks east (cols 4|5, rows 4-5)
          { x: 3, y: 3, o: 'v' }, // blocks west (cols 3|4, rows 3-4)
        ],
      },
    );
    expect(getLegalMoves(s, 0)).toEqual([]);
  });

  it('a wall only blocks the two columns it spans', () => {
    const s = makeState([
      { pos: { x: 6, y: 4 }, goal: 'north' },
      { pos: { x: 0, y: 0 }, goal: 'south' },
    ]);
    // h wall at cols 3-4, rows 3|4 — far from pawn at x=6
    const withWall = { ...s, walls: [{ x: 3, y: 3, o: 'h' as const }] };
    expect(sortCells(getLegalMoves(withWall, 0))).toEqual(cells([5, 4], [7, 4], [6, 3], [6, 5]));
  });

  it('returns no moves when the game is finished', () => {
    const s = makeState(
      [
        { pos: { x: 4, y: 0 }, goal: 'north' },
        { pos: { x: 4, y: 8 }, goal: 'south' },
      ],
      { status: 'finished', winner: 0 },
    );
    expect(getLegalMoves(s, 0)).toEqual([]);
  });

  it('throws for an out-of-range player index', () => {
    expect(() => getLegalMoves(createGame(2), 5)).toThrow(RangeError);
  });
});

describe('jumping', () => {
  it('jumps straight over an adjacent pawn (and diagonals are NOT offered)', () => {
    const s = makeState([
      { pos: { x: 4, y: 4 }, goal: 'north' },
      { pos: { x: 4, y: 3 }, goal: 'south' },
    ]);
    const moves = sortCells(getLegalMoves(s, 0));
    expect(moves).toEqual(cells([4, 2], [3, 4], [5, 4], [4, 5]));
    expect(moves).not.toContain('4,3'); // cannot land on the pawn
    expect(moves).not.toContain('3,3'); // no diagonal when straight jump works
  });

  it('offers diagonals when a wall sits behind the facing pawn', () => {
    const s = makeState(
      [
        { pos: { x: 4, y: 4 }, goal: 'north' },
        { pos: { x: 4, y: 3 }, goal: 'south' },
      ],
      { walls: [{ x: 4, y: 2, o: 'h' }] }, // blocks (4,3)->(4,2)
    );
    expect(sortCells(getLegalMoves(s, 0))).toEqual(
      cells([3, 3], [5, 3], [3, 4], [5, 4], [4, 5]),
    );
  });

  it('offers diagonals when the board edge is behind the facing pawn', () => {
    const s = makeState([
      { pos: { x: 4, y: 1 }, goal: 'north' },
      { pos: { x: 4, y: 0 }, goal: 'south' },
    ]);
    expect(sortCells(getLegalMoves(s, 0))).toEqual(
      cells([3, 0], [5, 0], [3, 1], [5, 1], [4, 2]),
    );
  });

  it('never double-jumps over two pawns in a line — diagonals only', () => {
    const s = makeState([
      { pos: { x: 4, y: 4 }, goal: 'north' },
      { pos: { x: 4, y: 3 }, goal: 'south' },
      { pos: { x: 4, y: 2 }, goal: 'south' },
    ]);
    const moves = sortCells(getLegalMoves(s, 0));
    expect(moves).toEqual(cells([3, 3], [5, 3], [3, 4], [5, 4], [4, 5]));
    expect(moves).not.toContain('4,2');
    expect(moves).not.toContain('4,1');
  });

  it('excludes a diagonal blocked by a wall', () => {
    const s = makeState(
      [
        { pos: { x: 4, y: 4 }, goal: 'north' },
        { pos: { x: 4, y: 3 }, goal: 'south' },
      ],
      {
        walls: [
          { x: 3, y: 2, o: 'h' }, // blocks straight jump (4,3)->(4,2)
          { x: 4, y: 2, o: 'v' }, // blocks east diagonal (4,3)->(5,3)
        ],
      },
    );
    expect(sortCells(getLegalMoves(s, 0))).toEqual(cells([3, 3], [3, 4], [5, 4], [4, 5]));
  });

  it('excludes a diagonal occupied by a third pawn', () => {
    const s = makeState(
      [
        { pos: { x: 4, y: 4 }, goal: 'north' },
        { pos: { x: 4, y: 3 }, goal: 'south' },
        { pos: { x: 3, y: 3 }, goal: 'east' },
      ],
      { walls: [{ x: 3, y: 2, o: 'h' }] }, // blocks straight jump
    );
    const moves = sortCells(getLegalMoves(s, 0));
    expect(moves).toContain('5,3');
    expect(moves).not.toContain('3,3');
  });

  it('dedupes a diagonal reachable around two different pawns', () => {
    const s = makeState(
      [
        { pos: { x: 4, y: 4 }, goal: 'north' },
        { pos: { x: 4, y: 3 }, goal: 'south' }, // north neighbor
        { pos: { x: 5, y: 4 }, goal: 'west' }, // east neighbor
      ],
      {
        walls: [
          { x: 3, y: 2, o: 'h' }, // blocks jump over north pawn
          { x: 5, y: 3, o: 'v' }, // blocks jump over east pawn
        ],
      },
    );
    const moves = getLegalMoves(s, 0);
    const keys = moves.map((c) => `${c.x},${c.y}`);
    expect(new Set(keys).size).toBe(keys.length); // unique
    expect(sortCells(moves)).toEqual(cells([3, 3], [5, 3], [5, 5], [3, 4], [4, 5]));
  });

  it('jump can land on the goal edge (win by jump)', () => {
    const s = makeState([
      { pos: { x: 4, y: 2 }, goal: 'north' },
      { pos: { x: 4, y: 1 }, goal: 'south' },
    ]);
    expect(sortCells(getLegalMoves(s, 0))).toContain('4,0');
  });

  it('a wall between me and the facing pawn prevents the jump entirely', () => {
    const s = makeState(
      [
        { pos: { x: 4, y: 4 }, goal: 'north' },
        { pos: { x: 4, y: 3 }, goal: 'south' },
      ],
      { walls: [{ x: 4, y: 3, o: 'h' }] }, // between (4,4) and (4,3)
    );
    expect(sortCells(getLegalMoves(s, 0))).toEqual(cells([3, 4], [5, 4], [4, 5]));
  });
});
