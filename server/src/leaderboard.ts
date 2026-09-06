import { Router, type Response } from "express";
import type { LeaderboardEntry } from "./shared.js";
import { q } from "./db.js";
import { requireAuth, type AuthedRequest } from "./auth.js";
import { wrap } from "./http.js";

const TOP_PLAYERS = `
  SELECT id, email, points FROM users
   ORDER BY points DESC, created_at ASC
   LIMIT 20`;

/** "alice@example.com" -> "a•••@e•••.com". Enough to recognise your own row,
 *  not enough to harvest addresses off the leaderboard. */
function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "•••";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : "";
  const clip = (s: string) => (s ? `${s[0]}•••` : "•••");
  return `${clip(local)}@${clip(host)}${tld}`;
}

export const leaderboardRouter = Router();
leaderboardRouter.use(requireAuth);

/** Top players by points, highest first. Emails are masked except your own. */
leaderboardRouter.get(
  "/",
  wrap(async (req: AuthedRequest, res: Response) => {
    const me = req.user!.id;
    const rows = await q<{ id: string; email: string; points: number }>(
      TOP_PLAYERS,
    );
    const entries: LeaderboardEntry[] = rows.map((r) => ({
      email: r.id === me ? r.email : maskEmail(r.email),
      points: r.points,
      isMe: r.id === me,
    }));
    res.json({ entries });
  }),
);
