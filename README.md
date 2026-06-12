# 🌸 Quori Quest

A cute, cozy take on the board game **Quoridor** — chibi animals racing across a garden,
building picket fences to slow each other down. 2–4 players, hotseat, fully playable offline.

> **Status:** Milestones **M1 (rules engine)** and **M2 (local hotseat client)** are complete.
> The multiplayer server (M3) and Discord Activity integration (M4) come next — see
> [GAME_PROMPT.md](GAME_PROMPT.md) for the full product spec.

| 🐰 Mochi | 🐸 Pebble | 🐱 Biscuit | 🐧 Tofu |
|---|---|---|---|
| pink · seat 1 | green · seat 2 | orange · seat 3 | blue · seat 4 |

## Quick start

Requirements: Node 20+ and pnpm (`npm i -g pnpm`).

```bash
pnpm install
pnpm dev          # → http://localhost:5173
```

Pick 2, 3 or 4 players (hotseat — pass the mouse), optionally a turn timer, and start.
Any seat can be handed to a **bot** in the "Who plays whom?" section — cycle each
critter between 🧑 Human, 🤖 Easy, 🤖 Smart and 🤖 Genius. All-bot games work too
(sit back and watch the garden sort itself out).

### Controls

- **Move** — on your turn, glowing dots mark every legal hop (jumps included). Click one.
- **Fence** — toggle 🪵 Fence mode (or press `W`/`F`). Hover between cells to preview a
  fence: **green ghost** = legal, **red ghost** = illegal (with a toast explaining why,
  e.g. *"That would trap Pebble! 🐸"*). Click to confirm. On touch: tap to preview,
  tap again to build. `Esc`/right-click cancels back to move mode.
- **Win** — first pawn to reach the opposite edge.

Other UI: 📜 move history (algebraic notation, e.g. `e2`, `d4h`), 🔊 mute (synthesized
SFX, no assets), ❓ illustrated how-to-play (auto-shows on first run), 🏠 new game,
rematch from the results screen. If the turn timer expires, the player is auto-moved
one step along their shortest path (never auto-fenced).

## CLI playtest (M1)

Drive the engine from a terminal with an ASCII board:

```bash
pnpm playtest          # 2 players
pnpm playtest -- 4     # 4 players
# commands:  m e2 | w e3h | moves | auto | q
```

## Monorepo layout

```
packages/
  engine/   @quori/engine — pure TypeScript rules engine (zero DOM/Node deps)
  client/   @quori/client — Vite + PixiJS hotseat client
```

### Scripts

```bash
pnpm test         # engine unit tests + coverage (threshold ≥90%)
pnpm typecheck    # strict TS across all packages
pnpm build        # engine check + client production build
pnpm lint         # eslint
pnpm check        # CI gate: test + typecheck + build
```

## The engine

`@quori/engine` implements the complete rule set:

- 9×9 board, walls on the 8×8 intersection grid; overlap/crossing checks.
- **Trap rule:** every wall placement is validated with BFS — it must leave *every*
  player a path to their goal (the illegal-wall ghost and server-side rejection share
  this code).
- Full jump rules: straight jumps, and diagonal side-steps only when the straight jump
  is blocked by a wall, the board edge, or a second pawn (no double jumps).
- 2p (10 walls), 3p (4p layout minus the east seat, 7 walls — documented choice),
  4p (5 walls, clockwise seats). Win detection on all four edges, including by jump.
- `shortestPathLength` / `bestAutoMove` for timer auto-moves, ranking and the future
  disconnect-AI; `rankPlayers` for results (winner, then by remaining distance).
- Monotonic `turnSeq` on every accepted action (idempotency guard for the future server).
- A `pass` action, legal only when a player has no move and no legal fence (rare but
  reachable in 3–4p games).
- `chooseBotAction(state, level)` — the bot ladder. *Easy* races its shortest path
  (with a little wandering, never fences). *Smart* greedily maximizes the race margin
  (closest opponent's distance minus its own) over every move and legal fence, paying
  a small cost per fence so it doesn't waste them. *Genius* adds a one-ply look-ahead
  against the opponent's best reply whenever the race is tight. All levels take an
  immediate winning move and only consider fences when not comfortably ahead.

**Testing:** 253 tests. Besides the unit suites, `test/_audit_*.test.ts` were written by
independent adversarial reviewers against the official rules, including a differential
fuzzer that checks `getLegalMoves` and wall legality against a from-scratch reference
implementation across 2,000 random positions.

## 60-second self-QA checklist

1. `pnpm check` — everything green.
2. `pnpm dev`, start a **4-player** game — four pawns on edge centers, 5 fences each.
3. Place a fence next to a pawn corner pocket so it would seal someone in → red ghost,
   confirming shows the "would trap" toast, state unchanged.
3b. Start a 2p game with Pebble set to 🤖 — after your hop the status reads
   "Pebble is thinking… 🤖" and the bot replies on its own; your taps during its
   turn do nothing.
4. March two pawns face to face → the cell *behind* the opponent glows; the jump lands.
5. Finish a 2p race → confetti celebration, results with placements/fences used/duration,
   **Rematch** resets cleanly.
6. Resize the window (or toggle device toolbar) mid-game → board rescales, state intact.

## Roadmap

- **M3** — Colyseus-style authoritative server, rooms, reconnect (the client already
  talks to its `GameController` via intents + events, mirroring the future protocol).
- **M4** — Discord Embedded App SDK, `instanceId` rooms, avatars, activity proxy rules.
- **M5/M6** — final art/audio pass, spectators, emotes, hardening.
