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
import { db, NOW_SQL, type GameRow } from "./db.js";
import { requireAuth, type AuthedRequest } from "./auth.js";
import { applyUciMove, positionFromFen, repetitionKey } from "./chessRules.js";

// Any game the user takes part in — creator (user_id) or either side of a pvp
// game. Named params so the same id can be bound three times.
const findActiveFor = db.prepare(
  `SELECT * FROM games
     WHERE status = 'active'
       AND (user_id = @u OR white_user_id = @u OR black_user_id = @u)
     ORDER BY created_at DESC LIMIT 1`,
);
const findGameFor = db.prepare(
  `SELECT * FROM games
     WHERE id = @id
       AND (user_id = @u OR white_user_id = @u OR black_user_id = @u)`,
);
const findEmailById = db.prepare("SELECT email FROM users WHERE id = ?");

const abandonActiveFor = db.prepare(
  `UPDATE games SET status = 'abandoned', updated_at = ${NOW_SQL}
     WHERE status = 'active'
       AND (user_id = @u OR white_user_id = @u OR black_user_id = @u)`,
);
const insertGame = db.prepare(
  "INSERT INTO games (id, user_id, user_color, fen, rep_counts) VALUES (?, ?, ?, ?, ?)",
);
const insertPvpGame = db.prepare(
  `INSERT INTO games
     (id, user_id, user_color, mode, white_user_id, black_user_id, fen, rep_counts)
     VALUES (@id, @creator, @creatorColor, 'pvp', @white, @black, @fen, @rep)`,
);
const updateGame = db.prepare(
  `UPDATE games SET fen = ?, moves = ?, san = ?, rep_counts = ?, status = ?,
     result = ?, end_reason = ?, updated_at = ${NOW_SQL} WHERE id = ?`,
);
const finishGame = db.prepare(
  `UPDATE games SET status = ?, result = ?, end_reason = ?,
     updated_at = ${NOW_SQL} WHERE id = ?`,
);
const addPoints = db.prepare(
  "UPDATE users SET points = MAX(0, points + ?) WHERE id = ?",
);
const markPointsApplied = db.prepare(
  "UPDATE games SET points_applied = 1 WHERE id = ?",
);

/** Abandon any active game for the user and create a fresh AI game, atomically. */
const createAiGame = db.transaction(
  (userId: string, id: string, color: Color, repKey: string) => {
    abandonActiveFor.run({ u: userId });
    insertGame.run(id, userId, color, START_FEN, JSON.stringify({ [repKey]: 1 }));
  },
);

/**
 * Create a pvp game between two users. Both players' prior active games are
 * abandoned first (one active game per account, either mode). Colours are split
 * at random; `user_id` records the creator so owner-scoped queries still work.
 */
export const createPvpGame = db.transaction(
  (opts: { gameId: string; creatorId: string; opponentId: string }) => {
    const creatorWhite = Math.random() < 0.5;
    abandonActiveFor.run({ u: opts.creatorId });
    abandonActiveFor.run({ u: opts.opponentId });
    insertPvpGame.run({
      id: opts.gameId,
      creator: opts.creatorId,
      creatorColor: creatorWhite ? "w" : "b",
      white: creatorWhite ? opts.creatorId : opts.opponentId,
      black: creatorWhite ? opts.opponentId : opts.creatorId,
      fen: START_FEN,
      rep: JSON.stringify({ [repetitionKey(START_FEN)]: 1 }),
    });
  },
);

/**
 * Move points for a finished pvp game, exactly once (`points_applied` guard).
 * Draws and stalemates award nothing. Losers are floored at 0 points.
 */
const applyPvpResult = db.transaction((row: GameRow, result: GameResult) => {
  if (row.mode !== "pvp" || row.points_applied) return;
  if (result !== "1-0" && result !== "0-1") return;
  const winnerId = result === "1-0" ? row.white_user_id : row.black_user_id;
  const loserId = result === "1-0" ? row.black_user_id : row.white_user_id;
  if (!winnerId || !loserId) return;
  addPoints.run(POINTS_WIN, winnerId);
  addPoints.run(-POINTS_LOSS, loserId);
  markPointsApplied.run(row.id);
});

export function getGameForUser(id: string, userId: string): GameRow | undefined {
  return findGameFor.get({ id, u: userId }) as GameRow | undefined;
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
export function toDTO(row: GameRow, requesterId: string): GameDTO {
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
      ? (findEmailById.get(oppId) as { email: string } | undefined)
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
gamesRouter.post("/", (req: AuthedRequest, res: Response) => {
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
  const userColor: Color = Math.random() < 0.5 ? "w" : "b";
  const id = nanoid();
  createAiGame(userId, id, userColor, repetitionKey(START_FEN));
  const row = getGameForUser(id, userId) as GameRow;
  res.status(201).json({ game: toDTO(row, userId) });
});

/** The user's active game, or 404. */
gamesRouter.get("/current", (req: AuthedRequest, res: Response) => {
  const userId = req.user!.id;
  const row = findActiveFor.get({ u: userId }) as GameRow | undefined;
  if (!row) {
    res.status(404).json({ error: "no active game" });
    return;
  }
  res.json({ game: toDTO(row, userId) });
});

/** A specific game the user takes part in. */
gamesRouter.get("/:id", (req: AuthedRequest, res: Response) => {
  const userId = req.user!.id;
  const row = getGameForUser(req.params.id, userId);
  if (!row) {
    res.status(404).json({ error: "game not found" });
    return;
  }
  res.json({ game: toDTO(row, userId) });
});

/** Apply one legal move. */
gamesRouter.post("/:id/move", (req: AuthedRequest, res: Response) => {
  const userId = req.user!.id;
  const parsed = moveRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "a valid UCI move is required" });
    return;
  }
  const row = getGameForUser(req.params.id, userId);
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

  updateGame.run(
    pos.fen,
    JSON.stringify(moves),
    JSON.stringify(san),
    JSON.stringify(repCounts),
    status,
    result,
    endReason,
    row.id,
  );
  if (status !== "active") applyPvpResult(row, result);

  res.json({ game: toDTO(getGameForUser(row.id, userId) as GameRow, userId) });
});

/** Resign the game; the resigning user loses. */
gamesRouter.post("/:id/resign", (req: AuthedRequest, res: Response) => {
  const userId = req.user!.id;
  const row = getGameForUser(req.params.id, userId);
  if (!row) {
    res.status(404).json({ error: "game not found" });
    return;
  }
  if (row.status !== "active") {
    res.json({ game: toDTO(row, userId) });
    return;
  }

  const myColor = colorForUser(row, userId) ?? row.user_color;
  const result: GameResult = myColor === "w" ? "0-1" : "1-0";
  finishGame.run("resigned", result, "resignation", row.id);
  applyPvpResult(row, result);

  res.json({ game: toDTO(getGameForUser(row.id, userId) as GameRow, userId) });
});
