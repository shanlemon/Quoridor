import './styles.css';
import { CHARACTERS, getLegalWallSlots } from '@quori/engine';
import type { ActionError, BotLevel, PlayerCount } from '@quori/engine';
import type { RoomConfig } from '@quori/protocol';
import { BoardView } from './board-view';
import type { BoardMode } from './board-view';
import { CHARACTER_META } from './characters';
import { GameController } from './controller';
import { $, escapeHtml } from './dom';
import type { NetworkController } from './net-controller';
import { OnlineSession } from './online';
import type { LobbyState } from './online';
import { helpSeen, initHelp, showHelp } from './help';
import { Hud } from './hud';
import { sfx } from './sfx';

export type PlayController = GameController | NetworkController;

const hud = new Hud();
let controller: PlayController | null = null;
let board: BoardView | null = null;
let mode: BoardMode = 'move';
let timerLeft: number | null = null;
let online: OnlineSession | null = null;
/** Last markup written to #lobby-config — skip rewrites (and focus loss) on roster-only broadcasts. */
let lastLobbyConfigHtml = '';

// Local setup choices
let playerCount: PlayerCount = 2;
let timerSeconds = 0;
const seatConfig: (BotLevel | null)[] = [null, null, null, null];

/**
 * Each new game bumps the generation; queued continuations from a previous
 * game check it and bail, so a restart mid-animation can never replay an old
 * celebration or overlay onto the new board.
 */
let gen = 0;
let starting = false;
let pendingAnims = 0;

// Serialize animations so an auto/bot/remote move can't overlap a running hop.
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
  const locked = controller.inputLocked();
  hud.renderPlayers(controller, state.status === 'playing' && controller.lockKind() !== 'bot' ? timerLeft : null);
  hud.updateStatus(state, mode, controller.lockKind(), controller.currentActorName());
  hud.updateModeBar(state, mode, locked);
  hud.renderHistory(controller);
  board.setActiveSeat(state.status === 'playing' ? state.current : null);
  const dots = state.status === 'playing' && !locked && mode === 'move' ? controller.legalMoves() : [];
  board.setHighlights(dots, CHARACTER_META[state.players[state.current].character].color);
  maybeAutoPass();
}

/**
 * Local games only (the server does this online): a player with no legal move
 * AND no legal fence would soft-lock — pass for them after a short beat.
 */
function maybeAutoPass(): void {
  const c = controller;
  if (!c || c.kind !== 'local' || c.state.status !== 'playing') return;
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
  if (next === 'wall' && controller.inputLocked()) {
    sfx.bonk();
    hud.toast("It's not your turn!");
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

function wireController(c: PlayController): void {
  // A reused controller (online resync/rematch) keeps its old handler set
  // otherwise — clear before rewiring so exactly one set fires per event.
  c.removeAllListeners();
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
    // chime only when it's an actionable turn (yours, or any hotseat turn)
    if (!c.inputLocked()) sfx.chime();
    if (
      mode === 'wall' &&
      (c.inputLocked() || c.state.players[c.state.current].wallsLeft === 0)
    ) {
      mode = 'move';
      board?.setMode('move');
    }
    if (c.kind === 'online') refresh();
  });

  c.on('timer', ({ secondsLeft }) => {
    if (gen !== myGen) return;
    timerLeft = secondsLeft;
    if (c.state.status === 'playing' && pendingAnims === 0 && c.lockKind() !== 'bot') {
      hud.renderPlayers(c, timerLeft);
    }
  });

  c.on('finished', ({ winner }) => {
    enqueue(myGen, async () => {
      sfx.fanfare();
      mode = 'move';
      refresh();
      await board?.celebrateWin(winner);
      // A new game may have mounted during the multi-second celebration.
      if (gen !== myGen) return;
      // Don't stack the results dialog over an open setup dialog.
      if ($('setup-overlay').classList.contains('hidden')) hud.showGameOver(c);
    });
  });

  if (c.kind === 'online') {
    c.onSeatsChanged(() => {
      if (gen !== myGen) return;
      refresh();
    });
  }
}

/** Tear down the previous game and mount a board for the given controller. */
async function mountGame(c: PlayController): Promise<void> {
  const myGen = ++gen;
  $('setup-overlay').classList.add('hidden');
  $('gameover-overlay').classList.add('hidden');

  board?.destroy();
  board = null;
  queue = Promise.resolve();
  controller = c;
  timerLeft = c.timerSeconds > 0 ? c.timerSeconds : null;
  mode = 'move';

  const host = $('board-container');
  host.querySelectorAll('canvas').forEach((cv) => cv.remove());

  const view = await BoardView.create(host, c.state, {
    onMoveTap: (cell) => {
      if (c.state.status !== 'playing' || c.inputLocked()) return;
      if (c.legalMoves().some((m) => m.x === cell.x && m.y === cell.y)) {
        c.dispatch({ type: 'move', to: cell });
      }
    },
    onWallConfirm: (wall) => {
      if (c.inputLocked()) return;
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
  // Another mount may have superseded this one during the async create.
  if (gen !== myGen) {
    view.destroy();
    return;
  }
  board = view;

  wireController(c);
  refresh();
}

// ---------------------------------------------------------------- local mode

async function startLocalGame(): Promise<void> {
  if (starting) return;
  starting = true;
  try {
    leaveOnlineIfAny(); // also destroys an online controller, if any
    controller?.destroy();
    controller = null;
    const local = new GameController(playerCount, {
      timerSeconds,
      bots: seatConfig.slice(0, playerCount),
    });
    await mountGame(local);
    local.begin(); // first bot turn, if seat 0 is a bot
    if (!helpSeen()) showHelp();
    syncPause();
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

/** Local games: bots and the turn clock freeze while a modal overlay covers the board. */
function syncPause(): void {
  if (!controller || controller.kind !== 'local') return;
  if (anyOverlayOpen()) controller.pause();
  else controller.resume();
}

// --------------------------------------------------------------- online mode

function leaveOnlineIfAny(): void {
  if (online) {
    online.leave();
    online = null;
  }
  lastLobbyConfigHtml = ''; // a fresh room must always render its config
  showLobbyPanel(false);
}

function showLobbyPanel(inLobby: boolean): void {
  $('online-entry').classList.toggle('hidden', inLobby);
  $('online-lobby').classList.toggle('hidden', !inLobby);
}

function onlineError(msg: string): void {
  $('online-error').textContent = msg;
  setTimeout(() => {
    $('online-error').textContent = '';
  }, 4000);
}

function makeOnlineSession(): OnlineSession {
  return new OnlineSession({
    onLobby(lobby) {
      renderLobby(lobby);
      showLobbyPanel(true);
    },
    onSnapshot(net, isFirst) {
      void (async () => {
        if (controller && controller !== net) controller.destroy(); // e.g. a local game was running
        await mountGame(net);
        if (isFirst && !helpSeen()) showHelp();
        if (!isFirst) hud.toast('Synced with the garden! 🌱');
      })();
    },
    onError(code, msg) {
      if (code === 'INVALID') {
        sfx.bonk();
        hud.toast(
          msg === 'NOT_YOUR_TURN' ? "It's not your turn!" : hud.errorMessage(msg as ActionError),
        );
        return;
      }
      onlineError(msg);
      hud.toast(msg);
    },
    onConnection(status) {
      if (status === 'reconnecting') hud.toast('Connection lost — reconnecting… 🛜');
      if (status === 'gone' && online) hud.toast('Disconnected from the room.');
    },
  });
}

function renderLobby(lobby: LobbyState): void {
  $('lobby-code').textContent = lobby.code;
  const isHost = lobby.members.some((m) => m.id === lobby.youId && m.host);

  $('lobby-members').innerHTML = lobby.members
    .map((m) => {
      const tags = [
        m.host ? '👑 host' : '',
        m.id === lobby.youId ? 'you' : '',
        m.seat !== null ? CHARACTER_META[CHARACTERS[m.seat]].emoji : '',
      ]
        .filter(Boolean)
        .join(' · ');
      return `<div class="lobby-member ${m.connected ? '' : 'offline'}">
        <span>${escapeHtml(m.name)}</span><span class="tags">${tags}${m.connected ? '' : ' · 📵'}</span>
      </div>`;
    })
    .join('');

  const cfg = lobby.config;
  const pill = (label: string, active: boolean, attrs: string): string =>
    `<button class="pill ${active ? 'active' : ''}" aria-pressed="${active}" ${isHost ? '' : 'disabled'} ${attrs}>${label}</button>`;
  const configHtml = `
    <h3>Seats</h3>
    <div class="pill-row" data-cfg="seats">
      ${[2, 3, 4].map((n) => pill(`${n}`, cfg.seats === n, `data-seats="${n}"`)).join('')}
    </div>
    <h3>Turn timer</h3>
    <div class="pill-row" data-cfg="timer">
      ${[0, 30, 60, 90].map((t) => pill(t === 0 ? 'Off' : `${t}s`, cfg.timerSeconds === t, `data-timer="${t}"`)).join('')}
    </div>
    <h3>Fill empty seats with bots</h3>
    <div class="pill-row" data-cfg="bots">
      ${(
        [
          [null, 'None'],
          ['easy', '🤖 Easy'],
          ['medium', '🤖 Smart'],
          ['hard', '🤖 Genius'],
        ] as const
      )
        .map(([lvl, label]) => pill(label, cfg.botFill === lvl, `data-botfill="${lvl ?? 'none'}"`))
        .join('')}
    </div>`;
  // Compare against the last string we wrote (not live innerHTML, which the
  // browser normalizes) so roster-only broadcasts don't rebuild the pills.
  if (configHtml !== lastLobbyConfigHtml) {
    lastLobbyConfigHtml = configHtml;
    $('lobby-config').innerHTML = configHtml;
  }

  const startBtn = $('btn-online-start') as HTMLButtonElement;
  startBtn.style.display = isHost ? '' : 'none';
  const humans = lobby.members.filter((m) => m.connected).length;
  $('lobby-hint').textContent = isHost
    ? humans >= cfg.seats
      ? 'Everyone is here — start when ready!'
      : cfg.botFill
        ? 'Empty seats will be filled with bots.'
        : `Waiting for ${cfg.seats - humans} more (or turn on bot fill).`
    : 'Waiting for the host to start…';

  if (lobby.phase !== 'lobby') {
    $('lobby-hint').textContent = 'Game in progress — you will join as a spectator.';
    startBtn.style.display = 'none';
  }
}

function initOnlineUi(): void {
  const nameInput = $('online-name') as HTMLInputElement;
  const codeInput = $('online-code') as HTMLInputElement;
  nameInput.value = OnlineSession.lastName();
  codeInput.value = OnlineSession.lastRoom();

  const getName = (): string | null => {
    const name = nameInput.value.trim();
    if (!name) {
      onlineError('Pick a name first!');
      nameInput.focus();
      return null;
    }
    return name;
  };

  $('btn-create-room').addEventListener('click', () => {
    const name = getName();
    if (!name) return;
    leaveOnlineIfAny();
    online = makeOnlineSession();
    online.create(name).catch(() => onlineError('Could not reach the game server — is it running?'));
  });

  $('btn-join-room').addEventListener('click', () => {
    const name = getName();
    if (!name) return;
    const code = codeInput.value.trim().toUpperCase();
    if (code.length !== 4) {
      onlineError('Room codes are 4 letters.');
      codeInput.focus();
      return;
    }
    leaveOnlineIfAny();
    online = makeOnlineSession();
    online.join(code, name).catch(() => onlineError('Could not reach the game server — is it running?'));
  });

  // One delegated listener for the host's config pills (markup is re-rendered
  // per broadcast; reading online.lobby here always sees the freshest config).
  $('lobby-config').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn || btn.disabled || !online?.lobby || !online.isHost()) return;
    const next: RoomConfig = { ...online.lobby.config };
    if (btn.dataset.seats) next.seats = Number(btn.dataset.seats) as RoomConfig['seats'];
    if (btn.dataset.timer !== undefined)
      next.timerSeconds = Number(btn.dataset.timer) as RoomConfig['timerSeconds'];
    if (btn.dataset.botfill)
      next.botFill = btn.dataset.botfill === 'none' ? null : (btn.dataset.botfill as BotLevel);
    sfx.pick();
    online.sendConfig(next);
  });

  $('btn-online-start').addEventListener('click', () => online?.start());
  $('btn-leave-room').addEventListener('click', () => {
    leaveOnlineIfAny();
  });
  $('lobby-code').addEventListener('click', () => {
    void navigator.clipboard?.writeText($('lobby-code').textContent ?? '');
    hud.toast('Room code copied! 📋');
  });

  // tabs
  $('tab-local').addEventListener('click', () => switchTab('local'));
  $('tab-online').addEventListener('click', () => switchTab('online'));
}

function switchTab(tab: 'local' | 'online'): void {
  $('tab-local').classList.toggle('active', tab === 'local');
  $('tab-local').setAttribute('aria-pressed', String(tab === 'local'));
  $('tab-online').classList.toggle('active', tab === 'online');
  $('tab-online').setAttribute('aria-pressed', String(tab === 'online'));
  $('setup-local').classList.toggle('hidden', tab !== 'local');
  $('setup-online').classList.toggle('hidden', tab !== 'online');
  sfx.pick();
}

// ----------------------------------------------------------------- top bar

function initSetup(): void {
  const pickPill = (row: HTMLElement, target: HTMLElement): void => {
    row.querySelectorAll('.pill').forEach((p) => {
      p.classList.remove('active');
      p.setAttribute('aria-pressed', 'false');
    });
    target.classList.add('active');
    target.setAttribute('aria-pressed', 'true');
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
  $('btn-start').addEventListener('click', () => void startLocalGame());
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
    if (controller?.kind === 'online') {
      if (!window.confirm('Leave the online room?')) return;
      leaveOnlineIfAny();
      controller = null;
      switchTab('online');
    }
    $('setup-overlay').classList.remove('hidden');
    syncPause();
  });
  $('btn-history').addEventListener('click', () => {
    const panel = $('history-panel');
    panel.classList.toggle('open');
    $('btn-history').setAttribute('aria-expanded', String(panel.classList.contains('open')));
    if (panel.classList.contains('open')) panel.scrollTop = panel.scrollHeight;
  });
  const muteBtn = $('btn-mute');
  muteBtn.textContent = sfx.isMuted() ? '🔇' : '🔊';
  muteBtn.addEventListener('click', () => {
    muteBtn.textContent = sfx.toggleMuted() ? '🔇' : '🔊';
  });

  $('btn-rematch').addEventListener('click', () => {
    if (controller?.kind === 'online') {
      if (online?.isHost()) online.rematch();
      else hud.toast('Only the host can start a rematch!');
      return;
    }
    void startLocalGame();
  });
  $('btn-setup').addEventListener('click', () => {
    $('gameover-overlay').classList.add('hidden');
    $('setup-overlay').classList.remove('hidden');
    syncPause();
  });

  window.addEventListener('keydown', (e) => {
    if (anyOverlayOpen()) return; // dialogs own the keyboard
    if (e.key === 'Escape') setMode('move');
    else if (e.key === 'w' || e.key === 'f') setMode('wall');
    else if (e.key === 'm') setMode('move');
  });

  if (window.innerWidth >= 1100) {
    $('history-panel').classList.add('open');
    $('btn-history').setAttribute('aria-expanded', 'true');
  }
}

initSetup();
initOnlineUi();
initTopbar();
initHelp(() => syncPause());

// Dev-only introspection hooks for QA tooling.
if (import.meta.env.DEV) {
  Object.defineProperty(window, '__quori', {
    get: () => (controller ? { state: controller.state, history: controller.history } : null),
  });
  Object.defineProperty(window, '__quoriBoard', { get: () => board });
  Object.defineProperty(window, '__quoriOnline', { get: () => online });
}
