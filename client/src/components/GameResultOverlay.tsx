import { useMemo } from "react";
import { POINTS_WIN, POINTS_LOSS, type GameDTO } from "../shared";

type Outcome = "win" | "loss" | "draw";

const END_REASON_TEXT: Record<string, string> = {
  checkmate: "Checkmate",
  stalemate: "Stalemate",
  insufficient_material: "Insufficient material",
  threefold_repetition: "Threefold repetition",
  fifty_move_rule: "Fifty-move rule",
  resignation: "Resignation",
};

function outcomeOf(game: GameDTO): Outcome {
  if (game.result === "1/2-1/2") return "draw";
  const youWon =
    (game.result === "1-0" && game.userColor === "w") ||
    (game.result === "0-1" && game.userColor === "b");
  return youWon ? "win" : "loss";
}

const CONFETTI_COLORS = ["#2f9e6b", "#f2c14e", "#4f9df7", "#e8734a", "#a56cf0"];

function Confetti() {
  const pieces = useMemo(
    () =>
      Array.from({ length: 28 }, (_, i) => ({
        left: `${(i * 37) % 100}%`,
        delay: `${(i % 7) * 0.09}s`,
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      })),
    [],
  );
  return (
    <div className="confetti" aria-hidden="true">
      {pieces.map((p, i) => (
        <i
          key={i}
          style={{ left: p.left, animationDelay: p.delay, background: p.color }}
        />
      ))}
    </div>
  );
}

function TrophyGraphic() {
  return (
    <svg className="result-graphic" viewBox="0 0 120 120" role="img" aria-label="Trophy">
      <g className="rg-pop">
        <ellipse cx="60" cy="104" rx="30" ry="7" fill="#e4f5ec" />
        <path
          d="M40 30h40v14a20 20 0 0 1-40 0V30Z"
          fill="#f2c14e"
          stroke="#d9a938"
          strokeWidth="3"
        />
        <path
          d="M40 34H30a10 10 0 0 0 10 12M80 34h10a10 10 0 0 1-10 12"
          fill="none"
          stroke="#d9a938"
          strokeWidth="4"
          strokeLinecap="round"
        />
        <rect x="54" y="62" width="12" height="16" fill="#d9a938" />
        <rect x="42" y="78" width="36" height="10" rx="3" fill="#2f9e6b" />
        <rect x="47" y="88" width="26" height="8" rx="3" fill="#268a5c" />
        <path
          d="M52 40l4 6 10-12"
          fill="none"
          stroke="#fff"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}

function ToppledKingGraphic() {
  return (
    <svg className="result-graphic" viewBox="0 0 120 120" role="img" aria-label="Defeated king">
      <g className="rg-pop">
        <ellipse cx="60" cy="98" rx="34" ry="8" fill="#fdeceb" />
        <g transform="rotate(74 62 84)">
          <rect x="52" y="30" width="20" height="10" rx="3" fill="#c9d0dc" />
          <path d="M58 12h8v18h-8zM52 18h20v6H52z" fill="#c9d0dc" />
          <path
            d="M48 40h28l-4 40a10 10 0 0 1-20 0Z"
            fill="#d7dde7"
            stroke="#b7c0cd"
            strokeWidth="3"
          />
          <rect x="44" y="80" width="36" height="10" rx="3" fill="#b7c0cd" />
        </g>
      </g>
    </svg>
  );
}

function HandshakeGraphic() {
  return (
    <svg className="result-graphic" viewBox="0 0 120 120" role="img" aria-label="Draw">
      <g className="rg-pop">
        <ellipse cx="60" cy="96" rx="34" ry="8" fill="#eef2f8" />
        <circle cx="60" cy="52" r="30" fill="#eef2f8" stroke="#dbe2ec" strokeWidth="3" />
        <path
          d="M30 54l16-12 14 10 14-10 16 12-14 12-8-6-8 12-8-10-8 6-6-8"
          fill="#4f9df7"
        />
        <path
          d="M44 52l10 8 8-6 8 8 10-8"
          fill="none"
          stroke="#fff"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}

interface Props {
  game: GameDTO;
  onNewGame?: () => void;
  onLobby: () => void;
  onClose: () => void;
}

export function GameResultOverlay({ game, onNewGame, onLobby, onClose }: Props) {
  const outcome = outcomeOf(game);
  const headline =
    outcome === "win" ? "You win!" : outcome === "loss" ? "You lose" : "It's a draw";
  const reason = END_REASON_TEXT[game.endReason ?? ""] ?? "Game over";
  const pointsNote =
    game.mode !== "pvp"
      ? null
      : outcome === "draw"
        ? "No points change"
        : outcome === "win"
          ? `+${POINTS_WIN} points`
          : `−${POINTS_LOSS} points`;

  return (
    <div className="result-overlay" role="dialog" aria-modal="true" aria-label={headline}>
      <div className={`result-modal ${outcome}`}>
        {outcome === "win" && <Confetti />}
        <button className="close-x" onClick={onClose} aria-label="Close">
          ×
        </button>

        {outcome === "win" && <TrophyGraphic />}
        {outcome === "loss" && <ToppledKingGraphic />}
        {outcome === "draw" && <HandshakeGraphic />}

        <h2>{headline}</h2>
        <p className="reason">
          {reason}
          {game.result ? ` · ${game.result}` : ""}
        </p>
        {pointsNote && <p className="points">{pointsNote}</p>}

        <div className="result-actions">
          {onNewGame && (
            <button className="primary" onClick={onNewGame}>
              New game
            </button>
          )}
          <button onClick={onLobby}>Back to lobby</button>
        </div>
      </div>
    </div>
  );
}
