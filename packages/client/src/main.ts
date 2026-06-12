import './styles.css';
import { CHARACTERS, getLegalWallSlots } from '@quori/engine';
import type { BotLevel, PlayerCount } from '@quori/engine';
import { BoardView } from './board-view';
import type { BoardMode } from './board-view';
import { CHARACTER_META } from './characters';
import { GameController } from './controller';
import { helpSeen, initHelp, showHelp } from './help';
import { Hud } from './hud';
import { sfx } from './sfx';

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

const hud = new Hud();
let controller: GameController | null = null;
let board: BoardView | null = null;
let mode: BoardMode = 'move';
let timerLeft: number | null = null;

// Setup choices
let playerCount: PlayerCount = 2;
let timerSeconds = 0;
const seatConfig: (BotLevel | null)[] = [null, null, null, null];

/**
 * Each startGame() bumps the generation; queued continuations from a previous
 * game check it and bail, so a rematch mid-animation can never replay an old
 * celebration or overlay onto the new board.
 */
let gen = 0;
let starting = false;
let pendingAnims = 0;

// Serialize animations so a timer auto-move can't overlap a running hop.
let queue: Promise<void> = Promise.resolve();
function enqueue(myGen: number, fn: () => Promise<void>): void {
  pendingAnims++;
  queue = queue
    .then(async () => {
      if (gen === myGen) await fn();
    })
    .catch((err) => console.error('[quori] animation error', err))
    .finally(() => {
      pendingAnims--;
    });
}

function refresh(): void {
  if (!controller || !board) return;
  const state = controller.state;
  const botTurn = controller.isBotTurn();
  hud.renderPlayers(controller, state.status === 'playing' && !botTurn ? timerLeft : null);
  hud.updateStatus(state, mode, botTurn);
  hud.updateModeBar(state, mode, botTurn);
  hud.renderHistory(controller);
  board.setActiveSeat(state.status === 'playing' ? state.current : null);
  const dots =
    state.status === 'playing' && !botTurn && mode === 'move' ? controller.legalMoves() : [];
  board.setHighlights(dots, CHARACTER_META[state.players[state.current].character].color);
  maybeAutoPass();
}

/**
 * A player with no legal move AND no legal fence (rare, but reachable) would
 * soft-lock a timer-less game — there is no Pass button. Pass for them after a
 * short beat. If a full round of consecutive passes happens, everyone is stuck
 * and we stop (the position is unresolvable).
 */
function maybeAutoPass(): void {
  const c = controller;
  if (!c || c.state.status !== 'playing') return;
  if (c.isBotTurn()) return; // bots pass on their own
  if (c.legalMoves().length > 0) return;
  if (getLegalWallSlots(c.state).length > 0) return;
  const n = c.state.players.length;
  const recent = c.history.slice(-n);
  if (recent.length === n && recent.every((h) => h.kind === 'pass')) {
    hud.toast('Everyone is stuck! 😱');
    return;
  }
  const myGen = gen;
  const seq = c.state.turnSeq;
  setTimeout(() => {
    if (gen !== myGen || controller !== c) return;
    if (c.state.status !== 'playing' || c.state.turnSeq !== seq) return;
    c.dispatch({ type: 'pass' });
  }, 900);
}

function setMode(next: BoardMode): void {
  if (!controller || !board) return;
  if (controller.state.status !== 'playing') return;
  if (next === 'wall' && controller.isBotTurn()) {
    sfx.bonk();
    hud.toast("It's not your turn! 🤖");
    return;
  }
  if (next === 'wall' && controller.state.players[controller.state.current].wallsLeft === 0) {
    sfx.bonk();
    hud.toast('No fences left!');
    return;
  }
  if (mode !== next) sfx.pick();
  mode = next;
  board.setMode(next);
  refresh();
}

function wireController(c: GameController): void {
  const myGen = gen;

  c.on('moved', ({ seat, from, to, auto }) => {
    enqueue(myGen, async () => {
      sfx.hop();
      if (auto) {
        const meta = CHARACTER_META[c.state.players[seat].character];
        hud.toast(`⏱ Time's up — ${meta.name} ${meta.emoji} hops ahead automatically!`);
      }
      board?.setLastMove(from);
      await board?.animateMove(seat, to);
      refresh();
    });
  });

  c.on('wallPlaced', ({ wall }) => {
    enqueue(myGen, async () => {
      sfx.thunk();
      board?.setLastMove(null);
      await board?.animateWall(wall);
      refresh();
    });
  });

  c.on('passed', () => {
    enqueue(myGen, async () => {
      hud.toast('Completely stuck — the turn passes! 💤');
      refresh();
    });
  });

  c.on('invalid', ({ error }) => {
    if (gen !== myGen) return;
    sfx.bonk();
    hud.toast(hud.errorMessage(error));
  });

  c.on('turn', () => {
    if (gen !== myGen) return;
    sfx.chime();
    // After a wall, the new player may be in wall mode with 0 fences — bounce
    // back. Bot turns also force move mode so no human ghost lingers.
    if (
      mode === 'wall' &&
      (c.isBotTurn() || c.state.players[c.state.current].wallsLeft === 0)
    ) {
      mode = 'move';
      board?.setMode('move');
    }
  });

  c.on('timer', ({ secondsLeft }) => {
    if (gen !== myGen) return;
    timerLeft = secondsLeft;
    // While a hop/fence animation is presenting the previous turn, don't flip
    // the players panel to the next player yet — the post-animation refresh
    // paints the new turn (and its countdown) consistently.
    if (c.state.status === 'playing' && pendingAnims === 0) hud.renderPlayers(c, timerLeft);
  });

  c.on('finished', ({ winner }) => {
    enqueue(myGen, async () => {
      sfx.fanfare();
      mode = 'move';
      refresh();
      await board?.celebrateWin(winner);
      // Don't stack the results dialog over an open setup dialog — the user
      // has already moved on to configuring the next game.
      if ($('setup-overlay').classList.contains('hidden')) hud.showGameOver(c);
    });
  });
}

async function startGame(): Promise<void> {
  if (starting) return;
  starting = true;
  try {
    gen++;
    $('setup-overlay').classList.add('hidden');
    $('gameover-overlay').classList.add('hidden');

    board?.destroy();
    board = null;
    controller?.destroy();
    queue = Promise.resolve();

    controller = new GameController(playerCount, {
      timerSeconds,
      bots: seatConfig.slice(0, playerCount),
    });
    timerLeft = timerSeconds > 0 ? timerSeconds : null;
    mode = 'move';

    const host = $('board-container');
    host.querySelectorAll('canvas').forEach((cv) => cv.remove());

    const c = controller;
    board = await BoardView.create(host, c.state, {
      onMoveTap: (cell) => {
        if (c.state.status !== 'playing' || c.isBotTurn()) return;
        if (c.legalMoves().some((m) => m.x === cell.x && m.y === cell.y)) {
          c.dispatch({ type: 'move', to: cell });
        }
      },
      onWallConfirm: (wall) => {
        if (c.isBotTurn()) return;
        c.dispatch({ type: 'wall', wall });
        mode = 'move';
        board?.setMode('move');
      },
      checkWall: (wall) => c.checkWall(wall),
      onInvalidWallConfirm: (check) => {
        sfx.bonk();
        hud.toast(hud.wallErrorMessage(check, c.state));
      },
      onCancel: () => setMode('move'),
    });

    wireController(c);
    refresh();
    c.begin(); // first bot turn, if seat 0 is a bot
    if (!helpSeen()) showHelp();
    syncPause(); // first-run help pauses bots until dismissed
  } finally {
    starting = false;
  }
}

const SEAT_LABELS: Record<'human' | BotLevel, string> = {
  human: '🧑 Human',
  easy: '🤖 Easy',
  medium: '🤖 Smart',
  hard: '🤖 Genius',
};

function renderSeats(): void {
  const host = $('setup-seats');
  host.innerHTML = '';
  for (let i = 0; i < playerCount; i++) {
    const meta = CHARACTER_META[CHARACTERS[i]];
    const row = document.createElement('div');
    row.className = 'seat-row';
    const name = document.createElement('span');
    name.className = 'seat-name';
    name.textContent = `${meta.emoji} ${meta.name}`;
    const btn = document.createElement('button');
    btn.className = 'pill';
    btn.textContent = SEAT_LABELS[seatConfig[i] ?? 'human'];
    btn.addEventListener('click', () => {
      const order: (BotLevel | null)[] = [null, 'easy', 'medium', 'hard'];
      seatConfig[i] = order[(order.indexOf(seatConfig[i]) + 1) % order.length];
      sfx.pick();
      renderSeats();
    });
    row.append(name, btn);
    host.appendChild(row);
  }
}

function anyOverlayOpen(): boolean {
  return ['setup-overlay', 'help-overlay', 'gameover-overlay'].some(
    (id) => !$(id).classList.contains('hidden'),
  );
}

/** Bots and the turn clock freeze whenever a modal overlay covers the board. */
function syncPause(): void {
  if (!controller) return;
  if (anyOverlayOpen()) controller.pause();
  else controller.resume();
}

function initSetup(): void {
  const pickPill = (row: HTMLElement, target: HTMLElement): void => {
    row.querySelectorAll('.pill').forEach((p) => p.classList.remove('active'));
    target.classList.add('active');
    sfx.pick();
  };
  $('setup-players').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-count]');
    if (!btn) return;
    playerCount = Number(btn.dataset.count) as PlayerCount;
    pickPill($('setup-players'), btn);
    renderSeats();
  });
  renderSeats();
  $('setup-timer').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-timer]');
    if (!btn) return;
    timerSeconds = Number(btn.dataset.timer);
    pickPill($('setup-timer'), btn);
  });
  $('btn-start').addEventListener('click', () => void startGame());
  // clicking the backdrop resumes a running game
  $('setup-overlay').addEventListener('click', (e) => {
    if (e.target === $('setup-overlay') && controller) {
      $('setup-overlay').classList.add('hidden');
      syncPause();
    }
  });
}

function initTopbar(): void {
  $('btn-mode-move').addEventListener('click', () => setMode('move'));
  $('btn-mode-wall').addEventListener('click', () => setMode('wall'));
  $('btn-help').addEventListener('click', () => {
    showHelp();
    syncPause();
  });
  $('btn-new').addEventListener('click', () => {
    $('setup-overlay').classList.remove('hidden');
    syncPause();
  });
  $('btn-history').addEventListener('click', () => {
    const panel = $('history-panel');
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) panel.scrollTop = panel.scrollHeight;
  });
  const muteBtn = $('btn-mute');
  muteBtn.textContent = sfx.isMuted() ? '🔇' : '🔊';
  muteBtn.addEventListener('click', () => {
    muteBtn.textContent = sfx.toggleMuted() ? '🔇' : '🔊';
  });

  $('btn-rematch').addEventListener('click', () => void startGame());
  $('btn-setup').addEventListener('click', () => {
    $('gameover-overlay').classList.add('hidden');
    $('setup-overlay').classList.remove('hidden');
  });

  window.addEventListener('keydown', (e) => {
    if (anyOverlayOpen()) return; // dialogs own the keyboard
    if (e.key === 'Escape') setMode('move');
    else if (e.key === 'w' || e.key === 'f') setMode('wall');
    else if (e.key === 'm') setMode('move');
  });

  if (window.innerWidth >= 1100) $('history-panel').classList.add('open');
}

initSetup();
initTopbar();
initHelp(() => syncPause());

// Dev-only introspection hooks for QA tooling.
if (import.meta.env.DEV) {
  Object.defineProperty(window, '__quori', {
    get: () => (controller ? { state: controller.state, history: controller.history } : null),
  });
  Object.defineProperty(window, '__quoriBoard', { get: () => board });
}
