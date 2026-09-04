import { existsSync } from "node:fs";
import { join } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import { config } from "./config.js";
import { authRouter } from "./auth.js";
import { gamesRouter } from "./games.js";
import { challengesRouter } from "./challenges.js";
import { leaderboardRouter } from "./leaderboard.js";

export function createApp() {
  const app = express();

  // Needed so express-rate-limit keys on the real client IP behind a proxy.
  app.set("trust proxy", config.trustProxy);

  app.use(
    cors({
      origin: config.clientOrigin,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: "16kb" }));
  app.use(cookieParser());

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
