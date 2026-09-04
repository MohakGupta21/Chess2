import { useCallback, useEffect, useRef, useState } from "react";

interface EngineReply {
  id: number;
  type: "bestmove" | "error";
  uci?: string | null;
  depth?: number;
  scoreCp?: number;
  message?: string;
}

export interface BestMoveOptions {
  budgetMs?: number;
  maxDepth?: number;
}

interface PendingEntry {
  resolve: (uci: string | null) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Wraps the engine Web Worker. `getBestMove` resolves with a UCI move for the
 * side to move in `fen`, or null if there is no legal move, and **rejects** if
 * the worker errors or does not answer within `budgetMs + 5s`. `thinking` is
 * true while at least one search is in flight.
 */
export function useEngine() {
  const workerRef = useRef<Worker | null>(null);
  const pending = useRef(new Map<number, PendingEntry>());
  const nextId = useRef(1);
  const [inFlight, setInFlight] = useState(0);

  const settle = useCallback(
    (id: number, fn: (e: PendingEntry) => void) => {
      const entry = pending.current.get(id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.current.delete(id);
      setInFlight((n) => Math.max(0, n - 1));
      fn(entry);
    },
    [],
  );

  const failAll = useCallback(
    (reason: string) => {
      for (const id of [...pending.current.keys()]) {
        settle(id, (e) => e.reject(new Error(reason)));
      }
    },
    [settle],
  );

  const spawn = useCallback(() => {
    const worker = new Worker(
      new URL("../engine/engine.worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.onmessage = (e: MessageEvent<EngineReply>) => {
      const { id, type } = e.data;
      if (type === "error") {
        settle(id, (entry) =>
          entry.reject(new Error(e.data.message ?? "engine error")),
        );
      } else {
        settle(id, (entry) => entry.resolve(e.data.uci ?? null));
      }
    };
    worker.onerror = () => {
      failAll("engine worker crashed");
      // Replace the dead worker so the next request has a fresh one.
      worker.terminate();
      workerRef.current = spawn();
    };
    return worker;
  }, [failAll, settle]);

  useEffect(() => {
    workerRef.current = spawn();
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
      failAll("component unmounted");
    };
  }, [spawn, failAll]);

  const getBestMove = useCallback(
    (fen: string, opts: BestMoveOptions = {}): Promise<string | null> => {
      const worker = workerRef.current;
      if (!worker) return Promise.reject(new Error("engine not ready"));
      const id = nextId.current++;
      const budgetMs = opts.budgetMs ?? 1500;
      setInFlight((n) => n + 1);
      return new Promise<string | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          settle(id, (e) => e.reject(new Error("engine timed out")));
        }, budgetMs + 5000);
        pending.current.set(id, { resolve, reject, timer });
        worker.postMessage({
          id,
          type: "bestmove",
          fen,
          budgetMs,
          maxDepth: opts.maxDepth,
        });
      });
    },
    [settle],
  );

  return { getBestMove, thinking: inFlight > 0 };
}
