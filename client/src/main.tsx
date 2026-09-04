import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  createBrowserRouter,
  Navigate,
  RouterProvider,
} from "react-router-dom";
import { AuthProvider, useAuth } from "./hooks/useAuth";
import { SignIn } from "./pages/SignIn";
import { Lobby } from "./pages/Lobby";
import { Play } from "./pages/Play";
import "./styles.css";

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="center-msg">Loading…</div>;
  if (!user) return <Navigate to="/signin" replace />;
  return <>{children}</>;
}

const router = createBrowserRouter([
  { path: "/signin", element: <SignIn /> },
  {
    path: "/",
    element: (
      <RequireAuth>
        <Lobby />
      </RequireAuth>
    ),
  },
  {
    path: "/play",
    element: (
      <RequireAuth>
        <Play />
      </RequireAuth>
    ),
  },
  { path: "*", element: <Navigate to="/" replace /> },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  </StrictMode>,
);
