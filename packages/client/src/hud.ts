import { rankPlayers } from '@quori/engine';
import type { ActionError, GameState, WallCheck } from '@quori/engine';
import { CHARACTER_META } from './characters';
import { $, escapeHtml } from './dom';
import type { PlayController } from './main';

const GOAL_ARROWS = { north: '⬆️', south: '⬇️', east: '➡️', west: '⬅️' } as const;

/** All DOM chrome around the canvas: player cards, status, history, toasts, results. */
export class Hud {
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly coarse = window.matchMedia('(pointer: coarse)').matches;

  renderPlayers(c: PlayController, timerLeft: number | null): void {
    const state = c.state;
    const panel = $('players-panel');
    panel.dataset.count = String(state.players.length);
    panel.innerHTML = state.players
      .map((p) => {
        const meta = CHARACTER_META[p.character];
        const seatMeta = c.seatMeta(p.seat);
        const active = state.status === 'playing' && p.seat === state.current;
        const winner = state.winner === p.seat;
        const fences =
          Array.from({ length: p.wallsLeft }, () => '<span class="fence-chip"></span>').join('') ||
          '<span class="goal-hint">no fences left</span>';
        const timer =
          active && timerLeft !== null
            ? `<span class="timer-badge ${timerLeft <= 5 ? 'urgent' : ''}">⏱ ${timerLeft}s</span>`
            : '';
        const badges = [
          seatMeta.bot ? '🤖' : '',
          seatMeta.you ? '<span class="you-chip">you</span>' : '',
          !seatMeta.connected ? '📵' : '',
        ]
          .filter(Boolean)
          .join(' ');
        const owner =
          seatMeta.label && seatMeta.label !== meta.name
            ? `<div class="goal-hint">${escapeHtml(seatMeta.label)}</div>`
            : '';
        return `
        <div class="player-card ${active ? 'active' : ''} ${winner ? 'winner' : ''}" style="--pc:${meta.colorCss}">
          <div class="avatar" style="--pc:${meta.colorCss}40">${meta.emoji}</div>
          <div class="pinfo">
            <div class="pname">${meta.name} ${badges} <span class="goal-hint char-icon">${meta.icon}</span></div>
            ${owner}
            <div class="goal-hint home-hint">home: ${GOAL_ARROWS[p.goal]} ${p.goal}</div>
            <div class="fences" data-count="${p.wallsLeft}">${fences}</div>
          </div>
          ${timer}${winner ? '<span>👑</span>' : ''}
        </div>`;
      })
      .join('');
  }

  updateStatus(
    state: GameState,
    mode: 'move' | 'wall',
    lock: 'bot' | 'remote' | null = null,
    actorName: string | null = null,
  ): void {
    const status = $('status-text');
    if (state.status === 'finished' && state.winner !== null) {
      const meta = CHARACTER_META[state.players[state.winner].character];
      status.textContent = `🎉 ${meta.name} ${meta.emoji} wins the quest!`;
      return;
    }
    const meta = CHARACTER_META[state.players[state.current].character];
    if (lock === 'bot') {
      status.textContent = `${meta.emoji} ${meta.name} is thinking… 🤖`;
      return;
    }
    if (lock === 'remote') {
      status.textContent = `${meta.emoji} Waiting for ${actorName ?? meta.name}… 🌐`;
      return;
    }
    if (mode === 'move') {
      status.textContent = this.coarse
        ? `${meta.emoji} ${meta.name}: tap a dot to hop`
        : `${meta.emoji} ${meta.name}'s turn — tap a glowing dot to hop!`;
    } else {
      status.textContent = this.coarse
        ? `${meta.emoji} ${meta.name}: tap board, then Place Fence`
        : `${meta.emoji} ${meta.name}'s turn - click the board to preview, then Place Fence`;
    }
  }

  updateModeBar(state: GameState, mode: 'move' | 'wall', inputLocked = false): void {
    const moveBtn = $('btn-mode-move') as HTMLButtonElement;
    const wallBtn = $('btn-mode-wall') as HTMLButtonElement;
    moveBtn.classList.toggle('active', mode === 'move');
    moveBtn.setAttribute('aria-pressed', String(mode === 'move'));
    wallBtn.classList.toggle('active', mode === 'wall');
    wallBtn.setAttribute('aria-pressed', String(mode === 'wall'));
    const me = state.players[state.current];
    $('wall-count').textContent = String(me.wallsLeft);
    const locked = state.status !== 'playing' || inputLocked;
    moveBtn.disabled = locked;
    wallBtn.disabled = locked || me.wallsLeft === 0;
  }

  renderHistory(c: PlayController): void {
    const list = $('history-list');
    list.innerHTML = c.history
      .map((h, i) => {
        const meta = CHARACTER_META[c.state.players[h.seat].character];
        const kind = h.kind === 'wall' ? '🪵 ' : h.kind === 'pass' ? '💤 ' : '';
        return `<li class="${i === c.history.length - 1 ? 'latest' : ''}">${meta.emoji} ${kind}${h.notation}${h.auto ? ' ⏱' : ''}</li>`;
      })
      .join('');
    const panel = $('history-panel');
    panel.scrollTop = panel.scrollHeight;
  }

  toast(msg: string): void {
    const toast = $('toast');
    toast.textContent = msg;
    toast.classList.add('show');
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => toast.classList.remove('show'), 2100);
  }

  errorMessage(error: ActionError): string {
    switch (error) {
      case 'ILLEGAL_MOVE':
        return "Can't hop there!";
      case 'WALL_OVERLAPS':
        return "Fences can't overlap!";
      case 'WALL_OUT_OF_BOUNDS':
        return "That's outside the garden!";
      case 'WALL_BLOCKS_PATH':
        return "That would trap someone — everyone needs a path home!";
      case 'NO_WALLS_LEFT':
        return 'No fences left!';
      case 'GAME_OVER':
        return 'The game is over!';
      case 'PASS_NOT_ALLOWED':
        return 'You can still play — no passing!';
    }
  }

  wallErrorMessage(check: WallCheck, state: GameState): string {
    if (!check.legal && check.reason === 'WALL_BLOCKS_PATH' && check.trapped.length > 0) {
      const names = check.trapped
        .map((seat) => {
          const meta = CHARACTER_META[state.players[seat].character];
          return `${meta.name} ${meta.emoji}`;
        })
        .join(' and ');
      return `That would trap ${names}!`;
    }
    return this.errorMessage(check.legal ? 'ILLEGAL_MOVE' : check.reason);
  }

  showGameOver(c: PlayController): void {
    const state = c.state;
    if (state.winner === null) return;
    const winMeta = CHARACTER_META[state.players[state.winner].character];
    $('gameover-title').textContent = `${winMeta.emoji} ${winMeta.name} wins!`;

    const medals = ['🥇', '🥈', '🥉', '🌼'];
    $('results-table').innerHTML = rankPlayers(state)
      .map((r) => {
        const p = state.players[r.seat];
        const meta = CHARACTER_META[p.character];
        const place = medals[Math.min(r.rank - 1, medals.length - 1)];
        const dist =
          r.seat === state.winner
            ? '🏁 made it home!'
            : `${r.distance} hop${r.distance === 1 ? '' : 's'} from home`;
        const used = c.initialWalls - p.wallsLeft;
        return `<tr class="${r.seat === state.winner ? 'winner-row' : ''}">
          <td>${place}</td><td>${meta.emoji} ${meta.name}</td><td>${dist}</td><td>🪵 ${used} used</td>
        </tr>`;
      })
      .join('');

    const secs = Math.round((Date.now() - c.startedAt) / 1000);
    $('gameover-duration').textContent =
      `Match time: ${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s · ${c.history.length} moves`;
    $('gameover-overlay').classList.remove('hidden');
  }
}
