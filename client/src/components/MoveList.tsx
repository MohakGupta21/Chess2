interface Props {
  san: string[];
}

export function MoveList({ san }: Props) {
  const rows: Array<[number, string, string]> = [];
  for (let i = 0; i < san.length; i += 2) {
    rows.push([i / 2 + 1, san[i], san[i + 1] ?? ""]);
  }

  return (
    <div className="card">
      <p className="status-sub" style={{ marginBottom: "0.5rem" }}>
        Moves
      </p>
      <div className="move-list">
        {rows.length === 0 && <span className="empty">No moves yet.</span>}
        {rows.map(([n, white, black]) => (
          <div key={n} style={{ display: "contents" }}>
            <span className="num">{n}.</span>
            <span>{white}</span>
            <span>{black}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
