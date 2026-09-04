import { useCallback, useEffect, useRef, useState } from "react";
import { Chess, type Square } from "chess.js";
import type { GameDTO } from "../shared";
import { api, ApiError } from "../api/client";
import { useEngine } from "./useEngine";
import { useAuth } from "./useAuth";

/** How often a pvp client re-fetches to pick up the opponent's move. */
const PVP_POLL_MS = 1500;

export interface UseGame {
  game: GameDTO | null;
  loading: boolean;
  error: string | null;
  /** True while the engine is choosing its reply. */
  engineThinking: boolean;
  /** Set when the engine's reply failed; `retryEngineMove` clears it. */
  engineFailed: boolean;
  /** Legal destination squares for a piece, for board highlights. */
  legalTargets: (square: string) => string[];
  /** Attempt a move for the human player. Returns true if it was legal. */
  playUserMove: (from: string, to: string, promotion?: string) => Promise<boolean>;
  newGame: () => Promise<void>;
  resign: () => Promise<void>;
  retryEngineMove: () => void;
}

function isEnginesTurn(g: GameDTO): boolean {
  return (
    g.mode === "ai" && g.status === "active" && g.turn !== g.userColor
  );
}

const errMsg = (e: unknown, fallback: string) =>
  e instanceof Error ? e.message : fallback;

export function useGame(): UseGame {
  const [game, setGame] = useState<GameDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [engineFailed, setEngineFailed] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const { getBestMove, thinking: engineThinking } = useEngine();
  const { refreshUser } = useAuth();

  // Latest game, readable from the polling interval without re-subscribing it.
  const gameRef = useRef<GameDTO | null>(null);
  gameRef.current = game;
  // Last status we reacted to, so a pvp game ending refreshes points once.
  const lastStatusRef = useRef<string | null>(null);

  // Guards a single engine reply per position. Safe as the sole guard because
  // the full-move counter makes every FEN string unique within one game; it is
  // also cleared once the reply lands and on newGame / retry.
  const engineWorkingOn = useRef<string | null>(null);
  // Prevents overlapping load() runs (e.g. React StrictMode double effect).
  const loadingRef = useRef(false);

  const load = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const { game } = await api.currentGame();
      setGame(game);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        // No active game — the Play page sends the user back to the lobby.
        setGame(null);
      } else {
        setError(errMsg(e, "failed to load game"));
      }
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Drive the engine whenever it is its turn.
  useEffect(() => {
    if (!game || !isEnginesTurn(game)) return;
    if (engineWorkingOn.current === game.fen) return;
    engineWorkingOn.current = game.fen;

    let cancelled = false;
    (async () => {
      try {
        const uci = await getBestMove(game.fen, { budgetMs: 1500, maxDepth: 4 });
        if (cancelled) return;
        if (!uci) return; // no legal move; server already has the terminal state
        const { game: updated } = await api.move(game.id, uci);
        if (cancelled) return;
        engineWorkingOn.current = updated.fen;
        setEngineFailed(false);
        setError(null);
        setGame(updated);
      } catch (e) {
        if (cancelled) return;
        engineWorkingOn.current = null; // allow a retry of this position
        setEngineFailed(true);
        setError(errMsg(e, "the computer could not make its move"));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [game, getBestMove, retryNonce]);

  // In a pvp game, poll for the opponent's move (and for the game ending).
  useEffect(() => {
    if (game?.mode !== "pvp" || game.status !== "active") return;
    let cancelled = false;
    const tick = async () => {
      try {
        const cur = gameRef.current;
        if (!cur) return;
        const { game: fresh } = await api.game(cur.id);
        if (cancelled || fresh.id !== gameRef.current?.id) return;
        if (
          fresh.updatedAt > gameRef.current.updatedAt ||
          fresh.status !== gameRef.current.status
        ) {
          setGame(fresh);
        }
      } catch {
        /* transient network error; the next tick retries */
      }
    };
    const handle = window.setInterval(tick, PVP_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [game?.id, game?.mode, game?.status, game?.updatedAt]);

  // When a pvp game finishes, the players' point totals have changed.
  useEffect(() => {
    if (!game) return;
    const prev = lastStatusRef.current;
    lastStatusRef.current = game.status;
    if (
      game.mode === "pvp" &&
      game.status !== "active" &&
      prev !== game.status
    ) {
      void refreshUser();
    }
  }, [game, refreshUser]);

  const legalTargets = useCallback(
    (square: string): string[] => {
      if (!game || game.status !== "active" || game.turn !== game.userColor) {
        return [];
      }
      const chess = new Chess(game.fen);
      return (
        chess.moves({ square: square as Square, verbose: true }) as Array<{
          to: string;
        }>
      ).map((m) => m.to);
    },
    [game],
  );

  const playUserMove = useCallback(
    async (from: string, to: string, promotion?: string): Promise<boolean> => {
      if (!game || game.status !== "active" || game.turn !== game.userColor) {
        return false;
      }
      // Validate locally first for instant rejection / no server round-trip.
      const probe = new Chess(game.fen);
      try {
        if (!probe.move({ from: from as Square, to: to as Square, promotion })) {
          return false;
        }
      } catch {
        return false;
      }

      const uci = from + to + (promotion ?? "");
      try {
        const { game: updated } = await api.move(game.id, uci);
        setError(null);
        setGame(updated);
        return true;
      } catch (e) {
        setError(errMsg(e, "move rejected"));
        void load(); // re-sync with the server's authoritative state
        return false;
      }
    },
    [game, load],
  );

  const newGame = useCallback(async () => {
    setError(null);
    setEngineFailed(false);
    engineWorkingOn.current = null;
    try {
      const { game } = await api.newGame();
      setGame(game);
    } catch (e) {
      setError(errMsg(e, "could not start a new game"));
    }
  }, []);

  const resign = useCallback(async () => {
    if (!game) return;
    try {
      const { game: updated } = await api.resign(game.id);
      setGame(updated);
    } catch (e) {
      setError(errMsg(e, "could not resign"));
    }
  }, [game]);

  const retryEngineMove = useCallback(() => {
    engineWorkingOn.current = null;
    setEngineFailed(false);
    setError(null);
    setRetryNonce((n) => n + 1);
  }, []);

  return {
    game,
    loading,
    error,
    engineThinking,
    engineFailed,
    legalTargets,
    playUserMove,
    newGame,
    resign,
    retryEngineMove,
  };
}
