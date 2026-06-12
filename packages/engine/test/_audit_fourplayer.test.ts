/**
 * AUDIT: 3- and 4-player specific interactions.
 *
 * Every expectation below is hand-derived from the official Quoridor rules
 * (Gigamic) + the documented project conventions:
 *  - 4p seats clockwise: south(4,8)->north, west(0,4)->east, north(4,0)->south, east(8,4)->west.
 *  - 3p = 4p minus the east seat, 7 walls each.
 *  - Straight jump over ONE adjacent pawn; diagonal side-steps ONLY when the
 *    straight jump is impossible (wall behind, edge behind, or pawn behind).
 *    Never a double jump over two pawns in a line.
 *  - A wall is illegal if it cuts off ANY player's last path to their goal.
 */
import { describe, expect, it } from 'vitest';
import {
  applyAction,
  checkWallPlacement,
  createGame,
  getLegalMoves,
  getLegalWallSlots,
  rankPlayers,
} from '../src/index';
import type { Action, GameState, Wall } from '../src/index';
import { cells, makeState, sortCells } from './helpers';

function mustApply(state: GameState, action: Action): GameState {
  const res = applyAction(state, action);
  if (!res.ok) {
    throw new Error(`expected legal action ${JSON.stringify(action)}, got ${res.error}`);
  }
  return res.state;
}

const wall = (x: number, y: number, o: 'h' | 'v'): Wall => ({ x, y, o });

// ---------------------------------------------------------------------------
// A. Clustered-pawn jump geometry (3-4 pawns: lines, L/T shapes, 2x2 blocks)
// ---------------------------------------------------------------------------
describe('4p clustered jumps', () => {
  it('A1: vertical line of 3 — no double jump, both diagonals beside the first pawn', () => {
    // s0 (mover) at (4,4); s1 at (4,3); s2 at (4,2) directly behind s1; s3 far away.
    // Straight jump to (4,2) impossible (pawn behind) => diagonals (3,3) and (5,3).
    // (4,1) — a double jump — must NOT be offered.
    const s = makeState([
      { pos: { x: 4, y: 4 }, goal: 'north' },
      { pos: { x: 4, y: 3 }, goal: 'east' },
      { pos: { x: 4, y: 2 }, goal: 'south' },
      { pos: { x: 0, y: 0 }, goal: 'south' },
    ]);
    expect(sortCells(getLegalMoves(s, 0))).toEqual(
      cells([3, 3], [5, 3], [5, 4], [4, 5], [3, 4]),
    );
  });

  it('A2: mover between two pawns (vertical line, me in the middle) — two straight jumps', () => {
    const s = makeState([
      { pos: { x: 4, y: 4 }, goal: 'north' },
      { pos: { x: 4, y: 3 }, goal: 'east' },
      { pos: { x: 4, y: 5 }, goal: 'south' },
      { pos: { x: 0, y: 0 }, goal: 'south' },
    ]);
    // North: jump over s1 to (4,2). South: jump over s2 to (4,6). Plus plain E/W.
    expect(sortCells(getLegalMoves(s, 0))).toEqual(
      cells([4, 2], [4, 6], [3, 4], [5, 4]),
    );
  });

  it('A3: adjacent to TWO pawns in perpendicular directions — both straight jumps, no diagonals', () => {
    // s1 north of s0, s2 east of s0; both landing cells free => straight jumps only.
    const s = makeState([
      { pos: { x: 4, y: 4 }, goal: 'north' },
      { pos: { x: 4, y: 3 }, goal: 'east' },
      { pos: { x: 5, y: 4 }, goal: 'south' },
      { pos: { x: 0, y: 0 }, goal: 'south' },
    ]);
    expect(sortCells(getLegalMoves(s, 0))).toEqual(
      cells([4, 2], [6, 4], [4, 5], [3, 4]),
    );
  });

  it('A4: perpendicular pawns, both straight jumps wall-blocked — diagonal fans, shared cell deduped', () => {
    // h(3,2) blocks (4,3)->(4,2): straight jump over the north pawn is dead.
    // v(5,3) blocks (5,4)->(6,4): straight jump over the east pawn is dead.
    // Diagonals over north pawn: (3,3), (5,3). Diagonals over east pawn: (5,3), (5,5).
    // (5,3) reachable via either jump — must appear exactly once.
    const s = makeState(
      [
        { pos: { x: 4, y: 4 }, goal: 'north' },
        { pos: { x: 4, y: 3 }, goal: 'east' },
        { pos: { x: 5, y: 4 }, goal: 'south' },
        { pos: { x: 0, y: 0 }, goal: 'south' },
      ],
      { walls: [wall(3, 2, 'h'), wall(5, 3, 'v')] },
    );
    const moves = getLegalMoves(s, 0);
    expect(sortCells(moves)).toEqual(cells([3, 3], [5, 3], [5, 5], [4, 5], [3, 4]));
    // explicit dedup check
    expect(moves.length).toBe(new Set(moves.map((c) => `${c.x},${c.y}`)).size);
  });

  it('A5: 2x2 block of four pawns — mover gets straight jumps over both neighbours', () => {
    // s0(4,4) s1(4,3) s2(5,3) s3(5,4): jumps to (4,2) and (6,4); plain S/W.
    const s = makeState([
      { pos: { x: 4, y: 4 }, goal: 'north' },
      { pos: { x: 4, y: 3 }, goal: 'east' },
      { pos: { x: 5, y: 3 }, goal: 'south' },
      { pos: { x: 5, y: 4 }, goal: 'west' },
    ]);
    expect(sortCells(getLegalMoves(s, 0))).toEqual(
      cells([4, 2], [6, 4], [4, 5], [3, 4]),
    );
  });

  it('A6: 2x2 block + wall behind the north jump — diagonal into the block is excluded', () => {
    // h(3,2) kills the straight jump over s1. Diagonals beside s1: (3,3) free,
    // (5,3) occupied by s2 => only (3,3). East jump over s3 still straight to (6,4).
    const s = makeState(
      [
        { pos: { x: 4, y: 4 }, goal: 'north' },
        { pos: { x: 4, y: 3 }, goal: 'east' },
        { pos: { x: 5, y: 3 }, goal: 'south' },
        { pos: { x: 5, y: 4 }, goal: 'west' },
      ],
      { walls: [wall(3, 2, 'h')] },
    );
    expect(sortCells(getLegalMoves(s, 0))).toEqual(
      cells([3, 3], [6, 4], [4, 5], [3, 4]),
    );
  });

  it('A7: T-shape — three adjacent pawns, three straight jumps', () => {
    const s = makeState([
      { pos: { x: 4, y: 4 }, goal: 'north' },
      { pos: { x: 4, y: 3 }, goal: 'east' },
      { pos: { x: 3, y: 4 }, goal: 'south' },
      { pos: { x: 5, y: 4 }, goal: 'west' },
    ]);
    expect(sortCells(getLegalMoves(s, 0))).toEqual(
      cells([4, 2], [2, 4], [6, 4], [4, 5]),
    );
  });

  it('A8: pawn on the edge ahead + third pawn on one diagonal — only the free diagonal', () => {
    // s0(4,1) faces s2 on the north edge (4,0); beyond is off-board => diagonals
    // (3,0)/(5,0); (3,0) is occupied by s3 => only (5,0).
    const s = makeState([
      { pos: { x: 4, y: 1 }, goal: 'north' },
      { pos: { x: 7, y: 7 }, goal: 'east' },
      { pos: { x: 4, y: 0 }, goal: 'south' },
      { pos: { x: 3, y: 0 }, goal: 'west' },
    ]);
    expect(sortCells(getLegalMoves(s, 0))).toEqual(
      cells([5, 0], [5, 1], [4, 2], [3, 1]),
    );
  });

  it('A9: line of 3 with one diagonal occupied by a fourth pawn — only the other diagonal', () => {
    // s0(4,4), s1(4,3), s2(4,2) (pawn behind), s3(5,3) occupies one diagonal.
    const s = makeState([
      { pos: { x: 4, y: 4 }, goal: 'north' },
      { pos: { x: 4, y: 3 }, goal: 'east' },
      { pos: { x: 4, y: 2 }, goal: 'south' },
      { pos: { x: 5, y: 3 }, goal: 'west' },
    ]);
    expect(sortCells(getLegalMoves(s, 0))).toEqual(
      cells([3, 3], [5, 4], [4, 5], [3, 4]),
    );
  });

  it('A10: a direction can be completely dead: straight jump walled, one diag occupied, other diag walled', () => {
    // h(3,2) blocks the straight jump over s1; v(4,2) blocks (4,3)->(5,3);
    // s2 occupies (3,3). North yields nothing at all.
    const s = makeState(
      [
        { pos: { x: 4, y: 4 }, goal: 'north' },
        { pos: { x: 4, y: 3 }, goal: 'east' },
        { pos: { x: 3, y: 3 }, goal: 'south' },
        { pos: { x: 0, y: 0 }, goal: 'south' },
      ],
      { walls: [wall(3, 2, 'h'), wall(4, 2, 'v')] },
    );
    expect(sortCells(getLegalMoves(s, 0))).toEqual(cells([5, 4], [4, 5], [3, 4]));
  });
});

// ---------------------------------------------------------------------------
// B. Win detection for east/west-goal players, including by jump
// ---------------------------------------------------------------------------
describe('4p east/west win detection', () => {
  it('B1: west seat (goal east) wins by STRAIGHT jump onto x=8', () => {
    const s = makeState(
      [
        { pos: { x: 4, y: 8 }, goal: 'north' },
        { pos: { x: 6, y: 4 }, goal: 'east' },
        { pos: { x: 4, y: 0 }, goal: 'south' },
        { pos: { x: 7, y: 4 }, goal: 'west' },
      ],
      { current: 1 },
    );
    // s1 faces s3; beyond (8,4) is free => straight jump available and it wins.
    expect(sortCells(getLegalMoves(s, 1))).toContain('8,4');
    const after = mustApply(s, { type: 'move', to: { x: 8, y: 4 } });
    expect(after.status).toBe('finished');
    expect(after.winner).toBe(1);
    expect(after.current).toBe(1); // current stays on the winner
    expect(after.turnSeq).toBe(s.turnSeq + 1);
  });

  it('B2: east seat (goal west) wins by DIAGONAL jump onto x=0 (edge behind the jumped pawn)', () => {
    const s = makeState(
      [
        { pos: { x: 4, y: 8 }, goal: 'north' },
        { pos: { x: 0, y: 4 }, goal: 'east' },
        { pos: { x: 4, y: 0 }, goal: 'south' },
        { pos: { x: 1, y: 4 }, goal: 'west' },
      ],
      { current: 3 },
    );
    // s3 faces s1 sitting on the west edge; beyond is off-board => diagonals
    // (0,3) and (0,5), both of which are goal cells for s3.
    const moves = sortCells(getLegalMoves(s, 3));
    expect(moves).toContain('0,3');
    expect(moves).toContain('0,5');
    const after = mustApply(s, { type: 'move', to: { x: 0, y: 5 } });
    expect(after.status).toBe('finished');
    expect(after.winner).toBe(3);
    expect(after.current).toBe(3);
  });

  it('B3: finished game accepts no further actions and exposes no legal moves/walls', () => {
    const s = makeState(
      [
        { pos: { x: 4, y: 8 }, goal: 'north' },
        { pos: { x: 8, y: 4 }, goal: 'east' },
        { pos: { x: 4, y: 0 }, goal: 'south' },
        { pos: { x: 7, y: 7 }, goal: 'west' },
      ],
      { current: 1, status: 'finished', winner: 1 },
    );
    expect(applyAction(s, { type: 'move', to: { x: 7, y: 4 } })).toEqual({
      ok: false,
      error: 'GAME_OVER',
    });
    expect(applyAction(s, { type: 'wall', wall: wall(3, 3, 'h') })).toEqual({
      ok: false,
      error: 'GAME_OVER',
    });
    expect(applyAction(s, { type: 'pass' })).toEqual({ ok: false, error: 'GAME_OVER' });
    expect(getLegalMoves(s, 1)).toEqual([]);
    expect(getLegalWallSlots(s, 0)).toEqual([]);
  });

  it("B4: reaching ANOTHER player's goal edge does not end the game", () => {
    // s3 (goal west) steps onto y=8 (south edge — not its goal). Game continues.
    const s = makeState(
      [
        { pos: { x: 4, y: 8 }, goal: 'north' },
        { pos: { x: 0, y: 4 }, goal: 'east' },
        { pos: { x: 4, y: 0 }, goal: 'south' },
        { pos: { x: 6, y: 7 }, goal: 'west' },
      ],
      { current: 3 },
    );
    const after = mustApply(s, { type: 'move', to: { x: 6, y: 8 } });
    expect(after.status).toBe('playing');
    expect(after.winner).toBeNull();
    expect(after.current).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// C. Trap rule must protect ALL 4 players (incl. east/west-goal players)
// ---------------------------------------------------------------------------
describe('4p wall trap protection for every seat', () => {
  it('C1: south player cannot seal the WEST pocket and trap the east-goal player (seat 1)', () => {
    // v(0,0),v(0,2),v(0,4),v(0,6) block every x0<->x1 crossing for rows 0..7;
    // each was individually fine because row 8 stayed open. h(0,7) closes the
    // last gap ((0,7)<->(0,8) and (1,7)<->(1,8)), sealing seat 1 (goal east)
    // inside {(0,0)..(0,7)}. Placed by seat 0 sitting far away at (4,8).
    const s = makeState(
      [
        { pos: { x: 4, y: 8 }, goal: 'north', wallsLeft: 5 },
        { pos: { x: 0, y: 4 }, goal: 'east', wallsLeft: 5 },
        { pos: { x: 4, y: 0 }, goal: 'south', wallsLeft: 5 },
        { pos: { x: 8, y: 4 }, goal: 'west', wallsLeft: 5 },
      ],
      { walls: [wall(0, 0, 'v'), wall(0, 2, 'v'), wall(0, 4, 'v'), wall(0, 6, 'v')] },
    );
    // sanity: before the sealing wall, seat 1 still has a path (via row 8)
    expect(checkWallPlacement(s, wall(5, 5, 'h'), 0).legal).toBe(true);

    const check = checkWallPlacement(s, wall(0, 7, 'h'), 0);
    expect(check.legal).toBe(false);
    if (!check.legal) {
      expect(check.reason).toBe('WALL_BLOCKS_PATH');
      expect(check.trapped).toEqual([1]);
    }
    const res = applyAction(s, { type: 'wall', wall: wall(0, 7, 'h') });
    expect(res).toEqual({ ok: false, error: 'WALL_BLOCKS_PATH' });
    // state untouched on rejection
    expect(s.walls).toHaveLength(4);
    expect(s.turnSeq).toBe(0);
    // and the slot is absent from the legal-slot enumeration
    const slots = getLegalWallSlots(s, 0).map((w) => `${w.o}${w.x},${w.y}`);
    expect(slots).not.toContain('h0,7');
  });

  it('C2: south player cannot seal the EAST pocket and trap the west-goal player (seat 3)', () => {
    const s = makeState(
      [
        { pos: { x: 4, y: 8 }, goal: 'north', wallsLeft: 5 },
        { pos: { x: 0, y: 4 }, goal: 'east', wallsLeft: 5 },
        { pos: { x: 4, y: 0 }, goal: 'south', wallsLeft: 5 },
        { pos: { x: 8, y: 4 }, goal: 'west', wallsLeft: 5 },
      ],
      { walls: [wall(7, 0, 'v'), wall(7, 2, 'v'), wall(7, 4, 'v'), wall(7, 6, 'v')] },
    );
    const check = checkWallPlacement(s, wall(7, 7, 'h'), 0);
    expect(check.legal).toBe(false);
    if (!check.legal) {
      expect(check.reason).toBe('WALL_BLOCKS_PATH');
      expect(check.trapped).toEqual([3]);
    }
    expect(applyAction(s, { type: 'wall', wall: wall(7, 7, 'h') })).toEqual({
      ok: false,
      error: 'WALL_BLOCKS_PATH',
    });
  });

  it('C3: the exact same east-pocket seal IS legal in 3-player (no west-goal seat exists)', () => {
    // 3p = south/west/north seats; nobody needs to reach x=0, and seat 1
    // (goal east) can still reach (8,8) via the open row-8 crossing.
    const s = makeState(
      [
        { pos: { x: 4, y: 8 }, goal: 'north', wallsLeft: 7 },
        { pos: { x: 0, y: 4 }, goal: 'east', wallsLeft: 7 },
        { pos: { x: 4, y: 0 }, goal: 'south', wallsLeft: 7 },
      ],
      { walls: [wall(7, 0, 'v'), wall(7, 2, 'v'), wall(7, 4, 'v'), wall(7, 6, 'v')] },
    );
    expect(checkWallPlacement(s, wall(7, 7, 'h'), 0).legal).toBe(true);
    const after = mustApply(s, { type: 'wall', wall: wall(7, 7, 'h') });
    expect(after.walls).toHaveLength(5);
    expect(after.players[0].wallsLeft).toBe(6);
    expect(after.current).toBe(1);
  });

  it('C4: a wall trapping multiple players reports every trapped seat', () => {
    // 2-cell pocket on the south-west corner: cells (0,8) and (1,8).
    // Pre-existing v(1,7) blocks (1,8)<->(2,8); the candidate h(0,7) blocks
    // both upward exits (0,8)->(0,7) and (1,8)->(1,7).
    // s0 (goal north) at (0,8) and s1 (goal east) at (1,8) would BOTH be
    // sealed in. The wall is placed by seat 2 (north player) from far away.
    const s = makeState(
      [
        { pos: { x: 0, y: 8 }, goal: 'north', wallsLeft: 5 },
        { pos: { x: 1, y: 8 }, goal: 'east', wallsLeft: 5 },
        { pos: { x: 4, y: 0 }, goal: 'south', wallsLeft: 5 },
        { pos: { x: 8, y: 4 }, goal: 'west', wallsLeft: 5 },
      ],
      { walls: [wall(1, 7, 'v')], current: 2 },
    );
    const check = checkWallPlacement(s, wall(0, 7, 'h'), 2);
    expect(check.legal).toBe(false);
    if (!check.legal) {
      expect(check.reason).toBe('WALL_BLOCKS_PATH');
      expect(check.trapped).toEqual([0, 1]);
    }
    expect(applyAction(s, { type: 'wall', wall: wall(0, 7, 'h') })).toEqual({
      ok: false,
      error: 'WALL_BLOCKS_PATH',
    });
  });
});

// ---------------------------------------------------------------------------
// D. Turn order never skips anyone once walls run out
// ---------------------------------------------------------------------------
describe('4p turn order with no walls', () => {
  it('D1: zero-wall game cycles all four seats with moves only; pass stays illegal', () => {
    let s = createGame(4, { wallsPerPlayer: 0 });
    for (let i = 0; i < 4; i++) expect(getLegalWallSlots(s, i)).toEqual([]);
    expect(applyAction(s, { type: 'wall', wall: wall(4, 4, 'h') })).toEqual({
      ok: false,
      error: 'NO_WALLS_LEFT',
    });
    expect(applyAction(s, { type: 'pass' })).toEqual({ ok: false, error: 'PASS_NOT_ALLOWED' });

    // out-and-back for every seat; note s1 returns to (0,4) (x=0 is NOT its
    // goal) and s3 returns to (8,4) (x=8 is NOT its goal) — no false wins.
    const script: Array<[number, number, number]> = [
      [0, 4, 7],
      [1, 1, 4],
      [2, 4, 1],
      [3, 7, 4],
      [0, 4, 8],
      [1, 0, 4],
      [2, 4, 0],
      [3, 8, 4],
    ];
    for (const [seat, x, y] of script) {
      expect(s.current).toBe(seat);
      s = mustApply(s, { type: 'move', to: { x, y } });
      expect(s.status).toBe('playing');
    }
    expect(s.current).toBe(0);
    expect(s.turnSeq).toBe(8);
  });

  it('D2: only the wall-less seat is denied wall placements; others unaffected', () => {
    const s = makeState([
      { pos: { x: 4, y: 8 }, goal: 'north', wallsLeft: 0 },
      { pos: { x: 0, y: 4 }, goal: 'east', wallsLeft: 5 },
      { pos: { x: 4, y: 0 }, goal: 'south', wallsLeft: 5 },
      { pos: { x: 8, y: 4 }, goal: 'west', wallsLeft: 5 },
    ]);
    expect(applyAction(s, { type: 'wall', wall: wall(4, 4, 'h') })).toEqual({
      ok: false,
      error: 'NO_WALLS_LEFT',
    });
    expect(getLegalWallSlots(s, 0)).toEqual([]);
    expect(getLegalWallSlots(s, 1).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// E. Pass corner case in a 4p pawn cluster
// ---------------------------------------------------------------------------
describe('4p pass when fully sealed by pawns + wall', () => {
  const sealed = (wallsLeft: number) =>
    makeState(
      [
        { pos: { x: 0, y: 8 }, goal: 'north', wallsLeft },
        { pos: { x: 1, y: 8 }, goal: 'east', wallsLeft: 5 },
        { pos: { x: 2, y: 8 }, goal: 'south', wallsLeft: 5 },
        { pos: { x: 7, y: 2 }, goal: 'west', wallsLeft: 5 },
      ],
      { walls: [wall(0, 7, 'h')] },
    );
  // s0 in the SW corner: north walled (h0,7 covers cols 0 and 1), east pawn
  // with pawn behind => diagonals (1,7) walled / (1,9) off-board. No moves.

  it('E1: zero moves; pass legal only with zero walls; turn advances, nothing else changes', () => {
    const s = sealed(0);
    expect(getLegalMoves(s, 0)).toEqual([]);
    const after = mustApply(s, { type: 'pass' });
    expect(after.current).toBe(1);
    expect(after.turnSeq).toBe(1);
    expect(after.players[0].pos).toEqual({ x: 0, y: 8 });
    expect(after.walls).toHaveLength(1);
  });

  it('E2: with a wall in hand, pass is refused (wall placements exist)', () => {
    const s = sealed(1);
    expect(getLegalMoves(s, 0)).toEqual([]);
    expect(getLegalWallSlots(s, 0).length).toBeGreaterThan(0);
    expect(applyAction(s, { type: 'pass' })).toEqual({ ok: false, error: 'PASS_NOT_ALLOWED' });
  });
});

// ---------------------------------------------------------------------------
// F. 3-player layout, goal coverage and a complete 3p game
// ---------------------------------------------------------------------------
describe('3-player mode', () => {
  it('F1: layout is 4p minus the east seat, 7 walls, distinct characters', () => {
    const s = createGame(3);
    expect(s.players).toHaveLength(3);
    expect(s.players.map((p) => p.pos)).toEqual([
      { x: 4, y: 8 },
      { x: 0, y: 4 },
      { x: 4, y: 0 },
    ]);
    expect(s.players.map((p) => p.goal)).toEqual(['north', 'east', 'south']);
    expect(s.players.every((p) => p.wallsLeft === 7)).toBe(true);
    expect(new Set(s.players.map((p) => p.character)).size).toBe(3);
    expect(s.players.map((p) => p.seat)).toEqual([0, 1, 2]);
  });

  it('F2: complete 3p game — west seat marches east and wins on x=8; rotation 0->1->2', () => {
    let s = createGame(3);
    // s0 shuffles (4,8)<->(4,7), s2 shuffles (4,0)<->(4,1), s1 walks row 4 east.
    const expectSeat = (seat: number) => expect(s.current).toBe(seat);
    for (let round = 1; round <= 7; round++) {
      expectSeat(0);
      s = mustApply(s, { type: 'move', to: { x: 4, y: round % 2 === 1 ? 7 : 8 } });
      expectSeat(1);
      s = mustApply(s, { type: 'move', to: { x: round, y: 4 } });
      expectSeat(2);
      s = mustApply(s, { type: 'move', to: { x: 4, y: round % 2 === 1 ? 1 : 0 } });
      expect(s.status).toBe('playing');
    }
    // round 8: s0 moves, then s1 steps from (7,4) onto (8,4) — east goal.
    expectSeat(0);
    s = mustApply(s, { type: 'move', to: { x: 4, y: 8 } });
    expectSeat(1);
    s = mustApply(s, { type: 'move', to: { x: 8, y: 4 } });
    expect(s.status).toBe('finished');
    expect(s.winner).toBe(1);
    expect(s.current).toBe(1);
    expect(s.turnSeq).toBe(23);
  });
});

// ---------------------------------------------------------------------------
// G. Full hand-verified 4-player game with per-turn invariants
// ---------------------------------------------------------------------------
describe('complete 4-player game', () => {
  it('G1: 26 hand-verified actions incl. a wall and a jump; invariants hold every turn', () => {
    let s = createGame(4);
    const initialWallTotal = s.players.reduce((a, p) => a + p.wallsLeft, 0);
    expect(initialWallTotal).toBe(20);

    const mv = (x: number, y: number): Action => ({ type: 'move', to: { x, y } });
    // [expected acting seat, action]
    const script: Array<[number, Action]> = [
      // round 1
      [0, mv(4, 7)],
      [1, mv(1, 4)],
      [2, mv(3, 0)],
      [3, { type: 'wall', wall: wall(0, 0, 'h') }], // harmless far-corner wall
      // round 2
      [0, mv(4, 6)],
      [1, mv(2, 4)],
      [2, mv(3, 1)],
      [3, mv(8, 3)],
      // round 3
      [0, mv(4, 5)],
      [1, mv(3, 4)],
      [2, mv(3, 2)],
      [3, mv(7, 3)],
      // round 4
      [0, mv(4, 4)],
      [1, mv(5, 4)], // straight JUMP over s0 at (4,4)
      [2, mv(3, 3)],
      [3, mv(6, 3)],
      // round 5
      [0, mv(4, 3)],
      [1, mv(6, 4)],
      [2, mv(3, 4)],
      [3, mv(5, 3)],
      // round 6
      [0, mv(4, 2)],
      [1, mv(7, 4)],
      [2, mv(3, 5)],
      [3, mv(4, 3)], // s0 vacated (4,3) earlier this round
      // round 7
      [0, mv(4, 1)],
      [1, mv(8, 4)], // east edge => seat 1 WINS
    ];

    let prevWallTotal = initialWallTotal;
    for (let i = 0; i < script.length; i++) {
      const [seat, action] = script[i];
      expect(s.current).toBe(seat);
      if (i === 13) {
        // the jump: (5,4) must be offered, the occupied (4,4) must not be
        const legal = sortCells(getLegalMoves(s, 1));
        expect(legal).toContain('5,4');
        expect(legal).not.toContain('4,4');
      }
      s = mustApply(s, action);

      // ---- invariants after every action ----
      expect(s.turnSeq).toBe(i + 1);
      expect(s.players).toHaveLength(4);
      for (const p of s.players) {
        expect(p.pos.x).toBeGreaterThanOrEqual(0);
        expect(p.pos.x).toBeLessThanOrEqual(8);
        expect(p.pos.y).toBeGreaterThanOrEqual(0);
        expect(p.pos.y).toBeLessThanOrEqual(8);
      }
      expect(new Set(s.players.map((p) => `${p.pos.x},${p.pos.y}`)).size).toBe(4);
      const wallTotal = s.players.reduce((a, p) => a + p.wallsLeft, 0);
      expect(wallTotal).toBeLessThanOrEqual(prevWallTotal);
      expect(s.walls.length).toBe(initialWallTotal - wallTotal);
      prevWallTotal = wallTotal;
      if (i < script.length - 1) expect(s.status).toBe('playing');
    }

    expect(s.status).toBe('finished');
    expect(s.winner).toBe(1);
    expect(s.current).toBe(1);
    expect(s.turnSeq).toBe(26);
    expect(s.players[3].wallsLeft).toBe(4); // exactly one wall spent
    expect(applyAction(s, mv(4, 0))).toEqual({ ok: false, error: 'GAME_OVER' });

    // hand-computed final ranking: s1 won (d0); s0 at (4,1) d1 to north;
    // s2 at (3,5) d3 to south; s3 at (4,3) d4 to west (h0,0 affects no path).
    expect(rankPlayers(s)).toEqual([
      { seat: 1, rank: 1, distance: 0 },
      { seat: 0, rank: 2, distance: 1 },
      { seat: 2, rank: 3, distance: 3 },
      { seat: 3, rank: 4, distance: 4 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// H. Ranking a finished 4p game by remaining distance (with a tie)
// ---------------------------------------------------------------------------
describe('4p ranking', () => {
  it('H1: winner first, then by remaining shortest path; equal distances share a rank', () => {
    // winner s2 on y=8 (d0); s0 (4,2)->north d2; s3 (2,4)->west d2 (tie);
    // s1 (5,4)->east d3.
    const s = makeState(
      [
        { pos: { x: 4, y: 2 }, goal: 'north' },
        { pos: { x: 5, y: 4 }, goal: 'east' },
        { pos: { x: 4, y: 8 }, goal: 'south' },
        { pos: { x: 2, y: 4 }, goal: 'west' },
      ],
      { status: 'finished', winner: 2, current: 2 },
    );
    const ranks = rankPlayers(s);
    expect(ranks[0]).toMatchObject({ seat: 2, rank: 1, distance: 0 });
    expect(ranks.slice(1).map((r) => r.seat)).toEqual([0, 3, 1]);
    expect(ranks[1].rank).toBe(2);
    expect(ranks[2].rank).toBe(2); // tied with seat 0
    expect(ranks[1].distance).toBe(2);
    expect(ranks[2].distance).toBe(2);
    expect(ranks[3]).toMatchObject({ seat: 1, distance: 3 });
    expect(ranks[3].rank).toBeGreaterThan(2);
  });

  it('H2: ranking respects walls when measuring remaining distance', () => {
    // s3 (goal west) at (1,0); v(0,0) blocks (1,0)->(0,0) AND (1,1)->(0,1),
    // so its true remaining distance is 1->(1,2 detour): (1,0)->(1,1)->(1,2)->(0,2) = 3.
    const s = makeState(
      [
        { pos: { x: 4, y: 0 }, goal: 'north' }, // winner, d0
        { pos: { x: 7, y: 4 }, goal: 'east' }, // d1
        { pos: { x: 4, y: 6 }, goal: 'south' }, // d2
        { pos: { x: 1, y: 0 }, goal: 'west' },
      ],
      { walls: [wall(0, 0, 'v')], status: 'finished', winner: 0, current: 0 },
    );
    expect(rankPlayers(s)).toEqual([
      { seat: 0, rank: 1, distance: 0 },
      { seat: 1, rank: 2, distance: 1 },
      { seat: 2, rank: 3, distance: 2 },
      { seat: 3, rank: 4, distance: 3 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// I. 4p opening sanity for the east/west seats
// ---------------------------------------------------------------------------
describe('4p opening moves', () => {
  it('I1: west and east seats each have exactly 3 opening moves along/off their edge', () => {
    const s = createGame(4);
    expect(sortCells(getLegalMoves(s, 1))).toEqual(cells([0, 3], [0, 5], [1, 4]));
    expect(sortCells(getLegalMoves(s, 3))).toEqual(cells([8, 3], [8, 5], [7, 4]));
  });
});
