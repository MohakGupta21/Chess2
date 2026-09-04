import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useGame } from "../hooks/useGame";
import { BoardView } from "../components/BoardView";
import { GameStatusBar } from "../components/GameStatusBar";
import { MoveList } from "../components/MoveList";

export function Play() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const {
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
  } = useGame();

  async function handleSignOut() {
    try {
      await signOut();
    } finally {
      navigate("/signin", { replace: true });
    }
  }

  const boardDisabled =
    !game ||
    game.status !== "active" ||
    game.turn !== game.userColor ||
    engineThinking ||
    engineFailed;

  return (
    <div className="play-wrap">
      <div className="topbar">
        <span className="brand">♞ Chess</span>
        <span>
          <button onClick={() => navigate("/")}>Lobby</button>
          <span className="who">{user?.email}</span>
          <span className="points-pill">{user?.points ?? 0} pts</span>
          <button onClick={handleSignOut}>Sign out</button>
        </span>
      </div>

      {loading && <div className="center-msg">Setting up the board…</div>}

      {!loading && !game && !error && <Navigate to="/" replace />}

      {!loading && error && !game && (
        <div className="center-msg">
          <div>
            <p>{error}</p>
            <button className="primary" onClick={() => void newGame()}>
              Start a new game
            </button>
          </div>
        </div>
      )}

      {!loading && game && (
        <div className="board-layout">
          <div className="board-col">
            <BoardView
              game={game}
              disabled={boardDisabled}
              legalTargets={legalTargets}
              onMove={(from, to, promotion) =>
                void playUserMove(from, to, promotion)
              }
            />
          </div>

          <div className="side-col">
            <GameStatusBar game={game} engineThinking={engineThinking} />

            {error && (
              <div className="form-error">
                {error}
                {engineFailed && (
                  <button
                    className="primary"
                    style={{ marginTop: "0.5rem", width: "100%" }}
                    onClick={retryEngineMove}
                  >
                    Retry computer move
                  </button>
                )}
              </div>
            )}

            <div className="card">
              <div className="actions">
                {game.mode === "ai" && (
                  <button className="primary" onClick={() => void newGame()}>
                    New game
                  </button>
                )}
                <button onClick={() => navigate("/")}>Back to lobby</button>
                {game.status === "active" && (
                  <button className="danger" onClick={() => void resign()}>
                    Resign
                  </button>
                )}
              </div>
            </div>

            <MoveList san={game.san} />
          </div>
        </div>
      )}
    </div>
  );
}
