import {
  actionToNotation,
  applyAction,
  bestAutoMove,
  checkWallPlacement,
  chooseBotAction,
  createGame,
  getLegalMoves,
  getLegalWallSlots,
} from '@quori/engine';
import type {
  Action,
  ActionError,
  BotLevel,
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
 * Owns the authoritative local GameState, the turn timer, and bot turns. The
 * rendering layer never mutates state — it dispatches intents and reacts to
 * events (same shape a future multiplayer server protocol will have).
 */
export class GameController {
  state: GameState;
  readonly history: HistoryEntry[] = [];
  readonly startedAt = Date.now();
  readonly timerSeconds: number; // 0 = off
  readonly initialWalls: number;
  readonly bots: readonly (BotLevel | null)[];

  private interval: ReturnType<typeof setInterval> | null = null;
  private botTimeout: ReturnType<typeof setTimeout> | null = null;
  private secondsLeft = 0;
  private began = false;
  private paused = false;
  private handlers: { [K in keyof ControllerEvents]?: Handler<ControllerEvents[K]>[] } = {};

  constructor(
    numPlayers: PlayerCount,
    opts: { timerSeconds?: number; bots?: readonly (BotLevel | null)[] } = {},
  ) {
    this.state = createGame(numPlayers);
    this.initialWalls = this.state.players[0].wallsLeft;
    this.timerSeconds = opts.timerSeconds ?? 0;
    this.bots = this.state.players.map((_, i) => opts.bots?.[i] ?? null);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.resetTimer();
  }

  /** Rendering pauses in hidden tabs (RAF) — pause the clock and bots too, so turns never resolve unseen. */
  private readonly onVisibility = (): void => {
    if (document.hidden) {
      this.stopTimer();
      this.stopBot();
    } else {
      this.resumeTimer();
      this.scheduleBot();
    }
  };

  /** Call once the view is wired up — kicks off the first bot turn if seat 0 is a bot. */
  begin(): void {
    this.began = true;
    this.scheduleBot();
  }

  /** Freeze the clock and bot turns while a modal overlay covers the board. */
  pause(): void {
    this.paused = true;
    this.stopTimer();
    this.stopBot();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.resumeTimer();
    this.scheduleBot();
  }

  isBot(seat: number): boolean {
    return this.bots[seat] !== null;
  }

  isBotTurn(): boolean {
    return this.state.status === 'playing' && this.isBot(this.state.current);
  }

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
      this.stopBot();
      this.emit('finished', { winner: this.state.winner });
    } else {
      this.resetTimer();
      this.emit('turn', { seat: this.state.current });
      this.scheduleBot();
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

  private scheduleBot(): void {
    this.stopBot();
    if (!this.began || this.paused || !this.isBotTurn() || document.hidden) return;
    const level = this.bots[this.state.current];
    if (!level) return;
    // A short "thinking" beat keeps bot turns readable.
    this.botTimeout = setTimeout(
      () => {
        this.botTimeout = null;
        if (this.paused || !this.isBotTurn()) return;
        // The AI contract is "always legal" — but a bot must never soft-lock
        // the game, so fall back to any legal action if dispatch refuses.
        if (!this.dispatch(chooseBotAction(this.state, level))) this.botFallback();
      },
      700 + Math.random() * 600,
    );
  }

  private botFallback(): void {
    const mv = bestAutoMove(this.state, this.state.current);
    if (mv && this.dispatch({ type: 'move', to: mv })) return;
    const slots = getLegalWallSlots(this.state);
    if (slots.length > 0 && this.dispatch({ type: 'wall', wall: slots[0] })) return;
    this.dispatch({ type: 'pass' });
  }

  private stopBot(): void {
    if (this.botTimeout !== null) {
      clearTimeout(this.botTimeout);
      this.botTimeout = null;
    }
  }

  /** Full reset — a new turn starts with a fresh clock. */
  private resetTimer(): void {
    this.secondsLeft = this.timerSeconds;
    this.resumeTimer();
  }

  /** (Re)start the countdown from the PRESERVED remaining seconds (tab return, overlay close). */
  private resumeTimer(): void {
    this.stopTimer();
    if (!this.timerSeconds || this.state.status !== 'playing') return;
    if (document.hidden || this.paused) return;
    if (this.isBotTurn()) return; // bots act on their own; no countdown
    if (this.secondsLeft <= 0) this.secondsLeft = this.timerSeconds;
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
    this.stopBot();
    this.handlers = {};
  }
}
