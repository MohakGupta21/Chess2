import { Router, type Response } from "express";
import { nanoid } from "nanoid";
import {
  START_FEN,
  POINTS_WIN,
  POINTS_LOSS,
  createGameSchema,
  moveRequestSchema,
  type Color,
  type EndReason,
  type GameDTO,
  type GameMode,
  type GameResult,
  type GameStatus,
} from "./shared.js";
import {
  q,
  q1,
  withTransaction,
  type Executor,
  type GameRow,
} from "./db.js";
import { requireAuth, type AuthedRequest } from "./auth.js";
import { wrap } from "./http.js";
import { applyUciMove, positionFromFen, repetitionKey } from "./chessRules.js";

// Any game the user takes part in — creator (user_id) or either side of a pvp
// game. `$1` is bound once and referenced three times.
const ACTIVE_FOR = `
  SELECT * FROM games
   WHERE status = 'active'
     AND (user_id = $1 OR white_user_id = $1 OR black_user_id = $1)
   ORDER BY created_at DESC LIMIT 1`;
const GAME_FOR = `
  SELECT * FROM games
   WHERE id = $1
     AND (user_id = $2 OR white_user_id = $2 OR black_user_id = $2)`;

/** True if the user is currently in an unfinished player-vs-player game. */
export async function hasActivePvpGame(userId: string): Promise<boolean> {
  const row = await q1(
    `SELECT 1 FROM games
       WHERE status = 'active' AND mode = 'pvp'
         AND (user_id = $1 OR white_user_id = $1 OR black_user_id = $1)
       LIMIT 1`,
    [userId],
  );
  return row !== undefined;
}

async function abandonActiveFor(exec: Executor, userId: string): Promise<void> {
  await q(
    `UPDATE games SET status = 'abandoned', updated_at = now()
       WHERE status = 'active'
         AND (user_id = $1 OR white_user_id = $1 OR black_user_id = $1)`,
    [userId],
    exec,
  );
}

async function addPoints(
  exec: Executor,
  delta: number,
  userId: string,
): Promise<void> {
  await q(
    `UPDATE users SET points = GREATEST(0, points + $1) WHERE id = $2`,
    [delta, userId],
    exec,
  );
}

/** Abandon any active game for the user and create a fresh AI game, atomically. */
async function createAiGame(
  userId: string,
  id: string,
  color: Color,
  repKey: string,
): Promise<void> {
  await withTransaction(async (tx) => {
    await abandonActiveFor(tx, userId);
    await q(
      `INSERT INTO games (id, user_id, user_color, fen, rep_counts)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, userId, color, START_FEN, JSON.stringify({ [repKey]: 1 })],
      tx,
    );
  });
}

/**
 * Create a pvp game between two users on the given executor (the caller owns the
 * transaction). Both players' prior active games are abandoned first (one active
 * game per account, either mode). Colours are split at random; `user_id` records
 * the creator so owner-scoped queries still work.
 */
export async function createPvpGame(
  exec: Executor,
  opts: { gameId: string; creatorId: string; opponentId: string },
): Promise<void> {
  const creatorWhite = Math.random() < 0.5;
  await abandonActiveFor(exec, opts.creatorId);
  await abandonActiveFor(exec, opts.opponentId);
  await q(
    `INSERT INTO games
       (id, user_id, user_color, mode, white_user_id, black_user_id, fen, rep_counts)
     VALUES ($1, $2, $3, 'pvp', $4, $5, $6, $7)`,
    [
      opts.gameId,
      opts.creatorId,
      creatorWhite ? "w" : "b",
      creatorWhite ? opts.creatorId : opts.opponentId,
      creatorWhite ? opts.opponentId : opts.creatorId,
      START_FEN,
      JSON.stringify({ [repetitionKey(START_FEN)]: 1 }),
    ],
    exec,
  );
}

/**
 * Move points for a finished pvp game, exactly once (`points_applied` guard).
 * Draws and stalemates award nothing. Losers are floored at 0 points. Runs on
 * the caller's transaction executor.
 */
async function applyPvpResult(
  exec: Executor,
  row: GameRow,
  result: GameResult,
): Promise<void> {
  if (row.mode !== "pvp" || row.points_applied) return;
  if (result !== "1-0" && result !== "0-1") return;
  const winnerId = result === "1-0" ? row.white_user_id : row.black_user_id;
  const loserId = result === "1-0" ? row.black_user_id : row.white_user_id;
  if (!winnerId || !loserId) return;
  await addPoints(exec, POINTS_WIN, winnerId);
  await addPoints(exec, -POINTS_LOSS, loserId);
  await q(`UPDATE games SET points_applied = 1 WHERE id = $1`, [row.id], exec);
}

/**
 * Persist a move and, if it ended the game, move the pvp points — in ONE
 * transaction, so a crash can't leave a finished game with points unapplied and
 * no path that ever retries.
 */
async function saveMove(args: {
  fen: string;
  moves: string;
  san: string;
  rep: string;
  status: GameStatus;
  result: GameResult;
  endReason: EndReason;
  row: GameRow;
}): Promise<void> {
  await withTransaction(async (tx) => {
    await q(
      `UPDATE games SET fen = $1, moves = $2, san = $3, rep_counts = $4,
         status = $5, result = $6, end_reason = $7, updated_at = now()
       WHERE id = $8`,
      [
        args.fen,
        args.moves,
        args.san,
        args.rep,
        args.status,
        args.result,
        args.endReason,
        args.row.id,
      ],
      tx,
    );
    if (args.status !== "active") await applyPvpResult(tx, args.row, args.result);
  });
}

/** Finish a game as a resignation and move the pvp points, in one transaction. */
async function resignGame(row: GameRow, result: GameResult): Promise<void> {
  await withTransaction(async (tx) => {
    await q(
      `UPDATE games SET status = 'resigned', result = $1, end_reason = 'resignation',
         updated_at = now() WHERE id = $2`,
      [result, row.id],
      tx,
    );
    await applyPvpResult(tx, row, result);
  });
}

export async function getGameForUser(
  id: string,
  userId: string,
): Promise<GameRow | undefined> {
  return q1<GameRow>(GAME_FOR, [id, userId]);
}

/** The requesting user's colour in this game, or null if they aren't in it. */
function colorForUser(row: GameRow, userId: string): Color | null {
  if (row.mode === "pvp") {
    if (row.white_user_id === userId) return "w";
    if (row.black_user_id === userId) return "b";
    return null;
  }
  return row.user_color;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Build the API view of a game for one requester. The stored
 * `status`/`result`/`end_reason` columns are authoritative for any finished
 * game; `turn` and `inCheck` are derived from the FEN. `userColor` and
 * `opponent` are relative to `requesterId`.
 */
export async function toDTO(
  row: GameRow,
  requesterId: string,
): Promise<GameDTO> {
  const pos = positionFromFen(row.fen);
  const status = row.status as GameStatus;
  const finished = status !== "active";
  const mode = row.mode as GameMode;

  let userColor: Color;
  let opponent: { email: string } | null = null;
  if (mode === "pvp") {
    userColor = row.white_user_id === requesterId ? "w" : "b";
    const oppId = userColor === "w" ? row.black_user_id : row.white_user_id;
    const oppRow = oppId
      ? await q1<{ email: string }>("SELECT email FROM users WHERE id = $1", [
          oppId,
        ])
      : undefined;
    opponent = oppRow ? { email: oppRow.email } : null;
  } else {
    userColor = row.user_color;
  }

  return {
    id: row.id,
    mode,
    userColor,
    opponent,
    turn: pos.turn,
    fen: row.fen,
    moves: parseJson<string[]>(row.moves, []),
    san: parseJson<string[]>(row.san, []),
    status,
    result: (row.result as GameResult) ?? null,
    endReason: (row.end_reason as EndReason) ?? null,
    inCheck: !finished && pos.inCheck,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const gamesRouter = Router();
gamesRouter.use(requireAuth);

/** Create a fresh AI game; any prior active game for the user is abandoned. */
gamesRouter.post(
  "/",
  wrap(async (req: AuthedRequest, res: Response) => {
    const parsed = createGameSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid game options" });
      return;
    }
    if (parsed.data.mode === "pvp") {
      res
        .status(400)
        .json({ error: "start a player game by accepting a challenge" });
      return;
    }

    const userId = req.user!.id;
    // Starting a solo game would otherwise abandon an in-progress ranked game
    // (and skip its points): make the player finish or resign it first.
    if (await hasActivePvpGame(userId)) {
      res.status(409).json({ error: "finish or resign your current game first" });
      return;
    }
    const userColor: Color = Math.random() < 0.5 ? "w" : "b";
    const id = nanoid();
    await createAiGame(userId, id, userColor, repetitionKey(START_FEN));
    const row = (await getGameForUser(id, userId)) as GameRow;
    res.status(201).json({ game: await toDTO(row, userId) });
  }),
);

/** The user's active game, or 404. */
gamesRouter.get(
  "/current",
  wrap(async (req: AuthedRequest, res: Response) => {
    const userId = req.user!.id;
    const row = await q1<GameRow>(ACTIVE_FOR, [userId]);
    if (!row) {
      res.status(404).json({ error: "no active game" });
      return;
    }
    res.json({ game: await toDTO(row, userId) });
  }),
);

/** A specific game the user takes part in. */
gamesRouter.get(
  "/:id",
  wrap(async (req: AuthedRequest, res: Response) => {
    const userId = req.user!.id;
    const row = await getGameForUser(req.params.id, userId);
    if (!row) {
      res.status(404).json({ error: "game not found" });
      return;
    }
    res.json({ game: await toDTO(row, userId) });
  }),
);

/** Apply one legal move. */
gamesRouter.post(
  "/:id/move",
  wrap(async (req: AuthedRequest, res: Response) => {
    const userId = req.user!.id;
    const parsed = moveRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "a valid UCI move is required" });
      return;
    }
    const row = await getGameForUser(req.params.id, userId);
    if (!row) {
      res.status(404).json({ error: "game not found" });
      return;
    }
    if (row.status !== "active") {
      res.status(409).json({ error: "game is already over" });
      return;
    }

    // In a pvp game a player may only move their own side, on their own turn.
    // An AI game lets the single client drive both sides.
    if (row.mode === "pvp") {
      const myColor = colorForUser(row, userId);
      if (!myColor || positionFromFen(row.fen).turn !== myColor) {
        res.status(409).json({ error: "not your turn" });
        return;
      }
    }

    const applied = applyUciMove(row.fen, parsed.data.uci);
    if (!applied.ok || !applied.position) {
      res.status(422).json({ error: applied.error ?? "illegal move" });
      return;
    }
    const pos = applied.position;

    const moves = [...parseJson<string[]>(row.moves, []), parsed.data.uci];
    const san = [...parseJson<string[]>(row.san, []), applied.san!];

    // Threefold repetition (RULES.md section 9): count occurrences of the new
    // position and, on the third, declare the draw.
    const repCounts = parseJson<Record<string, number>>(row.rep_counts, {});
    const key = repetitionKey(pos.fen);
    repCounts[key] = (repCounts[key] ?? 0) + 1;

    let status: GameStatus = pos.status;
    let result: GameResult = pos.result;
    let endReason: EndReason = pos.endReason;
    if (status === "active" && repCounts[key] >= 3) {
      status = "draw";
      result = "1/2-1/2";
      endReason = "threefold_repetition";
    }

    await saveMove({
      fen: pos.fen,
      moves: JSON.stringify(moves),
      san: JSON.stringify(san),
      rep: JSON.stringify(repCounts),
      status,
      result,
      endReason,
      row,
    });

    res.json({
      game: await toDTO((await getGameForUser(row.id, userId)) as GameRow, userId),
    });
  }),
);

/** Resign the game; the resigning user loses. */
gamesRouter.post(
  "/:id/resign",
  wrap(async (req: AuthedRequest, res: Response) => {
    const userId = req.user!.id;
    const row = await getGameForUser(req.params.id, userId);
    if (!row) {
      res.status(404).json({ error: "game not found" });
      return;
    }
    if (row.status !== "active") {
      res.json({ game: await toDTO(row, userId) });
      return;
    }

    const myColor = colorForUser(row, userId) ?? row.user_color;
    const result: GameResult = myColor === "w" ? "0-1" : "1-0";
    await resignGame(row, result);

    res.json({
      game: await toDTO((await getGameForUser(row.id, userId)) as GameRow, userId),
    });
  }),
);
