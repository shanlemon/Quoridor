import {
  actionToNotation,
  applyAction,
  bestAutoMove,
  checkWallPlacement,
  createGame,
  getLegalMoves,
} from '@quori/engine';
import type {
  Action,
  ActionError,
  Cell,
  GameState,
  PlayerCount,
  Wall,
  WallCheck,
} from '@quori/engine';

export interface HistoryEntry {
  seat: number;
  notation: string;
  kind: Action['type'];
  auto: boolean;
}

export interface ControllerEvents {
  moved: { seat: number; from: Cell; to: Cell; auto: boolean };
  wallPlaced: { seat: number; wall: Wall };
  passed: { seat: number };
  invalid: { error: ActionError };
  finished: { winner: number };
  turn: { seat: number };
  timer: { secondsLeft: number };
}

type Handler<T> = (e: T) => void;

/**
 * Owns the authoritative local GameState and the turn timer. The rendering
 * layer never mutates state — it dispatches intents and reacts to events
 * (same shape a future multiplayer server protocol will have).
 */
export class GameController {
  state: GameState;
  readonly history: HistoryEntry[] = [];
  readonly startedAt = Date.now();
  readonly timerSeconds: number; // 0 = off
  readonly initialWalls: number;

  private interval: ReturnType<typeof setInterval> | null = null;
  private secondsLeft = 0;
  private handlers: { [K in keyof ControllerEvents]?: Handler<ControllerEvents[K]>[] } = {};

  constructor(numPlayers: PlayerCount, opts: { timerSeconds?: number } = {}) {
    this.state = createGame(numPlayers);
    this.initialWalls = this.state.players[0].wallsLeft;
    this.timerSeconds = opts.timerSeconds ?? 0;
    document.addEventListener('visibilitychange', this.onVisibility);
    this.resetTimer();
  }

  /** Rendering pauses in hidden tabs (RAF) — pause the clock too, so turns never resolve unseen. */
  private readonly onVisibility = (): void => {
    if (document.hidden) this.stopTimer();
    else this.resetTimer();
  };

  on<K extends keyof ControllerEvents>(ev: K, h: Handler<ControllerEvents[K]>): void {
    const list = (this.handlers[ev] ??= []) as Handler<ControllerEvents[K]>[];
    list.push(h);
  }

  private emit<K extends keyof ControllerEvents>(ev: K, payload: ControllerEvents[K]): void {
    for (const h of this.handlers[ev] ?? []) h(payload);
  }

  dispatch(action: Action, auto = false): boolean {
    const prev = this.state;
    const res = applyAction(prev, action);
    if (!res.ok) {
      this.emit('invalid', { error: res.error });
      return false;
    }
    this.state = res.state;
    const seat = prev.current;
    this.history.push({ seat, notation: actionToNotation(action), kind: action.type, auto });

    if (action.type === 'move') {
      this.emit('moved', { seat, from: prev.players[seat].pos, to: action.to, auto });
    } else if (action.type === 'wall') {
      this.emit('wallPlaced', { seat, wall: action.wall });
    } else {
      this.emit('passed', { seat });
    }

    if (this.state.status === 'finished' && this.state.winner !== null) {
      this.stopTimer();
      this.emit('finished', { winner: this.state.winner });
    } else {
      this.resetTimer();
      this.emit('turn', { seat: this.state.current });
    }
    return true;
  }

  legalMoves(): Cell[] {
    return this.state.status === 'playing' ? getLegalMoves(this.state, this.state.current) : [];
  }

  checkWall(wall: Wall): WallCheck {
    return checkWallPlacement(this.state, wall);
  }

  /** Timer expiry / stuck player: move along the shortest path (never auto-place walls). */
  autoPlay(): void {
    const mv = bestAutoMove(this.state, this.state.current);
    if (mv) {
      this.dispatch({ type: 'move', to: mv }, true);
      return;
    }
    // No pawn move exists. Pass is only legal if no fence is placeable either;
    // when a fence IS available we never auto-place it — stop the clock instead.
    if (!this.dispatch({ type: 'pass' }, true)) this.stopTimer();
  }

  private resetTimer(): void {
    this.stopTimer();
    if (!this.timerSeconds || this.state.status !== 'playing') return;
    if (document.hidden) return;
    this.secondsLeft = this.timerSeconds;
    this.emit('timer', { secondsLeft: this.secondsLeft });
    this.interval = setInterval(() => {
      this.secondsLeft -= 1;
      this.emit('timer', { secondsLeft: Math.max(0, this.secondsLeft) });
      if (this.secondsLeft <= 0) this.autoPlay(); // dispatch restarts the timer
    }, 1000);
  }

  private stopTimer(): void {
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  destroy(): void {
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.stopTimer();
    this.handlers = {};
  }
}
