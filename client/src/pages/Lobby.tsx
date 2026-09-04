import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { api } from "../api/client";
import { ChallengePanel } from "../components/ChallengePanel";
import { Leaderboard } from "../components/Leaderboard";

export function Lobby() {
  const { user, signOut, refreshUser } = useAuth();
  const navigate = useNavigate();
  const [hasActiveGame, setHasActiveGame] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep points fresh (a game finished elsewhere) and know whether to offer
  // "Resume game".
  useEffect(() => {
    void refreshUser();
    api
      .currentGame()
      .then(() => setHasActiveGame(true))
      .catch(() => setHasActiveGame(false));
  }, [refreshUser]);

  const enterGame = useCallback(
    (_gameId: string) => navigate("/play"),
    [navigate],
  );

  async function playComputer() {
    setBusy(true);
    setError(null);
    try {
      await api.newGame("ai");
      navigate("/play");
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not start a game");
      setBusy(false);
    }
  }

  async function handleSignOut() {
    try {
      await signOut();
    } finally {
      navigate("/signin", { replace: true });
    }
  }

  return (
    <div className="play-wrap">
      <div className="topbar">
        <span className="brand">♞ Chess</span>
        <span>
          <span className="who">{user?.email}</span>
          <span className="points-pill">{user?.points ?? 0} pts</span>
          <button onClick={handleSignOut}>Sign out</button>
        </span>
      </div>

      <div className="lobby-layout">
        <div className="lobby-col">
          <div className="card">
            <p className="status-sub" style={{ marginBottom: "0.5rem" }}>
              Play vs. Computer
            </p>
            <p className="status-sub">
              A quick game against the built-in engine.
            </p>
            <div className="actions" style={{ marginTop: "0.75rem" }}>
              <button
                className="primary"
                onClick={() => void playComputer()}
                disabled={busy}
              >
                {busy ? "Starting…" : "New game vs. Computer"}
              </button>
            </div>
            {error && <div className="form-error">{error}</div>}
          </div>

          {hasActiveGame && (
            <div className="card">
              <p className="status-line">You have a game in progress.</p>
              <div className="actions" style={{ marginTop: "0.5rem" }}>
                <button className="primary" onClick={() => navigate("/play")}>
                  Resume game
                </button>
              </div>
            </div>
          )}

          <ChallengePanel onEnterGame={enterGame} />
        </div>

        <div className="lobby-col">
          <Leaderboard meEmail={user?.email} />
        </div>
      </div>
    </div>
  );
}
