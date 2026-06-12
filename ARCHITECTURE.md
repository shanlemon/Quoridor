# Architecture

## Packages

```
@quori/engine     pure TS rules engine — no DOM, no Node APIs (lib: ES2022 only)
@quori/protocol   wire protocol — zod schemas validate every client→server message
@quori/server     authoritative game server — node:http + ws, rooms, bots, reconnect
@quori/client     Vite + PixiJS v8 presentation layer (hotseat + online)
```

All packages consume each other as workspace source (`exports` → `src/index.ts`);
Vite/tsx/Vitest run the TypeScript directly. Nothing is published.

## Multiplayer model (M3)

```
 Browser A ─┐                        ┌──────────────────────────────┐
 Browser B ─┼── wss /ws ──────────▶ │ Room (one per code/instance) │
 Browser C ─┘   intents (zod)       │  · lobby → playing → finished│
   ▲                                │  · applyAction (shared engine)│
   └── events / snapshots ───────── │  · turnSeq replay guard       │
                                    │  · server timers + bots       │
                                    │  · 60s grace → bot takeover   │
                                    └──────────────────────────────┘
```

- **The server is authoritative.** Clients send intents (`action` with the
  `turnSeq` they saw); the room validates seat ownership, replay freshness, and
  rule legality via the same `@quori/engine`, then broadcasts the event.
- **Clients are event-sourced.** `NetworkController` re-applies each broadcast
  action through the engine and verifies the resulting `turnSeq`; any divergence
  triggers a `resync` → full snapshot. Join/reconnect always starts from a snapshot.
- **Reconnect:** a stable client token identifies the member; the seat is held for
  60 s after a drop, then bot-driven until the player returns. Extra joiners are
  spectators. Hosts migrate when the host leaves the lobby.
- **Discord-readiness (M4):** rooms are keyed by a 4-letter code today; under the
  Embedded App SDK the `instanceId` becomes the key. The server serves the built
  client from the same origin with relative URLs only, matching the activity
  proxy's constraints; `/api/token` is stubbed for the OAuth exchange.

## State flow

```
        ┌──────────────────────────────────────────────────────┐
        │ GameController (client/src/controller.ts)             │
        │  · owns the immutable GameState                       │
        │  · dispatch(action) → engine.applyAction → new state  │
        │  · turn timer → bestAutoMove on expiry                │
        └──────┬──────────────────────────────┬─────────────────┘
   intents     │ events: moved / wallPlaced / │
 (move, wall)  │ invalid / turn / timer /     │
        ▲      │ finished / passed            ▼
┌───────┴──────┴───┐                 ┌──────────────────┐
│ BoardView (Pixi) │                 │ Hud (DOM)        │
│ hit-test, anims, │                 │ cards, history,  │
│ ghost previews   │                 │ toasts, results  │
└──────────────────┘                 └──────────────────┘
```

- **The renderer never owns game logic.** `BoardView` converts pointer positions to
  cells/wall slots and asks the controller (`legalMoves()`, `checkWall()`) before
  showing anything; every state change goes through `applyAction`.
- `main.ts` wires controller events into a **serialized animation queue** so a timer
  auto-move can never interleave with a running hop/fence animation.
- **Bots** live in the controller: any seat may be a `BotLevel`; after each turn the
  controller schedules `chooseBotAction` behind a 0.7–1.3 s "thinking" delay. The view
  layer just sees ordinary events — it additionally hides move dots, locks the mode
  bar, and ignores taps while `isBotTurn()`. Bots and the turn timer both pause while
  the tab is hidden, matching the paused renderer.
- The local `GameController` and the online `NetworkController` expose the same
  surface (`dispatch`, events, `inputLocked()`, `seatMeta()`), so the board, HUD and
  all animations are identical in both modes; `main.ts` only swaps the controller.

## Engine model

- `Cell {x, y}` — x 0–8 west→east, y 0–8 north→south. Edges: north y=0, south y=8.
- `Wall {x, y, o}` — occupies intersection (x, y), x/y ∈ 0..7. `'h'` blocks crossing
  between rows y/y+1 for columns x and x+1; `'v'` blocks columns x/x+1 for rows y/y+1.
- `GameState` is treated as immutable; `applyAction` returns a fresh state or a typed
  error (`ActionResult`). Notation: cells `a1…i9` (row 1 = south), walls `e3h`.

Key entry points (`packages/engine/src`):

| function | role |
|---|---|
| `createGame(2\|3\|4, {wallsPerPlayer?})` | layouts, wall counts, clockwise seats |
| `getLegalMoves(state, i)` | steps + straight jumps + diagonal side-steps |
| `checkWallPlacement(state, w)` | bounds, overlap/cross, BFS path check for **all** players; reports `trapped` seats for UI tooltips |
| `getLegalWallSlots(state)` | all currently legal slots |
| `applyAction(state, action)` | move / wall / pass → new state or typed error |
| `distanceField / shortestPathLength / bestAutoMove` | BFS distances (pawns ignored), auto-move |
| `chooseBotAction(state, level, rng?)` | bot ladder: easy racer / greedy margin heuristic / +1-ply look-ahead |
| `rankPlayers(state)` | winner first, then remaining distance (ties share rank) |
| `renderAscii(state)` | CLI playtest / debugging |

## Client rendering (isometric)

- All game/hit-test **math** lives in a flat **780×780 board-unit space** (CELL 64,
  GAP 14, MARGIN 46); only **drawing** projects through a classic 2:1 isometric
  transform (`iso(u,v,z)`), and pointer input is inverse-projected back into board
  units — so cell/wall-slot picking is identical to a flat renderer.
- Tiles are extruded "garden blocks" (top diamond + two shaded side faces) over one
  big extruded mat; fences stand upright with posts, rails and ground shadows, drawn
  in white so the placement ghost can be tinted green/red multiplicatively.
- Pawns, fences and goal banners live in one depth-sorted layer
  (`zIndex = u + v` of their board position) so things overlap correctly; characters
  are billboarded vector sprites with squashed elliptical shadows.
- One `world` container is scaled/centred to the host element, so responsive resize
  is a single scale update (a `ResizeObserver` drives it).
- Characters are pure vector `Graphics` (no assets). Juice over detail: squash-and-
  stretch hops with anticipation/landing, fence drop with dust puff + micro screen
  shake, idle bobbing, pulsing legal-move tiles, confetti on win.
- SFX are synthesized with WebAudio oscillators (hop/thunk/bonk/chime/fanfare);
  mute preference persists in `localStorage`.
- The tween scheduler (`anim.ts`) is promise-based and driven by the Pixi ticker; a
  tween whose target was destroyed is dropped instead of killing the render loop.

## Testing strategy

- `packages/engine/test/*.test.ts` — primary unit suites (movement, jumps, walls,
  traps, wins, pass, ranking, notation, ASCII), coverage thresholds enforced (≥90%).
- `packages/engine/test/_audit_*.test.ts` — adversarial suites authored by independent
  review agents against the official rules, kept in CI. Includes a 2,000-position
  differential fuzz against a from-scratch reference implementation.
- The client is verified end-to-end by driving real pointer events through Pixi's
  event system (move, fence, illegal fence, jump, win, rematch, 4p rotation, resize).
