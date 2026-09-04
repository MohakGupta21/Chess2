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
