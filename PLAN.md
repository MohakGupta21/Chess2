# Build Plan: Chess vs. Computer

Derived from [AGENTS.md](./AGENTS.md) (business requirements) and
[RULES.md](./RULES.md) (chess rules the app must enforce).

## 1. Requirements Recap

From AGENTS.md:

- A user can **sign in**.
- Once signed in, the user can **play chess games** against the **computer**.
- The **chess board appears** and is playable.
- The **computer plays chess very well**.

MVP limitations:

- **Exactly two pages**: (1) sign-in page, (2) chess board page.
- The user is assigned **white or black at random** for each game.
- No time controls, no multiplayer, no matchmaking, no accounts beyond sign-in.

### Acceptance criteria

1. Visiting the app while signed out shows the sign-in page; the board page is
   not reachable.
2. After signing in, the user lands on the board page with a new game and a
   randomly assigned colour.
3. All moves are validated against RULES.md (including castling, en passant,
   promotion, check). Illegal moves are rejected client-side and server-side.
4. The computer replies with a legal, strong move within a few seconds.
5. The app detects and announces checkmate, stalemate, and the draw conditions
   in RULES.md section 9.
6. Refreshing the board page resumes the game in progress (state persisted).
7. Signing out returns to the sign-in page and ends access to the board.

## 2. Tech Stack

| Concern            | Choice                                             | Why |
|--------------------|----------------------------------------------------|-----|
| Language           | TypeScript (frontend + backend)                    | One language, shared types for moves/game state. |
| Frontend framework | React + Vite                                       | Fast dev loop, simple 2-route app. |
| Routing            | React Router (2 routes)                            | `/signin` and `/play`, with a route guard. |
| Board UI           | `react-chessboard`                                 | Drag/drop + click-to-move, promotion dialog, board flip. |
| Rules engine       | `chess.js`                                         | Legal move generation, SAN/FEN, check/checkmate/stalemate/draw detection — matches RULES.md. |
| Chess AI           | **Stockfish** (WASM) in a Web Worker              | "Plays very well"; runs in-browser, no server GPU/CPU cost. Strength capped via UCI `skill level` / search depth. |
| Backend            | Node + Express (or Fastify)                        | Auth + game persistence + move validation. |
| Auth               | Email + password with `bcrypt`, JWT in httpOnly cookie | Simple, self-contained. Swappable for OAuth later. |
| DB                 | SQLite via Prisma (dev) → Postgres (prod)          | Zero-config locally; Prisma migration path to Postgres. |
| Validation         | `zod` on API boundaries                            | Shared schemas for request/response. |
| Tests              | Vitest (unit), Playwright (e2e)                    | Rules coverage + the 7 acceptance criteria. |

### Alternatives considered

- **All client-side, no backend** (auth via a hosted service like Supabase/
  Firebase): fewer moving parts, but AGENTS.md implies we own "sign in", and a
  server lets us authoritatively validate moves. Kept a thin server.
- **Server-side engine** (spawn a Stockfish binary): stronger/faster but adds
  ops cost and latency. WASM in a worker is enough for the MVP; the engine
  interface is abstracted so this can switch later.
- **Custom move generator** instead of `chess.js`: unnecessary risk; `chess.js`
  already implements every rule in RULES.md.

## 3. Architecture

```
┌────────────────────────────── Browser ──────────────────────────────┐
│  React app (Vite)                                                    │
│  ┌──────────────┐   ┌──────────────────┐   ┌────────────────────┐    │
│  │ SignIn page  │   │ Play page        │   │ Stockfish Web      │    │
│  │  (/signin)   │   │  (/play)         │◀─▶│ Worker (WASM, UCI) │    │
│  └──────┬───────┘   │  - Board UI      │   └────────────────────┘    │
│         │           │  - chess.js game │                            │
│         │           │  - status/result │                            │
│         │           └───────┬──────────┘                            │
│         │  auth (cookie)    │  REST (fetch, cookie)                  │
└─────────┼───────────────────┼──────────────────────────────────────┘
          ▼                   ▼
┌──────────────────────── Node / Express API ─────────────────────────┐
│  /api/auth/*   sign up, sign in, sign out, me                       │
│  /api/games/*  create game, get game, submit move, resign          │
│  - re-validates every move with chess.js (server is authoritative)  │
│  - persists FEN + move list                                        │
└───────────────────────────┬────────────────────────────────────────┘
                            ▼
                    SQLite / Postgres (Prisma)
```

Key decisions:

- **Server is authoritative for game state and move legality.** The client
  runs `chess.js` too, for instant feedback and to drive the engine, but every
  move is POSTed and re-validated; the server's FEN wins on any mismatch.
- **The engine runs on the client** in a Web Worker so the UI never blocks and
  the server stays cheap. `EngineService` is an interface so a server engine
  can be dropped in without touching UI code.
- **One in-progress game per user** for the MVP (simplifies resume-on-refresh).

## 4. Data Model (Prisma)

```
User
  id           String  @id @default(cuid())
  email        String  @unique
  passwordHash String
  createdAt    DateTime @default(now())
  games        Game[]

Game
  id            String   @id @default(cuid())
  userId        String
  user          User     @relation(fields: [userId], references: [id])
  userColor     String   // "w" | "b"  (randomly assigned at creation)
  fen           String   // current position, starts from standard start FEN
  moves         String   // JSON array of UCI strings, or SAN
  status        String   // "active" | "checkmate" | "stalemate" | "draw" | "resigned"
  result        String?  // "1-0" | "0-1" | "1/2-1/2"
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
```

## 5. API

All game routes require a valid auth cookie.

| Method & path            | Body                    | Returns                              |
|--------------------------|-------------------------|-------------------------------------|
| `POST /api/auth/signup`  | `{ email, password }`   | sets cookie; `{ user }`             |
| `POST /api/auth/signin`  | `{ email, password }`   | sets cookie; `{ user }`             |
| `POST /api/auth/signout` | –                       | clears cookie                       |
| `GET  /api/auth/me`      | –                       | `{ user }` or `401`                 |
| `POST /api/games`        | –                       | creates game, random colour; if engine is White, includes its first move; `{ game }` |
| `GET  /api/games/current`| –                       | active game for user, or `404`      |
| `POST /api/games/:id/move` | `{ uci }` e.g. `"e2e4"` / `"e7e8q"` | applies user move, validates, then computes + applies engine reply; `{ game, engineMove }` |
| `POST /api/games/:id/resign` | –                   | `{ game }` with `status:"resigned"` |

Move flow on `POST /move`:

1. Load game, rebuild position from stored FEN with `chess.js`.
2. Reject if game not `active` or not the user's turn.
3. Reject if `uci` is not in the legal move list (covers RULES.md 3–8).
4. Apply move; check game end (RULES.md 9). If ended, persist and return.
5. Otherwise ask the engine for a reply, apply it, check game end again.
6. Persist new FEN + moves + status; return.

> The engine reply can also be computed on the client and sent for validation.
> The plan keeps engine calls on the server path in the API contract so the
> server remains the single source of truth; the client worker is used for the
> responsive local preview. Pick one as the canonical path during build — see
> Milestone 4.

## 6. Frontend

### Routes / pages (exactly two, per AGENTS.md)

- **`/signin` — Sign-in page**
  - Email + password fields, "Sign in" and "Create account" (same form, toggle).
  - On success, redirect to `/play`.
  - If already authenticated, redirect to `/play`.
- **`/play` — Chess board page**
  - Route guard: if `GET /api/auth/me` fails, redirect to `/signin`.
  - On mount: `GET /api/games/current`; if `404`, `POST /api/games`.
  - Board orientation set so the user's pieces are at the bottom (from
    `game.userColor`).
  - Components:
    - `BoardView` (`react-chessboard`): renders `fen`, handles drag/click,
      shows legal-move dots from `chess.js`, promotion picker.
    - `GameStatusBar`: whose turn, "Check!", result banner
      (checkmate/stalemate/draw/resigned), "New game" button.
    - `MoveList`: SAN move history (optional for MVP).
    - `EngineThinking` indicator while the worker searches.
  - "New game" → `POST /api/games` (new random colour), replace state.
  - Sign out button → `POST /api/auth/signout` → `/signin`.

### Client state

- `useAuth()` hook: current user, `signIn`, `signUp`, `signOut`.
- `useGame()` hook: holds `chess.js` instance + server `game`; exposes
  `makeMove(uci)` which (a) applies locally for instant feedback, (b) POSTs to
  the server, (c) reconciles with the server's returned FEN, (d) surfaces the
  engine's reply.
- `useEngine()` hook: wraps the Stockfish worker; `getBestMove(fen, opts)`.

### Engine configuration

- Load `stockfish.wasm` in a `Worker`; speak UCI.
- "Very well" but responsive: `go movetime 1000` (≈1s) or fixed
  `go depth 12`. Expose an optional difficulty later via
  `setoption name Skill Level value N`.
- Guard against illegal engine output by validating its move through
  `chess.js` before applying (should never fire, but fail loud).

## 7. Random Colour Assignment

- At `POST /api/games`: `userColor = Math.random() < 0.5 ? "w" : "b"`.
- If `userColor === "b"`, the engine (White) moves first: the server computes
  move 1 and includes it in the create response so the client renders a
  position where it is the user's turn.
- Board is rendered with `boardOrientation = userColor === "w" ? "white" : "black"`.

## 8. Rule Enforcement Mapping

| RULES.md section | Enforced by |
|------------------|-------------|
| 1 Setup, 2 Turn order | `chess.js` initial FEN + `turn()` |
| 3 Piece movement, 4 Capturing | `chess.js` `moves({ verbose: true })` legal-move list |
| 5 Castling (all 5 conditions) | `chess.js` (`O-O` / `O-O-O` appear only when legal) |
| 6 En passant | `chess.js` (`flags` includes `e`) |
| 7 Promotion | `react-chessboard` promotion dialog → `uci` 5th char → `chess.js` |
| 8 Check / pinned pieces | `chess.js` excludes king-exposing moves; `inCheck()` |
| 9 Checkmate / stalemate | `chess.js` `isCheckmate()`, `isStalemate()` |
| 9 Insufficient material | `chess.js` `isInsufficientMaterial()` |
| 9 Threefold repetition | `chess.js` `isThreefoldRepetition()` — applied automatically |
| 9 Fifty-move rule | `chess.js` `isDraw()` (covers 50-move) — applied automatically |
| 10 Notation | store FEN + UCI list; SAN via `chess.js` `history()` |
| 11 Clocks | not implemented (out of scope) |

## 9. Project Structure

```
Chess/
  AGENTS.md
  RULES.md
  PLAN.md
  package.json                 # workspaces: client, server, shared
  shared/
    src/types.ts               # zod schemas + TS types for API + game state
  server/
    src/index.ts               # express app
    src/auth.ts                # signup/signin/signout/me, jwt cookie, bcrypt
    src/games.ts               # create/current/move/resign
    src/engine.ts              # EngineService interface + (optional) impl
    src/chessRules.ts          # thin wrapper around chess.js used by routes
    prisma/schema.prisma
  client/
    index.html
    src/main.tsx               # router: /signin, /play, guard
    src/pages/SignIn.tsx
    src/pages/Play.tsx
    src/components/BoardView.tsx
    src/components/GameStatusBar.tsx
    src/components/MoveList.tsx
    src/hooks/useAuth.tsx
    src/hooks/useGame.ts
    src/hooks/useEngine.ts
    src/engine/engine.worker.ts   # + builtinEngine.ts, evaluation.ts
    src/api/client.ts           # typed fetch wrappers
  e2e/                          # Playwright specs for the 7 acceptance criteria
```

## 10. Build Milestones

1. **Scaffold** — monorepo, Vite React app, Express server, Prisma + SQLite,
   shared types package, lint/format, CI running Vitest.
2. **Auth vertical slice** — signup/signin/signout/me with hashed passwords
   and httpOnly JWT cookie; `/signin` page; route guard on `/play` (shows an
   empty placeholder). *Acceptance criteria 1, 7.*
3. **Board + local rules** — render board from a `chess.js` game on `/play`;
   drag/click moves, legal-move hints, promotion dialog; status bar with
   check/checkmate/stalemate/draw using `chess.js`. No server, no engine yet.
   *Rule enforcement (RULES.md 1–9).*
4. **Persistence** — `POST /api/games` (random colour), `GET /current`,
   `POST /:id/move` with server-side `chess.js` re-validation; wire `useGame`
   to server; resume on refresh. Decide canonical engine path (server vs
   client) here. *Acceptance criteria 2, 3, 6.*
5. **Engine** — Stockfish WASM worker; `useEngine`; auto-reply after the user's
   move; "engine thinking" indicator; validate engine moves; engine opens when
   the user is Black. *Acceptance criteria 4.*
6. **Endgame + polish** — result banners for every RULES.md 9 outcome; "New
   game" and "Resign"; board orientation per colour; empty/error/loading
   states; basic responsive layout. *Acceptance criteria 5.*
7. **Test + harden** — Vitest suite covering each RULES.md section (castling
   through the 5 conditions, en passant window, promotion, pins, all draw
   types); Playwright e2e for the 7 acceptance criteria; rate-limit auth;
   input validation with zod; deploy config (Postgres env, static client).

## 11. Testing Strategy

- **Rules unit tests** (`server/src/chessRules.test.ts`): feed FEN + move,
  assert accept/reject and resulting status. One or more cases per row of the
  section 8 table. Include known tricky positions: castling out of / through
  check, en passant only on the immediate reply, under-promotion to knight
  giving mate, stalemate positions, K+B vs K+B same colour.
- **API tests**: auth happy/sad paths; move on opponent's turn; move in a
  finished game; resume `GET /current`.
- **Engine test**: given a position with a forced mate in 1, the engine plays
  it; given any legal position, the returned move passes `chess.js` validation.
- **E2e (Playwright)**: the seven acceptance criteria in section 1, run against
  a seeded test user.

## 12. Out of Scope for MVP

- Time controls / clocks (RULES.md 11).
- Human vs human, spectating, or online play.
- Draw offers / takebacks / move analysis / opening book UI.
- Multiple simultaneous games per user, game archive/history page (would need a
  third page).
- Social login, password reset emails, profile management.
- Adjustable engine difficulty UI (engine strength is fixed for the MVP;
  the `setoption Skill Level` hook is left in place for later).

## 13. As-Built Notes (deviations from the plan above)

The initial implementation follows this plan with three pragmatic changes,
each keeping the same architecture and contracts:

1. **Persistence: `better-sqlite3` instead of Prisma.** A single well-supported
   native module with prebuilt binaries — no `generate` step, no engine
   downloads. The schema in `server/src/db.ts` mirrors the model in section 4.
   Swapping in Prisma/Postgres later only touches that file and the two route
   modules.
2. **Engine: a built-in negamax + alpha-beta worker, not Stockfish WASM.**
   `client/src/engine/` contains a self-contained engine (material +
   piece-square tables, MVV-LVA ordering, quiescence search, iterative
   deepening to depth 4 / ~1.5 s) running in the same ES-module Web Worker
   behind the exact `useEngine` protocol the plan specifies. It plays a solid
   casual game and works fully offline. Vendoring a real Stockfish build and
   driving it over UCI is a drop-in replacement for the worker body — the rest
   of the app is unchanged.
3. **`POST /games/:id/move` applies exactly one move.** The client submits its
   own move, then submits the engine's reply as a second call. The server
   re-validates every move (legality + turn order) with `chess.js` and remains
   the source of truth for game state; it just doesn't compute the engine move
   itself. `GameResponse` is therefore `{ game }` with no `engineMove` field.
   Threefold repetition is tracked in a `rep_counts` column on the game row
   (keyed by the position-defining FEN fields), since a `chess.js` instance
   rebuilt from a bare FEN has no move history to detect it.

A code-review pass (`code_review.md`) has since been applied — production
`node dist/index.js` runs, threefold repetition is enforced, the DB path is
anchored to `server/data/`, auth uses async bcrypt with a SHA-256 pre-hash, the
engine worker has error/timeout handling, and superseded games use a distinct
`abandoned` status. Playwright e2e is still not implemented.

Build / run: `npm install`, then `npm run dev` (builds `shared`, then server on
:4000 + client on :5173 with an `/api` proxy). `npm run test` runs the 32
server tests (`chessRules.test.ts` covers RULES.md sections 2–9; `api.test.ts`
covers the auth + game flow, threefold repetition, and acceptance criteria
1–3, 6, 7). See `README.md`.
