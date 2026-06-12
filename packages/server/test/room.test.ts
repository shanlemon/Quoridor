import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bestAutoMove } from '@quori/engine';
import type { SocketSession } from '../src/manager';
import { RoomManager } from '../src/manager';
import { DISCONNECT_GRACE_MS } from '../src/room';
import type { Conn } from '../src/room';
import type { ServerMessage, Snapshot } from '@quori/protocol';

class FakeConn implements Conn {
  inbox: ServerMessage[] = [];
  closed = false;
  send(msg: ServerMessage): void {
    this.inbox.push(msg);
  }
  close(): void {
    this.closed = true;
  }
  last<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }> | undefined {
    return [...this.inbox].reverse().find((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
  }
  count(t: ServerMessage['t']): number {
    return this.inbox.filter((m) => m.t === t).length;
  }
}

interface Player {
  conn: FakeConn;
  session: SocketSession;
  token: string;
}

function mkPlayer(manager: RoomManager): Player {
  const conn = new FakeConn();
  return { conn, session: manager.attach(conn), token: `token-${Math.random()}-padpad` };
}

function send(p: Player, msg: object): void {
  p.session.onMessage(JSON.stringify(msg));
}

function snapshotOf(p: Player): Snapshot {
  const snap = p.conn.last('snapshot');
  if (!snap) throw new Error('no snapshot received');
  return snap.snap;
}

describe('room lifecycle', () => {
  let manager: RoomManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new RoomManager(() => 5); // bots think for 5ms in tests
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function createAndJoin(): { host: Player; guest: Player; code: string } {
    const host = mkPlayer(manager);
    send(host, { t: 'create', name: 'Alice', token: host.token });
    const code = host.conn.last('joined')!.code;
    const guest = mkPlayer(manager);
    send(guest, { t: 'join', code, name: 'Bob', token: guest.token });
    return { host, guest, code };
  }

  function startGame(host: Player): void {
    send(host, { t: 'config', config: { seats: 2, timerSeconds: 0, botFill: null } });
    send(host, { t: 'start' });
  }

  it('create + join broadcasts the lobby with host flag', () => {
    const { host, guest } = createAndJoin();
    const lobby = guest.conn.last('lobby')!;
    expect(lobby.members).toHaveLength(2);
    expect(lobby.members[0]).toMatchObject({ name: 'Alice', host: true });
    expect(lobby.members[1]).toMatchObject({ name: 'Bob', host: false });
    expect(host.conn.last('lobby')!.members).toHaveLength(2);
  });

  it('rejects malformed and out-of-order messages', () => {
    const p = mkPlayer(manager);
    p.session.onMessage('not json{');
    expect(p.conn.last('err')!.code).toBe('BAD_MESSAGE');
    send(p, { t: 'start' });
    expect(p.conn.last('err')!.msg).toMatch(/join a room/i);
    send(p, { t: 'join', code: 'ZZZZ', name: 'X', token: p.token });
    expect(p.conn.last('err')!.code).toBe('ROOM_NOT_FOUND');
  });

  it('only the host can configure and start', () => {
    const { host, guest } = createAndJoin();
    send(guest, { t: 'config', config: { seats: 2, timerSeconds: 0, botFill: null } });
    expect(guest.conn.last('err')!.code).toBe('NOT_HOST');
    send(guest, { t: 'start' });
    expect(guest.conn.last('err')!.code).toBe('NOT_HOST');
    startGame(host);
    expect(snapshotOf(host).yourSeat).toBe(0);
    expect(snapshotOf(guest).yourSeat).toBe(1);
  });

  it('plays a full authoritative game between two clients', () => {
    const { host, guest } = createAndJoin();
    startGame(host);
    const players = [host, guest];
    let snap = snapshotOf(host);
    let state = snap.state;
    let guard = 0;
    while (state.status === 'playing' && guard++ < 200) {
      const actor = players[state.current];
      const mv = bestAutoMove(state, state.current);
      send(actor, { t: 'action', action: { type: 'move', to: mv! }, turnSeq: state.turnSeq });
      const ev = actor.conn.last('ev');
      expect(ev, 'move should be broadcast').toBeDefined();
      // both clients receive the same event stream
      const moved = host.conn.count('ev');
      expect(guest.conn.count('ev')).toBe(moved);
      // track state like a client would: re-request authoritative snapshot
      send(host, { t: 'resync' });
      snap = snapshotOf(host);
      state = snap.state;
    }
    expect(state.status).toBe('finished');
    const fin = guest.conn.last('ev');
    expect(fin).toBeDefined();
    // host can rematch; a fresh snapshot arrives with turnSeq 0
    send(host, { t: 'rematch' });
    expect(snapshotOf(guest).state.turnSeq).toBe(0);
  });

  it('enforces seat ownership and turnSeq idempotency', () => {
    const { host, guest } = createAndJoin();
    startGame(host);
    const state = snapshotOf(host).state;
    // guest (seat 1) tries to act on seat 0's turn
    const mv = bestAutoMove(state, 0)!;
    send(guest, { t: 'action', action: { type: 'move', to: mv }, turnSeq: state.turnSeq });
    expect(guest.conn.last('invalid')!.error).toBe('NOT_YOUR_TURN');
    // host acts twice with the same turnSeq (double-click) — second is stale
    send(host, { t: 'action', action: { type: 'move', to: mv }, turnSeq: state.turnSeq });
    send(host, { t: 'action', action: { type: 'move', to: mv }, turnSeq: state.turnSeq });
    expect(host.conn.last('invalid')!.error).toBe('STALE_TURN');
    // engine-illegal action is rejected with the engine error
    send(host, { t: 'resync' });
    const s2 = snapshotOf(host).state;
    send(guest, { t: 'action', action: { type: 'move', to: { x: 0, y: 0 } }, turnSeq: s2.turnSeq });
    expect(guest.conn.last('invalid')!.error).toBe('ILLEGAL_MOVE');
  });

  it('fills empty seats with bots and the bot plays', () => {
    const host = mkPlayer(manager);
    send(host, { t: 'create', name: 'Solo', token: host.token });
    send(host, { t: 'config', config: { seats: 2, timerSeconds: 0, botFill: 'easy' } });
    send(host, { t: 'start' });
    const snap = snapshotOf(host);
    expect(snap.seats[1].kind).toBe('bot');
    // human moves, then the bot replies after its think delay
    const mv = bestAutoMove(snap.state, 0)!;
    send(host, { t: 'action', action: { type: 'move', to: mv }, turnSeq: 0 });
    vi.advanceTimersByTime(50);
    send(host, { t: 'resync' });
    expect(snapshotOf(host).state.turnSeq).toBe(2); // human + bot both moved
  });

  it('holds a disconnected seat for the grace period, then a bot takes over; reconnect restores it', () => {
    const { host, guest } = createAndJoin();
    startGame(host);
    // guest drops
    guest.session.onClose();
    let seats = (() => {
      send(host, { t: 'resync' });
      return snapshotOf(host).seats;
    })();
    expect(seats[1].connected).toBe(false);
    expect(seats[1].takenOver).toBe(false);

    // grace expires → bot takeover
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS + 10);
    send(host, { t: 'resync' });
    seats = snapshotOf(host).seats;
    expect(seats[1].takenOver).toBe(true);
    expect(seats[1].kind).toBe('bot');

    // host moves; the takeover bot answers
    const st = snapshotOf(host).state;
    const mv = bestAutoMove(st, st.current)!;
    send(host, { t: 'action', action: { type: 'move', to: mv }, turnSeq: st.turnSeq });
    vi.advanceTimersByTime(50);
    send(host, { t: 'resync' });
    const after = snapshotOf(host);
    expect(after.state.turnSeq).toBe(st.turnSeq + 2);

    // reconnect with the same token reclaims the seat
    const guest2 = mkPlayer(manager);
    guest2.token = guest.token;
    send(guest2, { t: 'join', code: host.conn.last('joined')!.code, name: 'Bob', token: guest.token });
    const snap2 = snapshotOf(guest2);
    expect(snap2.yourSeat).toBe(1);
    expect(snap2.seats[1].takenOver).toBe(false);
    expect(snap2.seats[1].kind).toBe('human');
  });

  it('migrates the host when the host leaves the lobby', () => {
    const { host, guest } = createAndJoin();
    send(host, { t: 'leave' });
    const lobby = guest.conn.last('lobby')!;
    expect(lobby.members).toHaveLength(1);
    expect(lobby.members[0]).toMatchObject({ name: 'Bob', host: true });
  });

  it('turn timer ticks and auto-moves on expiry', () => {
    const { host, guest } = createAndJoin();
    send(host, { t: 'config', config: { seats: 2, timerSeconds: 30, botFill: null } });
    send(host, { t: 'start' });
    vi.advanceTimersByTime(3000);
    const timerEv = host.conn.last('ev');
    expect(timerEv).toBeDefined();
    // let the full clock run out — server moves for the idle player
    vi.advanceTimersByTime(30_000);
    send(guest, { t: 'resync' });
    expect(snapshotOf(guest).state.turnSeq).toBeGreaterThanOrEqual(1);
  });

  it('extra joiners beyond the seat count become spectators with a snapshot', () => {
    const { host, guest, code } = createAndJoin();
    startGame(host);
    const spec = mkPlayer(manager);
    send(spec, { t: 'join', code, name: 'Watcher', token: spec.token });
    const snap = snapshotOf(spec);
    expect(snap.yourSeat).toBeNull();
    expect(snap.state.turnSeq).toBe(0);
    void guest;
  });
});
