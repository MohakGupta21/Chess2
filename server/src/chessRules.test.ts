import { describe, expect, it } from "vitest";
import { applyUciMove, positionFromFen } from "./chessRules.js";
import { START_FEN } from "./shared.js";

describe("piece movement & turn order (RULES.md 2, 3)", () => {
  it("accepts a legal opening pawn double-step", () => {
    const r = applyUciMove(START_FEN, "e2e4");
    expect(r.ok).toBe(true);
    expect(r.san).toBe("e4");
    expect(r.position!.turn).toBe("b");
  });

  it("rejects moving a piece that is not yours", () => {
    // White to move, try to move a black pawn.
    const r = applyUciMove(START_FEN, "e7e5");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("illegal move");
  });

  it("rejects a rook jumping over its own pawn", () => {
    const r = applyUciMove(START_FEN, "a1a3");
    expect(r.ok).toBe(false);
  });
});

describe("castling — five conditions (RULES.md 5)", () => {
  it("allows kingside castling when all conditions hold", () => {
    const fen = "r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1";
    const r = applyUciMove(fen, "e1g1");
    expect(r.ok).toBe(true);
    expect(r.san).toBe("O-O");
  });

  it("forbids castling through an attacked square", () => {
    // Black rook on f8 attacks f1 down a clear file -> king would pass
    // through check.
    const fen = "r4rk1/ppppp1pp/8/8/8/8/PPPP2PP/R3K2R w KQ - 0 1";
    const r = applyUciMove(fen, "e1g1");
    expect(r.ok).toBe(false);
  });

  it("forbids castling out of check", () => {
    // Black rook on e8 gives check along the e-file.
    const fen = "4r1k1/pppp1ppp/8/8/8/8/PPPP1PPP/R3K2R w KQ - 0 1";
    const r = applyUciMove(fen, "e1g1");
    expect(r.ok).toBe(false);
  });

  it("forbids castling after the king has moved (no rights in FEN)", () => {
    const fen = "r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w - - 0 1";
    const r = applyUciMove(fen, "e1g1");
    expect(r.ok).toBe(false);
  });
});

describe("en passant window (RULES.md 6)", () => {
  it("allows en passant immediately after the double-step", () => {
    const fen = "rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3";
    const r = applyUciMove(fen, "e5f6");
    expect(r.ok).toBe(true);
    expect(r.san).toBe("exf6");
  });

  it("disallows en passant when the target square is not set in the FEN", () => {
    const fen = "rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq - 0 3";
    const r = applyUciMove(fen, "e5f6");
    expect(r.ok).toBe(false);
  });
});

describe("promotion (RULES.md 7)", () => {
  it("requires a promotion piece for a pawn reaching the last rank", () => {
    const fen = "8/P6k/8/8/8/8/7K/8 w - - 0 1";
    const missing = applyUciMove(fen, "a7a8");
    expect(missing.ok).toBe(false);
    expect(missing.error).toBe("promotion piece required");
  });

  it("allows under-promotion to a knight", () => {
    const fen = "8/P6k/8/8/8/8/7K/8 w - - 0 1";
    const r = applyUciMove(fen, "a7a8n");
    expect(r.ok).toBe(true);
    expect(r.san).toBe("a8=N");
  });
});

describe("check & pins (RULES.md 8)", () => {
  it("rejects a move that leaves your own king in check (pinned piece)", () => {
    // White bishop on e2 is pinned by the black rook on e8.
    const fen = "4r1k1/8/8/8/8/8/4B3/4K3 w - - 0 1";
    const r = applyUciMove(fen, "e2b5");
    expect(r.ok).toBe(false);
  });

  it("reports the side to move as in check", () => {
    // Bishop on b5 checks the black king on e8; Black can block or step aside.
    const fen =
      "rnbqkbnr/ppp2ppp/8/1B1pp3/4P3/8/PPPP1PPP/RNBQK1NR b KQkq - 1 3";
    const pos = positionFromFen(fen);
    expect(pos.inCheck).toBe(true);
    expect(pos.status).toBe("active");
  });
});

describe("game end (RULES.md 9)", () => {
  it("detects checkmate and awards the win", () => {
    // Fool's mate: 1. f3 e5 2. g4 Qh4#
    let fen = START_FEN;
    for (const uci of ["f2f3", "e7e5", "g2g4", "d8h4"]) {
      const r = applyUciMove(fen, uci);
      expect(r.ok).toBe(true);
      fen = r.position!.fen;
    }
    const pos = positionFromFen(fen);
    expect(pos.status).toBe("checkmate");
    expect(pos.result).toBe("0-1");
    expect(pos.endReason).toBe("checkmate");
  });

  it("detects stalemate as a draw", () => {
    const fen = "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1";
    const pos = positionFromFen(fen);
    expect(pos.status).toBe("stalemate");
    expect(pos.result).toBe("1/2-1/2");
  });

  it("detects insufficient material (K+B vs K)", () => {
    const pos = positionFromFen("8/8/8/4k3/8/8/4KB2/8 w - - 0 1");
    expect(pos.status).toBe("draw");
    expect(pos.endReason).toBe("insufficient_material");
  });

  it("detects the fifty-move rule from the halfmove clock", () => {
    const pos = positionFromFen("7k/8/8/8/8/8/8/R6K w - - 100 80");
    expect(pos.status).toBe("draw");
    expect(pos.endReason).toBe("fifty_move_rule");
  });

  it("refuses further moves once the game is over", () => {
    const mate = "7k/6Q1/5K2/8/8/8/8/8 b - - 0 1"; // black is checkmated
    const r = applyUciMove(mate, "h8h7");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("game is already over");
  });
});
