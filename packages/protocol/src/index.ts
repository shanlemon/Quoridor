/**
 * Wire protocol between the Quori Quest client and the authoritative game
 * server. Every client→server message is validated with zod at the socket
 * boundary (never trust the client); server→client messages are plain typed
 * JSON (the client trusts the server but still re-derives game state through
 * the shared engine and resyncs on any mismatch).
 *
 * The room model is Discord-Activity-shaped: one room per Activity instance.
 * For browser play the room key is a short code; under Discord (M4) the
 * `instanceId` from the Embedded App SDK becomes the room key, so everyone in
 * the same voice channel lands in the same lobby automatically.
 */
import { z } from 'zod';
import { BOARD_SIZE, WALL_GRID } from '@quori/engine';
import type {
  Action,
  ActionError,
  BotLevel,
  Cell,
  CharacterId,
  GameState,
  Wall,
} from '@quori/engine';

// ---------------------------------------------------------------------------
// zod schemas (client → server)
// ---------------------------------------------------------------------------

const coord = (max: number) => z.number().int().min(0).max(max - 1);

export const CellSchema = z.object({
  x: coord(BOARD_SIZE),
  y: coord(BOARD_SIZE),
}) satisfies z.ZodType<Cell>;

export const WallSchema = z.object({
  x: coord(WALL_GRID),
  y: coord(WALL_GRID),
  o: z.enum(['h', 'v']),
}) satisfies z.ZodType<Wall>;

export const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('move'), to: CellSchema }),
  z.object({ type: z.literal('wall'), wall: WallSchema }),
  z.object({ type: z.literal('pass') }),
]) satisfies z.ZodType<Action>;

export const BotLevelSchema = z.enum(['easy', 'medium', 'hard']);
export const PlayerCountSchema = z.union([z.literal(2), z.literal(3), z.literal(4)]);
export const TimerSchema = z.union([z.literal(0), z.literal(30), z.literal(60), z.literal(90)]);

const NameSchema = z
  .string()
  .trim()
  .min(1)
  .max(20)
  // no control characters; anything printable (incl. emoji) is fine
  .refine(
    (s) => ![...s].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127),
    'control characters are not allowed',
  );

/** Client-generated stable session token — lets a dropped player reclaim their seat. */
const TokenSchema = z.string().min(8).max(64);

export const RoomConfigSchema = z.object({
  seats: PlayerCountSchema,
  timerSeconds: TimerSchema,
  /** Fill seats with no human with bots of this level (null = don't fill). */
  botFill: BotLevelSchema.nullable(),
});
export type RoomConfig = z.infer<typeof RoomConfigSchema>;

export const ClientMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('create'), name: NameSchema, token: TokenSchema }),
  z.object({
    t: z.literal('join'),
    code: z.string().trim().toUpperCase().length(4),
    name: NameSchema,
    token: TokenSchema,
  }),
  z.object({ t: z.literal('config'), config: RoomConfigSchema }),
  z.object({ t: z.literal('start') }),
  z.object({
    t: z.literal('action'),
    action: ActionSchema,
    /** turnSeq the client saw — idempotency/replay guard. */
    turnSeq: z.number().int().min(0),
  }),
  z.object({ t: z.literal('rematch') }),
  z.object({ t: z.literal('resync') }),
  z.object({ t: z.literal('leave') }),
  z.object({ t: z.literal('ping') }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ---------------------------------------------------------------------------
// server → client (plain types)
// ---------------------------------------------------------------------------

export interface LobbyMember {
  /** Public member id (NOT the secret token). */
  id: string;
  name: string;
  host: boolean;
  connected: boolean;
  /** Seat index once the game has started; null in lobby / for spectators. */
  seat: number | null;
}

export interface SeatInfo {
  seat: number;
  character: CharacterId;
  /** Display name: member name, or a bot label. */
  name: string;
  kind: 'human' | 'bot';
  botLevel: BotLevel | null;
  connected: boolean;
  /** True while a disconnected human's seat is bot-driven. */
  takenOver: boolean;
}

export interface HistoryEntryWire {
  seat: number;
  notation: string;
  kind: Action['type'];
  auto: boolean;
}

export type GameEventWire =
  | {
      kind: 'moved';
      seat: number;
      from: Cell;
      to: Cell;
      auto: boolean;
      /** state.turnSeq AFTER the action — clients verify and resync on mismatch. */
      turnSeq: number;
    }
  | { kind: 'wallPlaced'; seat: number; wall: Wall; turnSeq: number }
  | { kind: 'passed'; seat: number; turnSeq: number }
  | { kind: 'turn'; seat: number }
  | { kind: 'timer'; secondsLeft: number }
  | { kind: 'finished'; winner: number; turnSeq: number }
  | { kind: 'seats'; seats: SeatInfo[] };

export interface Snapshot {
  state: GameState;
  seats: SeatInfo[];
  history: HistoryEntryWire[];
  config: RoomConfig;
  /** Your seat, or null if you are a spectator. */
  yourSeat: number | null;
  phase: 'playing' | 'finished';
}

export type ServerMessage =
  | { t: 'joined'; code: string; you: { id: string; name: string } }
  | {
      t: 'lobby';
      code: string;
      members: LobbyMember[];
      config: RoomConfig;
      phase: 'lobby' | 'playing' | 'finished';
    }
  | { t: 'snapshot'; snap: Snapshot }
  | { t: 'ev'; ev: GameEventWire }
  | { t: 'invalid'; error: ActionError | 'STALE_TURN' | 'NOT_YOUR_TURN' }
  | { t: 'err'; code: ServerErrorCode; msg: string }
  | { t: 'pong' };

export type ServerErrorCode =
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'NOT_HOST'
  | 'BAD_PHASE'
  | 'NOT_ENOUGH_PLAYERS'
  | 'BAD_MESSAGE'
  | 'RATE_LIMITED';

export const PROTOCOL_VERSION = 1;
