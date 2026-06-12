import {
  actionToNotation,
  applyAction,
  bestAutoMove,
  chooseBotAction,
  createGame,
  CHARACTERS,
  getLegalMoves,
  getLegalWallSlots,
} from '@quori/engine';
import type { Action, BotLevel, GameState } from '@quori/engine';
import type {
  ClientMessage,
  GameEventWire,
  HistoryEntryWire,
  LobbyMember,
  RoomConfig,
  SeatInfo,
  ServerErrorCode,
  ServerMessage,
  Snapshot,
} from '@quori/protocol';

/** Transport abstraction so room logic is testable without real sockets. */
export interface Conn {
  send(msg: ServerMessage): void;
  close(): void;
}

export interface Member {
  /** Public id shown to other clients. */
  id: string;
  /** Secret session token — reconnect key. Never broadcast. */
  token: string;
  name: string;
  conn: Conn | null;
  host: boolean;
  seat: number | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
}

interface Seat {
  /** Member id owning this seat, or null for a pure bot seat. */
  ownerId: string | null;
  /** Bot level when bot-driven (fill bot, or takeover of a disconnected human). */
  bot: BotLevel | null;
  takenOver: boolean;
}

const BOT_NAMES: Record<BotLevel, string> = {
  easy: 'Bot (easy)',
  medium: 'Bot (smart)',
  hard: 'Bot (genius)',
};

/** How long a disconnected player's seat is held before a bot takes over. */
export const DISCONNECT_GRACE_MS = 60_000;
/** A room with nobody connected is destroyed after this long. */
export const EMPTY_ROOM_TTL_MS = 5 * 60_000;
const MAX_MEMBERS = 8; // extras beyond the seat count spectate

export class Room {
  readonly code: string;
  phase: 'lobby' | 'playing' | 'finished' = 'lobby';
  config: RoomConfig = { seats: 2, timerSeconds: 0, botFill: null };
  members: Member[] = [];
  state: GameState | null = null;
  history: HistoryEntryWire[] = [];
  private seatsTable: Seat[] = [];
  private timerInterval: ReturnType<typeof setInterval> | null = null;
  private secondsLeft = 0;
  private botTimeout: ReturnType<typeof setTimeout> | null = null;
  private emptyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    code: string,
    private readonly onEmpty: (room: Room) => void,
    /** Injectable for tests: bot think delay in ms. */
    private readonly botDelayMs: () => number = () => 700 + Math.random() * 600,
  ) {
    this.code = code;
  }

  // ------------------------------------------------------------ join/leave

  /** Join as a new member, or reconnect when the token matches an existing one. */
  join(conn: Conn, name: string, token: string): void {
    const existing = this.members.find((m) => m.token === token);
    if (existing) {
      this.reconnect(existing, conn, name);
      return;
    }
    if (this.members.length >= MAX_MEMBERS) {
      conn.send({ t: 'err', code: 'ROOM_FULL', msg: 'This room is full.' });
      conn.close();
      return;
    }
    const member: Member = {
      id: newId(),
      token,
      name,
      conn,
      host: this.members.length === 0,
      seat: null,
      graceTimer: null,
    };
    this.members.push(member);
    this.cancelEmptyTimer();
    conn.send({ t: 'joined', code: this.code, you: { id: member.id, name: member.name } });
    if (this.phase === 'lobby') {
      this.broadcastLobby();
    } else {
      // joined mid-game: spectator
      this.broadcastLobby();
      conn.send({ t: 'snapshot', snap: this.snapshotFor(member) });
    }
  }

  private reconnect(member: Member, conn: Conn, name: string): void {
    member.conn?.close();
    member.conn = conn;
    member.name = name;
    if (member.graceTimer) {
      clearTimeout(member.graceTimer);
      member.graceTimer = null;
    }
    // reclaim the seat from the takeover bot
    if (member.seat !== null) {
      const seat = this.seatsTable[member.seat];
      if (seat.takenOver) {
        seat.takenOver = false;
        seat.bot = null;
        this.stopBot();
      }
    }
    this.cancelEmptyTimer();
    conn.send({ t: 'joined', code: this.code, you: { id: member.id, name: member.name } });
    this.broadcastLobby();
    if (this.phase !== 'lobby') {
      conn.send({ t: 'snapshot', snap: this.snapshotFor(member) });
      this.broadcastSeats();
      this.scheduleBot();
      this.resumeTimerIfNeeded();
    }
  }

  disconnect(member: Member): void {
    member.conn = null;
    if (this.phase === 'lobby') {
      this.removeMember(member);
    } else {
      // hold the seat for a grace period, then let a bot take over
      if (member.seat !== null) {
        member.graceTimer = setTimeout(() => {
          member.graceTimer = null;
          if (member.conn || member.seat === null) return;
          const seat = this.seatsTable[member.seat];
          seat.bot = 'easy';
          seat.takenOver = true;
          this.broadcastSeats();
          this.scheduleBot();
        }, DISCONNECT_GRACE_MS);
      }
      this.broadcastLobby();
      this.broadcastSeats();
    }
    this.armEmptyTimerIfNeeded();
  }

  leave(member: Member): void {
    member.conn?.close();
    member.conn = null;
    this.removeMember(member);
    this.armEmptyTimerIfNeeded();
  }

  private removeMember(member: Member): void {
    if (member.graceTimer) clearTimeout(member.graceTimer);
    this.members = this.members.filter((m) => m !== member);
    // a seated player leaving mid-game hands their seat to a bot permanently
    if (member.seat !== null && this.phase !== 'lobby') {
      const seat = this.seatsTable[member.seat];
      seat.ownerId = null;
      seat.bot = seat.bot ?? 'easy';
      seat.takenOver = false;
      this.broadcastSeats();
      this.scheduleBot();
    }
    // host migration
    if (member.host && this.members.length > 0) {
      this.members[0].host = true;
    }
    this.broadcastLobby();
  }

  // ------------------------------------------------------------ messages

  handle(member: Member, msg: ClientMessage): void {
    switch (msg.t) {
      case 'config': {
        if (!member.host) return this.errTo(member, 'NOT_HOST', 'Only the host can change setup.');
        if (this.phase !== 'lobby') return this.errTo(member, 'BAD_PHASE', 'Game already started.');
        this.config = msg.config;
        this.broadcastLobby();
        return;
      }
      case 'start': {
        if (!member.host) return this.errTo(member, 'NOT_HOST', 'Only the host can start.');
        if (this.phase !== 'lobby') return this.errTo(member, 'BAD_PHASE', 'Game already started.');
        this.start(member);
        return;
      }
      case 'action': {
        if (this.phase !== 'playing' || !this.state) {
          return this.errTo(member, 'BAD_PHASE', 'No game in progress.');
        }
        // Replay/double-click guard first: a duplicate of an already-applied
        // action is "stale", regardless of whose turn it has become since.
        if (msg.turnSeq !== this.state.turnSeq) {
          member.conn?.send({ t: 'invalid', error: 'STALE_TURN' });
          return;
        }
        if (member.seat === null || member.seat !== this.state.current) {
          member.conn?.send({ t: 'invalid', error: 'NOT_YOUR_TURN' });
          return;
        }
        this.dispatch(msg.action, false);
        return;
      }
      case 'rematch': {
        if (!member.host) return this.errTo(member, 'NOT_HOST', 'Only the host can rematch.');
        if (this.phase !== 'finished') return this.errTo(member, 'BAD_PHASE', 'Game still running.');
        this.startGameState();
        return;
      }
      case 'resync': {
        if (this.phase === 'lobby') return this.broadcastLobby();
        member.conn?.send({ t: 'snapshot', snap: this.snapshotFor(member) });
        return;
      }
      case 'leave':
        this.leave(member);
        return;
      case 'ping':
        member.conn?.send({ t: 'pong' });
        return;
      case 'create':
      case 'join':
        return; // already routed by the manager
    }
  }

  // ------------------------------------------------------------ game flow

  private start(host: Member): void {
    const connected = this.members.filter((m) => m.conn);
    const humans = connected.slice(0, this.config.seats);
    const botSeats = this.config.seats - humans.length;
    if (humans.length < 1 || (botSeats > 0 && !this.config.botFill)) {
      return this.errTo(
        host,
        'NOT_ENOUGH_PLAYERS',
        `Need ${this.config.seats} players (or turn on bot fill).`,
      );
    }
    if (humans.length < 2 && botSeats === 0) {
      return this.errTo(host, 'NOT_ENOUGH_PLAYERS', 'At least 2 participants needed.');
    }
    this.seatsTable = [];
    for (let i = 0; i < this.config.seats; i++) {
      const human = humans[i];
      if (human) {
        human.seat = i;
        this.seatsTable.push({ ownerId: human.id, bot: null, takenOver: false });
      } else {
        this.seatsTable.push({ ownerId: null, bot: this.config.botFill, takenOver: false });
      }
    }
    this.startGameState();
  }

  /** (Re)create the game state — used by both start and rematch. */
  private startGameState(): void {
    this.state = createGame(this.config.seats);
    this.history = [];
    this.phase = 'playing';
    this.broadcastLobby();
    for (const m of this.members) {
      m.conn?.send({ t: 'snapshot', snap: this.snapshotFor(m) });
    }
    this.resetTimer();
    this.scheduleBot();
  }

  /** Validate + apply an action for the current player and broadcast the event. */
  private dispatch(action: Action, auto: boolean): boolean {
    if (!this.state) return false;
    const prev = this.state;
    const res = applyAction(prev, action);
    if (!res.ok) {
      const owner = this.memberBySeat(prev.current);
      owner?.conn?.send({ t: 'invalid', error: res.error });
      return false;
    }
    this.state = res.state;
    const seat = prev.current;
    this.history.push({ seat, notation: actionToNotation(action), kind: action.type, auto });

    let ev: GameEventWire;
    if (action.type === 'move') {
      ev = {
        kind: 'moved',
        seat,
        from: prev.players[seat].pos,
        to: action.to,
        auto,
        turnSeq: this.state.turnSeq,
      };
    } else if (action.type === 'wall') {
      ev = { kind: 'wallPlaced', seat, wall: action.wall, turnSeq: this.state.turnSeq };
    } else {
      ev = { kind: 'passed', seat, turnSeq: this.state.turnSeq };
    }
    this.broadcast({ t: 'ev', ev });

    if (this.state.status === 'finished' && this.state.winner !== null) {
      this.phase = 'finished';
      this.stopTimer();
      this.stopBot();
      this.broadcast({
        t: 'ev',
        ev: { kind: 'finished', winner: this.state.winner, turnSeq: this.state.turnSeq },
      });
      this.broadcastLobby();
    } else {
      this.broadcast({ t: 'ev', ev: { kind: 'turn', seat: this.state.current } });
      this.resetTimer();
      this.scheduleBot();
      this.maybeAutoPass();
    }
    return true;
  }

  /** A seated human with no legal move AND no legal fence cannot act — pass for them. */
  private maybeAutoPass(): void {
    const st = this.state;
    if (!st || this.phase !== 'playing') return;
    if (this.seatsTable[st.current]?.bot) return; // bots pass on their own
    if (getLegalMoves(st, st.current).length > 0) return;
    if (getLegalWallSlots(st, st.current).length > 0) return;
    const seq = st.turnSeq;
    setTimeout(() => {
      if (this.phase === 'playing' && this.state && this.state.turnSeq === seq) {
        this.dispatch({ type: 'pass' }, true);
      }
    }, 900);
  }

  // ------------------------------------------------------------ bots & timer

  private scheduleBot(): void {
    this.stopBot();
    const st = this.state;
    if (!st || this.phase !== 'playing') return;
    const seat = this.seatsTable[st.current];
    const level = seat?.bot;
    if (!level) return;
    this.botTimeout = setTimeout(() => {
      this.botTimeout = null;
      const now = this.state;
      if (!now || this.phase !== 'playing' || !this.seatsTable[now.current]?.bot) return;
      if (!this.dispatch(chooseBotAction(now, level), false)) {
        // never soft-lock: fall back to any legal action
        const mv = bestAutoMove(now, now.current);
        if (mv && this.dispatch({ type: 'move', to: mv }, true)) return;
        const slots = getLegalWallSlots(now);
        if (slots.length > 0 && this.dispatch({ type: 'wall', wall: slots[0] }, true)) return;
        this.dispatch({ type: 'pass' }, true);
      }
    }, this.botDelayMs());
  }

  private stopBot(): void {
    if (this.botTimeout) {
      clearTimeout(this.botTimeout);
      this.botTimeout = null;
    }
  }

  private resetTimer(): void {
    this.secondsLeft = this.config.timerSeconds;
    this.resumeTimerIfNeeded();
  }

  private resumeTimerIfNeeded(): void {
    this.stopTimer();
    const st = this.state;
    if (!st || this.phase !== 'playing' || !this.config.timerSeconds) return;
    if (this.seatsTable[st.current]?.bot) return; // bots need no clock
    if (this.secondsLeft <= 0) this.secondsLeft = this.config.timerSeconds;
    this.broadcast({ t: 'ev', ev: { kind: 'timer', secondsLeft: this.secondsLeft } });
    this.timerInterval = setInterval(() => {
      this.secondsLeft -= 1;
      this.broadcast({
        t: 'ev',
        ev: { kind: 'timer', secondsLeft: Math.max(0, this.secondsLeft) },
      });
      if (this.secondsLeft <= 0) this.autoPlay();
    }, 1000);
  }

  private stopTimer(): void {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  /** Timer expiry: shortest-path step (never auto-place fences). */
  private autoPlay(): void {
    const st = this.state;
    if (!st) return;
    const mv = bestAutoMove(st, st.current);
    if (mv) {
      this.dispatch({ type: 'move', to: mv }, true);
      return;
    }
    if (!this.dispatch({ type: 'pass' }, true)) this.stopTimer();
  }

  // ------------------------------------------------------------ views

  memberBySeat(seat: number): Member | undefined {
    const owner = this.seatsTable[seat]?.ownerId;
    return owner ? this.members.find((m) => m.id === owner) : undefined;
  }

  seatInfos(): SeatInfo[] {
    return this.seatsTable.map((s, i) => {
      const owner = s.ownerId ? this.members.find((m) => m.id === s.ownerId) : undefined;
      const botLevel = s.bot;
      return {
        seat: i,
        character: CHARACTERS[i],
        name: owner ? owner.name : botLevel ? BOT_NAMES[botLevel] : '—',
        kind: owner && !s.takenOver ? 'human' : 'bot',
        botLevel,
        connected: owner ? owner.conn !== null : true,
        takenOver: s.takenOver,
      };
    });
  }

  private snapshotFor(member: Member): Snapshot {
    if (!this.state) throw new Error('no game state');
    return {
      state: this.state,
      seats: this.seatInfos(),
      history: this.history,
      config: this.config,
      yourSeat: member.seat,
      phase: this.phase === 'finished' ? 'finished' : 'playing',
    };
  }

  lobbyView(): ServerMessage {
    return {
      t: 'lobby',
      code: this.code,
      members: this.members.map(
        (m): LobbyMember => ({
          id: m.id,
          name: m.name,
          host: m.host,
          connected: m.conn !== null,
          seat: m.seat,
        }),
      ),
      config: this.config,
      phase: this.phase,
    };
  }

  // ------------------------------------------------------------ plumbing

  private broadcast(msg: ServerMessage): void {
    for (const m of this.members) m.conn?.send(msg);
  }

  private broadcastLobby(): void {
    this.broadcast(this.lobbyView());
  }

  private broadcastSeats(): void {
    if (this.phase === 'lobby') return;
    this.broadcast({ t: 'ev', ev: { kind: 'seats', seats: this.seatInfos() } });
  }

  private errTo(member: Member, code: ServerErrorCode, msg: string): void {
    member.conn?.send({ t: 'err', code, msg });
  }

  private armEmptyTimerIfNeeded(): void {
    if (this.members.some((m) => m.conn)) return;
    this.cancelEmptyTimer();
    this.emptyTimer = setTimeout(() => this.destroy(), EMPTY_ROOM_TTL_MS);
  }

  private cancelEmptyTimer(): void {
    if (this.emptyTimer) {
      clearTimeout(this.emptyTimer);
      this.emptyTimer = null;
    }
  }

  destroy(): void {
    this.stopTimer();
    this.stopBot();
    this.cancelEmptyTimer();
    for (const m of this.members) {
      if (m.graceTimer) clearTimeout(m.graceTimer);
      m.conn?.close();
    }
    this.members = [];
    this.onEmpty(this);
  }
}

let idCounter = 0;
function newId(): string {
  idCounter += 1;
  return `m${idCounter.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}
