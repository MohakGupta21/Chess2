# Deploying Chess

This app deploys as **one service**: the Express server ([server/](./server)) both
serves the API under `/api` **and** serves the built React client
([client/dist](./client)) as static files with SPA fallback
(see [server/src/app.ts](./server/src/app.ts)).

Deploy it as a single Node process. Do **not** split the client and server onto
two origins unless you also rework auth — the browser calls `/api/...`
*relative* to its own origin ([client/src/api/client.ts](./client/src/api/client.ts))
and the session cookie is `httpOnly; SameSite=Lax; Secure`
([server/src/auth.ts](./server/src/auth.ts#L34-L38)), which only works cleanly
same‑origin over HTTPS.

No Docker is used anywhere below.

---

## 1. What the host needs

| Requirement | Why |
|---|---|
| **Node.js 22 LTS** (built/tested on v22.6) + npm 10 | runtime + build |
| **A persistent writable directory** | the database is a `better-sqlite3` file on disk ([server/src/db.ts](./server/src/db.ts)); it must survive restarts and redeploys |
| **HTTPS** (platform TLS or nginx + certbot) | the auth cookie is `Secure` in production, so plain HTTP will not keep you logged in |
| C toolchain **only if** `npm ci` can't fetch a `better-sqlite3` prebuilt binary | native module. Prebuilds cover Linux x64/arm64 on Node 22, so usually not needed. If it is: `python3`, `make`, `g++` (Debian/Ubuntu: `build-essential`) |

`better-sqlite3` is synchronous and in‑process — fine for a single node, but it
means you can run **only one instance**. Do not scale to multiple replicas
without first moving to a networked database.

---

## 2. Environment variables

Set these on the server process (defaults from [server/src/config.ts](./server/src/config.ts)):

| Var | Required | Set it to | Notes |
|---|---|---|---|
| `NODE_ENV` | yes | `production` | enables `Secure` cookie, requires `JWT_SECRET`, `trust proxy` defaults to `loopback` |
| `JWT_SECRET` | **yes** | 32+ random bytes, e.g. `openssl rand -hex 32` | server **throws on startup** if unset in production. Rotating it logs everyone out |
| `CLIENT_DIST` | yes | absolute path to the built client, e.g. `/srv/chess/client/dist` | without it the server runs API‑only and the site returns 404 |
| `DB_PATH` | yes | absolute path on the persistent disk, e.g. `/var/lib/chess/chess.sqlite` | parent dir is created automatically; WAL mode is on |
| `PORT` | no | port to listen on (default `4000`) | many PaaS platforms inject this |
| `TRUST_PROXY` | if behind a proxy/load balancer | `1` (single proxy hop) or `true` | so the rate limiter keys on the real client IP, not the proxy |
| `CLIENT_ORIGIN` | no (single‑origin) | — | only matters if you serve the UI from a different origin; then set it to that origin for CORS |

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
CLIENT_DIST="$PWD/client/dist" \
DB_PATH=/var/lib/chess/chess.sqlite \
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
apt update && apt install -y curl nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
# only if the better-sqlite3 prebuild is missing for your arch:
# apt install -y build-essential python3

adduser --system --group --home /srv/chess chess
mkdir -p /var/lib/chess && chown chess:chess /var/lib/chess   # DB lives here
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
CLIENT_DIST=/srv/chess/app/client/dist
DB_PATH=/var/lib/chess/chess.sqlite
TRUST_PROXY=1
```

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
ReadWritePaths=/var/lib/chess

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
The SQLite schema is created with `CREATE TABLE IF NOT EXISTS` and has no
destructive migrations, so old code runs against the existing DB.

---

## Option B — Managed platform (Render, Railway, etc.), no Docker

Any platform that runs a **native Node build** (not just containers) and offers a
**mounted persistent disk** works. Heroku‑style ephemeral filesystems do **not** —
the SQLite file would be wiped on every restart.

### Render (example)

1. **New → Web Service**, connect the repo. Runtime: **Node**.
2. **Build command:** `npm ci && npm run build`
3. **Start command:** `npm start`
4. **Add a Disk:** mount path `/var/data`, ~1 GB.
5. **Environment:**
   - `NODE_ENV=production`
   - `JWT_SECRET=` (generate one; keep it stable)
   - `CLIENT_DIST=/opt/render/project/src/client/dist` (absolute path to the repo's `client/dist` on the build host — check the platform's project root and adjust)
   - `DB_PATH=/var/data/chess.sqlite` (on the mounted disk)
   - `TRUST_PROXY=1`
   - `PORT` is provided by the platform; the server already reads it.
6. **Health check path:** `/api/health`
7. Deploy. Use the platform's managed TLS domain or attach your own.

Keep the instance count at **1** (single‑writer SQLite).

---

## 4. Database persistence & backups

- The DB is one file at `DB_PATH`, plus `-wal` / `-shm` siblings while running.
- **Back it up without stopping the app** using SQLite's online backup:

  ```bash
  sqlite3 /var/lib/chess/chess.sqlite ".backup '/var/backups/chess-$(date +%F).sqlite'"
  ```

  (`apt install -y sqlite3`.) Schedule it with cron/systemd‑timer and copy the
  output off‑box.
- To restore: stop the service, replace `chess.sqlite` (delete stale `-wal` /
  `-shm`), start again.
- Moving hosts = copy the one file to the new `DB_PATH`.

---

## 5. Pre‑launch checklist

- [ ] `npm run build` succeeds clean; `npm test` passes.
- [ ] `JWT_SECRET` set, random, stored somewhere safe, and **stable** across restarts.
- [ ] `CLIENT_DIST` points at a real `client/dist` (absolute path) — visit `/` and get the app, not a 404.
- [ ] `DB_PATH` is on the persistent disk; restart the service and confirm accounts/games survive.
- [ ] Site is served over HTTPS; sign‑in works and the session sticks after a refresh (confirms the `Secure` cookie is reaching the browser).
- [ ] `TRUST_PROXY` set when behind nginx / a platform LB; sign‑in rate‑limit (5 attempts / 15 min) triggers per‑client, not globally.
- [ ] `GET /api/health` returns `{"ok":true}` through the public URL.
- [ ] Backup job for the SQLite file is scheduled and its output lands off the server.

---

## 6. Notes & limits

- **Single instance only.** `better-sqlite3` is an in‑process writer; running two
  copies against the same file will corrupt it. To scale horizontally, port
  [server/src/db.ts](./server/src/db.ts) to a networked DB (Postgres) first.
- **pvp is polling-based** — clients re‑fetch every 1.5–3s. No WebSocket/SSE, so
  no sticky‑session or upgrade config is needed at the proxy.
- **No email is sent.** Challenges are by account email and surface in‑app only;
  no SMTP setup required.
- The built‑in chess engine runs **in the browser** (Web Worker), not on the
  server — the server holds the authoritative rules via `chess.js` but does no
  heavy compute, so a small instance is fine.
