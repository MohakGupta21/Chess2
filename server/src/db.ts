import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { config } from "./config.js";

function open(): Database.Database {
  if (config.dbPath !== ":memory:") {
    mkdirSync(dirname(config.dbPath), { recursive: true });
  }
  const db = new Database(config.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

export const db = open();

/** UTC ISO-8601 with milliseconds and a trailing "Z". */
export const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    points        INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (${NOW_SQL})
  );

  CREATE TABLE IF NOT EXISTS games (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_color     TEXT NOT NULL CHECK (user_color IN ('w','b')),
    -- "ai": solo vs the engine. "pvp": account vs account, players in
    -- white_user_id / black_user_id (user_id stays the creator).
    mode           TEXT NOT NULL DEFAULT 'ai' CHECK (mode IN ('ai','pvp')),
    white_user_id  TEXT REFERENCES users(id) ON DELETE CASCADE,
    black_user_id  TEXT REFERENCES users(id) ON DELETE CASCADE,
    -- 1 once a terminal pvp result has moved points, so it never doubles.
    points_applied INTEGER NOT NULL DEFAULT 0,
    fen            TEXT NOT NULL,
    moves          TEXT NOT NULL DEFAULT '[]',
    san            TEXT NOT NULL DEFAULT '[]',
    -- position-repetition counts, keyed by the first four FEN fields
    rep_counts     TEXT NOT NULL DEFAULT '{}',
    status         TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','checkmate','stalemate','draw','resigned','abandoned')),
    result         TEXT CHECK (result IN ('1-0','0-1','1/2-1/2')),
    end_reason     TEXT,
    created_at     TEXT NOT NULL DEFAULT (${NOW_SQL}),
    updated_at     TEXT NOT NULL DEFAULT (${NOW_SQL})
  );

  -- At most one active game keyed on the creator column (AI-mode backstop;
  -- pvp joiner uniqueness is enforced in the challenge-accept transaction).
  CREATE UNIQUE INDEX IF NOT EXISTS idx_games_one_active
    ON games(user_id) WHERE status = 'active';

  CREATE TABLE IF NOT EXISTS challenges (
    id           TEXT PRIMARY KEY,
    from_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','accepted','declined','cancelled')),
    game_id      TEXT REFERENCES games(id) ON DELETE SET NULL,
    created_at   TEXT NOT NULL DEFAULT (${NOW_SQL}),
    updated_at   TEXT NOT NULL DEFAULT (${NOW_SQL})
  );

  CREATE INDEX IF NOT EXISTS idx_challenges_to
    ON challenges(to_user_id, status);
  CREATE INDEX IF NOT EXISTS idx_challenges_from
    ON challenges(from_user_id, status);
`);

/**
 * Bring an existing on-disk DB (created before multiplayer) up to the schema
 * above. `CREATE TABLE IF NOT EXISTS` never adds columns to a table that is
 * already there, so the new `games` / `users` columns need explicit ALTERs.
 * Fresh DBs (including `:memory:` tests) already have them and skip this.
 */
function addColumnIfMissing(table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${decl}`);
  }
}

addColumnIfMissing("users", "points", "points INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing(
  "games",
  "mode",
  "mode TEXT NOT NULL DEFAULT 'ai' CHECK (mode IN ('ai','pvp'))",
);
addColumnIfMissing(
  "games",
  "white_user_id",
  "white_user_id TEXT REFERENCES users(id) ON DELETE CASCADE",
);
addColumnIfMissing(
  "games",
  "black_user_id",
  "black_user_id TEXT REFERENCES users(id) ON DELETE CASCADE",
);
addColumnIfMissing(
  "games",
  "points_applied",
  "points_applied INTEGER NOT NULL DEFAULT 0",
);

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  points: number;
  created_at: string;
}

export interface GameRow {
  id: string;
  user_id: string;
  user_color: "w" | "b";
  mode: "ai" | "pvp";
  white_user_id: string | null;
  black_user_id: string | null;
  points_applied: number;
  fen: string;
  moves: string;
  san: string;
  rep_counts: string;
  status: string;
  result: string | null;
  end_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChallengeRow {
  id: string;
  from_user_id: string;
  to_user_id: string;
  status: "pending" | "accepted" | "declined" | "cancelled";
  game_id: string | null;
  created_at: string;
  updated_at: string;
}
