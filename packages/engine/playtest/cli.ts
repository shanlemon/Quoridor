/**
 * Interactive CLI playtest for the Quoridor engine (M1 validation).
 *
 *   pnpm playtest            # 2 players
 *   pnpm playtest -- 4       # 4 players
 *
 * Commands:
 *   m e2     move your pawn to cell e2
 *   w e3h    place a horizontal wall at e3 (or e3v for vertical)
 *   moves    list legal destinations
 *   auto     play the shortest-path auto-move
 *   q        quit
 */
import readline from 'node:readline/promises';
import { stdin, stdout, argv, exit } from 'node:process';
import {
  applyAction,
  bestAutoMove,
  cellToNotation,
  createGame,
  getLegalMoves,
  parseCell,
  parseWall,
  renderAscii,
  shortestPathLength,
} from '../src/index';
import type { GameState, PlayerCount } from '../src/index';

const NAMES = ['Mochi 🐰', 'Pebble 🐸', 'Biscuit 🐱', 'Tofu 🐧'];

function printState(state: GameState): void {
  console.log('\n' + renderAscii(state) + '\n');
  for (const p of state.players) {
    const marker = p.seat === state.current && state.status === 'playing' ? '→' : ' ';
    console.log(
      `${marker} ${p.seat + 1} ${NAMES[p.seat]}  walls: ${p.wallsLeft}  goal: ${p.goal}  dist: ${shortestPathLength(state, p.seat)}`,
    );
  }
}

async function main(): Promise<void> {
  const n = Number(argv[2] ?? 2);
  if (n !== 2 && n !== 3 && n !== 4) {
    console.error('Usage: pnpm playtest -- [2|3|4]');
    exit(1);
  }
  let state = createGame(n as PlayerCount);
  const rl = readline.createInterface({ input: stdin, output: stdout });

  printState(state);
  while (state.status === 'playing') {
    const line = (await rl.question(`${NAMES[state.current]} > `)).trim().toLowerCase();
    if (line === 'q' || line === 'quit') break;
    if (line === 'moves') {
      console.log(getLegalMoves(state, state.current).map(cellToNotation).join('  '));
      continue;
    }
    let result;
    if (line === 'auto') {
      const mv = bestAutoMove(state, state.current);
      result = mv ? applyAction(state, { type: 'move', to: mv }) : applyAction(state, { type: 'pass' });
    } else if (line.startsWith('m ')) {
      const cell = parseCell(line.slice(2));
      if (!cell) {
        console.log('Bad cell — try "m e2".');
        continue;
      }
      result = applyAction(state, { type: 'move', to: cell });
    } else if (line.startsWith('w ')) {
      const wall = parseWall(line.slice(2));
      if (!wall) {
        console.log('Bad wall — try "w e3h" or "w e3v".');
        continue;
      }
      result = applyAction(state, { type: 'wall', wall });
    } else {
      console.log('Commands: m <cell> | w <wall> | moves | auto | q');
      continue;
    }
    if (!result.ok) {
      console.log(`✗ ${result.error}`);
      continue;
    }
    state = result.state;
    printState(state);
  }
  if (state.winner !== null) console.log(`\n🎉 ${NAMES[state.winner]} wins!\n`);
  rl.close();
}

void main();
