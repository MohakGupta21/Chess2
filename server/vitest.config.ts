import { defineConfig } from "vitest/config";

// Tests need a real Postgres (the schema uses a plpgsql trigger). Start one with
//   docker compose -f server/docker-compose.yml up -d
// or point TEST_DATABASE_URL at your own.
const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://chess:chess@localhost:5433/chess_test";

export default defineConfig({
  test: {
    env: {
      NODE_ENV: "test",
      DATABASE_URL,
      DATABASE_SSL: "disable",
      JWT_SECRET: "test-secret-do-not-use-in-prod",
    },
    // db-backed suites share tables; don't run the files concurrently.
    fileParallelism: false,
  },
});
