import { Chess } from "chess.js";
import type {
  Color,
  EndReason,
  GameResult,
  GameStatus,
} from "./shared.js";

export interface Position {
  fen: string;
  turn: Color;
  status: GameStatus;
  result: GameResult;
  endReason: EndReason;
  inCheck: boolean;
}

/** Halfmove clock from a FEN (moves since last capture or pawn move). */
function halfmoveClock(fen: string): number {
  const parts = fen.split(" ");
  return Number(parts[4] ?? "0");
}

/**
 * Repetition key: the parts of a FEN that define "the same position" for the
 * threefold rule — piece placement, side to move, castling rights and the en
 * passant target. Move counters are deliberately excluded.
 */
export function repetitionKey(fen: string): string {
  return fen.split(" ").slice(0, 4).join(" ");
}

/**
 * Classify a position against the game-end rules in RULES.md section 9 that are
 * decidable from the position alone. Threefold repetition needs move history
 * and is handled by the caller (see games.ts, via `repetitionKey`); resignation
 * and abandonment are also caller concerns.
 */
export function classify(chess: Chess): Omit<Position, "fen" | "turn"> {
  const turn: Color = chess.turn();
  const inCheck = chess.isCheck();

  if (chess.isCheckmate()) {
    // Side to move is mated => the other side wins.
    return {
      status: "checkmate",
      result: turn === "w" ? "0-1" : "1-0",
      endReason: "checkmate",
      inCheck: true,
    };
  }
  if (chess.isStalemate()) {
    return {
      status: "stalemate",
      result: "1/2-1/2",
      endReason: "stalemate",
      inCheck: false,
    };
  }
  if (chess.isInsufficientMaterial()) {
    return {
      status: "draw",
      result: "1/2-1/2",
      endReason: "insufficient_material",
      inCheck,
    };
  }
  if (halfmoveClock(chess.fen()) >= 100) {
    return {
      status: "draw",
      result: "1/2-1/2",
      endReason: "fifty_move_rule",
      inCheck,
    };
  }
  return { status: "active", result: null, endReason: null, inCheck };
}

export function positionFromFen(fen: string): Position {
  const chess = new Chess(fen);
  return { fen: chess.fen(), turn: chess.turn(), ...classify(chess) };
}

export interface ApplyResult {
  ok: boolean;
  /** Present when ok. */
  position?: Position;
  /** SAN of the move just played. Present when ok. */
  san?: string;
  /** Present when !ok. */
  error?: string;
}

/**
 * Validate a single UCI move against the full ruleset (chess.js generates only
 * legal moves: piece movement, captures, castling's five conditions, en
 * passant window, promotion, and any move that would leave the king in check
 * is excluded) and apply it.
 */
export function applyUciMove(fen: string, uci: string): ApplyResult {
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch {
    return { ok: false, error: "corrupt game position" };
  }

  if (classify(chess).status !== "active") {
    return { ok: false, error: "game is already over" };
  }

  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promotion = uci.length > 4 ? uci[4] : undefined;

  const legal = chess.moves({ verbose: true }) as Array<{
    from: string;
    to: string;
    promotion?: string;
  }>;
  const match = legal.find(
    (m) =>
      m.from === from &&
      m.to === to &&
      (promotion ? m.promotion === promotion : !m.promotion),
  );

  if (!match) {
    // Distinguish "you must choose a promotion piece" for a clearer message.
    const needsPromotion = legal.some(
      (m) => m.from === from && m.to === to && m.promotion,
    );
    return {
      ok: false,
      error: needsPromotion ? "promotion piece required" : "illegal move",
    };
  }

  const played = chess.move({ from, to, promotion });
  return {
    ok: true,
    san: played.san,
    position: { fen: chess.fen(), turn: chess.turn(), ...classify(chess) },
  };
}
