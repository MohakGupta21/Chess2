import { existsSync } from "node:fs";
import { join } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import { config } from "./config.js";
import { authRouter } from "./auth.js";
import { gamesRouter } from "./games.js";
import { challengesRouter } from "./challenges.js";
import { leaderboardRouter } from "./leaderboard.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** True if `value` (an Origin header, or an origin parsed from Referer) is a
 *  request source we accept for state-changing calls. */
function isAllowedOrigin(value: string, req: Request): boolean {
  if (value === config.clientOrigin) return true;
  try {
    // Same-origin: the request's Origin host matches the host it was sent to.
    return new URL(value).host === req.headers.host;
  } catch {
    return false;
  }
}

/**
 * Origin/Referer check for unsafe methods — a CSRF defence that does not depend
 * on the cookie's `SameSite` (which is `None` in a split-origin deploy, i.e. no
 * protection at all). A browser always sends `Origin` on a cross-site POST, so
 * rejecting a present-but-unlisted origin blocks forged requests; requests with
 * neither header (curl, native clients, server-to-server, tests) are allowed.
 */
function csrfGuard(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.get("origin");
  const referer = req.get("referer");
  if (!origin && !referer) return next();
  let candidate = origin;
  if (!candidate && referer) {
    try {
      candidate = new URL(referer).origin;
    } catch {
      candidate = undefined;
    }
  }
  if (candidate && isAllowedOrigin(candidate, req)) return next();
  res.status(403).json({ error: "cross-origin request refused" });
}

export function createApp() {
  const app = express();

  // Needed so express-rate-limit keys on the real client IP behind a proxy.
  app.set("trust proxy", config.trustProxy);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          // react-chessboard positions pieces with inline style attributes.
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
          fontSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          frameAncestors: ["'none'"],
          // Only force https upgrades in production (localhost dev is http).
          upgradeInsecureRequests: config.isProd ? [] : null,
        },
      },
      // This service is an API meant to be called from another origin in a
      // split deploy; CORS still gates who may read the responses.
      crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
  );

  app.use(
    cors({
      origin: config.clientOrigin,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: "16kb" }));
  app.use(cookieParser());
  app.use(csrfGuard);

  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.use("/api/auth", authRouter);
  app.use("/api/games", gamesRouter);
  app.use("/api/challenges", challengesRouter);
  app.use("/api/leaderboard", leaderboardRouter);

  // Unknown API route -> JSON 404 (before any static/SPA handling).
  app.use("/api", (_req, res) => res.status(404).json({ error: "not found" }));

  // Optionally serve the built client (single-origin production deploy).
  if (config.clientDist && existsSync(config.clientDist)) {
    const dist = config.clientDist;
    app.use(express.static(dist));
    app.get("*", (_req, res) => res.sendFile(join(dist, "index.html")));
  }

  // Terminal error handler: always JSON, never a stack trace to the client.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[unhandled]", err);
    if (res.headersSent) return;
    res.status(500).json({ error: "internal error" });
  });

  return app;
}
