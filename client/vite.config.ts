import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The dev server proxies /api to the backend so the browser sees one origin
// (keeps the auth cookie first-party).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.API_TARGET ?? "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
  worker: {
    format: "es",
  },
});
