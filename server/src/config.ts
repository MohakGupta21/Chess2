import { randomBytes } from "node:crypto";

const isProd = process.env.NODE_ENV === "production";
const isTest = process.env.NODE_ENV === "test";

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Postgres connection string. Required in production. */
function databaseUrl(): string {
  const raw = process.env.DATABASE_URL;
  if (raw && raw.trim() !== "") return raw;
  if (isProd) throw new Error("DATABASE_URL must be set in production");
  // Local dev / tests default to the docker-compose Postgres.
  return "postgres://chess:chess@localhost:5433/chess";
}

/**
 * Whether to use TLS for the Postgres connection. Managed providers (Render,
 * Neon, …) require it; a local container does not. Auto-off for localhost;
 * override with `DATABASE_SSL=require` / `disable`.
 */
function databaseSsl(url: string): false | { rejectUnauthorized: boolean } {
  const flag = process.env.DATABASE_SSL;
  if (flag === "disable") return false;
  if (flag === "require") return { rejectUnauthorized: false };
  const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
  return isLocal ? false : { rejectUnauthorized: false };
}

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

const dbUrl = databaseUrl();

export const config = {
  isProd,
  isTest,
  port: intFromEnv("PORT", 4000),
  /** Postgres connection string. */
  databaseUrl: dbUrl,
  /** TLS options for `pg.Pool` (`false` to disable). */
  databaseSsl: databaseSsl(dbUrl),
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
