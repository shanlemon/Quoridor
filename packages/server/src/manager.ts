import { Room } from './room';
import type { Conn, Member } from './room';
import { ClientMessageSchema } from '@quori/protocol';
import type { ClientMessage, ServerMessage } from '@quori/protocol';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class RoomManager {
  private rooms = new Map<string, Room>();

  /** Injectable for tests. */
  constructor(private readonly botDelayMs?: () => number) {}

  roomCount(): number {
    return this.rooms.size;
  }

  getRoom(code: string): Room | undefined {
    return this.rooms.get(code.toUpperCase());
  }

  createRoom(): Room {
    let code = this.newCode();
    while (this.rooms.has(code)) code = this.newCode();
    const room = new Room(code, (r) => this.rooms.delete(r.code), this.botDelayMs);
    this.rooms.set(code, room);
    return room;
  }

  /**
   * Bind a raw connection: the first message must be `create` or `join`,
   * after which the session is attached to a room member.
   */
  attach(conn: Conn): SocketSession {
    return new SocketSession(this, conn);
  }

  private newCode(): string {
    let code = '';
    for (let i = 0; i < 4; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    return code;
  }
}

/** Per-socket state machine: unbound → (create|join) → bound to a room member. */
export class SocketSession {
  private room: Room | null = null;
  private member: Member | null = null;
  // simple token bucket: 30 messages per rolling 5 seconds
  private stamps: number[] = [];

  constructor(
    private readonly manager: RoomManager,
    private readonly conn: Conn,
  ) {}

  onMessage(raw: unknown): void {
    if (this.rateLimited()) {
      this.conn.send({ t: 'err', code: 'RATE_LIMITED', msg: 'Slow down a little!' });
      return;
    }
    let msg: ClientMessage;
    try {
      const parsed = ClientMessageSchema.safeParse(
        typeof raw === 'string' ? JSON.parse(raw) : raw,
      );
      if (!parsed.success) {
        this.conn.send({ t: 'err', code: 'BAD_MESSAGE', msg: 'Malformed message.' });
        return;
      }
      msg = parsed.data;
    } catch {
      this.conn.send({ t: 'err', code: 'BAD_MESSAGE', msg: 'Not JSON.' });
      return;
    }

    if (!this.room || !this.member) {
      if (msg.t === 'create') {
        const room = this.manager.createRoom();
        room.join(this.conn, msg.name, msg.token);
        this.bind(room, msg.token);
      } else if (msg.t === 'join') {
        const room = this.manager.getRoom(msg.code);
        if (!room) {
          this.conn.send({ t: 'err', code: 'ROOM_NOT_FOUND', msg: `No room "${msg.code}".` });
          return;
        }
        room.join(this.conn, msg.name, msg.token);
        this.bind(room, msg.token);
      } else if (msg.t === 'ping') {
        this.conn.send({ t: 'pong' });
      } else {
        this.conn.send({ t: 'err', code: 'BAD_MESSAGE', msg: 'Join a room first.' });
      }
      return;
    }

    this.room.handle(this.member, msg);
    if (msg.t === 'leave') {
      this.room = null;
      this.member = null;
    }
  }

  onClose(): void {
    if (this.room && this.member && this.member.conn === this.conn) {
      this.room.disconnect(this.member);
    }
    this.room = null;
    this.member = null;
  }

  private bind(room: Room, token: string): void {
    const member = room.members.find((m) => m.token === token && m.conn === this.conn) ?? null;
    if (member) {
      this.room = room;
      this.member = member;
    }
  }

  private rateLimited(): boolean {
    const now = Date.now();
    this.stamps = this.stamps.filter((t) => now - t < 5000);
    if (this.stamps.length >= 30) return true;
    this.stamps.push(now);
    return false;
  }
}

export type { ServerMessage };
