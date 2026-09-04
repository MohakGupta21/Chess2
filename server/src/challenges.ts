import { Router, type Response } from "express";
import { nanoid } from "nanoid";
import {
  createChallengeSchema,
  type ChallengeDTO,
} from "./shared.js";
import { db, NOW_SQL, type ChallengeRow } from "./db.js";
import { requireAuth, type AuthedRequest } from "./auth.js";
import { createPvpGame, getGameForUser, toDTO } from "./games.js";

/** How long an accepted challenge keeps showing so the initiator can redirect. */
const ACCEPTED_GRACE_MS = 60_000;

const findUserByEmail = db.prepare("SELECT id, email FROM users WHERE email = ?");
const findUserById = db.prepare("SELECT id, email FROM users WHERE id = ?");
const findChallengeById = db.prepare("SELECT * FROM challenges WHERE id = ?");
const pendingBetween = db.prepare(
  `SELECT * FROM challenges
     WHERE status = 'pending'
       AND ((from_user_id = @a AND to_user_id = @b)
         OR (from_user_id = @b AND to_user_id = @a))`,
);
const insertChallenge = db.prepare(
  "INSERT INTO challenges (id, from_user_id, to_user_id) VALUES (?, ?, ?)",
);
const setChallengeStatus = db.prepare(
  `UPDATE challenges SET status = ?, updated_at = ${NOW_SQL} WHERE id = ?`,
);
const acceptChallengeRow = db.prepare(
  `UPDATE challenges SET status = 'accepted', game_id = ?, updated_at = ${NOW_SQL}
     WHERE id = ?`,
);
const listIncoming = db.prepare(
  `SELECT * FROM challenges
     WHERE to_user_id = @u
       AND (status = 'pending' OR (status = 'accepted' AND updated_at >= @since))
     ORDER BY created_at DESC`,
);
const listOutgoing = db.prepare(
  `SELECT * FROM challenges
     WHERE from_user_id = @u
       AND (status = 'pending' OR (status = 'accepted' AND updated_at >= @since))
     ORDER BY created_at DESC`,
);

const acceptTxn = db.transaction(
  (challengeId: string, creatorId: string, opponentId: string, gameId: string) => {
    createPvpGame({ gameId, creatorId, opponentId });
    acceptChallengeRow.run(gameId, challengeId);
  },
);

function challengeToDTO(row: ChallengeRow): ChallengeDTO {
  const from = findUserById.get(row.from_user_id) as { email: string };
  const to = findUserById.get(row.to_user_id) as { email: string };
  return {
    id: row.id,
    from: { email: from.email },
    to: { email: to.email },
    status: row.status,
    gameId: row.game_id,
    createdAt: row.created_at,
  };
}

export const challengesRouter = Router();
challengesRouter.use(requireAuth);

/** Challenge another account by email. */
challengesRouter.post("/", (req: AuthedRequest, res: Response) => {
  const parsed = createChallengeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "a valid opponent email is required" });
    return;
  }
  const email = parsed.data.email.toLowerCase().trim();
  const target = findUserByEmail.get(email) as
    | { id: string; email: string }
    | undefined;
  if (!target) {
    res.status(404).json({ error: "no player with that email" });
    return;
  }
  if (target.id === req.user!.id) {
    res.status(400).json({ error: "you cannot challenge yourself" });
    return;
  }
  if (pendingBetween.get({ a: req.user!.id, b: target.id })) {
    res
      .status(409)
      .json({ error: "there is already a pending challenge with this player" });
    return;
  }
  const id = nanoid();
  insertChallenge.run(id, req.user!.id, target.id);
  res
    .status(201)
    .json({ challenge: challengeToDTO(findChallengeById.get(id) as ChallengeRow) });
});

/** Pending challenges (plus just-accepted ones) for the current user. */
challengesRouter.get("/", (req: AuthedRequest, res: Response) => {
  const u = req.user!.id;
  const since = new Date(Date.now() - ACCEPTED_GRACE_MS).toISOString();
  res.json({
    incoming: (listIncoming.all({ u, since }) as ChallengeRow[]).map(challengeToDTO),
    outgoing: (listOutgoing.all({ u, since }) as ChallengeRow[]).map(challengeToDTO),
  });
});

/** Accept an incoming challenge: creates the pvp game. */
challengesRouter.post("/:id/accept", (req: AuthedRequest, res: Response) => {
  const userId = req.user!.id;
  const row = findChallengeById.get(req.params.id) as ChallengeRow | undefined;
  if (!row || row.to_user_id !== userId) {
    res.status(404).json({ error: "challenge not found" });
    return;
  }
  if (row.status !== "pending") {
    res.status(409).json({ error: "challenge is no longer pending" });
    return;
  }
  const gameId = nanoid();
  acceptTxn(row.id, row.from_user_id, row.to_user_id, gameId);
  const game = getGameForUser(gameId, userId)!;
  res.status(201).json({ game: toDTO(game, userId) });
});

/** Decline an incoming challenge. */
challengesRouter.post("/:id/decline", (req: AuthedRequest, res: Response) => {
  const userId = req.user!.id;
  const row = findChallengeById.get(req.params.id) as ChallengeRow | undefined;
  if (!row || row.to_user_id !== userId) {
    res.status(404).json({ error: "challenge not found" });
    return;
  }
  if (row.status !== "pending") {
    res.status(409).json({ error: "challenge is no longer pending" });
    return;
  }
  setChallengeStatus.run("declined", row.id);
  res.json({
    challenge: challengeToDTO(findChallengeById.get(row.id) as ChallengeRow),
  });
});

/** Cancel a challenge you sent. */
challengesRouter.post("/:id/cancel", (req: AuthedRequest, res: Response) => {
  const userId = req.user!.id;
  const row = findChallengeById.get(req.params.id) as ChallengeRow | undefined;
  if (!row || row.from_user_id !== userId) {
    res.status(404).json({ error: "challenge not found" });
    return;
  }
  if (row.status !== "pending") {
    res.status(409).json({ error: "challenge is no longer pending" });
    return;
  }
  setChallengeStatus.run("cancelled", row.id);
  res.json({
    challenge: challengeToDTO(findChallengeById.get(row.id) as ChallengeRow),
  });
});
