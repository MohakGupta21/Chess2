import pg from "pg";
import { config } from "./config.js";

// Return timestamptz columns as ISO-8601 strings (not JS Date), so the DTO
// builders can pass them straight through as they always have.
pg.types.setTypeParser(1184, (v: string | null) =>
  v == null ? v : new Date(v).toISOString(),
);

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl,
  max: 10,
});

pool.on("error", (err) => {
  console.error("[pg pool]", err);
});

/** A pool or a checked-out client in a transaction. */
export type Executor = pg.Pool | pg.PoolClient;

/** `now()` — kept as a name so query strings read the same as before. */
export const NOW_SQL = "now()";

/** Run a query, return the rows. */
export async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
  exec: Executor = pool,
): Promise<T[]> {
  const res = await exec.query<T>(text, params as unknown[]);
  return res.rows;
}

/** Run a query, return the first row (or undefined). */
export async function q1<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
  exec: Executor = pool,
): Promise<T | undefined> {
  return (await q<T>(text, params, exec))[0];
}

/** Run `fn` inside a single transaction; commit on success, roll back on throw. */
export async function withTransaction<T>(
  fn: (tx: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* connection already broken */
    }
    throw e;
  } finally {
    client.release();
  }
}

const BASELINE_DDL = `
  CREATE TABLE IF NOT EXISTS users (
    id            text PRIMARY KEY,
    email         text NOT NULL,
    password_hash text NOT NULL,
    points        integer NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now()
  );
  -- Case-insensitive uniqueness (the app also lower-cases before writing).
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (lower(email));

  CREATE TABLE IF NOT EXISTS games (
    id             text PRIMARY KEY,
    user_id        text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_color     text NOT NULL CHECK (user_color IN ('w','b')),
    -- "ai": solo vs the engine. "pvp": account vs account, players in
    -- white_user_id / black_user_id (user_id stays the creator).
    mode           text NOT NULL DEFAULT 'ai' CHECK (mode IN ('ai','pvp')),
    white_user_id  text REFERENCES users(id) ON DELETE CASCADE,
    black_user_id  text REFERENCES users(id) ON DELETE CASCADE,
    -- 1 once a terminal pvp result has moved points, so it never doubles.
    points_applied integer NOT NULL DEFAULT 0,
    fen            text NOT NULL,
    moves          text NOT NULL DEFAULT '[]',
    san            text NOT NULL DEFAULT '[]',
    -- position-repetition counts, keyed by the first four FEN fields
    rep_counts     text NOT NULL DEFAULT '{}',
    status         text NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','checkmate','stalemate','draw','resigned','abandoned')),
    result         text CHECK (result IN ('1-0','0-1','1/2-1/2')),
    end_reason     text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
  );

  -- At most one active game per creator (backstop; the trigger below covers the
  -- pvp joiner too, which a single-column index cannot express).
  CREATE UNIQUE INDEX IF NOT EXISTS idx_games_one_active
    ON games (user_id) WHERE status = 'active';

  CREATE TABLE IF NOT EXISTS challenges (
    id           text PRIMARY KEY,
    from_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_user_id   text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','accepted','declined','cancelled')),
    game_id      text REFERENCES games(id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS idx_challenges_to
    ON challenges (to_user_id, status);
  CREATE INDEX IF NOT EXISTS idx_challenges_from
    ON challenges (from_user_id, status);
`;

// Rejects a new active game if either named player (creator or, for pvp,
// white/black) is already in an active game. Normal create paths abandon a
// player's prior game in the same transaction, so this only fires as a
// backstop, but it holds the invariant at the DB level regardless of caller.
const ONE_ACTIVE_GAME_TRIGGER = `
  CREATE OR REPLACE FUNCTION assert_one_active_game() RETURNS trigger AS $fn$
  BEGIN
    IF NEW.status = 'active' AND EXISTS (
      SELECT 1 FROM games
       WHERE status = 'active'
         AND (
           user_id       IN (NEW.user_id, NEW.white_user_id, NEW.black_user_id)
           OR white_user_id IN (NEW.user_id, NEW.white_user_id, NEW.black_user_id)
           OR black_user_id IN (NEW.user_id, NEW.white_user_id, NEW.black_user_id)
         )
    ) THEN
      RAISE EXCEPTION 'player already has an active game' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END;
  $fn$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS trg_one_active_game ON games;
  CREATE TRIGGER trg_one_active_game
    BEFORE INSERT ON games
    FOR EACH ROW EXECUTE FUNCTION assert_one_active_game();
`;

/**
 * Numbered migrations applied after the baseline. Each runs once, in order,
 * inside its own transaction; the version is recorded in `schema_migrations`.
 * The baseline itself is version 1 and is (re)asserted idempotently every boot.
 */
const MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  // { version: 2, sql: `ALTER TABLE games ADD COLUMN ...` },
];

/** Create the schema if absent and apply any pending migrations. Idempotent. */
export async function initDb(): Promise<void> {
  await q(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    integer PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  await q(BASELINE_DDL);
  await q(ONE_ACTIVE_GAME_TRIGGER);
  await q(
    `INSERT INTO schema_migrations (version) VALUES (1) ON CONFLICT DO NOTHING`,
  );

  const applied = new Set(
    (await q<{ version: number }>(`SELECT version FROM schema_migrations`)).map(
      (r) => r.version,
    ),
  );
  for (const m of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) continue;
    await withTransaction(async (tx) => {
      await tx.query(m.sql);
      await tx.query(`INSERT INTO schema_migrations (version) VALUES ($1)`, [
        m.version,
      ]);
    });
    console.log(`applied migration ${m.version}`);
  }
}

/** Close the pool. Call on process shutdown. */
export async function closeDb(): Promise<void> {
  await pool.end();
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
