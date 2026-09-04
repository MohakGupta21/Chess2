import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Dev: the Vite server proxies /api to the backend so the browser sees one
// origin (keeps the auth cookie first-party). Point it at a non-default backend
// with `API_TARGET` in client/.env.
//
// Deployed builds where the client and API are on different origins use
// `VITE_API_BASE_URL` instead (read at build time — see src/api/client.ts).
export default defineConfig(({ mode }) => {
  // "" prefix: load every var from client/.env*, not just the VITE_* ones.
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = env.API_TARGET || "http://localhost:4000";

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: true,
        },
      },
    },
    worker: {
      format: "es",
    },
  };
});
