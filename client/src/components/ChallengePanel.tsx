import { useEffect, useState, type FormEvent } from "react";
import { useChallenges } from "../hooks/useChallenges";

interface Props {
  /** Called with the game id when a challenge becomes a playable game. */
  onEnterGame: (gameId: string) => void;
}

export function ChallengePanel({ onEnterGame }: Props) {
  const {
    incoming,
    outgoing,
    error,
    readyGameId,
    createChallenge,
    accept,
    decline,
    cancel,
  } = useChallenges();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  // The opponent accepted one of our challenges — join the game.
  useEffect(() => {
    if (readyGameId) onEnterGame(readyGameId);
  }, [readyGameId, onEnterGame]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!email.trim() || busy) return;
    setBusy(true);
    await createChallenge(email);
    setBusy(false);
    setEmail("");
  }

  async function onAccept(id: string) {
    const gameId = await accept(id);
    if (gameId) onEnterGame(gameId);
  }

  const pendingIn = incoming.filter((c) => c.status === "pending");
  const pendingOut = outgoing.filter((c) => c.status === "pending");

  return (
    <div className="card">
      <p className="status-sub" style={{ marginBottom: "0.5rem" }}>
        Play vs. Player
      </p>

      <form onSubmit={onSubmit} className="challenge-form">
        <input
          type="email"
          placeholder="opponent's account email"
          autoComplete="off"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "Sending…" : "Challenge"}
        </button>
      </form>

      {error && <div className="form-error">{error}</div>}

      {pendingIn.length > 0 && (
        <>
          <p className="status-sub" style={{ margin: "0.75rem 0 0.35rem" }}>
            Incoming
          </p>
          {pendingIn.map((c) => (
            <div key={c.id} className="challenge-row">
              <span className="who">{c.from.email}</span>
              <span className="challenge-actions">
                <button className="primary" onClick={() => void onAccept(c.id)}>
                  Accept
                </button>
                <button onClick={() => void decline(c.id)}>Decline</button>
              </span>
            </div>
          ))}
        </>
      )}

      {pendingOut.length > 0 && (
        <>
          <p className="status-sub" style={{ margin: "0.75rem 0 0.35rem" }}>
            Waiting for
          </p>
          {pendingOut.map((c) => (
            <div key={c.id} className="challenge-row">
              <span className="who">{c.to.email}</span>
              <span className="challenge-actions">
                <span className="badge thinking">pending…</span>
                <button onClick={() => void cancel(c.id)}>Cancel</button>
              </span>
            </div>
          ))}
        </>
      )}

      {pendingIn.length === 0 && pendingOut.length === 0 && (
        <span className="empty">
          Enter another player's email to challenge them.
        </span>
      )}
    </div>
  );
}
