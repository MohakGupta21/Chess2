import { POINTS_WIN, POINTS_LOSS, type Color, type GameDTO } from "../shared";

const COLOR_NAME: Record<Color, string> = { w: "White", b: "Black" };

const END_REASON_TEXT: Record<string, string> = {
  checkmate: "Checkmate",
  stalemate: "Stalemate — draw",
  insufficient_material: "Insufficient material — draw",
  threefold_repetition: "Threefold repetition — draw",
  fifty_move_rule: "Fifty-move rule — draw",
  resignation: "Resignation",
};

interface Props {
  game: GameDTO;
  engineThinking: boolean;
}

function opponentLabel(game: GameDTO): string {
  return game.mode === "pvp" && game.opponent
    ? `vs. ${game.opponent.email}`
    : "vs. Computer";
}

export function GameStatusBar({ game, engineThinking }: Props) {
  const youAre = COLOR_NAME[game.userColor];

  if (game.status === "abandoned") {
    return (
      <div className="result-banner">
        <h3>Game set aside</h3>
        <p>A newer game replaced this one.</p>
      </div>
    );
  }

  if (game.status !== "active") {
    const youWon =
      (game.result === "1-0" && game.userColor === "w") ||
      (game.result === "0-1" && game.userColor === "b");
    const draw = game.result === "1/2-1/2";
    const headline = draw ? "Draw" : youWon ? "You win" : "You lose";
    const pointsNote =
      game.mode !== "pvp"
        ? null
        : draw
          ? "No points change"
          : youWon
            ? `+${POINTS_WIN} points`
            : `−${POINTS_LOSS} points`;
    return (
      <div className={`result-banner ${!draw && !youWon ? "loss" : ""}`}>
        <h3>{headline}</h3>
        <p>
          {END_REASON_TEXT[game.endReason ?? ""] ?? "Game over"}
          {game.result ? ` · ${game.result}` : ""}
        </p>
        {pointsNote && <p className="points-note">{pointsNote}</p>}
      </div>
    );
  }

  const yourTurn = game.turn === game.userColor;
  const waitingLabel =
    game.mode === "pvp" ? "Waiting for opponent…" : "Computer to move";
  return (
    <div className="card">
      <p className="status-line">
        {yourTurn ? "Your move" : waitingLabel}
        {game.inCheck && <span className="badge check">Check</span>}
        {engineThinking && <span className="badge thinking">thinking…</span>}
      </p>
      <p className="status-sub">
        {opponentLabel(game)} · you are {youAre}. {COLOR_NAME[game.turn]} to play ·
        move {Math.floor(game.moves.length / 2) + 1}
      </p>
    </div>
  );
}
