import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const isProd = process.env.NODE_ENV === "production";
const isTest = process.env.NODE_ENV === "test";

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Default SQLite location, anchored to `server/data/` regardless of the process
 * working directory (this file resolves the same from `src/` and `dist/`).
 */
const defaultDbPath = fileURLToPath(new URL("../data/chess.sqlite", import.meta.url));

/**
 * `trust proxy` value for Express. Needed so `express-rate-limit` keys on the
 * real client IP when the app runs behind a reverse proxy. Accepts the same
 * forms Express does: "false", "true", "loopback", or a hop count.
 */
function trustProxy(): boolean | string | number {
  const raw = process.env.TRUST_PROXY;
  if (raw === undefined) return isProd ? "loopback" : false;
  if (raw === "true") return true;
  if (raw === "false") return false;
  const n = Number(raw);
  return Number.isInteger(n) ? n : raw;
}

export const config = {
  isProd,
  isTest,
  port: intFromEnv("PORT", 4000),
  /** Where the SQLite file lives. ":memory:" for tests. */
  dbPath: process.env.DB_PATH ?? defaultDbPath,
  /** JWT signing secret. A random ephemeral secret is used if unset (dev only). */
  jwtSecret:
    process.env.JWT_SECRET ??
    (isProd
      ? (() => {
          throw new Error("JWT_SECRET must be set in production");
        })()
      : randomBytes(32).toString("hex")),
  /** Auth cookie name. */
  cookieName: "chess_token",
  /**
   * `SameSite` attribute for the auth cookie. Defaults to `lax`, which is right
   * for a same-origin deploy. For a split deploy (client and API on different
   * origins) set `COOKIE_SAMESITE=none`; the browser then requires `Secure`,
   * so also run the server in production over HTTPS (or set `COOKIE_SECURE=1`).
   */
  cookieSameSite: (() => {
    const raw = (process.env.COOKIE_SAMESITE ?? "lax").toLowerCase();
    return raw === "none" || raw === "strict" ? raw : "lax";
  })() as "lax" | "none" | "strict",
  /** `Secure` attribute for the auth cookie. On in production; forced on when
   *  `SameSite=None` (browsers reject `None` without `Secure`). */
  cookieSecure:
    process.env.COOKIE_SECURE === "1" ||
    isProd ||
    (process.env.COOKIE_SAMESITE ?? "").toLowerCase() === "none",
  /** Session lifetime. */
  tokenTtlSeconds: 60 * 60 * 24 * 7,
  /** Allowed browser origin for CORS in dev (client Vite server). */
  clientOrigin: process.env.CLIENT_ORIGIN ?? "http://localhost:5173",
  /** Optional path to the built client (`client/dist`) to serve in production. */
  clientDist: process.env.CLIENT_DIST ?? null,
  trustProxy: trustProxy(),
};
