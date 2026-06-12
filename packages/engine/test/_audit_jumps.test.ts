/**
 * AUDIT: pawn movement + ALL jump rules (moves.ts getLegalMoves).
 *
 * Every expectation below is hand-derived from the official (Gigamic) Quoridor
 * rules and the documented wall geometry — NOT from the implementation.
 *
 * Geometry cheat sheet (from types.ts / board.ts docs):
 *   - cell (x,y): x 0..8 left->right, y 0..8 top->bottom. north = y0, south = y8.
 *   - wall (x,y,'h'): blocks crossing rows y|y+1 for columns x and x+1.
 *   - wall (x,y,'v'): blocks crossing columns x|x+1 for rows y and y+1.
 *
 * Jump rules under audit:
 *   - straight jump over an adjacent facing pawn in all 4 directions
 *   - diagonals offered ONLY when the straight jump is impossible
 *     (wall behind pawn, board edge behind pawn, or pawn behind pawn)
 *   - a wall between mover and the facing pawn kills the jump entirely
 *   - never a double jump over two pawns in a line
 *   - diagonals individually blocked by walls / occupied by pawns
 *   - dedupe when two different facing pawns yield the same diagonal cell
 */
import { describe, expect, it } from 'vitest';
import { getLegalMoves } from '../src/index';
import { cells, makeState, sortCells } from './helpers';

describe('straight jumps in all four directions', () => {
  it('jumps north over a facing pawn; no diagonals offered when jump is free', () => {
    // me (4,4), pawn (4,3). Straight jump -> (4,2). Sides (3,4),(5,4),(4,5).
    const s = makeState([
      { pos: { x: 4, y: 4 }, goal: 'north' },
      { pos: { x: 4, y: 3 }, goal: 'south' },
    ]);
    expect(sortCells(getLegalMoves(s, 0))).toEqual(cells([4, 2], [3, 4], [5, 4], [4, 5]));
  });

  it('jumps east over a facing pawn; no diagonals offered when jump is free', () => {
    // me (3,4), pawn (4,4). Straight jump -> (5,4). Sides (3,3),(3,5),(2,4).
    const s = makeState([
      { pos: { x: 3, y: 4 }, goal: 'east' },
      { pos: { x: 4, y: 4 }, goal: 'west' },
    ]);
    expect(sortCells(getLegalMoves(s, 0))).toEqual(cells([5, 4], [3, 3], [3, 5], [2, 4]));
  });

  it('jumps south over a facing pawn', () => {
    // me (4,4), pawn (4,5). Straight jump -> (4,6).
    const s = makeState([
      { pos: { x: 4, y: 4 }, goal: 'south' },
      { pos: { x: 4, y: 5 }, goal: 'north' },
    ]);
    expect(sortCells(getLegalMoves(s, 0))).toEqual(cells([4, 6], [4, 3], [3, 4], [5, 4]));
  });

  it('jumps west over a facing pawn', () => {
    // me (4,4), pawn (3,4). Straight jump -> (2,4).
    const s = makeState([
      { pos: { x: 4, y: 4 }, goal: 'west' },
      { pos: { x: 3, y: 4 }, goal: 'east' },
    ]);
    expect(sortCells(getLegalMoves(s, 0))).toEqual(cells([2, 4], [4, 3], [4, 5], [5, 4]));
  });

  it('an h-wall one column over does NOT block the vertical jump (off-by-one detector)', () => {
    // h(5,2) spans columns 5,6 at rows 2|3 — does not touch (4,3)->(4,2).
    const s = makeState(
      [
        { pos: { x: 4, y: 4 }, goal: 'north' },
        { pos: { x: 4, y: 3 }, goal: 'south' },
      ],
      { walls: [{ x: 5, y: 2, o: 'h' }] },
    );
    expect(sortCells(getLegalMoves(s, 0))).toEqual(cells([4, 2], [3, 4], [5, 4], [4, 5]));
  });

  it('a v-wall behind the pawn does NOT block a vertical jump (orientation detector)', () => {
    // v(4,2) blocks columns 4|5 crossings at rows 2,3 — vertical movement unaffected.
    const s = makeState(
      [
        { pos: { x: 4, y: 4 }, goal: 'north' },
        { pos: { x: 4, y: 3 }, goal: 'south' },
      ],
      { walls: [{ x: 4, y: 2, o: 'v' }] },
    );
    expect(sortCells(getLegalMoves(s, 0))).toEqual(cells([4, 2], [3, 4], [5, 4], [4, 5]));
  });

  it('straight jump can land on the goal edge (win-by-jump, horizontal)', () => {
    // me (6,4) goal east, pawn (7,4): jump -> (8,4) which is the goal column.
    const s = makeState([
      { pos: { x: 6, y: 4 }, goal: 'east' },
      { pos: { x: 7, y: 4 }, goal: 'west' },
    ]);
    expect(sortCells(getLegalMoves(s, 0))).toEqual(cells([8, 4], [6, 3], [6, 5], [5, 4]));
  });
});

describe('wall between mover and facing pawn kills the jump entirely', () => {
  it('h-wall between me and the pawn to the north: no jump, no diagonals', () => {
    // h(4,3) blocks rows 3|4 for cols 4,5 => blocks (4,4)->(4,3).
    const s = makeState(
      [
        { pos: { x: 4, y: 4 }, goal: 'north' },
        { pos: { x: 4, y: 3 }, goal: 'south' },
      ],
      { walls: [{ x: 4, y: 3, o: 'h' }] },
    );
    expect(sortCells(getLegalMoves(s, 0))).toEqual(cells([3, 4], [5, 4], [4, 5]));
  });

  it('v-wall between me and the pawn to the east: no jump, no diagonals', () => {
    // v(4,3) blocks cols 4|5 for rows 3,4 => blocks (4,4)->(5,4).
    const s = makeState(
      [
        { pos: { x: 4, y: 4 }, goal: 'east' },
        { pos: { x: 5, y: 4 }, goal: 'west' },
      ],
      { walls: [{ x: 4, y: 3, o: 'v' }] },
    );
    expect(sortCells(getLegalMoves(s, 0))).toEqual(cells([4, 3], [4, 5], [3, 4]));
  });
});

describe('diagonals when a wall sits behind the facing pawn', () => {
  it('h-wall behind north pawn: both diagonals offered', () => {
    // h(4,2) blocks (4,3)->(4,2). Diagonals (3,3),(5,3) + sides (3,4),(5,4),(4,5).
    const s = makeState(
      [
        { pos: { x: 4, y: 4 }, goal: 'north' },
        { pos: { x: 4, y: 3 }, goal: 'south' },
      ],
      { walls: [{ x: 4, y: 2, o: 'h' }] },
    );
    expect(sortCells(getLegalMoves(s, 0))).toEqual(
      cells([3, 3], [5, 3], [3, 4], [5, 4], [4, 5]),
    );
  });

  it('the FAR half of an h-wall also counts as "behind" (span detector)', () => {
    // h(3,2) spans cols 3,4 — its col-4 half blocks (4,3)->(4,2).
    const s = makeState(
      [
        { pos: { x: 4, y: 4 }, goal: 'north' },
        { pos: { x: 4, y: 3 }, goal: 'south' },
      ],
      { walls: [{ x: 3, y: 2, o: 'h' }] },
    );
    expect(sortCells(getLegalMoves(s, 0))).toEqual(
      cells([3, 3], [5, 3], [3, 4], [5, 4], [4, 5]),
    );
  });

  it('v-wall behind east pawn + h-wall blocking one diagonal (horizontal geometry)', () => {
    // me (3,4), pawn (4,4). v(4,4) blocks (4,4)->(5,4) => jump dead.
    // h(4,3) blocks (4,4)->(4,3) => north diagonal dead; south diagonal (4,5) lives.
    const s = makeState(
      [
        { pos: { x: 3, y: 4 }, goal: 'east' },
        { pos: { x: 4, y: 4 }, goal: 'west' },
      ],
      {
        walls: [
          { x: 4, y: 4, o: 'v' },
          { x: 4, y: 3, o: 'h' },
        ],
      },
    );
    expect(sortCells(getLegalMoves(s, 0))).toEqual(cells([3, 3], [4, 5], [3, 5], [2, 4]));
  });

  it('diagonal blocked by a v-wall between the jumped pawn and the diagonal cell', () => {
    // me (4,4), pawn (4,3), h(4,2) kills the jump.
    // v(4,3) blocks (4,3)->(5,3) (east diagonal) AND (4,4)->(5,4) (east side step).
    const s = makeState(
      [
        { pos: { x: 4, y: 4 }, goal: 'north' },
        { pos: { x: 4, y: 3 }, goal: 'south' },
      ],
      {
        walls: [
          { x: 4, y: 2, o: 'h' },
          { x: 4, y: 3, o: 'v' },
        ],
      },
    );
    expect(sortCells(getLegalMoves(s, 0))).toEqual(cells([3, 3], [4, 5], [3, 4]));
  });

  it('a wall beside ME does not block the diagonal (the move passes through the pawn cell)', () => {
    // me (4,4), pawn (4,3), h(4,2) kills the jump.
    // v(4,4) blocks my side step (4,4)->(5,4) but NOT the diagonal (4,3)->(5,3):
    // the diagonal hop crosses mover->pawn then pawn->lateral (standard convention).
    const s = makeState(
      [
        { pos: { x: 4, y: 4 }, goal: 'north' },
        { pos: { x: 4, y: 3 }, goal: 'south' },
      ],
      {
        walls: [
          { x: 4, y: 2, o: 'h' },
          { x: 4, y: 4, o: 'v' },
        ],
      },
    );
    expect(sortCells(getLegalMoves(s, 0))).toEqual(cells([3, 3], [5, 3], [4, 5], [3, 4]));
  });
});

describe('diagonals when the board edge is behind the facing pawn', () => {
  it('north edge behind pawn: both diagonals land on the goal row', () => {
    // me (4,1) goal north, pawn (4,0). Beyond is off-board => diagonals (3,0),(5,0).
    const s = makeState([
      { pos: { x: 4, y: 1 }, goal: 'north' },
      { pos: { x: 4, y: 0 }, goal: 'south' },
    ]);
    expect(sortCells(getLegalMoves(s, 0))).toEqual(
      cells([3, 0], [5, 0], [3, 1], [5, 1], [4, 2]),
    );
  });

  it('south edge behind pawn', () => {
    // me (4,7), pawn (4,8). Diagonals (3,8),(5,8).
    const s = makeState([
      { pos: { x: 4, y: 7 }, goal: 'south' },
      { pos: { x: 4, y: 8 }, goal: 'north' },
    ]);
    expect(sortCells(getLegalMoves(s, 0))).toEqual(
      cells([3, 8], [5, 8], [3, 7], [5, 7], [4, 6]),
    );
  });

  it('edge behind pawn with one diagonal walled off (v-wall blocks diagonal AND my side step)', () => {
    // me (4,1), pawn (4,0). v(4,0) blocks cols 4|5 rows 0,1:
    //   kills diagonal (4,0)->(5,0) and side step (4,1)->(5,1).
    const s = makeState(
      [
        { pos: { x: 4, y: 1 }, goal: 'north' },
        { pos: { x: 4, y: 0 }, goal: 'south' },
      ],
      { walls: [{ x: 4, y: 0, o: 'v' }] },
    );
    expect(sortCells(getLegalMoves(s, 0))).toEqual(cells([3, 0], [3, 1], [4, 2]));
  });

  it('edge behind pawn with one diagonal occupied by a third pawn', () => {
    // me (4,1), pawn (4,0), third pawn (3,0): only the east diagonal (5,0) remains.
    const s = makeState([
      { pos: { x: 4, y: 1 }, goal: 'north' },
      { pos: { x: 4, y: 0 }, goal: 'south' },
      { pos: { x: 3, y: 0 }, goal: 'south' },
    ]);
    expect(sortCells(getLegalMoves(s, 0))).toEqual(cells([5, 0], [3, 1], [5, 1], [4, 2]));
  });

  it('jumping ALONG the west edge with a wall behind: only the inboard diagonal exists', () => {
    // me (0,4), pawn (0,3), h(0,2) blocks (0,3)->(0,2). West diagonal (-1,3) is off-board.
    const s = makeState(
      [
        { pos: { x: 0, y: 4 }, goal: 'north' },
        { pos: { x: 0, y: 3 }, goal: 'south' },
      ],
      { walls: [{ x: 0, y: 2, o: 'h' }] },
    );
    expect(sortCells(getLegalMoves(s, 0))).toEqual(cells([1, 3], [1, 4], [0, 5]));
  });

  it('facing a pawn IN the corner: a single diagonal', () => {
    // me (1,0), pawn (0,0). Beyond (-1,0) off-board; north diagonal (0,-1) off-board.
    // Only diagonal: (0,1). Plus normal moves (2,0),(1,1).
    const s = makeState([
      { pos: { x: 1, y: 0 }, goal: 'west' },
      { pos: { x: 0, y: 0 }, goal: 'east' },
    ]);
    expect(sortCells(getLegalMoves(s, 0))).toEqual(cells([0, 1], [2, 0], [1, 1]));
  });
});

describe('pawn behind pawn: diagonals only, never a double jump', () => {
  it('two pawns in a vertical line', () => {
    // me (4,4), pawns (4,3) and (4,2). No (4,2), no (4,1). Diagonals (3,3),(5,3).
    const s = makeState([
      { pos: { x: 4, y: 4 }, goal: 'north' },
      { pos: { x: 4, y: 3 }, goal: 'south' },
      { pos: { x: 4, y: 2 }, goal: 'south' },
    ]);
    expect(sortCells(getLegalMoves(s, 0))).toEqual(
      cells([3, 3], [5, 3], [3, 4], [5, 4], [4, 5]),
    );
  });

  it('two pawns in a horizontal line', () => {
    // me (2,4), pawns (3,4),(4,4). Diagonals around the NEAR pawn: (3,3),(3,5).
    const s = makeState([
      { pos: { x: 2, y: 4 }, goal: 'east' },
      { pos: { x: 3, y: 4 }, goal: 'west' },
      { pos: { x: 4, y: 4 }, goal: 'west' },
    ]);
    expect(sortCells(getLegalMoves(s, 0))).toEqual(
      cells([3, 3], [3, 5], [2, 3], [2, 5], [1, 4]),
    );
  });

  it('two pawns in a line ALONG the edge: one diagonal, no landing on either pawn', () => {
    // me (2,0), pawns (1,0),(0,0) on the north edge. Diagonal via (1,0): (1,1) only
    // ((1,-1) is off-board). No double jump to (0,0) or beyond.
    const s = makeState([
      { pos: { x: 2, y: 0 }, goal: 'west' },
      { pos: { x: 1, y: 0 }, goal: 'east' },
      { pos: { x: 0, y: 0 }, goal: 'east' },
    ]);
    expect(sortCells(getLegalMoves(s, 0))).toEqual(cells([1, 1], [3, 0], [2, 1]));
  });

  it('L-shaped cluster: diagonal occupied by the third pawn is excluded', () => {
    // me (4,4), pawn N (4,3), pawn NE (5,3). h(4,2) kills the straight jump.
    // Diagonals via (4,3): (3,3) free, (5,3) occupied. East side (5,4) still free.
    const s = makeState(
      [
        { pos: { x: 4, y: 4 }, goal: 'north' },
        { pos: { x: 4, y: 3 }, goal: 'south' },
        { pos: { x: 5, y: 3 }, goal: 'south' },
      ],
      { walls: [{ x: 4, y: 2, o: 'h' }] },
    );
    expect(sortCells(getLegalMoves(s, 0))).toEqual(cells([3, 3], [3, 4], [5, 4], [4, 5]));
  });
});

describe('mover surrounded on multiple sides simultaneously', () => {
  it('surrounded on 3 sides with all straight jumps free: 3 jump cells + 1 plain step', () => {
    // 4-player game: me (4,4) with opponents N (4,3), E (5,4), S (4,5). West is empty.
    const s = makeState([
      { pos: { x: 4, y: 4 }, goal: 'north' },
      { pos: { x: 4, y: 3 }, goal: 'south' },
      { pos: { x: 5, y: 4 }, goal: 'west' },
      { pos: { x: 4, y: 5 }, goal: 'north' },
    ]);
    expect(sortCells(getLegalMoves(s, 0))).toEqual(cells([4, 2], [6, 4], [4, 6], [3, 4]));
  });

  it('surrounded on 3 sides with all 3 jumps walled: deduped diagonals + plain step', () => {
    // Walls: h(4,2) kills N jump, v(5,4) kills E jump, h(4,5) kills S jump.
    // N pawn diagonals: (3,3),(5,3). E pawn: (5,3) dup,(5,5). S pawn: (5,5) dup,(3,5).
    // 6 candidates collapse to 4 cells; west is a plain step (3,4).
    const s = makeState(
      [
        { pos: { x: 4, y: 4 }, goal: 'north' },
        { pos: { x: 4, y: 3 }, goal: 'south' },
        { pos: { x: 5, y: 4 }, goal: 'west' },
        { pos: { x: 4, y: 5 }, goal: 'north' },
      ],
      {
        walls: [
          { x: 4, y: 2, o: 'h' },
          { x: 5, y: 4, o: 'v' },
          { x: 4, y: 5, o: 'h' },
        ],
      },
    );
    const moves = getLegalMoves(s, 0);
    const keys = moves.map((c) => `${c.x},${c.y}`);
    expect(new Set(keys).size).toBe(keys.length); // no duplicates in the returned list
    expect(sortCells(moves)).toEqual(cells([3, 3], [5, 3], [5, 5], [3, 5], [3, 4]));
  });

  it('mixed sides: walled jump, pawn-behind-pawn, and plain steps at once', () => {
    // me (4,4), 4 players total.
    //   N: pawn (4,3), h(3,2) kills the jump (far half spans col 4) => diagonals (3,3),(5,3).
    //   S: pawn (4,5), pawn (4,6) behind => diagonals (3,5),(5,5).
    //   E/W: empty => plain steps (5,4),(3,4).
    const s = makeState(
      [
        { pos: { x: 4, y: 4 }, goal: 'north' },
        { pos: { x: 4, y: 3 }, goal: 'south' },
        { pos: { x: 4, y: 5 }, goal: 'north' },
        { pos: { x: 4, y: 6 }, goal: 'north' },
      ],
      { walls: [{ x: 3, y: 2, o: 'h' }] },
    );
    expect(sortCells(getLegalMoves(s, 0))).toEqual(
      cells([3, 3], [5, 3], [3, 5], [5, 5], [5, 4], [3, 4]),
    );
  });

  it('two facing pawns sharing a diagonal cell: deduped, listed once', () => {
    // me (4,4). N pawn (4,3) with h(4,2) behind; E pawn (5,4) with v(5,3) behind.
    // N diagonals: (3,3),(5,3). E diagonals: (5,3),(5,5). Shared: (5,3).
    const s = makeState(
      [
        { pos: { x: 4, y: 4 }, goal: 'north' },
        { pos: { x: 4, y: 3 }, goal: 'south' },
        { pos: { x: 5, y: 4 }, goal: 'west' },
      ],
      {
        walls: [
          { x: 4, y: 2, o: 'h' },
          { x: 5, y: 3, o: 'v' },
        ],
      },
    );
    const moves = getLegalMoves(s, 0);
    const keys = moves.map((c) => `${c.x},${c.y}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(sortCells(moves)).toEqual(cells([3, 3], [5, 3], [5, 5], [4, 5], [3, 4]));
  });

  it('boxed into a corner by two pawns with both jumps walled: a single deduped diagonal', () => {
    // me (0,0), pawns (1,0) and (0,1).
    // v(1,0) kills the east jump (1,0)->(2,0); h(0,1) kills the south jump (0,1)->(0,2).
    // E pawn diagonals: (1,1) [ (1,-1) off-board ]. S pawn diagonals: (1,1) [(-1,1) off-board].
    // Both routes land on (1,1) => exactly one legal move.
    const s = makeState(
      [
        { pos: { x: 0, y: 0 }, goal: 'south' },
        { pos: { x: 1, y: 0 }, goal: 'south' },
        { pos: { x: 0, y: 1 }, goal: 'north' },
      ],
      {
        walls: [
          { x: 1, y: 0, o: 'v' },
          { x: 0, y: 1, o: 'h' },
        ],
      },
    );
    const moves = getLegalMoves(s, 0);
    expect(moves).toHaveLength(1);
    expect(sortCells(moves)).toEqual(cells([1, 1]));
  });

  it('boxed into a corner by two pawns with jumps free: exactly the two jump cells', () => {
    const s = makeState([
      { pos: { x: 0, y: 0 }, goal: 'south' },
      { pos: { x: 1, y: 0 }, goal: 'south' },
      { pos: { x: 0, y: 1 }, goal: 'north' },
    ]);
    expect(sortCells(getLegalMoves(s, 0))).toEqual(cells([2, 0], [0, 2]));
  });
});

describe('API behavior within the movement area', () => {
  it('computes moves for a non-current player index (jump geometry symmetric)', () => {
    // current=0 but we query player 1 at (4,3): jumps south over (4,4) to (4,5).
    const s = makeState(
      [
        { pos: { x: 4, y: 4 }, goal: 'north' },
        { pos: { x: 4, y: 3 }, goal: 'south' },
      ],
      { current: 0 },
    );
    expect(sortCells(getLegalMoves(s, 1))).toEqual(cells([4, 2], [5, 3], [4, 5], [3, 3]));
  });

  it('never offers the mover its own cell, a pawn cell, or any non-adjacent/non-jump cell', () => {
    // Dense sanity sweep: every returned cell must be either an empty orthogonal
    // neighbor, a straight-jump landing, or a legal diagonal — here we just assert
    // the full exact set for a 3-pawn cluster and that own/occupied cells are absent.
    const s = makeState([
      { pos: { x: 4, y: 4 }, goal: 'north' },
      { pos: { x: 4, y: 3 }, goal: 'south' },
      { pos: { x: 3, y: 4 }, goal: 'east' },
    ]);
    const keys = sortCells(getLegalMoves(s, 0));
    expect(keys).not.toContain('4,4'); // own cell
    expect(keys).not.toContain('4,3'); // occupied
    expect(keys).not.toContain('3,4'); // occupied
    // N: jump (4,2). W: jump (2,4). E: (5,4). S: (4,5).
    expect(keys).toEqual(cells([4, 2], [2, 4], [5, 4], [4, 5]));
  });
});
