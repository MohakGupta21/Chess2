import { useCallback, useEffect, useRef, useState } from "react";
import type { ChallengeDTO } from "../shared";
import { api } from "../api/client";

const POLL_MS = 3000;

const errMsg = (e: unknown, fallback: string) =>
  e instanceof Error ? e.message : fallback;

export interface UseChallenges {
  incoming: ChallengeDTO[];
  outgoing: ChallengeDTO[];
  error: string | null;
  /** Set to a game id once one of our challenges turns into a game to join. */
  readyGameId: string | null;
  createChallenge: (email: string) => Promise<void>;
  accept: (id: string) => Promise<string | null>;
  decline: (id: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
}

export function useChallenges(): UseChallenges {
  const [incoming, setIncoming] = useState<ChallengeDTO[]>([]);
  const [outgoing, setOutgoing] = useState<ChallengeDTO[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [readyGameId, setReadyGameId] = useState<string | null>(null);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const { incoming, outgoing } = await api.challenges();
      setIncoming(incoming);
      setOutgoing(outgoing);
      // An outgoing challenge the opponent accepted -> jump into that game.
      const accepted = outgoing.find(
        (c) => c.status === "accepted" && c.gameId,
      );
      if (accepted?.gameId) setReadyGameId(accepted.gameId);
    } catch (e) {
      setError(errMsg(e, "could not load challenges"));
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const h = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(h);
  }, [refresh]);

  const createChallenge = useCallback(
    async (email: string) => {
      setError(null);
      try {
        await api.createChallenge(email.trim().toLowerCase());
        await refresh();
      } catch (e) {
        setError(errMsg(e, "could not send the challenge"));
      }
    },
    [refresh],
  );

  const accept = useCallback(async (id: string): Promise<string | null> => {
    setError(null);
    try {
      const { game } = await api.acceptChallenge(id);
      return game.id;
    } catch (e) {
      setError(errMsg(e, "could not accept the challenge"));
      return null;
    }
  }, []);

  const decline = useCallback(
    async (id: string) => {
      setError(null);
      try {
        await api.declineChallenge(id);
        await refresh();
      } catch (e) {
        setError(errMsg(e, "could not decline the challenge"));
      }
    },
    [refresh],
  );

  const cancel = useCallback(
    async (id: string) => {
      setError(null);
      try {
        await api.cancelChallenge(id);
        await refresh();
      } catch (e) {
        setError(errMsg(e, "could not cancel the challenge"));
      }
    },
    [refresh],
  );

  return {
    incoming,
    outgoing,
    error,
    readyGameId,
    createChallenge,
    accept,
    decline,
    cancel,
  };
}
