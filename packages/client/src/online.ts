import type { Action } from '@quori/engine';
import type {
  ClientMessage,
  LobbyMember,
  RoomConfig,
  ServerMessage,
  Snapshot,
} from '@quori/protocol';
import { NetworkController } from './net-controller';

const TOKEN_KEY = 'quori-net-token';
const LAST_ROOM_KEY = 'quori-last-room';
const LAST_NAME_KEY = 'quori-last-name';

function sessionToken(): string {
  let token = localStorage.getItem(TOKEN_KEY);
  if (!token) {
    token = crypto.randomUUID();
    localStorage.setItem(TOKEN_KEY, token);
  }
  return token;
}

export interface LobbyState {
  code: string;
  members: LobbyMember[];
  config: RoomConfig;
  phase: 'lobby' | 'playing' | 'finished';
  youId: string;
}

export interface OnlineCallbacks {
  /** Lobby roster/config changed (also fires on phase changes). */
  onLobby(lobby: LobbyState): void;
  /** A game snapshot arrived: a game started, a rematch began, or we resynced. */
  onSnapshot(controller: NetworkController, isFirst: boolean): void;
  onError(code: string, msg: string): void;
  /** Connection dropped; reconnecting automatically when `retrying`. */
  onConnection(status: 'connected' | 'reconnecting' | 'gone'): void;
}

/**
 * Owns the WebSocket and the room membership. Survives refreshes/drops via a
 * stable session token: the server holds the seat for 60s and restores it on
 * reconnect.
 */
export class OnlineSession {
  controller: NetworkController | null = null;
  lobby: LobbyState | null = null;
  private ws: WebSocket | null = null;
  private youId = '';
  private name = '';
  private code: string | null = null;
  private closedByUs = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;

  constructor(private readonly cb: OnlineCallbacks) {}

  static lastName(): string {
    return localStorage.getItem(LAST_NAME_KEY) ?? '';
  }

  static lastRoom(): string {
    return localStorage.getItem(LAST_ROOM_KEY) ?? '';
  }

  async create(name: string): Promise<void> {
    this.name = name;
    localStorage.setItem(LAST_NAME_KEY, name);
    await this.open();
    this.send({ t: 'create', name, token: sessionToken() });
  }

  async join(code: string, name: string): Promise<void> {
    this.name = name;
    localStorage.setItem(LAST_NAME_KEY, name);
    await this.open();
    this.send({ t: 'join', code: code.toUpperCase(), name, token: sessionToken() });
  }

  sendConfig(config: RoomConfig): void {
    this.send({ t: 'config', config });
  }

  start(): void {
    this.send({ t: 'start' });
  }

  rematch(): void {
    this.send({ t: 'rematch' });
  }

  isHost(): boolean {
    return this.lobby?.members.some((m) => m.id === this.youId && m.host) ?? false;
  }

  leave(): void {
    this.closedByUs = true;
    localStorage.removeItem(LAST_ROOM_KEY);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.send({ t: 'leave' });
    this.ws?.close();
    this.ws = null;
    this.controller?.destroy();
    this.controller = null;
    this.lobby = null;
    this.code = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }

  // ------------------------------------------------------------- socket

  private wsUrl(): string {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws`;
  }

  private open(): Promise<void> {
    this.closedByUs = false;
    // Close any superseded socket first; the stale guard below makes its
    // close event a no-op.
    this.ws?.close();
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl());
      this.ws = ws;
      ws.onopen = () => {
        this.retryAttempt = 0;
        this.cb.onConnection('connected');
        resolve();
      };
      ws.onerror = () => reject(new Error('could not reach the game server'));
      ws.onmessage = (e) => this.onMessage(String(e.data));
      ws.onclose = () => {
        // Only the current socket may drive reconnect logic — a superseded or
        // server-closed old socket must not trigger a spurious retry cycle.
        if (this.ws === ws) this.onClose();
      };
    });
  }

  private onClose(): void {
    this.ws = null;
    if (this.closedByUs) {
      this.cb.onConnection('gone');
      return;
    }
    if (!this.code) return; // never joined a room: create()/join() rejection or a server 'err' already surfaced the failure
    // unexpected drop while in a room: reconnect with backoff for ~60s
    this.retryAttempt += 1;
    if (this.retryAttempt > 8) {
      this.cb.onConnection('gone');
      return;
    }
    this.cb.onConnection('reconnecting');
    const delay = Math.min(8000, 500 * 2 ** this.retryAttempt);
    if (this.retryTimer) clearTimeout(this.retryTimer); // defensive: never run two retry timers
    this.retryTimer = setTimeout(() => {
      void this.open()
        .then(() => {
          if (this.code) this.send({ t: 'join', code: this.code, name: this.name, token: sessionToken() });
        })
        // A failed connection always fires the socket's own 'close' event,
        // which drives the next retry — no need to call onClose() here too.
        .catch(() => {});
    }, delay);
  }

  private send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  // ------------------------------------------------------------- routing

  private onMessage(raw: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.t) {
      case 'joined':
        this.youId = msg.you.id;
        this.code = msg.code;
        localStorage.setItem(LAST_ROOM_KEY, msg.code);
        return;
      case 'lobby':
        this.lobby = {
          code: msg.code,
          members: msg.members,
          config: msg.config,
          phase: msg.phase,
          youId: this.youId,
        };
        this.cb.onLobby(this.lobby);
        return;
      case 'snapshot':
        this.handleSnapshot(msg.snap);
        return;
      case 'ev':
        this.controller?.handleEvent(msg.ev);
        return;
      case 'invalid':
        if (msg.error === 'STALE_TURN') return; // harmless duplicate
        this.cb.onError('INVALID', msg.error);
        return;
      case 'err':
        this.cb.onError(msg.code, msg.msg);
        return;
      case 'pong':
        return;
    }
  }

  private handleSnapshot(snap: Snapshot): void {
    if (this.controller) {
      this.controller.applySnapshot(snap);
      this.cb.onSnapshot(this.controller, false);
    } else {
      this.controller = new NetworkController(
        snap,
        (action: Action, turnSeq: number) => this.send({ t: 'action', action, turnSeq }),
        () => this.send({ t: 'resync' }),
      );
      this.cb.onSnapshot(this.controller, true);
    }
  }
}
