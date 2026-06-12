# Development Prompt: "Quori Quest" — A Cute Quoridor Discord Activity

## Overview

Build a real-time multiplayer Discord Activity (embedded app) based on the board game **Quoridor**, supporting **2–4 players**, with a cute, cozy art style featuring adorable animal characters. The game runs inside Discord voice channels via the **Discord Embedded App SDK**, with a Node.js authoritative game server handling matchmaking, game state, and move validation.

---

## 1. Game Rules (Quoridor)

### Core rules
- The board is a **9×9 grid** of cells. Pawns move on cells; walls are placed in the **grooves between cells** on an 8×8 grid of wall intersections.
- On your turn you do exactly ONE of:
  1. **Move your pawn** one cell orthogonally (up/down/left/right), or
  2. **Place a wall** (if you have walls remaining).
- **Walls** are 2 cells long, placed horizontally or vertical­ly between cells. Walls cannot overlap, cross an existing wall, or extend off the board.
- **Critical rule:** a wall placement is ILLEGAL if it completely blocks ANY player from reaching their goal row/column. Validate every wall placement with a pathfinding check (BFS/A*) for every player.
- **Jumping:** if an adjacent pawn faces you, you may jump straight over it to the cell beyond. If that cell is blocked (by a wall or board edge) or occupied, you may instead move diagonally to either cell beside the blocking pawn (standard Quoridor jump rules). Handle chains carefully in 4-player mode (a jump cannot pass over two pawns in a line — diagonal rules apply).
- **Win condition:** first pawn to reach any cell on the opposite edge from where it started.

### Player-count variants
- **2 players:** start at center of north and south edges (e5 / e1 in board terms). **10 walls each.** Goals: opposite edge.
- **4 players:** start at the center of each of the four edges (north, south, east, west). **5 walls each.** Each player's goal is the opposite edge.
- **3 players (optional, nice to have):** support 3 players with 4-player layout minus one seat; give 7 walls each, or simply run a 4-player board with one empty seat using 5 walls each — pick one and document it.

### Turn structure
- Fixed turn order (clockwise by seat). Configurable **turn timer** (default 60s; options: 30s / 60s / 90s / off). If the timer expires, auto-move the player one step along their shortest path to goal (never auto-place walls).
- If a player **disconnects**, hold their seat for 60 seconds (pause or auto-move on timeout), then convert them to a simple AI (shortest-path mover) or allow vote-to-remove. Reconnection restores their seat and state.

---

## 2. Platform: Discord Activity

### Architecture
```
[Discord Client (iframe)]
   └── Frontend SPA (Vite + TypeScript + PixiJS)
         │  @discord/embedded-app-sdk (RPC: auth, participants, etc.)
         │  WebSocket (wss) — game protocol
         ▼
[Game Server: Node.js + TypeScript]
   ├── Express/Fastify: OAuth token exchange endpoint (/api/token)
   ├── Colyseus (or socket.io + custom rooms): one room per Activity instance
   └── Authoritative Quoridor engine (shared package with client)
```

### Discord integration requirements
- Use **`@discord/embedded-app-sdk`**. On load: `ready()` → `authorize()` (scopes: `identify`, `guilds`, `rsvp` not needed) → exchange code at backend `/api/token` → `authenticate()`.
- **Room = Activity instance:** use `instanceId` from the SDK as the room key so everyone in the same voice channel joins the same lobby automatically.
- Pull **Discord avatars and display names** for player identity; show avatar chips next to each character.
- Respect Discord's **URL mapping / proxy rules**: all external requests go through the activity proxy (`/.proxy/` prefix), no hard-coded external domains, no CSP violations. Bundle all assets (no third-party CDNs).
- Handle the iframe lifecycle: layout resize events, mobile vs desktop sizing, `sdk.commands.setActivity` optional rich presence.
- Support **Discord mobile** (portrait, ~390px wide) and desktop (landscape, resizable). The board must scale responsively; UI controls reflow.

### Backend & infra
- Node.js 20+, TypeScript everywhere. Monorepo (pnpm workspaces or turborepo) with packages: `client`, `server`, `shared` (game engine + protocol types).
- The **server is authoritative**: clients send intents (`move`, `placeWall`), server validates with the shared engine, broadcasts resulting state. Never trust client state.
- State sync: full snapshot on join/reconnect, delta/event updates per move. Include a monotonically increasing `turnSeq` to guard against replays/races.
- Provide a `docker-compose.yml` and `.env.example` (DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, PORT). Document local dev with `cloudflared`/`ngrok` tunnel + Discord Developer Portal URL mapping setup in the README.

---

## 3. Art Direction: Cute & Cozy

### Characters
- **4 playable chibi animal characters**, one per player color:
  - 🐰 **Mochi** the bunny (pink, player 1)
  - 🐸 **Pebble** the frog (green, player 2)
  - 🐱 **Biscuit** the cat (orange, player 3)
  - 🐧 **Tofu** the penguin (blue, player 4)
- Big heads, tiny bodies, large sparkly eyes, soft rounded shapes. Think Animal Crossing / Pokémon-plush energy.
- Each character needs sprite states: **idle** (gentle bobbing/breathing loop), **hop** (move animation between cells), **think** (on their turn — e.g., tapping chin), **place-wall** (little hammer tap), **sad** (blocked/losing), **win celebration** (confetti + dance), **lose** (teary but cute).
- Implement art as SVG or texture-atlas sprites; squash-and-stretch tween on hops (anticipate → leap → land with a tiny bounce). Even simple shapes with good easing read as cute — prioritize ANIMATION JUICE over detail.

### Board & environment
- The board is a **cozy garden / picnic theme**: soft grass-green cells with rounded corners, subtle checker tint, pastel palette, soft drop shadows.
- Walls are **white picket fences** (or hedge rows) that drop in with a satisfying *thunk* + dust puff particle.
- Each player's goal edge is tinted with their color and marked with a small flag/banner showing their character's face.
- Ambient details: occasional butterfly/leaf particles, soft vignette. Keep it under control on mobile (cap particles).

### UI style
- Rounded, bubbly UI: pill buttons, thick soft outlines, slight wobble on hover. Font: a rounded display font (e.g., Baloo 2, Fredoka — self-hosted, license-checked).
- Color-blind safe: player colors must also differ by character shape and an icon/pattern on walls and goal banners.

### Audio
- Soft, cheerful lo-fi/kawaii background loop (toggleable, default ~30% volume).
- SFX: hop (boing), wall place (thunk), invalid action (gentle "bonk"), turn-start chime (only for YOUR turn), win fanfare. All sounds soft and rounded, never harsh. Respect Discord — keep default volume low since users are in voice chat; persist mute preference.

---

## 4. Game Flow & Screens

### 1. Lobby
- Shows all Activity participants. Players claim a seat by **picking a character** (first-come; duplicates not allowed). Non-playing participants become **spectators** automatically.
- Host (first joiner, transferable) sets options: player count auto-derived from seats (2 or 4), turn timer, wall count override (default per rules).
- "Ready" checkmarks; game starts when all seated players ready (min 2). Fun idle animations of characters waving in the lobby.

### 2. In-game
- **Board center-stage.** Current player highlighted with a bouncing arrow/crown; their UI panel glows.
- **Move mode (default):** legal destination cells glow with pulsing dots when it's your turn; tap/click to hop. Jump destinations included automatically.
- **Wall mode:** toggle button (or drag a wall from your wall tray). Show a **ghost preview** snapping to the nearest valid slot; valid = green ghost, invalid = red ghost with a brief tooltip ("This would trap Pebble! 🐸"). Click/release to confirm. ESC/right-click/tap-elsewhere cancels.
- **Wall trays:** each player's remaining walls shown as mini fence icons next to their avatar + character portrait + name.
- Turn timer ring around the active player's avatar.
- **Spectator view:** watch live, see whose turn it is, no controls. Spectators can send a small set of cute emote reactions (optional stretch).
- **Emotes:** wheel with 6 reactions (❤️ 😆 😮 😭 👏 🤔) that pop above your character. Rate-limited (1 per 3s).
- Move history sidebar (collapsible) in simple notation; last move highlighted on the board (trail/ghost).

### 3. Game over
- Winner's character does a celebration at center board with confetti; others clap sadly-cutely.
- Results panel: placements (for 4p, rank by who won, then by remaining shortest-path distance), walls used, match duration.
- **Rematch vote** (same seats) and **Back to lobby** buttons.

### 4. Help
- A "How to play" overlay with 3–4 illustrated slides (move, wall, jump, win). Show automatically for first-time players (localStorage flag).

---

## 5. Engine & Code Quality Requirements

- **Shared `@quori/engine` package** (pure TypeScript, zero DOM/Node deps):
  - Immutable-ish `GameState`: pawn positions, walls placed, walls remaining, current turn, status.
  - `getLegalMoves(state, player)` — including full jump/diagonal rules.
  - `getLegalWallSlots(state)` — overlap/cross checks + **path-exists check for ALL players** (BFS from each pawn to its goal edge).
  - `applyAction(state, action)` → new state or typed error.
  - `shortestPathLength(state, player)` — for auto-move, AI fallback, and ranking.
- **Comprehensive unit tests** for the engine (Vitest): jump edge cases (board edge, wall behind pawn, two pawns in a line in 4p), wall-blocking detection, all-players-path validation, win detection on every edge. Target ≥90% coverage on the engine package.
- Protocol types shared between client/server (zod schemas for runtime validation of all client messages).
- Clean separation: rendering layer (PixiJS) reads state + animates diffs; never owns game logic.
- ESLint + Prettier, strict TypeScript, CI script (`pnpm test && pnpm typecheck && pnpm build`).

---

## 6. Edge Cases to Handle Explicitly

1. Wall placement that traps any player → reject server-side AND prevent client-side (red ghost).
2. Simultaneous/duplicate action submissions (double-click) → idempotency via `turnSeq`.
3. Player closes Discord / drops mid-turn → timer continues, auto-move on expiry, reconnect grace.
4. Activity instance with 5+ participants → extras are spectators; seat opens if a player leaves in lobby.
5. Mobile portrait: wall placement via drag must not conflict with scroll; use a dedicated wall-mode toggle on small screens.
6. 4-player jump over two aligned pawns (must NOT allow double jump — diagonal options only).
7. Window resize / Discord layout changes mid-game → board re-scales without losing state.
8. Host migration if host leaves lobby.

---

## 7. Milestones (build in this order)

1. **M1 — Engine:** `@quori/engine` complete with full rule set + unit tests passing. CLI playtest script (text-render the board) to validate rules by hand.
2. **M2 — Local hotseat client:** PixiJS board, move/wall UI with ghost previews, 2–4 players on one screen, placeholder shapes for characters. Fully playable offline.
3. **M3 — Multiplayer server:** Colyseus rooms, authoritative validation, reconnect, turn timers. Two browser tabs can play.
4. **M4 — Discord integration:** Embedded App SDK auth, instanceId rooms, avatars, proxy compliance, mobile layout. Test inside a real Discord voice channel.
5. **M5 — Cute pass:** final character sprites + animations, board theme, particles, audio, emotes, polish (easing, juice, screen transitions).
6. **M6 — Hardening:** spectators, rematch flow, disconnect AI fallback, help overlay, edge-case QA from section 6, README with full setup + deploy guide (Docker, Discord portal config, URL mappings).

## 8. Deliverables

- Monorepo with `client/`, `server/`, `shared/` packages, README covering: Discord Developer Portal setup (app creation, OAuth2 redirect, URL mappings, enabling Activities), local tunnel dev workflow, env vars, deployment (single Docker image or Fly.io/Railway guide).
- Passing test suite and a short `ARCHITECTURE.md` describing state flow and the protocol.
- A 60-second self-QA checklist in the README (start 4p game, place blocking wall rejected, jump works, disconnect/reconnect, mobile layout).
