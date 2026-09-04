/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Base URL of the API server, e.g. "https://chess-api.example.com".
   * Leave unset to call `/api` on the same origin that served the app
   * (single-origin deploy, or the Vite dev proxy).
   */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
