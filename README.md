# Chess

Sign in, then either play the built-in computer or challenge another account to
a live game. Rules enforced per [RULES.md](./RULES.md); design and as-built notes
in [PLAN.md](./PLAN.md). (The original single-player MVP scope is in
[AGENTS.md](./AGENTS.md); multiplayer + points extends it.)

## Modes

- **Vs. Computer** — solo game against the negamax engine, exactly as before.
- **Vs. Player** — from the lobby, challenge another account by its email. They
  accept, both players land on the same board with opposite colours, and each
  client polls for the other's moves.

## Points

Every finished **pvp** game moves points: **+100** to the winner, **−25** to the
loser (floored at 0), nothing on a draw. Resigning counts as a loss. Totals show
in the top bar and on the lobby leaderboard. AI games never change points.

## Stack

- **Monorepo** — npm workspaces: `server/`, `client/`. The types + zod schemas
  shared by both live in identical vendored copies at `server/src/shared.ts` and
  `client/src/shared.ts` (no standalone `shared` package), so each side builds
  and deploys on its own. Keep the two copies in sync.
- **Server** — Express + PostgreSQL (`pg`), JWT-in-httpOnly-cookie auth
  (`bcryptjs`), `chess.js` as the authoritative rules engine.
- **Client** — React + Vite, `react-chessboard`, `chess.js` for instant local
  feedback, a built-in negamax engine in a Web Worker (`useEngine`).

## Run

```bash
npm install
npm run db:up      # local Postgres in Docker on :5433 (or run your own — see below)
npm run dev        # server :4000, client :5173 (Vite proxies /api -> :4000)
```

No Docker? Point `DATABASE_URL` at any Postgres, e.g.
`DATABASE_URL=postgres://you@localhost:5432/chess npm run dev`. The server
creates its schema on startup.

Open http://localhost:5173, create an account, and you land on the lobby. Start
a computer game or challenge another account. Open a second browser profile to
play both sides of a pvp game locally.

### Other commands

```bash
npm run db:up         # start local Postgres (needed by the tests)
npm run test          # server tests (rules + API + pvp/points)
npm run build         # typecheck + build server, then client
npm start             # run the already-built server (server/dist/index.js)
npm run db:down       # stop local Postgres
```

`npm start` builds nothing — run `npm run build` first.

## Environment (server)

| Var             | Default                          | Notes                                        |
|-----------------|---------------------------------|----------------------------------------------|
| `PORT`          | `4000`                          | non-numeric values fall back to the default  |
| `DATABASE_URL`  | `postgres://chess:chess@localhost:5433/chess` (dev) | **required** when `NODE_ENV=production`; schema/migrations run on boot |
| `DATABASE_SSL`  | auto (off for localhost)        | `require` / `disable` to override            |
| `JWT_SECRET`    | random per process (dev)        | **required** when `NODE_ENV=production`       |
| `CLIENT_ORIGIN` | `http://localhost:5173`         | CORS allow-origin                            |
| `COOKIE_SAMESITE` | `lax`                         | set `none` for a split (cross-origin) deploy; forces `Secure` |
| `CLIENT_DIST`   | unset                           | path to `client/dist` to serve the built UI from the API (single-origin prod) |
| `TRUST_PROXY`   | `false` (dev) / `loopback` (prod) | Express `trust proxy`; set so the rate limiter sees the real client IP behind a proxy |

## Layout

```
server/src/shared.ts       types + zod schemas (identical copy in client/src/shared.ts)
server/src/
  config.ts  db.ts         env + Postgres pool, schema + migrations, query/tx helpers
                            (users.points, games.mode/white_user_id/black_user_id/
                            points_applied, challenges table)
  chessRules.ts            chess.js wrapper: validate/apply a UCI move, classify end state
  auth.ts  games.ts        routers (games.ts owns pvp turn-auth + points on a result)
  challenges.ts            challenge-by-email router; accept creates the pvp game
  leaderboard.ts           top players by points
  app.ts  index.ts         express app factory + entrypoint
  *.test.ts                vitest suites
client/src/
  pages/SignIn.tsx  pages/Lobby.tsx  pages/Play.tsx
  components/BoardView.tsx GameStatusBar.tsx MoveList.tsx ChallengePanel.tsx Leaderboard.tsx
  hooks/useAuth.tsx useGame.ts useEngine.ts useChallenges.ts
  engine/                  builtin engine + evaluation + engine.worker.ts
  api/client.ts            typed fetch wrappers
```

pvp is polling-based: `useGame` re-fetches the game every 1.5s while a pvp game
is active, `useChallenges` polls the challenge list every 3s. Swap in SSE or a
WebSocket here if you want push updates.

## Swapping in Stockfish

`client/src/engine/engine.worker.ts` speaks a small `{ id, fen } -> { id, uci }`
protocol. Replace its body with a UCI driver for a vendored Stockfish build
(single-threaded `stockfish-*-single.js` needs no COOP/COEP headers); nothing
else changes.
