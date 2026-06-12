# Architecture

## Packages

```
@quori/engine   pure TS rules engine — no DOM, no Node APIs (lib: ES2022 only)
@quori/client   Vite + PixiJS v8 presentation layer
```

The client consumes the engine as workspace source (`exports` → `src/index.ts`);
Vite bundles it directly, Vitest runs it directly. Nothing is published.

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
- This is deliberately the shape of the future client↔server protocol: `dispatch`
  becomes "send intent", the event handlers become "apply server broadcast". The
  engine's `turnSeq` (bumped on every accepted action, unchanged on rejection) is the
  replay/idempotency guard.

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
| `rankPlayers(state)` | winner first, then remaining distance (ties share rank) |
| `renderAscii(state)` | CLI playtest / debugging |

## Client rendering

- Everything is drawn in a fixed **780×780 unit space** (CELL 64, GAP 14, MARGIN 46);
  one `world` container is scaled/centred to the host element, so responsive resize is
  a single scale update (a `ResizeObserver` drives it) and all hit math stays integral.
- Characters are pure vector `Graphics` (no assets). Juice over detail: squash-and-
  stretch hops with anticipation/landing, fence drop with dust puff + micro screen
  shake, idle bobbing, pulsing legal-move dots, confetti on win.
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
