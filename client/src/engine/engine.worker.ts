/// <reference lib="webworker" />
import { builtinBestMove } from "./builtinEngine";

/**
 * Engine worker. Speaks a tiny request/response protocol so the UI thread
 * never blocks on search.
 *
 *   main -> worker : { id, type: "bestmove", fen, budgetMs?, maxDepth? }
 *   worker -> main : { id, type: "bestmove", uci, depth, scoreCp }   (uci null if no move)
 *   worker -> main : { id, type: "error", message }                  (search threw)
 *
 * Currently backed by the built-in negamax engine (builtinEngine.ts). To use a
 * stronger engine, replace the body of the handler with a UCI driver for a
 * vendored Stockfish build — the protocol above stays the same. See PLAN.md.
 */

interface BestMoveRequest {
  id: number;
  type: "bestmove";
  fen: string;
  budgetMs?: number;
  maxDepth?: number;
}

const post = (msg: unknown) => (self as unknown as Worker).postMessage(msg);

self.onmessage = (e: MessageEvent<BestMoveRequest>) => {
  const msg = e.data;
  if (!msg || msg.type !== "bestmove") return;

  try {
    const result = builtinBestMove(
      msg.fen,
      msg.budgetMs ?? 1500,
      msg.maxDepth ?? 4,
    );
    post({
      id: msg.id,
      type: "bestmove",
      uci: result?.uci ?? null,
      depth: result?.depth ?? 0,
      scoreCp: result?.scoreCp ?? 0,
    });
  } catch (err) {
    post({
      id: msg.id,
      type: "error",
      message: err instanceof Error ? err.message : "engine search failed",
    });
  }
};
