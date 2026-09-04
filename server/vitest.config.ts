import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      NODE_ENV: "test",
      DB_PATH: ":memory:",
      JWT_SECRET: "test-secret-do-not-use-in-prod",
    },
  },
});
