import { Router, type Response } from "express";
import { nanoid } from "nanoid";
import { createChallengeSchema, type ChallengeDTO } from "./shared.js";
import { q, q1, withTransaction, type ChallengeRow } from "./db.js";
import { requireAuth, type AuthedRequest } from "./auth.js";
import { wrap } from "./http.js";
import {
  createPvpGame,
  getGameForUser,
  hasActivePvpGame,
  toDTO,
} from "./games.js";

/**
 * How long an accepted challenge keeps showing so the initiator can redirect.
 * Compared with `now()` in SQL, so there is no JS/SQL date-format coupling.
 */
const ACCEPTED_GRACE = "60 seconds";
const RECENT = `updated_at >= now() - interval '${ACCEPTED_GRACE}'`;

async function findChallengeById(id: string): Promise<ChallengeRow | undefined> {
  return q1<ChallengeRow>("SELECT * FROM challenges WHERE id = $1", [id]);
}

const listIncoming = `
  SELECT * FROM challenges
   WHERE to_user_id = $1
     AND (status = 'pending' OR (status = 'accepted' AND ${RECENT}))
   ORDER BY created_at DESC`;
const listOutgoing = `
  SELECT * FROM challenges
   WHERE from_user_id = $1
     AND (status = 'pending' OR (status = 'accepted' AND ${RECENT}))
   ORDER BY created_at DESC`;

async function challengeToDTO(row: ChallengeRow): Promise<ChallengeDTO> {
  const [from, to] = await Promise.all([
    q1<{ email: string }>("SELECT email FROM users WHERE id = $1", [
      row.from_user_id,
    ]),
    q1<{ email: string }>("SELECT email FROM users WHERE id = $1", [
      row.to_user_id,
    ]),
  ]);
  return {
    id: row.id,
    from: { email: from?.email ?? "unknown" },
    to: { email: to?.email ?? "unknown" },
    status: row.status,
    gameId: row.game_id,
    createdAt: row.created_at,
  };
}

export const challengesRouter = Router();
challengesRouter.use(requireAuth);

/** Challenge another account by email. */
challengesRouter.post(
  "/",
  wrap(async (req: AuthedRequest, res: Response) => {
    const parsed = createChallengeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "a valid opponent email is required" });
      return;
    }
    const email = parsed.data.email.toLowerCase().trim();
    const target = await q1<{ id: string; email: string }>(
      "SELECT id, email FROM users WHERE lower(email) = $1",
      [email],
    );
    if (!target) {
      res.status(404).json({ error: "no player with that email" });
      return;
    }
    if (target.id === req.user!.id) {
      res.status(400).json({ error: "you cannot challenge yourself" });
      return;
    }
    const existing = await q1(
      `SELECT 1 FROM challenges
         WHERE status = 'pending'
           AND ((from_user_id = $1 AND to_user_id = $2)
             OR (from_user_id = $2 AND to_user_id = $1))
         LIMIT 1`,
      [req.user!.id, target.id],
    );
    if (existing) {
      res
        .status(409)
        .json({ error: "there is already a pending challenge with this player" });
      return;
    }
    const id = nanoid();
    await q(
      "INSERT INTO challenges (id, from_user_id, to_user_id) VALUES ($1, $2, $3)",
      [id, req.user!.id, target.id],
    );
    res.status(201).json({
      challenge: await challengeToDTO((await findChallengeById(id))!),
    });
  }),
);

/** Pending challenges (plus just-accepted ones) for the current user. */
challengesRouter.get(
  "/",
  wrap(async (req: AuthedRequest, res: Response) => {
    const u = req.user!.id;
    const [incoming, outgoing] = await Promise.all([
      q<ChallengeRow>(listIncoming, [u]),
      q<ChallengeRow>(listOutgoing, [u]),
    ]);
    res.json({
      incoming: await Promise.all(incoming.map(challengeToDTO)),
      outgoing: await Promise.all(outgoing.map(challengeToDTO)),
    });
  }),
);

/** Accept an incoming challenge: creates the pvp game. */
challengesRouter.post(
  "/:id/accept",
  wrap(async (req: AuthedRequest, res: Response) => {
    const userId = req.user!.id;
    const row = await findChallengeById(req.params.id);
    if (!row || row.to_user_id !== userId) {
      res.status(404).json({ error: "challenge not found" });
      return;
    }
    if (row.status !== "pending") {
      res.status(409).json({ error: "challenge is no longer pending" });
      return;
    }
    // Accepting abandons both players' active games; refuse if that would throw
    // away an in-progress ranked game (and its points) for either side.
    if (await hasActivePvpGame(userId)) {
      res
        .status(409)
        .json({ error: "finish or resign your current game first" });
      return;
    }
    if (await hasActivePvpGame(row.from_user_id)) {
      res
        .status(409)
        .json({ error: "that player is already in a game; try again later" });
      return;
    }
    const gameId = nanoid();
    await withTransaction(async (tx) => {
      await createPvpGame(tx, {
        gameId,
        creatorId: row.from_user_id,
        opponentId: row.to_user_id,
      });
      await tx.query(
        `UPDATE challenges SET status = 'accepted', game_id = $1, updated_at = now()
           WHERE id = $2`,
        [gameId, row.id],
      );
    });
    const game = (await getGameForUser(gameId, userId))!;
    res.status(201).json({ game: await toDTO(game, userId) });
  }),
);

/** Decline an incoming challenge. */
challengesRouter.post(
  "/:id/decline",
  wrap(async (req: AuthedRequest, res: Response) => {
    const userId = req.user!.id;
    const row = await findChallengeById(req.params.id);
    if (!row || row.to_user_id !== userId) {
      res.status(404).json({ error: "challenge not found" });
      return;
    }
    if (row.status !== "pending") {
      res.status(409).json({ error: "challenge is no longer pending" });
      return;
    }
    await q(
      `UPDATE challenges SET status = 'declined', updated_at = now() WHERE id = $1`,
      [row.id],
    );
    res.json({ challenge: await challengeToDTO((await findChallengeById(row.id))!) });
  }),
);

/** Cancel a challenge you sent. */
challengesRouter.post(
  "/:id/cancel",
  wrap(async (req: AuthedRequest, res: Response) => {
    const userId = req.user!.id;
    const row = await findChallengeById(req.params.id);
    if (!row || row.from_user_id !== userId) {
      res.status(404).json({ error: "challenge not found" });
      return;
    }
    if (row.status !== "pending") {
      res.status(409).json({ error: "challenge is no longer pending" });
      return;
    }
    await q(
      `UPDATE challenges SET status = 'cancelled', updated_at = now() WHERE id = $1`,
      [row.id],
    );
    res.json({ challenge: await challengeToDTO((await findChallengeById(row.id))!) });
  }),
);
