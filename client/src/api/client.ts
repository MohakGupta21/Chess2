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

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body != null;
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
    credentials: "same-origin",
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
