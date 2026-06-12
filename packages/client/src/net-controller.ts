import {
  actionToNotation,
  applyAction,
  checkWallPlacement,
  createGame,
  getLegalMoves,
} from '@quori/engine';
import type { Action, Cell, GameState, Wall, WallCheck } from '@quori/engine';
import type { GameEventWire, SeatInfo, Snapshot } from '@quori/protocol';
import mitt from 'mitt';
import type { ControllerEvents, HistoryEntry, SeatMeta } from './controller';

/**
 * Drop-in replacement for the local GameController, backed by the server.
 * State is event-sourced: the server broadcasts each accepted action and the
 * client re-applies it through the shared engine; any divergence (turnSeq
 * mismatch) triggers a full snapshot resync. Input is gated to YOUR seat on
 * YOUR turn — everything else renders exactly like the local game.
 */
export class NetworkController {
  readonly kind = 'online' as const;

  state!: GameState;
  history: HistoryEntry[] = [];
  seats: SeatInfo[] = [];
  mySeat: number | null = null;
  timerSeconds = 0;
  initialWalls = 10;
  startedAt = Date.now();

  private readonly emitter = mitt<ControllerEvents>();

  constructor(
    snapshot: Snapshot,
    private readonly sendToServer: (action: Action, turnSeq: number) => void,
    private readonly requestResync: () => void,
  ) {
    this.applySnapshot(snapshot);
  }

  applySnapshot(snap: Snapshot): void {
    this.state = snap.state;
    this.history = snap.history.map((h) => ({ ...h }));
    this.seats = snap.seats;
    this.mySeat = snap.yourSeat;
    this.timerSeconds = snap.config.timerSeconds;
    // Same wall budget the server used when it called createGame(seats).
    this.initialWalls = createGame(snap.config.seats).players[0].wallsLeft;
    if (snap.state.turnSeq === 0) this.startedAt = Date.now();
  }

  // ----------------------------------------------------------- events in

  handleEvent(ev: GameEventWire): void {
    switch (ev.kind) {
      case 'moved':
        this.applyWireAction({ type: 'move', to: ev.to }, ev.turnSeq, ev.seat, ev.auto, () =>
          this.emit('moved', { seat: ev.seat, from: ev.from, to: ev.to, auto: ev.auto }),
        );
        return;
      case 'wallPlaced':
        this.applyWireAction({ type: 'wall', wall: ev.wall }, ev.turnSeq, ev.seat, false, () =>
          this.emit('wallPlaced', { seat: ev.seat, wall: ev.wall }),
        );
        return;
      case 'passed':
        this.applyWireAction({ type: 'pass' }, ev.turnSeq, ev.seat, false, () =>
          this.emit('passed', { seat: ev.seat }),
        );
        return;
      case 'turn':
        this.emit('turn', { seat: ev.seat });
        return;
      case 'timer':
        this.emit('timer', { secondsLeft: ev.secondsLeft });
        return;
      case 'finished':
        // The winning action's event already emitted 'finished' locally; this
        // standalone event only matters if we somehow missed that action.
        if (this.state.status !== 'finished') this.requestResync();
        return;
      case 'seats':
        this.seats = ev.seats;
        this.emitter.emit('seatsChanged');
        return;
    }
  }

  private applyWireAction(
    action: Action,
    expectedSeq: number,
    seat: number,
    auto: boolean,
    emitFn: () => void,
  ): void {
    if (this.state.current !== seat) {
      this.requestResync();
      return;
    }
    const res = applyAction(this.state, action);
    if (!res.ok || res.state.turnSeq !== expectedSeq) {
      this.requestResync();
      return;
    }
    this.state = res.state;
    this.history.push({ seat, notation: actionToNotation(action), kind: action.type, auto });
    emitFn();
    if (this.state.status === 'finished' && this.state.winner !== null) {
      this.emit('finished', { winner: this.state.winner });
    }
  }

  // ----------------------------------------------------------- emitter

  on<K extends keyof ControllerEvents>(ev: K, h: (e: ControllerEvents[K]) => void): void {
    this.emitter.on(ev, h);
  }

  onSeatsChanged(h: () => void): void {
    this.emitter.on('seatsChanged', h);
  }

  removeAllListeners(): void {
    this.emitter.all.clear();
  }

  private emit<K extends keyof ControllerEvents>(ev: K, payload: ControllerEvents[K]): void {
    this.emitter.emit(ev, payload);
  }

  // ----------------------------------------------------------- intents out

  dispatch(action: Action): boolean {
    if (this.inputLocked()) return false;
    this.sendToServer(action, this.state.turnSeq);
    return true;
  }

  // ----------------------------------------------------------- queries

  legalMoves(): Cell[] {
    return this.state.status === 'playing' ? getLegalMoves(this.state, this.state.current) : [];
  }

  checkWall(wall: Wall): WallCheck {
    // Game over: the fence ghost must never render green; NO_WALLS_LEFT is the
    // least-wrong existing reason since the WallCheck union is public API.
    if (this.state.status !== 'playing') return { legal: false, reason: 'NO_WALLS_LEFT', trapped: [] };
    return checkWallPlacement(this.state, wall);
  }

  /** True whenever it is not OUR turn to act (spectator, remote player, bot, game over). */
  inputLocked(): boolean {
    return (
      this.state.status !== 'playing' || this.mySeat === null || this.state.current !== this.mySeat
    );
  }

  lockKind(): 'bot' | 'remote' | null {
    if (this.state.status !== 'playing' || !this.inputLocked()) return null;
    return this.seats[this.state.current]?.kind === 'bot' ? 'bot' : 'remote';
  }

  currentActorName(): string | null {
    return this.seats[this.state.current]?.name ?? null;
  }

  seatMeta(seat: number): SeatMeta {
    const info = this.seats[seat];
    return {
      label: info ? info.name : null,
      bot: info?.kind === 'bot',
      connected: info?.connected ?? true,
      you: seat === this.mySeat,
    };
  }

  destroy(): void {
    this.removeAllListeners();
  }
}
