import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Credentials, PublicUser } from "../shared";
import { api, setUnauthorizedHandler } from "../api/client";

interface AuthState {
  user: PublicUser | null;
  loading: boolean;
  signIn: (c: Credentials) => Promise<void>;
  signUp: (c: Credentials) => Promise<void>;
  signOut: () => Promise<void>;
  /** Re-pull the current user (e.g. after a game changes their points). */
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .me()
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  // If any request 401s mid-session, drop the user so route guards send them
  // back to /signin.
  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    return () => setUnauthorizedHandler(null);
  }, []);

  const signIn = useCallback(async (c: Credentials) => {
    const r = await api.signin(c);
    setUser(r.user);
  }, []);

  const signUp = useCallback(async (c: Credentials) => {
    const r = await api.signup(c);
    setUser(r.user);
  }, []);

  const signOut = useCallback(async () => {
    await api.signout();
    setUser(null);
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      const r = await api.me();
      setUser(r.user);
    } catch {
      /* leave the current user in place; a 401 is handled elsewhere */
    }
  }, []);

  const value = useMemo(
    () => ({ user, loading, signIn, signUp, signOut, refreshUser }),
    [user, loading, signIn, signUp, signOut, refreshUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
