import { Chess, type Move } from "chess.js";
import { evaluateBoard } from "./evaluation";

/**
 * A self-contained negamax + alpha-beta search. Not Stockfish-strong, but with
 * piece-square tables, MVV-LVA ordering, principal-variation move ordering and a
 * time-bounded quiescence search it plays a solid game — enough for the MVP
 * when no real engine binary is vendored. See PLAN.md section 2: this sits
 * behind the same worker protocol as Stockfish so it can be swapped out.
 */

const MATE = 1_000_000;
const MAX_QUIESCE_PLY = 8;

const CAPTURE_VALUE: Record<string, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0,
};

function moveScore(m: Move): number {
  let s = 0;
  if (m.captured) s += 10 * CAPTURE_VALUE[m.captured] - CAPTURE_VALUE[m.piece];
  if (m.promotion) s += 8;
  if (m.san.includes("+")) s += 1;
  return s;
}

/**
 * Order moves best-first. `pvUci` (from a previous iterative-deepening pass) is
 * tried first when present.
 */
function orderMoves(moves: Move[], pvUci?: string): Move[] {
  return [...moves].sort((a, b) => {
    if (pvUci) {
      if (a.from + a.to + (a.promotion ?? "") === pvUci) return -1;
      if (b.from + b.to + (b.promotion ?? "") === pvUci) return 1;
    }
    return moveScore(b) - moveScore(a);
  });
}

interface SearchCtx {
  deadline: number;
  timedOut: boolean;
}

/**
 * Capture/promotion search to quieten the leaf. Time-bounded (checks the
 * deadline) and ply-capped so it can never run away — that was the real bug.
 */
function quiesce(
  chess: Chess,
  alpha: number,
  beta: number,
  sign: number,
  ply: number,
  ctx: SearchCtx,
): number {
  if (Date.now() > ctx.deadline) {
    ctx.timedOut = true;
    return sign * evaluateBoard(chess);
  }

  const standPat = sign * evaluateBoard(chess);
  if (standPat >= beta) return beta;
  if (standPat > alpha) alpha = standPat;
  if (ply >= MAX_QUIESCE_PLY) return alpha;

  const captures = (chess.moves({ verbose: true }) as Move[]).filter(
    (m) => m.captured || m.promotion,
  );
  for (const m of orderMoves(captures)) {
    chess.move(m);
    const val = -quiesce(chess, -beta, -alpha, -sign, ply + 1, ctx);
    chess.undo();
    if (ctx.timedOut) return alpha;
    if (val >= beta) return beta;
    if (val > alpha) alpha = val;
  }
  return alpha;
}

function negamax(
  chess: Chess,
  depth: number,
  alpha: number,
  beta: number,
  sign: number,
  ply: number,
  ctx: SearchCtx,
): number {
  if (Date.now() > ctx.deadline) {
    ctx.timedOut = true;
    return sign * evaluateBoard(chess);
  }

  const moves = chess.moves({ verbose: true }) as Move[];
  if (moves.length === 0) {
    if (chess.isCheck()) return -MATE + ply; // mated: worse the sooner
    return 0; // stalemate
  }
  if (depth === 0) return quiesce(chess, alpha, beta, sign, ply, ctx);

  let best = -Infinity;
  for (const m of orderMoves(moves)) {
    chess.move(m);
    const val = -negamax(chess, depth - 1, -beta, -alpha, -sign, ply + 1, ctx);
    chess.undo();
    if (ctx.timedOut) break;
    if (val > best) best = val;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

export interface BuiltinResult {
  uci: string;
  depth: number;
  scoreCp: number;
}

function toUci(m: Move): string {
  return m.from + m.to + (m.promotion ?? "");
}

/**
 * Pick a move for the side to move in `fen`. Iterative deepening until
 * `maxDepth` or `budgetMs` runs out; the best move from the deepest *completed*
 * iteration is returned (falling back to the ordered first move).
 */
export function builtinBestMove(
  fen: string,
  budgetMs = 1200,
  maxDepth = 4,
): BuiltinResult | null {
  const root = new Chess(fen);
  const rootMoves = root.moves({ verbose: true }) as Move[];
  if (rootMoves.length === 0) return null;

  const sign = root.turn() === "w" ? 1 : -1;
  const ctx: SearchCtx = { deadline: Date.now() + budgetMs, timedOut: false };

  let chosen = orderMoves(rootMoves)[0];
  let chosenScore = 0;
  let reachedDepth = 0;

  for (let depth = 1; depth <= maxDepth; depth++) {
    let localBest: Move | null = null;
    let localScore = -Infinity;
    let alpha = -Infinity;

    for (const m of orderMoves(rootMoves, toUci(chosen))) {
      root.move(m);
      const val = -negamax(root, depth - 1, -Infinity, -alpha, -sign, 1, ctx);
      root.undo();
      if (ctx.timedOut) break;
      if (val > localScore) {
        localScore = val;
        localBest = m;
      }
      if (val > alpha) alpha = val;
    }

    if (!ctx.timedOut && localBest) {
      chosen = localBest;
      chosenScore = localScore;
      reachedDepth = depth;
    }
    if (ctx.timedOut || Math.abs(localScore) > MATE - 1000) break;
  }

  return { uci: toUci(chosen), depth: reachedDepth, scoreCp: Math.round(chosenScore) };
}
