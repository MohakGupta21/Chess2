import { useEffect, useState } from "react";
import type { LeaderboardEntry } from "../shared";
import { api } from "../api/client";

interface Props {
  /** Change this (e.g. a counter) to force a re-fetch. */
  refreshKey?: number;
}

export function Leaderboard({ refreshKey = 0 }: Props) {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .leaderboard()
      .then((r) => !cancelled && setEntries(r.entries))
      .catch(() => !cancelled && setError(true));
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  return (
    <div className="card">
      <p className="status-sub" style={{ marginBottom: "0.5rem" }}>
        Leaderboard
      </p>
      {error && <span className="empty">Could not load the leaderboard.</span>}
      {!error && entries.length === 0 && (
        <span className="empty">No players yet.</span>
      )}
      <div className="leaderboard">
        {entries.map((e, i) => (
          <div key={i} className={e.isMe ? "lb-row me" : "lb-row"}>
            <span className="num">{i + 1}.</span>
            <span className="lb-email">{e.email}</span>
            <span className="lb-points">{e.points}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
