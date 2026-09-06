# Deploying Chess

This app deploys as **one service**: the Express server ([server/](./server)) both
serves the API under `/api` **and** serves the built React client
([client/dist](./client)) as static files with SPA fallback
(see [server/src/app.ts](./server/src/app.ts)).

The simplest deploy is a single Node process. It **can** also be split with the
client on a static host and the server elsewhere — see
["Split (cross‑origin) deploy"](#split-cross-origin-deploy) below.

By default the browser calls `/api/...` *relative* to its own origin
([client/src/api/client.ts](./client/src/api/client.ts)) and the session cookie
is `httpOnly; SameSite=Lax; Secure`
([server/src/auth.ts](./server/src/auth.ts#L34-L38)), which works cleanly
same‑origin over HTTPS with no extra configuration.

No Docker is used in any deploy path below. (Docker is only a convenience for
running Postgres locally for dev/tests — see `server/docker-compose.yml`.)

---

## 1. What the host needs

| Requirement | Why |
|---|---|
| **Node.js 22 LTS** (built/tested on v22.6) + npm 10 | runtime + build |
| **A PostgreSQL database** (v14+) | all data lives in Postgres ([server/src/db.ts](./server/src/db.ts)). The server runs its schema/migrations on startup |
| **HTTPS** (platform TLS or nginx + certbot) | the auth cookie is `Secure` in production, so plain HTTP will not keep you logged in |

No native modules — `pg` is pure JavaScript, so `npm ci` needs no C toolchain and
any Node 22+ works. The single-writer limitation is gone; you may run more than
one instance (the "one active game per player" rule is enforced by a DB trigger,
not by process-level serialisation).

---

## 2. Environment variables

Set these on the server process (defaults from [server/src/config.ts](./server/src/config.ts)):

| Var | Required | Set it to | Notes |
|---|---|---|---|
| `NODE_ENV` | yes | `production` | enables `Secure` cookie, requires `JWT_SECRET` and `DATABASE_URL`, `trust proxy` defaults to `loopback` |
| `JWT_SECRET` | **yes** | 32+ random bytes, e.g. `openssl rand -hex 32` | server **throws on startup** if unset in production. Rotating it logs everyone out |
| `DATABASE_URL` | **yes** | Postgres connection string, e.g. `postgres://user:pass@host:5432/chess` | server **throws on startup** if unset in production. Schema + migrations run automatically on boot |
| `DATABASE_SSL` | usually no | `require` or `disable` | auto: off for `localhost`, on otherwise. Most managed Postgres needs TLS (kept on by default); set `disable` only for a local/plaintext DB |
| `CLIENT_DIST` | yes | absolute path to the built client, e.g. `/srv/chess/client/dist` | without it the server runs API‑only and the site returns 404 |
| `PORT` | no | port to listen on (default `4000`) | many PaaS platforms inject this |
| `TRUST_PROXY` | if behind a proxy/load balancer | `1` (single proxy hop) or `true` | so the rate limiter keys on the real client IP, not the proxy |
| `CLIENT_ORIGIN` | only for a split deploy | the client's origin, e.g. `https://chess.example.com` | reflected by CORS so the browser accepts credentialed cross‑origin API calls |
| `COOKIE_SAMESITE` | only for a split deploy | `none` | lets the browser send the auth cookie on cross‑site requests; forces `Secure` on, so the API must be HTTPS |
| `COOKIE_SECURE` | no | `1` | force the `Secure` cookie flag outside production (rarely needed) |

---

## 2a. Split (cross‑origin) deploy

To host the built client (`client/dist`) on a static/CDN host and the API on a
separate origin:

**Client** — build with the API's base URL baked in (Vite reads `VITE_*` at
build time; see [client/.env.example](./client/.env.example)):

```bash
VITE_API_BASE_URL="https://chess-api.example.com" npm run build --workspace client
```

Deploy `client/dist` as static files with SPA fallback (rewrite unknown paths to
`/index.html`). Leave `CLIENT_DIST` **unset** on the server so it stays API‑only.

**Server** — set, in addition to the section 2 vars:

| Var | Set it to |
|---|---|
| `CLIENT_ORIGIN` | the client's origin, e.g. `https://chess.example.com` |
| `COOKIE_SAMESITE` | `none` |

Both origins must be HTTPS. With `VITE_API_BASE_URL` unset the build is
byte‑for‑byte the same‑origin bundle, so the single‑origin deploy is unaffected.

---

## 3. Build (same on every target)

From the repo root:

```bash
npm ci                 # install all workspaces
npm run build          # builds server -> client
npm test               # optional: server rules + API + pvp/points suites
```

`npm run build` produces:

- `server/dist/` — compiled server, entry `server/dist/index.js`. The types +
  zod schemas it shares with the client are a vendored copy at
  [server/src/shared.ts](./server/src/shared.ts) (identical copy in
  `client/src/shared.ts`), so each side builds and runs on its own
- `client/dist/` — static site (`index.html` + `assets/`)

Server only, for a server‑only deploy or a faster build:

```bash
npm ci --workspace server --include-workspace-root
npm run build --workspace server
```

Run:

```bash
NODE_ENV=production \
JWT_SECRET=... \
DATABASE_URL=postgres://user:pass@host:5432/chess \
CLIENT_DIST="$PWD/client/dist" \
PORT=4000 \
npm start
```

> `npm start` does **not** rebuild anything — it just launches
> `node server/dist/index.js`. Always run a full `npm run build` in your release
> step.

Health check: `GET /api/health` → `{"ok":true}`.

> **`error TS2307: Cannot find module '../shared'`** — the client and server
> each import their own `src/shared.ts`; there is no `@chess/shared` package to
> install or pre‑build. If you see this, the vendored file is missing from the
> checkout.

---

## Option A — VPS (Ubuntu/Debian) with systemd + nginx

Full control, no platform lock‑in. ~15 minutes.

### A.1 One‑time server setup

```bash
# as root / sudo
apt update && apt install -y curl nginx postgresql
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

adduser --system --group --home /srv/chess chess

# create the database and a login role
sudo -u postgres psql -c "CREATE ROLE chess LOGIN PASSWORD 'change-me';"
sudo -u postgres psql -c "CREATE DATABASE chess OWNER chess;"
# -> DATABASE_URL = postgres://chess:change-me@localhost:5432/chess
```

### A.2 Get the code and build

```bash
sudo -u chess -H bash
cd /srv/chess
git clone <your-repo-url> app && cd app
npm ci
npm run build
# generate a secret once and keep it:
openssl rand -hex 32 > /srv/chess/jwt_secret && chmod 600 /srv/chess/jwt_secret
exit
```

### A.3 Environment file

`/srv/chess/app/.env.production` (readable by the `chess` user only):

```ini
NODE_ENV=production
PORT=4000
JWT_SECRET=paste-the-openssl-rand-hex-32-value
DATABASE_URL=postgres://chess:change-me@localhost:5432/chess
DATABASE_SSL=disable
CLIENT_DIST=/srv/chess/app/client/dist
TRUST_PROXY=1
```

(`DATABASE_SSL=disable` because Postgres is on the same host over the loopback;
drop it if your DB is remote and speaks TLS.)

```bash
chmod 600 /srv/chess/app/.env.production
chown chess:chess /srv/chess/app/.env.production
```

### A.4 systemd service

`/etc/systemd/system/chess.service`:

```ini
[Unit]
Description=Chess app
After=network.target

[Service]
Type=simple
User=chess
Group=chess
WorkingDirectory=/srv/chess/app
EnvironmentFile=/srv/chess/app/.env.production
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=2
# hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now chess
systemctl status chess
curl -s localhost:4000/api/health   # -> {"ok":true}
```

### A.5 nginx reverse proxy + HTTPS

`/etc/nginx/sites-available/chess`:

```nginx
server {
    listen 80;
    server_name chess.example.com;

    client_max_body_size 32k;   # API caps JSON bodies at 16kb

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/chess /etc/nginx/sites-enabled/chess
nginx -t && systemctl reload nginx

apt install -y certbot python3-certbot-nginx
certbot --nginx -d chess.example.com     # provisions the cert and rewrites to 443
```

With nginx as the single local proxy hop, `TRUST_PROXY=1` is correct. Certbot
adds an auto‑renew timer.

### A.6 Deploying an update

```bash
sudo -u chess -H bash -c '
  cd /srv/chess/app &&
  git pull &&
  npm ci &&
  npm run build
'
systemctl restart chess
```

Rollback: `git checkout <previous-sha>`, `npm ci && npm run build`, restart.
Migrations run forward on boot ([server/src/db.ts](./server/src/db.ts),
`schema_migrations` table) and are additive, so rolling the code back is safe as
long as you don't roll back across a migration that dropped/renamed something.

---

## Option B — Managed platform (Render, Railway, etc.), no Docker

Any platform that runs a **native Node build** and can give you a **PostgreSQL
database** works. No disk is needed; ephemeral filesystems are fine now that all
state is in Postgres.

### Render (example)

> **Fastest path:** the repo ships a [`render.yaml`](./render.yaml) Blueprint that
> encodes everything below — a web service (API + client) **and** a managed
> `chess-db` Postgres, with `DATABASE_URL` wired between them, env vars, and the
> health check. Render Dashboard → **New → Blueprint**, point it at this repo,
> deploy. `JWT_SECRET` is auto-generated and kept stable.

1. **New → Postgres.** Note its **Internal Database URL**.
2. **New → Web Service**, connect the repo. Runtime: **Node**. Any Node 22+ is
   fine (no native modules).
3. **Build command:** `npm ci && npm run build`
4. **Start command:** `npm start` (runs migrations, then listens)
5. **Environment:**
   - `NODE_ENV=production`
   - `JWT_SECRET=` (generate one; keep it stable)
   - `DATABASE_URL=` the Postgres Internal Database URL from step 1
   - `CLIENT_DIST=/opt/render/project/src/client/dist` (absolute path to the repo's `client/dist` on the build host — check the platform's project root and adjust)
   - `TRUST_PROXY=1`
   - `PORT` is provided by the platform; the server already reads it.
6. **Health check path:** `/api/health`
7. Deploy. Use the platform's managed TLS domain or attach your own.

Render's Postgres URL already implies TLS; `DATABASE_SSL` can stay unset.

---

## 4. Database persistence & backups

- All state is in Postgres. Schema and forward migrations run automatically on
  every boot ([server/src/db.ts](./server/src/db.ts)); a `schema_migrations`
  table records what has been applied.
- **Backups:** use your provider's automated backups (Render, RDS, Neon, … all
  offer point-in-time or daily snapshots) — turn them on. For a self-managed
  Postgres, schedule `pg_dump`:

  ```bash
  pg_dump "$DATABASE_URL" --format=custom --file=/var/backups/chess-$(date +%F).dump
  ```

  and copy the output off-box.
- **Restore:** `pg_restore --clean --dbname "$DATABASE_URL" chess-YYYY-MM-DD.dump`
  (stop the service first).
- **Moving hosts:** `pg_dump` from the old DB, `pg_restore` into the new one,
  point `DATABASE_URL` at it.

---

## 5. Pre‑launch checklist

- [ ] `npm run build` succeeds clean; `npm test` passes (needs a Postgres — `npm run db:up`).
- [ ] `JWT_SECRET` set, random, stored somewhere safe, and **stable** across restarts.
- [ ] `DATABASE_URL` set and reachable; restart the service and confirm accounts/games survive.
- [ ] `CLIENT_DIST` points at a real `client/dist` (absolute path) — visit `/` and get the app, not a 404.
- [ ] Site is served over HTTPS; sign‑in works and the session sticks after a refresh (confirms the `Secure` cookie is reaching the browser).
- [ ] `TRUST_PROXY` set when behind nginx / a platform LB; sign‑in rate‑limit (5 attempts / 15 min) triggers per‑client, not globally.
- [ ] `GET /api/health` returns `{"ok":true}` through the public URL.
- [ ] Automated Postgres backups are enabled (provider snapshots or a `pg_dump` cron).

---

## 6. Notes & limits

- **Scaling out is OK.** State is in Postgres and the "one active game per
  player" rule is enforced by a DB trigger, so you can run more than one
  instance. Watch the Postgres connection count (`pg.Pool` defaults to 10 per
  instance).
- **pvp is polling-based** — clients re‑fetch every 1.5–3s. No WebSocket/SSE, so
  no sticky‑session or upgrade config is needed at the proxy.
- **No email is sent.** Challenges are by account email and surface in‑app only;
  no SMTP setup required.
- The built‑in chess engine runs **in the browser** (Web Worker), not on the
  server — the server holds the authoritative rules via `chess.js` but does no
  heavy compute, so a small instance is fine.
