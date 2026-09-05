# Code Review — Chess vs. Computer

Review date: 2026-09-02. Scope: entire repo (`shared/`, `server/`, `client/`,
config, tests). Findings are grouped by severity; each has a concrete impact and
a suggested fix. Line numbers are approximate.

Legend: **verified** = reproduced during review; **plausible** = reasoned from
the code, not run.

---

## Resolution — 2026-09-02 (all items addressed)

Every finding below has been fixed. Server suite is now 32 tests (was 28):
added threefold-repetition, duplicate-signup, long-password, ISO-timestamp and
JSON-404 cases. Verified after: `npm run build && node server/dist/index.js`
boots; `npm run dev` boots (predev builds `shared`); engine still finds
mate-in-1 and plays legal self-play within its time budget; threefold draw
fires end-to-end via the API.

| ID | Fix |
|----|-----|
| **H1** | `shared/package.json` `exports` → `dist` (with a `development` condition for source in Vite); root `predev`/`prestart` build `shared`; `dev` runs a `tsc -w` for `shared`; `server/vitest.config.ts` aliases `@chess/shared` to source so tests need no build. `node server/dist/index.js` now runs. |
| **H2** | `games.ts` maintains a `rep_counts` column keyed by `repetitionKey(fen)` (first four FEN fields); on the 3rd occurrence the move response is `draw / threefold_repetition / 1/2-1/2`. `chessRules.classify` no longer calls the history-less `isThreefoldRepetition()`. New API test covers it. |
| **H3** | `config.ts` anchors the default DB path to `server/data/` via `new URL("../data/…", import.meta.url)` (same from `src/` and `dist/`). Stray `server/server/` removed. `.gitignore` now has `**/data/`, `*.sqlite-*`. |
| **H4** | `test:e2e` script and empty `e2e/` removed; gap already noted in PLAN §13. |
| **M1** | `app.ts` has a terminal JSON error handler (`{ error: "internal error" }`, no stack to client); async auth handlers wrapped so rejections reach it; `games.ts` `parseJson` never throws. |
| **M2** | `useEngine` adds `worker.onerror` (rejects all pending, respawns the worker) and a per-request timeout (`budgetMs + 5s`); the worker posts an `error` message on a thrown search. `getBestMove` now rejects instead of hanging. |
| **M3** | `useGame.newGame`/`resign` wrapped in try/catch → `error`; `Play.tsx` calls them as `void fn()`; `handleSignOut` navigates in `finally`. |
| **M4** | `api/client.ts` calls a `setUnauthorizedHandler` callback on any non-`/auth` 401; `useAuth` registers it and clears `user` → route guard bounces to `/signin`. |
| **M5** | Documented in PLAN §13 (client submits both moves; server enforces legality + turn order only). Left as an intentional MVP trade-off. |
| **M6** | `POST /games` wrapped in a `better-sqlite3` transaction (`createGame`); `idx_games_one_active` is now a **UNIQUE** partial index; superseded games get `status='abandoned'` (new value, added to the CHECK, the `GameStatus` union and `GameStatusBar`). |
| **M7** | `toDTO` trusts the stored `status/result/end_reason` for finished games; only `turn`/`inCheck` come from the FEN. |
| **M8** | Timestamps stored/emitted as `strftime('%Y-%m-%dT%H:%M:%fZ','now')`; asserted by a test. |
| **M9** | `bcrypt.hash`/`compare` are async; passwords are SHA-256-pre-hashed (no 72-byte truncation); sign-in compares against a fixed `DUMMY_HASH` when the user is absent (constant-ish time); duplicate signup returns a generic 409. |
| **M10** | `app.set("trust proxy", config.trustProxy)` (`TRUST_PROXY` env; `loopback` in prod). |
| **M11** | Limiter `skip: () => config.isTest`; dev limit raised to 200. |
| **M12** | `useGame.load()` guarded by a `loadingRef` against overlapping runs. |
| **L1** | Removed dead `legalUciMoves`, `squareIndex`, empty `server/prisma/`. |
| **L2** | SHA-256 pre-hash (see M9); schema cap relaxed to 1024 with a comment. |
| **L3** | `quiesce` takes the search `ctx`, checks the deadline, and is ply-capped (`MAX_QUIESCE_PLY`). |
| **L4** | `builtinBestMove` seeds `chosen` from `orderMoves(rootMoves)[0]` and keeps the best move from the last completed depth. |
| **L5** | Iterative deepening now tries the previous best move first (`orderMoves(moves, pvUci)`). |
| **L6** | Black PST mirror is `idx ^ 56` (rank flip) with a comment. |
| **L7** | `error` cleared on every successful user/engine move and on new game. |
| **L8** | `BoardView` resets `selected`/`pendingPromo` in a `useEffect` on `game.id`. |
| **L9 / L10** | Promotion dialog is `role="dialog" aria-modal`, auto-focuses, `Escape`/Cancel closes it. (Kept the custom picker so click- and drag-promotion behave the same; residual drag snap-back accepted.) |
| **L11** | `Number(PORT)` guarded (`intFromEnv`); `api/client.ts` omits `Content-Type` when there is no body; `app.ts` can serve `client/dist` (`CLIENT_DIST`) with an SPA fallback; `main.tsx` imports `ReactNode`; engine `moveScore` hoisted above its use. |

---

## High — broken paths / rule violations

### H1. Production build does not run — `@chess/shared` `exports` points at `.ts` source · verified
- **Where:** `shared/package.json` lines 8–16.
- **What:** `exports["."]` resolves to `./src/index.ts` for both `types` and
  `default`, while `main`/`types` point at `./dist`. `exports` wins. `dev`,
  `test` and the Vite client build all transpile TS on the fly so they work,
  but `npm run build && npm start` → `node server/dist/index.js` crashes
  immediately:
  ```
  TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".ts" for
  .../shared/src/index.ts
  ```
- **Impact:** the documented production path (README "Run" table, `npm start`)
  is completely non-functional.
- **Fix:** point `exports["."]` at the built output
  (`"types": "./dist/index.d.ts"`, `"default": "./dist/index.js"`), or drop the
  custom `exports` block and rely on `main`/`types`. If the source-import dev
  convenience is wanted, add a `"development"` condition and set it in dev only.
  Also make the root `build` script guarantee `shared` builds before `server`
  (it currently does, keep it).

### H2. Threefold repetition is never detected — RULES.md §9 not enforced · verified
- **Where:** `server/src/chessRules.ts` — `positionFromFen` (L76–79) and
  `applyUciMove` (L97–103) both do `new Chess(fen)` with no move history;
  `classify` then calls `chess.isThreefoldRepetition()` (L57).
- **What:** `chess.js` needs the full move history to detect repetition. Built
  from a bare FEN it always returns `false`. Verified: the same position
  reached by shuffling knights reports `isThreefoldRepetition() === true` with
  history and `=== false` when reconstructed from its FEN.
- **Impact:** a game that repeats a position three times is never drawn; it
  just continues. `games.ts` also never stores a threefold result, and `toDTO`
  recomputes from FEN, so even a manually-set draw would be shown as `active`.
  Fifty-move and insufficient-material still work (fifty-move reads the FEN
  halfmove clock; material is position-only).
- **Fix:** replay the stored `moves` (or `san`) into a single `Chess()` instance
  when validating/among classification — e.g. `chess.js` `new Chess()` then
  `.move()` each stored UCI, then apply the new move and classify. Or persist a
  position-count map on the game row and increment it per move. Add a
  `chessRules.test.ts` case for it once fixed.

### H3. Default `DB_PATH` is resolved against the wrong directory · verified
- **Where:** `server/src/config.ts` L9 — `dbPath: process.env.DB_PATH ??
  "server/data/chess.sqlite"`.
- **What:** the path is relative to `process.cwd()`, which for
  `npm run dev`/`start` (run in the `server/` workspace) is `server/`. The DB is
  actually created at `server/server/data/chess.sqlite` (verified — the file
  and its `-wal`/`-shm` siblings exist there now).
- **Impact:** (a) confusing on-disk layout; (b) `.gitignore` only lists
  `server/data/` (see L4), so `server/server/data/*.sqlite*` is **not ignored**
  and would be committed; (c) `mkdirSync(dirname(...))` in `db.ts` silently
  creates the nested dir.
- **Fix:** resolve relative to a stable base, e.g.
  `path.resolve(process.cwd(), ...)` is not enough — anchor to the repo/server
  root (`new URL("../data/chess.sqlite", import.meta.url)` from `config.ts`,
  or `path.join(__dirname, "../../data/...")`). Delete the stray
  `server/server/` tree. Broaden `.gitignore` (`**/data/` or `*.sqlite*` is
  already there — the sqlite globs on L8–9 do match, but WAL/SHM files
  `chess.sqlite-wal` are covered by `*.sqlite*`? no — add `*.sqlite-*`).

### H4. `npm run test:e2e` is advertised but cannot run · verified
- **Where:** root `package.json` L14 (`"test:e2e": "playwright test"`), empty
  `e2e/` directory, PLAN.md §10 milestone 7.
- **What:** no `@playwright/test` dependency, no `playwright.config`, no specs.
- **Impact:** the script fails; acceptance criteria 4 and 5 (engine plays;
  every RULES.md §9 end state shown) have no automated coverage.
- **Fix:** either implement the Playwright suite or remove the script and note
  the gap in README (PLAN §13 already lists it as not-done — keep them in sync).

---

## Medium — correctness, robustness, security

### M1. No Express error-handling middleware · plausible
- **Where:** `server/src/app.ts` — no `app.use((err, req, res, next) => …)`.
- **What:** any thrown error in a handler (corrupt `fen` → `new Chess()` throws
  in `toDTO`/`positionFromFen`; `JSON.parse(row.moves)` on a bad column;
  unexpected `better-sqlite3` error) escapes to Express's default handler,
  which returns an HTML page and, with `NODE_ENV!==production`, a stack trace.
- **Impact:** inconsistent (non-JSON) error responses the client can't parse
  (`req()` does `res.json().catch(()=>({}))` → generic message); potential
  info leak in non-prod.
- **Fix:** add a terminal JSON error handler that logs and returns
  `{ error: "internal error" }` with 500; wrap `positionFromFen`/`toDTO` in a
  try/catch that maps to a 500 with a clean message.

### M2. Client soft-locks if the engine worker fails or stalls · plausible
- **Where:** `client/src/hooks/useEngine.ts` L46–64 — `getBestMove` returns a
  promise that only ever settles from `worker.onmessage`. No timeout, no
  `worker.onerror` handler.
- **What:** if the worker throws on load, dies, or never posts back,
  `getBestMove` never resolves. In `useGame` L63–68 the engine effect `await`s
  it forever, `inFlight` stays > 0, `thinking` stays `true`.
- **Impact:** the board is stuck disabled with "thinking…" and the only
  recovery is a full reload.
- **Fix:** add `worker.onerror` that rejects all pending promises; race
  `getBestMove` against a timeout (e.g. `budgetMs + 3000`) that rejects; in
  `useGame`, on engine failure surface an error and offer "retry" /
  re-request. Consider recreating the worker on error.

### M3. "New game" and "Resign" have no error handling · plausible
- **Where:** `client/src/hooks/useGame.ts` L126–137 (`newGame`, `resign` — no
  try/catch); `client/src/pages/Play.tsx` L49, L74, L78 call them as
  `onClick={() => newGame()}` (floating promise).
- **What:** if `api.newGame()`/`api.resign()` rejects (network, 401, 500) the
  rejection is unhandled; nothing is shown; the button appears dead.
- **Impact:** on the full-screen error path (`error && !game` in Play.tsx
  L45–54) the only action is "Start a new game" → `newGame()`; if that also
  fails the user is stuck with no feedback.
- **Fix:** wrap both in try/catch, set `error`, keep the promise handled
  (`void newGame().catch(...)` or handle inside the hook).

### M4. Session expiry mid-play is not handled · plausible
- **Where:** `client/src/api/client.ts` `req()` L15–27; `client/src/hooks/*`.
- **What:** there is no global 401 handling. If the auth cookie expires after
  the app has mounted, `/me` already succeeded so `RequireAuth` keeps rendering
  `Play`, but `/games/*` calls return 401 → shown as the raw string "not
  authenticated" in the side panel or full-screen.
- **Fix:** in `req()`, on 401 clear auth state / redirect to `/signin` (e.g. via
  an event or by having `useAuth` expose a `handleUnauthorized`).

### M5. Server lets the authenticated user play both colours · by design, undocumented risk
- **Where:** `server/src/games.ts` `POST /:id/move` L78–114.
- **What:** the endpoint applies any legal move for whichever side is to move.
  It never checks that the human only moves `userColor`, nor that the engine's
  move originated from the engine. PLAN §13 acknowledges the client submits both
  moves, but the endpoint has no guard at all.
- **Impact:** acceptable for a solo vs-computer MVP (no stakes), but a client
  bug or a curious user can drive the "engine" into a losing line, or race two
  moves. Worth an explicit note + a lightweight guard if this ever becomes
  competitive.
- **Fix (optional):** track whose move the client is submitting, or compute the
  engine reply server-side (the original PLAN §5 flow) so `/move` only ever
  accepts the human's colour.

### M6. `POST /games` is not atomic and does not enforce one active game · plausible
- **Where:** `server/src/games.ts` L57–65; `server/src/db.ts` L40–41
  (`idx_games_user_active` is a **non-unique** partial index).
- **What:** `abandonActive.run()` then `insertGame.run()` are two statements, no
  transaction. Two concurrent `POST /games` (or the StrictMode double-mount in
  `useGame.load()` hitting the 404→`newGame` path twice) can create two active
  rows; `GET /current` masks it with `ORDER BY created_at DESC LIMIT 1`.
- **Impact:** orphan "active" games accumulate; `abandonActive` marks
  superseded games `status='resigned', result=NULL` which is semantically wrong
  (they weren't resigned).
- **Fix:** wrap abandon+insert in `db.transaction(...)`; make the partial index
  `UNIQUE`; use a distinct status like `'abandoned'` (add to the CHECK / DTO)
  instead of overloading `'resigned'`.

### M7. `toDTO` ignores stored `status/result/end_reason` (except `resigned`) · plausible
- **Where:** `server/src/games.ts` L32–51.
- **What:** every read recomputes the outcome from the FEN via
  `positionFromFen`; the persisted columns are only consulted for the
  `resigned` case. For checkmate/stalemate/insufficient/fifty-move the recompute
  happens to agree with storage, so the `games.status/result/end_reason`
  columns are dead weight that can silently diverge (and *do* for threefold —
  see H2).
- **Fix:** pick one source of truth. Simplest: trust the stored columns for any
  non-`active` row and only compute `turn`/`inCheck`/legal-move data from the
  FEN. Then also fix the writer to persist threefold.

### M8. Timestamps are not ISO-8601 · plausible
- **Where:** `server/src/db.ts` L23/36/37 (`datetime('now')`), surfaced as
  `GameDTO.createdAt/updatedAt` (typed `string`, implied ISO).
- **What:** SQLite `datetime('now')` yields `"2026-09-02 08:49:18"` (space
  separator, no `Z`). `new Date("2026-09-02 08:49:18")` is parsed as *local*
  time by some JS engines and is technically implementation-defined.
- **Impact:** latent — the client does not currently render these fields.
- **Fix:** store/emit `strftime('%Y-%m-%dT%H:%M:%fZ','now')` or convert in
  `toDTO`.

### M9. Auth: blocking bcrypt, user enumeration, timing side-channel · plausible
- **Where:** `server/src/auth.ts`.
  - L79/L92 `bcrypt.hashSync`/`compareSync` block the event loop (~10 ms each at
    cost 10) — under concurrency every request stalls. Use the async
    `bcrypt.hash`/`bcrypt.compare`.
  - L74–76 signup returns `409 "an account with that email already exists"` →
    email enumeration. Signin correctly uses a generic message.
  - L91–92 when the user does not exist, `compareSync` is skipped → faster
    response → enumeration by timing. Compare against a fixed dummy hash
    unconditionally.
- **Impact:** low for an MVP; standard hardening items.

### M10. Rate limiter is effectively global behind the dev proxy · plausible
- **Where:** `server/src/auth.ts` L57–63; no `app.set("trust proxy", …)` in
  `app.ts`.
- **What:** `express-rate-limit` keys on client IP. All requests arrive via the
  Vite `/api` proxy (or a prod reverse proxy) as `127.0.0.1`, so the limit
  (30 / 15 min) is shared across *all* users, and `express-rate-limit` v7 logs
  a proxy-misconfig validation warning.
- **Impact:** a demo with a few people, or the test suite growing past ~30 auth
  calls, hits `429` for everyone.
- **Fix:** set `trust proxy` appropriately and/or key the limiter on something
  meaningful; disable/raise it under `NODE_ENV=test`.

### M11. `api.test.ts` shares rate-limiter state across tests · plausible
- **Where:** `server/src/api.test.ts` — `beforeEach` clears tables but not the
  in-memory rate-limit store; each `signedInAgent()` spends one signup.
- **Impact:** the suite is ~15–20 auth calls today (under the 30 limit) but any
  new auth-touching test pushes it over and the file starts flaking with 429s.
- **Fix:** disable the limiter when `NODE_ENV==='test'`, or `resetKey`/recreate
  the app per test.

### M12. StrictMode double-invoke creates a second game · plausible
- **Where:** `client/src/hooks/useGame.ts` L52–54 — `useEffect(() => { void
  load(); }, [load])`, `load` not guarded against concurrent calls.
- **What:** in dev, the effect runs twice; if there is no active game both runs
  take the 404→`api.newGame()` branch → two `POST /games`, the second
  abandoning the first (see M6).
- **Impact:** dev-only churn; harmless in production build but sloppy.
- **Fix:** guard with an in-flight ref / `AbortController`, or dedupe by
  ignoring the second run.

---

## Low — quality, dead code, UX, a11y

### L1. Dead code
- `server/src/chessRules.ts` L146–152 `legalUciMoves` — never imported.
- `client/src/engine/evaluation.ts` L56–60 + L83 `squareIndex` — never used.
- `server/prisma/` — empty directory left from the original Prisma scaffold
  (superseded by `better-sqlite3`, see PLAN §13). Remove it.

### L2. `bcryptjs` silently truncates passwords > 72 bytes
- **Where:** `shared/src/index.ts` `credentialsSchema` allows `password` up to
  200 chars; `bcryptjs` only hashes the first 72 bytes.
- **Impact:** two different long passwords sharing a 72-byte prefix are
  interchangeable. Low, but surprising.
- **Fix:** cap at 72, or pre-hash (`sha256` → base64) before bcrypt.

### L3. `quiesce` ignores the search deadline
- **Where:** `client/src/engine/builtinEngine.ts` L34–50 — no `ctx` param, no
  `Date.now() > deadline` check, no depth cap.
- **Impact:** at a leaf with a long forcing capture sequence the quiescence
  search can overrun `budgetMs`. Bounded (captures reduce material) but not by
  time. Also stand-pat while in check is unsound (minor strength bug).
- **Fix:** thread `ctx` into `quiesce`, bail on timeout, cap ply; when in check,
  search all evasions rather than standing pat.

### L4. Timeout at depth 1 plays `rootMoves[0]` unordered
- **Where:** `builtinEngine.ts` L113 (`chosen = rootMoves[0]`), L134–138 (only
  accept results when `!timedOut`).
- **Impact:** on a slow machine / tiny budget the engine can play `chess.js`'s
  first-generated move (often a random-looking a/b-file move) instead of an
  ordered one.
- **Fix:** initialise `chosen` to `orderMoves(rootMoves)[0]`; always keep the
  best move found so far even on a partial depth.

### L5. Iterative deepening does not reuse the previous iteration's ordering
- **Where:** `builtinEngine.ts` L117–140 — `orderMoves(rootMoves)` recomputed
  each depth, no principal-variation / best-move-first carry-over, no
  transposition table.
- **Impact:** weaker/slower than a few lines of PV ordering would give. Quality
  only.

### L6. PST black mirroring is 180° rotation, not a vertical flip
- **Where:** `client/src/engine/evaluation.ts` L76 — `pst[63 - idx]`.
- **What:** works only because every table here is left–right symmetric. Any
  future asymmetric table (e.g. king-side castling bonus) would be
  file-mirrored for Black.
- **Fix:** use `idx ^ 56` (rank flip) and add a comment.

### L7. Sticky client `error` state
- **Where:** `client/src/hooks/useGame.ts` — `error` set on failed move (L117),
  cleared only in `load`/`newGame`.
- **Impact:** a transient rejected move leaves the red error box in the side
  panel through subsequent successful moves until "New game".
- **Fix:** clear `error` at the start of a successful `playUserMove` / when a
  fresh `game` arrives.

### L8. `pendingPromo` / `selected` not reset when the game changes
- **Where:** `client/src/components/BoardView.tsx` L32–36 — component state,
  no `useEffect` on `game.id`.
- **What:** open the promotion picker, click "New game" in the side panel
  (not disabled), then pick a piece → `onMove(oldFrom, oldTo, code)` fires
  against the new game → server `422` → error box.
- **Fix:** `useEffect(() => { setSelected(null); setPendingPromo(null); },
  [game.id])`.

### L9. Promotion via drag snaps back before the picker appears
- **Where:** `BoardView.tsx` L57–61 — `attempt` returns `false` for a promotion
  drop so `react-chessboard` reverts the pawn, then the overlay shows.
- **Impact:** minor visual jank. `react-chessboard` v4 has a native promotion
  dialog (`onPromotionCheck` / `onPromotionPieceSelect`) that avoids this.
- **Fix:** use the library's promotion flow, or render the picker immediately
  on drop without the revert.

### L10. Board interaction has no keyboard / focus support
- **Where:** `BoardView.tsx` — promo overlay doesn't trap focus or handle
  `Escape`; the board itself is mouse/touch only (library limitation).
- **Fix:** at least make the promo overlay a focus-trapped dialog with
  `role="dialog"`, `aria-modal`, and `Escape` to cancel.

### L11. Minor
- `server/src/games.ts` L40/L100 `JSON.parse(row.moves)` unguarded — a corrupt
  column 500s (M1 covers the handler).
- `server/src/config.ts` L7 `Number(process.env.PORT)` → `NaN` on a
  non-numeric value → binds a random port.
- `server/src/app.ts` — `cors` with a single origin + credentials is dev-only;
  in a same-origin prod deployment it is unnecessary. Also the server never
  serves `client/dist` (no `express.static`), so `npm start` alone has no UI.
- `client/src/main.tsx` L13 uses the `React.ReactNode` global without importing
  React, while `useAuth.tsx` imports `ReactNode` — pick one style.
- `client/src/engine/builtinEngine.ts` L23–32 — `function score` declared after
  `return` in `orderMoves`; hoisting makes it work but it reads as dead code.
- `client/src/api/client.ts` L18 sends `Content-Type: application/json` on
  body-less POSTs (`signout`, `newGame`, `resign`); harmless with current
  Express but unnecessary.
- `client/src/hooks/useGame.ts` L59–60 `engineWorkingOn` is only reset in
  `newGame`; it is safe today only because the full-move counter makes every
  FEN string unique within a game — fragile, worth a comment or a reset after
  the engine move completes.

---

## What looks good

- All SQL is parameterised; `foreign_keys=ON` + `ON DELETE CASCADE`.
- Auth cookie is `httpOnly`, `sameSite=lax`, `secure` in prod; `JWT_SECRET` is
  mandatory in production (`config.ts` throws otherwise).
- Rules enforcement leans on `chess.js` for move generation, so castling's five
  conditions, en-passant window, promotion and self-check are correct; the
  server re-validates every move (`games.ts` → `applyUciMove`).
- `chessRules.test.ts` (18 cases) covers RULES.md §§2–9 with genuinely tricky
  positions (castle through/out of check, en-passant window, under-promotion to
  knight, pinned piece, fool's mate, stalemate, K+B vs K, fifty-move).
- `api.test.ts` (10 cases) covers auth lifecycle, persistence/resume, illegal
  move rejection, cross-user isolation, resign.
- Built-in engine verified: finds mate-in-1 and plays 120 legal self-play moves
  with zero illegal outputs; iterative deepening correctly discards
  timed-out partial results.
- Clean separation: `shared` types, `EngineService`-style worker protocol so a
  real Stockfish build is a drop-in (per PLAN §13).

---
---

# Review 2 — 2026-09-05 · database-focused comprehensive pass

Review date: 2026-09-05. Requested scope: full codebase, **with particular
attention to the database** (`server/src/db.ts` and every call site in
`auth.ts`, `games.ts`, `challenges.ts`, `leaderboard.ts`). Context: since
Review 1 the app gained pvp games + points, a SQLite disk on Render, and a
split-origin deploy mode (`COOKIE_SAMESITE=none`, `VITE_API_BASE_URL`).

Legend: **verified** = traced through the code and confirmed reachable;
**plausible** = reasoned from the code, not executed. Line numbers approximate.

Findings new in this pass are prefixed `DB-` (database), `SEC-` (security),
`R-` (rules), `T-` (tests). They do not renumber Review 1.

---

## High — data integrity / competitive fairness

### DB-H1 — End-of-game point transfer is not crash-safe and never reconciles — *verified (by inspection)*

`games.ts` `/move` (L273–283) and `/resign` (L303–304) commit the finishing
`UPDATE games SET status=… result=…` as one **autocommit** statement and *then*
call `applyPvpResult()` as a **separate** `db.transaction`. There is no
surrounding transaction and no reconciliation anywhere.

If the process stops between the two writes — a Render redeploy sends `SIGTERM`
mid-request; an unhandled throw; an OOM — the game is permanently
`checkmate`/`resigned` with `points_applied = 0`, and **nothing ever retries**.
`toDTO` reads the stored terminal status straight back, so the UI shows the game
as finished; the winner never receives `+100`, the loser never spends `-25`.
Over many games the leaderboard silently drifts.

**Impact:** silent, permanent corruption of the one competitive feature; no
error surfaced, no way to detect it after the fact without auditing rows.

**Fix:** wrap the whole terminal path in a single `db.transaction` —
`updateGame`/`finishGame` **and** `applyPvpResult` commit together or not at
all. Cheap and total. Optionally add a read-time reconciler: when `toDTO` sees
`status != 'active' && mode='pvp' && points_applied = 0`, apply the result then.

### DB-H2 — A losing player can abandon a ranked game to dodge the loss — *verified (by inspection)*

`POST /games` (new AI game) → `createAiGame` → `abandonActiveFor` (games.ts
L35–39) runs:

```sql
UPDATE games SET status='abandoned'
  WHERE status='active' AND (user_id=@u OR white_user_id=@u OR black_user_id=@u)
```

That matches an **in-progress pvp game** where the user is a player. `abandoned`
games never pass through `applyPvpResult` (it is only called from `/move` and
`/resign`), so **no points move**. The flow is reachable from the UI: while a
ranked game is active, go to the Lobby (the "New game vs. Computer" button is
always shown) and start an AI game — your pvp game flips to `abandoned`, the
opponent sees "Game set aside", and the `-25` you were about to take evaporates.

**Impact:** the ranked ladder is trivially gameable; an opponent who was winning
gets nothing.

**Fix:** in `createAiGame` / `abandonActiveFor`, refuse to abandon an active
`mode='pvp'` row — either 409 ("finish or resign your current game first") or
treat it as a resignation by the leaver (call the same path `/resign` uses,
inside the transaction).

---

## Medium — schema management, robustness, durability

### DB-M1 — `CHECK` constraints are never migrated; no schema versioning — *plausible*

`addColumnIfMissing()` (db.ts L96–105) only ever emits
`ALTER TABLE … ADD COLUMN`. SQLite **cannot** change a `CHECK` on an existing
table without rebuilding it. So any database file created before `'abandoned'`
was added to the `games.status` CHECK (or before `'pvp'` / the pvp columns) is
still carrying the *old* constraints, and then:

- `abandonActiveFor` writing `status='abandoned'` → `SQLITE_CONSTRAINT: CHECK`
- `insertPvpGame` writing `mode='pvp'` → same

There is no `PRAGMA user_version` (or any migrations table) to detect schema
age, so this fails at runtime with a 500 rather than at startup.

**Impact:** latent hard failure for any deployment whose `.sqlite` predates
these features (i.e. an upgrade rather than a fresh disk). Fresh DBs are fine,
which is why tests (`:memory:`, always current) don't catch it.

**Fix:** add a tiny migration runner keyed on `PRAGMA user_version`. For the
CHECK change specifically, do the standard rebuild inside one transaction:
`CREATE TABLE games_new (… full current schema …)`, `INSERT INTO games_new
SELECT …`, `DROP TABLE games`, `ALTER TABLE games_new RENAME TO games`, recreate
indexes, bump `user_version`.

### DB-M2 — "one active game per participant" has no DB constraint for the non-creator — *verified (by inspection)*

`idx_games_one_active` is `UNIQUE(user_id) WHERE status='active'` — it only
covers `user_id`, i.e. the **creator**. In a pvp game the opponent sits in
`white_user_id` / `black_user_id`, which nothing constrains. The invariant holds
today only because better-sqlite3 is synchronous and single-threaded and
`createPvpGame` / `createAiGame` abandon the relevant players' active games
first, inside a transaction. It breaks the instant there is a second process, an
async driver, or a networked DB — the Render blueprint's `numInstances: 1` and
the "never scale past 1" comment are the *only* things holding it.

**Impact:** none now; a sharp edge for any future scaling. A concurrent
double-accept (same opponent, two challenges) on a threaded stack would leave
two active games for that opponent, and the "resume game" / `findActiveFor`
`LIMIT 1` would then be non-deterministic.

**Fix:** either (a) document `db.ts` as single-instance-only and add a
start-up guard that refuses to run with a config implying >1 instance, or
(b) model players in a `game_players(game_id, user_id, active)` table with a
partial unique index on `(user_id) WHERE active`.

### DB-M3 — timestamp filtering depends on an exact string format — *verified (by inspection)*

`challenges.ts` L104 builds `since = new Date(Date.now() - GRACE).toISOString()`
and the list queries compare `updated_at >= @since` as **text**. This only works
because both sides are fixed-width UTC ISO-8601 with millisecond precision and a
`Z` (`NOW_SQL` = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`). Any row written another
way — a manual `UPDATE`, a future column defaulted to `CURRENT_TIMESTAMP`
(`YYYY-MM-DD HH:MM:SS`, a space, sorts *before* every `…T…` value), a different
`strftime` mask — silently breaks the comparison: accepted challenges either
vanish from the list immediately or linger forever.

**Fix:** store timestamps as integer epoch-millis (or `strftime('%s','now')`)
and compare numerically. If keeping ISO text, add a schema test that asserts the
stored format and never introduce a second way to write a timestamp.

### DB-M4 — no graceful shutdown, no WAL checkpoint — *verified (by inspection)*

`db.ts` opens the connection at import (L15) and never closes it; there is no
`SIGTERM` / `SIGINT` handler anywhere (`index.ts` is a bare `listen`). Every
Render deploy kills the process with an open WAL. SQLite recovers the WAL on the
next open, so this is not routine data loss — but the `-wal` file is never
checkpointed on shutdown, so it only ever grows, and a host that swaps the
filesystem out from under a killed process can lose the un-checkpointed tail.

**Fix:** on `SIGTERM`/`SIGINT`: stop accepting connections, then
`db.pragma('wal_checkpoint(TRUNCATE)')` and `db.close()`, then exit.

### DB-M5 — no `busy_timeout` — *verified (by inspection)*

`db.ts` sets `journal_mode=WAL` and `foreign_keys=ON` but not `busy_timeout`.
While the app is the only connection this is invisible. The moment a second
reader exists — a backup job, the `sqlite3` CLI, litestream, a future
read-replica script — a write can throw `SQLITE_BUSY` *immediately* instead of
waiting, surfacing as a random 500.

**Fix:** `db.pragma('busy_timeout = 5000')` right after open.

---

## Low — hygiene, growth, minor correctness

### DB-L1 — `markPointsApplied` doesn't touch `updated_at`

`UPDATE games SET points_applied = 1 WHERE id = ?` (games.ts L59–61) is the only
`games` write that doesn't also set `updated_at = ${NOW_SQL}`. After a pvp game's
points post, `updated_at` no longer means "last modified". One-word fix.

### DB-L2 — `users.email` uniqueness is case-sensitive at the DB level

`UNIQUE(email)` with SQLite's default `BINARY` collation. Case-folding is done in
app code in three places (`auth.ts` signup + signin, `challenges.ts`). A fourth
path that forgets `.toLowerCase().trim()` would let `A@x.com` and `a@x.com`
coexist. Fix: `email TEXT NOT NULL UNIQUE COLLATE NOCASE`.

### DB-L3 — `challenges` rows are never deleted

Declined / cancelled / accepted challenges live forever. Queries stay fast only
because they filter on `status` and time. Add a periodic sweep (e.g. delete
non-`pending` rows older than a day) or a startup cleanup.

### DB-L4 — unbounded challenge creation

Only a *pending pair* is de-duplicated (`pendingBetween`). One account can open
pending challenges against unlimited distinct emails — table growth plus a
low-grade nuisance vector. Consider a per-user cap on open outgoing challenges.

### DB-L5 — `challengeToDTO` casts user rows with no null guard

`challenges.ts` L54–55: `findUserById.get(...) as { email: string }` then
`from.email`. Safe today only via `ON DELETE CASCADE` (delete a user → their
challenges go too). `games.ts` `toDTO` handles the missing-opponent case;
`challenges.ts` doesn't. Harmless unless a user row is ever removed by a path
that bypasses cascade.

### DB-L6 — full-row rewrite every half-move

`updateGame` re-serialises and rewrites `moves`, `san` and `rep_counts` on every
move — O(n) write per move, O(n²) bytes written per game. Negligible at chess
game lengths; noted only so it isn't a surprise if move history is ever expanded.

---

## Security (non-DB)

### SEC-M1 — no CSRF protection, and `COOKIE_SAMESITE=none` removes the only mitigation — *verified (by inspection)*

Auth is a cookie the browser attaches automatically. No state-changing route
(`POST /api/games`, `/games/:id/move`, `/challenges`, …) carries a CSRF token or
checks `Origin`/`Referer`. With `SameSite=Lax` (single-origin deploy) cross-site
sub-requests are blocked, so exposure is limited to top-level-navigation POSTs.
With `SameSite=None` — the split-origin mode wired up in `config.ts` L56–65 and
now documented in DEPLOY.md — **any website can drive the API as the logged-in
user** (start games, spend the victim's move, spam challenges).

**Fix:** on unsafe methods, verify `req.get('origin')` (or `referer`) is
`config.clientOrigin`; or issue a double-submit CSRF token; or keep auth
strictly same-origin and drop the `None` option.

### SEC-M2 — no security headers

`app.ts` wires CORS + `express.json` + `cookie-parser` only. No `helmet`, so no
HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `X-Frame-Options` /
frame-ancestors CSP on API responses or on the SPA served by `express.static`.
The app is clickjackable and has no transport-security pinning.

**Fix:** `app.use(helmet())`, with a CSP tuned for the built client.

### SEC-M3 — raw email addresses exposed to every authenticated user

`leaderboard.ts` returns the top-20 players' real emails; `games.ts` `toDTO`
returns the opponent's email. That is PII disclosure to the whole user base and
an account-enumeration aid.

**Fix:** add a display name at signup and return that; or mask
(`j•••@d•••.com`) anywhere the viewer isn't the owner.

### SEC-L1 — JWT is unrevocable for its 7-day TTL

`signout` only clears the cookie (`auth.ts` L146–153). A copied token stays valid
for a week regardless. Acceptable for a hobby app; document, or shorten the TTL
and add refresh, or track a per-user token version in `users`.

### SEC-L2 — shared-IP rate-limit lockout

`authLimiter` is `30 / 15 min` (prod) for signup **and** signin combined, keyed
on IP. A campus / office NAT can lock out honest users. Consider also keying
signin *failures* on the submitted email, and raising the per-IP ceiling.

### SEC-L3 — only `/auth/*` is rate-limited

A logged-in client can hammer `/games/:id/move` or `/challenges` freely. Impact
is low (handlers are cheap, `express.json` capped at 16 kB) but a modest global
limiter is cheap insurance.

### SEC-L4 — production misconfig fails silently

If `NODE_ENV=production` with **neither** `CLIENT_DIST` nor `CLIENT_ORIGIN` set
(exactly the split-deploy case), CORS falls back to `http://localhost:5173` and
every real browser call fails with an opaque "Failed to fetch" — the exact
symptom hit during this project's deploy. Fix: in that env combination, log a
loud warning at startup (or refuse to boot).

---

## Rules (minor deviations from FIDE, consistent with RULES.md §9)

### R-L1 — threefold repetition and the fifty-move rule are applied automatically

FIDE makes 3-fold and 50-move *claims* (only 5-fold / 75-move are automatic).
`games.ts` L267 forces the draw at the 3rd occurrence; `chessRules.ts` L68
forces it at halfmove clock 100. Matches RULES.md's stated intent; noted so the
deviation is on record.

### R-L2 — `repetitionKey` over-counts distinct positions

`repetitionKey` (chessRules.ts L29–31) keeps FEN field 4, the en-passant target,
which chess.js writes after *any* double pawn push even when no en-passant
capture is actually available. Two otherwise-identical positions that differ only
by a phantom EP square are treated as different, so a legitimate threefold can be
delayed by up to one occurrence. Edge case; documented limitation.

---

## Test coverage gaps

- **T-1** No test upgrades an older on-disk schema through `addColumnIfMissing`
  (DB-M1) — the migration path is entirely unexercised.
- **T-2** No test for abandoning an active pvp game to dodge points (DB-H2).
- **T-3** No test simulates interruption between `updateGame` and
  `applyPvpResult` (DB-H1), nor concurrent challenge accepts (DB-M2).
- **T-4** No test asserts security headers, CSRF behaviour, or the CORS
  fallback (SEC-M1/M2/L4).
- **T-5** No test pins the stored timestamp format that DB-M3 depends on.

---

## What looks good (database)

- **No SQL injection surface.** Every statement is a prepared statement with
  bound params (named or positional); nothing is string-concatenated into SQL,
  including `repetitionKey` output (it goes into JSON, not a query).
- `foreign_keys = ON` is set on the connection, with sensible
  `ON DELETE CASCADE` / `SET NULL` throughout.
- The **happy-path** point transfer is correct: `applyPvpResult` is a
  `db.transaction`, guarded by `points_applied`, so on a clean run it is
  exactly-once and atomic (the crash gap is DB-H1, a separate concern).
- The money-like invariant is enforced in SQL — `UPDATE users SET points =
  MAX(0, points + ?)` — not a read-modify-write in JS.
- Nested `db.transaction` (`acceptTxn` → `createPvpGame`) is safe:
  better-sqlite3 promotes the inner one to a `SAVEPOINT`.
- WAL + synchronous driver + `numInstances: 1` is a coherent single-writer
  design for this scale; the constraints are written down in `render.yaml`.
- Primary keys are `nanoid` (crypto RNG), not guessable sequential integers.
- `requireAuth` re-reads the user row every request, so a deleted user's token
  stops working immediately.

---

## Suggested order of work

1. **DB-H1** — wrap the terminal move/resign path in one transaction (one-line
   change, stops silent points corruption).
2. **DB-H2** — block abandoning an active pvp game (closes the ladder exploit).
3. **SEC-M1 / SEC-M2** — `helmet` + an `Origin` check on unsafe methods, before
   relying on `SameSite=None` in production.
4. **DB-M1** — real migration runner keyed on `user_version` before the next
   schema change ships.
5. **DB-M4 / DB-M5** — shutdown checkpoint + `busy_timeout` (both one-liners in
   `db.ts`).
6. Everything under Low / Rules / Tests as capacity allows.

---

## Resolution — 2026-09-05 (all High + Medium addressed)

Server suite is now 48 tests (was 42): +4 CSRF-guard cases, +2 abandon-a-ranked-
game cases; the leaderboard test now asserts masking. `npm test` green;
`npm run build` (server + client) green; a fresh file-DB boot was smoke-tested
(helmet headers present, CSRF 403 on a foreign Origin, `SIGTERM` → clean exit);
an old-schema DB was migrated end-to-end (rows preserved, stale CHECK replaced,
`user_version` → 1, `foreign_key_check` clean).

| ID | Fix |
|----|-----|
| **DB-H1** | `games.ts` — new `saveMoveTxn` / `resignTxn` `db.transaction`s wrap the finishing `UPDATE` **and** `applyPvpResult` as one unit; `/move` and `/resign` call those. A crash can no longer land between "game finished" and "points moved". |
| **DB-H2** | `games.ts` `hasActivePvpGame(userId)`; `POST /games` returns 409 ("finish or resign your current game first") when the user is in a live pvp game; `challenges.ts` `POST /:id/accept` returns 409 if either the accepter or the challenger is. Belt-and-braces: a new `trg_one_active_game` trigger (see DB-M2) rejects a second active game for any named player at the DB level. |
| **DB-M1** | `db.ts` — `gamesTableDDL()` factored so the initial create and the rebuild are identical; `runMigrations()` keyed on `PRAGMA user_version`; migration 1 rebuilds `games` via SQLite's supported sequence (`foreign_keys=OFF` → copy → drop → rename → `foreign_key_check`) inside a transaction, replacing any stale `CHECK` set while preserving rows. |
| **DB-M2** | `trg_one_active_game` `BEFORE INSERT` trigger: `RAISE(ABORT)` if any of `NEW.user_id / white_user_id / black_user_id` already appears in an `active` row. Covers the non-creator side the partial unique index can't express. Single-writer assumption now documented in `db.ts`. |
| **DB-M3** | `challenges.ts` — the "recently accepted" cutoff is computed in SQL with the *same* `strftime('%Y-%m-%dT%H:%M:%fZ','now',<offset>)` used to store `updated_at`; the JS `new Date().toISOString()` param is gone. No JS/SQL date-format coupling. |
| **DB-M4** | `db.ts` exports `closeDb()` (`wal_checkpoint(TRUNCATE)` + `close()`); `index.ts` traps `SIGTERM`/`SIGINT`, stops the server, calls it, force-exits after 5 s. |
| **DB-M5** | `db.ts` `open()` sets `PRAGMA busy_timeout = 5000`. |
| **SEC-M1** | `app.ts` `csrfGuard`: for non-safe methods, a present `Origin`/`Referer` must equal `config.clientOrigin` or be same-origin as the request host, else 403; requests with neither header (curl, native, tests) pass. Independent of cookie `SameSite`. |
| **SEC-M2** | `helmet` added (`server` dep) with a CSP tuned for the SPA (`style-src 'unsafe-inline'` for react-chessboard, `img-src data:`), `Cross-Origin-Resource-Policy: cross-origin` (this is a cross-origin API), `upgrade-insecure-requests` only in prod. |
| **SEC-M3** | `leaderboard.ts` `maskEmail()` — every row except the requester's own is returned as `a•••@e•••.com`; DTO gains `isMe`. `LeaderboardEntry` updated in both `shared.ts` copies; client `Leaderboard`/`Lobby` use `isMe` for the "me" highlight instead of matching on email. Opponent email in a game DTO is left intact (a consented 1:1 pairing). |

**Deploy note:** migration 1 rebuilds the `games` table on first boot of the
updated server against an existing database. It is transactional and was tested,
but **back up the SQLite file (`DB_PATH`) before deploying** — or accept the risk
if the DB is fresh.

Not done (out of scope — Low / Rules / Tests): DB-L1–L6, SEC-L1–L4, R-L1/L2,
T-1/T-3/T-5. `users.email COLLATE NOCASE` (DB-L2) was added to the canonical DDL
so *fresh* DBs get it; existing DBs would need another migration.
