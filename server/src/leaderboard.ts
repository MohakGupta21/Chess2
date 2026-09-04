import { Router, type Response } from "express";
import type { LeaderboardEntry } from "./shared.js";
import { db } from "./db.js";
import { requireAuth, type AuthedRequest } from "./auth.js";

const topPlayers = db.prepare(
  `SELECT email, points FROM users
     ORDER BY points DESC, created_at ASC
     LIMIT 20`,
);

export const leaderboardRouter = Router();
leaderboardRouter.use(requireAuth);

/** Top players by points, highest first. */
leaderboardRouter.get("/", (_req: AuthedRequest, res: Response) => {
  const entries = topPlayers.all() as LeaderboardEntry[];
  res.json({ entries });
});
