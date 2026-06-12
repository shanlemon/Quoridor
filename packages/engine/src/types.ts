/** Board is BOARD_SIZE × BOARD_SIZE cells; walls live on a WALL_GRID × WALL_GRID grid of intersections. */
export const BOARD_SIZE = 9;
export const WALL_GRID = 8;

export type Orientation = 'h' | 'v';

/** Edges of the board. north = row y=0, south = row y=8, west = col x=0, east = col x=8. */
export type Edge = 'north' | 'south' | 'east' | 'west';

export interface Cell {
  readonly x: number;
  readonly y: number;
}

/**
 * A wall occupies intersection (x, y) — the corner shared by cells (x,y), (x+1,y),
 * (x,y+1), (x+1,y+1) — with x, y in 0..WALL_GRID-1.
 *
 * - 'h' spans 2 cells horizontally: blocks movement between rows y/y+1 for columns x and x+1.
 * - 'v' spans 2 cells vertically: blocks movement between columns x/x+1 for rows y and y+1.
 */
export interface Wall {
  readonly x: number;
  readonly y: number;
  readonly o: Orientation;
}

export const CHARACTERS = ['mochi', 'pebble', 'biscuit', 'tofu'] as const;
export type CharacterId = (typeof CHARACTERS)[number];

export interface PlayerState {
  readonly seat: number;
  readonly character: CharacterId;
  readonly pos: Cell;
  readonly wallsLeft: number;
  readonly goal: Edge;
}

export type GameStatus = 'playing' | 'finished';

export interface GameState {
  readonly players: readonly PlayerState[];
  readonly walls: readonly Wall[];
  /** Index into players of whose turn it is. */
  readonly current: number;
  /** Monotonically increasing sequence number, bumped on every successful action. */
  readonly turnSeq: number;
  readonly status: GameStatus;
  readonly winner: number | null;
}

export type Action =
  | { readonly type: 'move'; readonly to: Cell }
  | { readonly type: 'wall'; readonly wall: Wall }
  /** Only legal when the current player has no legal move and no legal wall placement. */
  | { readonly type: 'pass' };

export type ActionError =
  | 'GAME_OVER'
  | 'ILLEGAL_MOVE'
  | 'NO_WALLS_LEFT'
  | 'WALL_OUT_OF_BOUNDS'
  | 'WALL_OVERLAPS'
  | 'WALL_BLOCKS_PATH'
  | 'PASS_NOT_ALLOWED';

export type ActionResult =
  | { readonly ok: true; readonly state: GameState }
  | { readonly ok: false; readonly error: ActionError };
