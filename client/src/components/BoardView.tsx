import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Chessboard } from "react-chessboard";
import { Chess, type Square } from "chess.js";
import type { GameDTO } from "../shared";

interface Props {
  game: GameDTO;
  disabled: boolean;
  legalTargets: (square: string) => string[];
  onMove: (from: string, to: string, promotion?: string) => void;
}

const PROMO_PIECES = [
  { code: "q", label: "Queen" },
  { code: "r", label: "Rook" },
  { code: "b", label: "Bishop" },
  { code: "n", label: "Knight" },
] as const;

function isPromotion(fen: string, from: string, to: string): boolean {
  const chess = new Chess(fen);
  const piece = chess.get(from as Square);
  if (!piece || piece.type !== "p") return false;
  const rank = to[1];
  return (
    (piece.color === "w" && rank === "8") ||
    (piece.color === "b" && rank === "1")
  );
}

export function BoardView({ game, disabled, legalTargets, onMove }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [pendingPromo, setPendingPromo] = useState<{
    from: string;
    to: string;
  } | null>(null);
  const firstPromoBtn = useRef<HTMLButtonElement>(null);

  const orientation = game.userColor === "w" ? "white" : "black";

  // Drop any in-progress selection / promotion when the game changes.
  useEffect(() => {
    setSelected(null);
    setPendingPromo(null);
  }, [game.id]);

  // Focus the promotion dialog and let Escape cancel it.
  useEffect(() => {
    if (!pendingPromo) return;
    firstPromoBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPendingPromo(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pendingPromo]);

  const highlightStyles = useMemo(() => {
    if (!selected) return {};
    const styles: Record<string, CSSProperties> = {
      [selected]: { background: "rgba(108, 158, 95, 0.45)" },
    };
    for (const sq of legalTargets(selected)) {
      styles[sq] = {
        background:
          "radial-gradient(circle, rgba(108,158,95,0.55) 22%, transparent 24%)",
      };
    }
    return styles;
  }, [selected, legalTargets]);

  function attempt(from: string, to: string): boolean {
    if (disabled) return false;
    if (!legalTargets(from).includes(to)) return false;
    if (isPromotion(game.fen, from, to)) {
      setPendingPromo({ from, to });
      setSelected(null);
      return false; // wait for the piece choice
    }
    onMove(from, to);
    setSelected(null);
    return true;
  }

  function onSquareClick(square: string) {
    if (disabled) return;
    if (selected) {
      if (square === selected) {
        setSelected(null);
        return;
      }
      if (legalTargets(selected).includes(square)) {
        attempt(selected, square);
        return;
      }
    }
    // Select only own pieces whose side is to move.
    const chess = new Chess(game.fen);
    const piece = chess.get(square as Square);
    setSelected(piece && piece.color === game.userColor ? square : null);
  }

  return (
    <div style={{ position: "relative" }}>
      <Chessboard
        position={game.fen}
        boardOrientation={orientation}
        arePiecesDraggable={!disabled}
        onPieceDrop={(from, to) => attempt(from, to)}
        onSquareClick={onSquareClick}
        customSquareStyles={highlightStyles}
        customBoardStyle={{
          borderRadius: "8px",
          boxShadow: "0 6px 24px rgba(0,0,0,0.4)",
        }}
        customDarkSquareStyle={{ backgroundColor: "#6f7f8c" }}
        customLightSquareStyle={{ backgroundColor: "#c7cfd6" }}
      />

      {pendingPromo && (
        <div
          className="promo-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Choose promotion piece"
        >
          <div className="promo-card">
            <p>Promote to</p>
            <div className="promo-buttons">
              {PROMO_PIECES.map((p, i) => (
                <button
                  key={p.code}
                  ref={i === 0 ? firstPromoBtn : undefined}
                  onClick={() => {
                    onMove(pendingPromo.from, pendingPromo.to, p.code);
                    setPendingPromo(null);
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <button
              className="promo-cancel"
              onClick={() => setPendingPromo(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
