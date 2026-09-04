// Chess types + zod schemas used by the client and server.
// This is the server's own copy; the client keeps an identical copy at
// client/src/shared.ts (there is no longer a standalone @chess/shared
// workspace). Keep the two in sync when you change either.

import { z } from "zod";

/** Standard chess starting position. */
export const START_FEN =
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export type Color = "w" | "b";

export type GameStatus =
  | "active"
  | "checkmate"
  | "stalemate"
  | "draw"
  | "resigned"
  /** Superseded by a newer game the same user started; never shown to play. */
  | "abandoned";

/** "1-0" | "0-1" | "1/2-1/2" | null (still active) */
export type GameResult = "1-0" | "0-1" | "1/2-1/2" | null;

/** Why a finished game ended, for display. */
export type EndReason =
  | "checkmate"
  | "stalemate"
  | "insufficient_material"
  | "threefold_repetition"
  | "fifty_move_rule"
  | "resignation"
  | null;

// ---------------------------------------------------------------------------
// API request/response schemas
// ---------------------------------------------------------------------------

export const credentialsSchema = z.object({
  email: z.string().email().max(254),
  // Upper bound is just a sanity cap; the server pre-hashes with SHA-256 before
  // bcrypt so the full string counts (bcrypt itself only reads 72 bytes).
  password: z.string().min(8).max(1024),
});
export type Credentials = z.infer<typeof credentialsSchema>;

/** UCI long algebraic move, e.g. "e2e4", "e7e8q", "e1g1" (castle). */
export const uciSchema = z
  .string()
  .regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/, "invalid UCI move");

export const moveRequestSchema = z.object({
  uci: uciSchema,
});
export type MoveRequest = z.infer<typeof moveRequestSchema>;

/** "ai" = solo game against the built-in engine; "pvp" = account vs account. */
export type GameMode = "ai" | "pvp";

/** Points awarded when a pvp game ends. Draws award nothing. */
export const POINTS_WIN = 100;
export const POINTS_LOSS = 25;

export const createGameSchema = z.object({
  mode: z.enum(["ai", "pvp"]).optional(),
});
export type CreateGameRequest = z.infer<typeof createGameSchema>;

export const createChallengeSchema = z.object({
  email: z.string().email().max(254),
});
export type CreateChallengeRequest = z.infer<typeof createChallengeSchema>;

export type ChallengeStatus =
  | "pending"
  | "accepted"
  | "declined"
  | "cancelled";

export interface PublicUser {
  id: string;
  email: string;
  /** Running score: +100 per pvp win, -25 per pvp loss, floored at 0. */
  points: number;
}

export interface GameDTO {
  id: string;
  mode: GameMode;
  userColor: Color;
  /** The other human player, or null for an "ai" game. */
  opponent: { email: string } | null;
  /** Whose turn it is now. */
  turn: Color;
  fen: string;
  /** Move history in UCI. */
  moves: string[];
  /** Move history in SAN, aligned with `moves`. */
  san: string[];
  status: GameStatus;
  result: GameResult;
  endReason: EndReason;
  /** True when the side to move is in check (and game still active). */
  inCheck: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ChallengeDTO {
  id: string;
  from: { email: string };
  to: { email: string };
  status: ChallengeStatus;
  /** Set once the challenge is accepted and a game exists. */
  gameId: string | null;
  createdAt: string;
}

export interface AuthResponse {
  user: PublicUser;
}

export interface GameResponse {
  game: GameDTO;
}

export interface ChallengesResponse {
  incoming: ChallengeDTO[];
  outgoing: ChallengeDTO[];
}

export interface ChallengeResponse {
  challenge: ChallengeDTO;
}

export interface LeaderboardEntry {
  email: string;
  points: number;
}

export interface LeaderboardResponse {
  entries: LeaderboardEntry[];
}

export interface ApiError {
  error: string;
}
