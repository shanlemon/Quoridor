import { describe, expect, it } from 'vitest';
import {
  bestAutoMove,
  createGame,
  distanceField,
  shortestPathLength,
  wallSetOf,
} from '../src/index';
import { makeState } from './helpers';

describe('distanceField', () => {
  it('equals row index for goal north with no walls', () => {
    const field = distanceField(wallSetOf([]), 'north');
    expect(field[0][3]).toBe(0);
    expect(field[4][4]).toBe(4);
    expect(field[8][0]).toBe(8);
  });

  it('marks sealed regions as Infinity', () => {
    const walls = wallSetOf([
      { x: 0, y: 0, o: 'h' },
      { x: 1, y: 0, o: 'v' },
    ]);
    const field = distanceField(walls, 'south');
    expect(field[0][0]).toBe(Infinity);
    expect(field[0][1]).toBe(Infinity);
    expect(field[0][2]).not.toBe(Infinity);
  });
});

describe('shortestPathLength', () => {
  it('is 8 for both players at the 2p start', () => {
    const s = createGame(2);
    expect(shortestPathLength(s, 0)).toBe(8);
    expect(shortestPathLength(s, 1)).toBe(8);
  });

  it('grows when a wall blocks the direct path', () => {
    const s = makeState(
      [
        { pos: { x: 4, y: 8 }, goal: 'north' },
        { pos: { x: 0, y: 0 }, goal: 'south' }, // different column, unaffected
      ],
      { walls: [{ x: 3, y: 7, o: 'h' }] }, // blocks (4,8)->(4,7) and (3,8)->(3,7)
    );
    expect(shortestPathLength(s, 0)).toBe(9);
    expect(shortestPathLength(s, 1)).toBe(8);
  });
});

describe('bestAutoMove', () => {
  it('steps toward the goal from the start position', () => {
    expect(bestAutoMove(createGame(2), 0)).toEqual({ x: 4, y: 7 });
    expect(bestAutoMove(createGame(2), 1)).toEqual({ x: 4, y: 1 });
  });

  it('routes around walls', () => {
    const s = makeState(
      [
        { pos: { x: 4, y: 8 }, goal: 'north' },
        { pos: { x: 4, y: 0 }, goal: 'south' },
      ],
      { walls: [{ x: 3, y: 7, o: 'h' }] },
    );
    expect(bestAutoMove(s, 0)).toEqual({ x: 5, y: 8 }); // sidestep east
  });

  it('uses jumps when they are the shortest route', () => {
    const s = makeState([
      { pos: { x: 4, y: 4 }, goal: 'north' },
      { pos: { x: 4, y: 3 }, goal: 'south' },
    ]);
    expect(bestAutoMove(s, 0)).toEqual({ x: 4, y: 2 });
  });

  it('returns null when fully boxed in', () => {
    const s = makeState(
      [
        { pos: { x: 0, y: 0 }, goal: 'south' },
        { pos: { x: 1, y: 0 }, goal: 'north' },
      ],
      {
        walls: [
          { x: 0, y: 0, o: 'h' },
          { x: 1, y: 0, o: 'v' },
        ],
      },
    );
    expect(bestAutoMove(s, 0)).toBeNull();
  });
});
