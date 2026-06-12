/**
 * Headless test player for end-to-end multiplayer verification.
 *
 *   pnpm --filter @quori/server exec tsx scripts/e2e-player.ts <CODE> <NAME> [maxMoves]
 *
 * Joins the room, and whenever it is this player's turn, plays the
 * shortest-path move. Prints JSON lines for assertions.
 */
import WebSocket from 'ws';
import { bestAutoMove } from '@quori/engine';
import type { GameState } from '@quori/engine';
import type { ClientMessage, ServerMessage } from '@quori/protocol';

const [, , CODE, NAME = 'Remote', MAX = '50'] = process.argv;
if (!CODE) {
  console.error('usage: tsx scripts/e2e-player.ts <CODE> [name] [maxMoves]');
  process.exit(1);
}
const URL = process.env.QUORI_WS ?? 'ws://localhost:5174/ws';
const token = `e2e-${Math.random().toString(36).slice(2)}-padding`;

const ws = new WebSocket(URL);
let mySeat: number | null = null;
let state: GameState | null = null;
let movesMade = 0;

const log = (o: object): void => console.log(JSON.stringify(o));
const send = (msg: ClientMessage): void => ws.send(JSON.stringify(msg));

ws.on('open', () => {
  log({ e: 'open' });
  send({ t: 'join', code: CODE, name: NAME, token });
});

ws.on('message', (data) => {
  const msg = JSON.parse(String(data)) as ServerMessage;
  switch (msg.t) {
    case 'joined':
      log({ e: 'joined', code: msg.code });
      return;
    case 'lobby':
      log({ e: 'lobby', members: msg.members.map((m) => m.name), phase: msg.phase });
      return;
    case 'snapshot':
      mySeat = msg.snap.yourSeat;
      state = msg.snap.state;
      log({ e: 'snapshot', yourSeat: mySeat, turnSeq: state.turnSeq, phase: msg.snap.phase });
      maybeAct();
      return;
    case 'ev':
      if (msg.ev.kind === 'turn' || msg.ev.kind === 'moved' || msg.ev.kind === 'wallPlaced' || msg.ev.kind === 'passed') {
        // stay simple and authoritative: refresh the snapshot, then act
        send({ t: 'resync' });
      }
      if (msg.ev.kind === 'finished') {
        log({ e: 'finished', winner: msg.ev.winner });
        setTimeout(() => process.exit(0), 200);
      }
      return;
    case 'invalid':
      log({ e: 'invalid', error: msg.error });
      return;
    case 'err':
      log({ e: 'err', code: msg.code, msg: msg.msg });
      return;
    case 'pong':
      return;
  }
});

function maybeAct(): void {
  if (!state || mySeat === null) return;
  if (state.status !== 'playing' || state.current !== mySeat) return;
  if (movesMade >= Number(MAX)) return;
  const mv = bestAutoMove(state, mySeat);
  if (!mv) return;
  movesMade += 1;
  log({ e: 'acting', to: mv, turnSeq: state.turnSeq });
  send({ t: 'action', action: { type: 'move', to: mv }, turnSeq: state.turnSeq });
}

ws.on('close', () => {
  log({ e: 'close' });
});
ws.on('error', (err) => {
  log({ e: 'socket-error', msg: String(err) });
  process.exit(1);
});
