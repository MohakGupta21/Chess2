import type {
  AuthResponse,
  ChallengeResponse,
  ChallengesResponse,
  Credentials,
  GameMode,
  GameResponse,
  LeaderboardResponse,
} from "../shared";

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Called when any request (other than the auth endpoints themselves) gets a
// 401, so the app can drop back to the sign-in screen. Registered by useAuth.
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

// Base URL of the API server. Empty (the default) means "same origin": the
// browser hits `/api/...` on whatever host served the app, which is how both
// the single-origin production deploy and the Vite dev proxy work. Set
// `VITE_API_BASE_URL` at build time (e.g. https://chess-api.example.com) to
// point a separately-hosted client at a remote server.
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");

// When the API lives on another origin the auth cookie is cross-site, so the
// request has to opt in to sending credentials. Same-origin keeps the stricter
// default. (Cross-origin also needs the server's `CLIENT_ORIGIN` set and its
// auth cookie issued as `SameSite=None; Secure` — see DEPLOY.md.)
const CREDENTIALS: RequestCredentials = API_BASE_URL ? "include" : "same-origin";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body != null;
  const res = await fetch(`${API_BASE_URL}/api${path}`, {
    ...init,
    headers: {
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
    credentials: CREDENTIALS,
  });

  if (res.status === 401 && !path.startsWith("/auth/")) {
    onUnauthorized?.();
  }

  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(
      res.status,
      (body as { error?: string }).error ?? res.statusText,
    );
  }
  return body as T;
}

export const api = {
  signup: (c: Credentials) =>
    req<AuthResponse>("/auth/signup", { method: "POST", body: JSON.stringify(c) }),
  signin: (c: Credentials) =>
    req<AuthResponse>("/auth/signin", { method: "POST", body: JSON.stringify(c) }),
  signout: () => req<void>("/auth/signout", { method: "POST" }),
  me: () => req<AuthResponse>("/auth/me"),

  currentGame: () => req<GameResponse>("/games/current"),
  game: (gameId: string) => req<GameResponse>(`/games/${gameId}`),
  newGame: (mode: GameMode = "ai") =>
    req<GameResponse>("/games", {
      method: "POST",
      body: JSON.stringify({ mode }),
    }),
  move: (gameId: string, uci: string) =>
    req<GameResponse>(`/games/${gameId}/move`, {
      method: "POST",
      body: JSON.stringify({ uci }),
    }),
  resign: (gameId: string) =>
    req<GameResponse>(`/games/${gameId}/resign`, { method: "POST" }),

  challenges: () => req<ChallengesResponse>("/challenges"),
  createChallenge: (email: string) =>
    req<ChallengeResponse>("/challenges", {
      method: "POST",
      body: JSON.stringify({ email }),
    }),
  acceptChallenge: (id: string) =>
    req<GameResponse>(`/challenges/${id}/accept`, { method: "POST" }),
  declineChallenge: (id: string) =>
    req<ChallengeResponse>(`/challenges/${id}/decline`, { method: "POST" }),
  cancelChallenge: (id: string) =>
    req<ChallengeResponse>(`/challenges/${id}/cancel`, { method: "POST" }),

  leaderboard: () => req<LeaderboardResponse>("/leaderboard"),
};

export { ApiError };
