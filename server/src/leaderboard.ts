import { Router, type Response } from "express";
import type { LeaderboardEntry } from "./shared.js";
import { q } from "./db.js";
import { requireAuth, type AuthedRequest } from "./auth.js";
import { wrap } from "./http.js";

const TOP_PLAYERS = `
  SELECT id, email, points FROM users
   ORDER BY points DESC, created_at ASC
   LIMIT 20`;

export const leaderboardRouter = Router();
leaderboardRouter.use(requireAuth);

/** Top players by points, highest first. Full email on every row. */
leaderboardRouter.get(
  "/",
  wrap(async (req: AuthedRequest, res: Response) => {
    const me = req.user!.id;
    const rows = await q<{ id: string; email: string; points: number }>(
      TOP_PLAYERS,
    );
    const entries: LeaderboardEntry[] = rows.map((r) => ({
      email: r.email,
      points: r.points,
      isMe: r.id === me,
    }));
    res.json({ entries });
  }),
);
