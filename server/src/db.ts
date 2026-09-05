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
  // Wait up to 5s for a lock instead of throwing SQLITE_BUSY immediately, in
  // case a second process (a backup tool, the sqlite3 CLI) is also connected.
  db.pragma("busy_timeout = 5000");
  return db;
}

export const db = open();

/** UTC ISO-8601 with milliseconds and a trailing "Z". */
export const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/**
 * DDL for the `games` table. Factored out so the initial `CREATE TABLE` and the
 * migration rebuild (below) stay byte-identical — SQLite can only change a
 * `CHECK` constraint by recreating the table, so both paths must agree.
 */
function gamesTableDDL(name: string): string {
  return `
  CREATE TABLE ${name} (
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
  );`;
}

// The column list, in canonical order, for copying rows during a table rebuild.
const GAMES_COLUMNS = [
  "id",
  "user_id",
  "user_color",
  "mode",
  "white_user_id",
  "black_user_id",
  "points_applied",
  "fen",
  "moves",
  "san",
  "rep_counts",
  "status",
  "result",
  "end_reason",
  "created_at",
  "updated_at",
].join(", ");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    points        INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (${NOW_SQL})
  );

  ${gamesTableDDL("IF NOT EXISTS games")}

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
 * (Re)create the constraints that keep "at most one active game per player".
 *
 * `idx_games_one_active` is a partial UNIQUE index on the creator column only.
 * `trg_one_active_game` closes the gap it cannot express: it rejects any new
 * active game if *either* named player (creator or, for pvp, white/black) is
 * already in an active game. The normal create paths abandon a player's prior
 * game inside the same transaction, so this only fires as a backstop — but it
 * makes the invariant hold at the DB level regardless of who inserts.
 *
 * Note: this app is single-writer by design (see `render.yaml`,
 * `numInstances: 1`). The trigger + `better-sqlite3`'s synchronous, serialized
 * writes are what enforce the invariant; do not run more than one instance
 * against the same database.
 */
function ensureGamesConstraints(): void {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_games_one_active
      ON games(user_id) WHERE status = 'active';

    CREATE TRIGGER IF NOT EXISTS trg_one_active_game
    BEFORE INSERT ON games
    WHEN NEW.status = 'active'
    BEGIN
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM games g
         WHERE g.status = 'active'
           AND (
             g.user_id       IN (NEW.user_id, NEW.white_user_id, NEW.black_user_id)
             OR g.white_user_id IN (NEW.user_id, NEW.white_user_id, NEW.black_user_id)
             OR g.black_user_id IN (NEW.user_id, NEW.white_user_id, NEW.black_user_id)
           )
      ) THEN RAISE(ABORT, 'player already has an active game') END;
    END;
  `);
}

/**
 * Bring an existing on-disk DB up to the current schema.
 *
 * 1. `addColumnIfMissing` adds columns that `CREATE TABLE IF NOT EXISTS` will
 *    not add to a table that already exists (DBs created before multiplayer).
 * 2. `runMigrations` handles changes that need more than a new column — chiefly
 *    `CHECK` constraint changes, which SQLite can only apply by rebuilding the
 *    table. Keyed on `PRAGMA user_version` so each migration runs once.
 *
 * Fresh DBs (including `:memory:` test DBs) already match the current schema;
 * the migrations still run once but copy zero or already-valid rows.
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

const SCHEMA_VERSION = 1;

/** Rebuild `games` from `gamesTableDDL` so any stale CHECK constraints (from a
 *  DB created before 'abandoned'/'pvp' existed) are replaced by the current
 *  set, preserving all rows. Follows SQLite's supported table-rebuild sequence. */
function rebuildGamesTable(): void {
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec(gamesTableDDL("games_rebuild"));
      db.exec(
        `INSERT INTO games_rebuild (${GAMES_COLUMNS})
           SELECT ${GAMES_COLUMNS} FROM games;`,
      );
      db.exec("DROP TABLE games;");
      db.exec("ALTER TABLE games_rebuild RENAME TO games;");
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
  } finally {
    db.pragma("foreign_keys = ON");
  }
  const violations = db.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    throw new Error(`schema migration left foreign key violations: ${violations.length}`);
  }
}

function runMigrations(): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current < 1) rebuildGamesTable();
}

runMigrations();
ensureGamesConstraints();

/** Checkpoint the WAL and close the connection. Call on process shutdown. */
export function closeDb(): void {
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    /* best effort */
  }
  db.close();
}

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
