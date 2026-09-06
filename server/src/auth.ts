import { createHash } from "node:crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { nanoid } from "nanoid";
import rateLimit from "express-rate-limit";
import { credentialsSchema, type PublicUser } from "./shared.js";
import { config } from "./config.js";
import { q, q1, type UserRow } from "./db.js";

/**
 * bcrypt only reads the first 72 bytes of its input. Pre-hashing with SHA-256
 * (base64, 44 chars) means the whole password contributes and there is no
 * silent truncation. The base64 alphabet has no NUL, so bcryptjs is happy.
 */
function prehash(password: string): string {
  return createHash("sha256").update(password, "utf8").digest("base64");
}

// A fixed hash to compare against when an account does not exist, so sign-in
// takes the same time whether or not the email is registered.
const DUMMY_HASH = bcrypt.hashSync(prehash("unused-placeholder"), 10);

function setAuthCookie(res: Response, userId: string): void {
  const token = jwt.sign({ sub: userId }, config.jwtSecret, {
    expiresIn: config.tokenTtlSeconds,
  });
  res.cookie(config.cookieName, token, {
    httpOnly: true,
    sameSite: config.cookieSameSite,
    secure: config.cookieSecure,
    maxAge: config.tokenTtlSeconds * 1000,
    path: "/",
  });
}

export interface AuthedRequest extends Request {
  user?: PublicUser;
}

/** Resolve the signed-in user from the auth cookie, or null. */
async function authenticate(req: Request): Promise<PublicUser | null> {
  const token = req.cookies?.[config.cookieName];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, config.jwtSecret) as { sub?: string };
    if (!payload.sub) return null;
    const row = await q1<UserRow>("SELECT * FROM users WHERE id = $1", [
      payload.sub,
    ]);
    if (!row) return null;
    return { id: row.id, email: row.email, points: row.points };
  } catch {
    return null;
  }
}

/** Middleware: 401 unless a valid session cookie resolves to a real user. */
export function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
): void {
  authenticate(req)
    .then((user) => {
      if (!user) {
        res.status(401).json({ error: "not authenticated" });
        return;
      }
      req.user = user;
      next();
    })
    .catch(next);
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.isProd ? 30 : 200,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => config.isTest,
  message: { error: "too many attempts, try again later" },
});

export const authRouter = Router();

/** Wrap an async handler so rejected promises reach the error middleware. */
function wrap(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

authRouter.post(
  "/signup",
  authLimiter,
  wrap(async (req, res) => {
    const parsed = credentialsSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "email and an 8+ character password required" });
      return;
    }
    const email = parsed.data.email.toLowerCase().trim();
    const passwordHash = await bcrypt.hash(prehash(parsed.data.password), 10);
    try {
      const id = nanoid();
      await q("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)", [
        id,
        email,
        passwordHash,
      ]);
      setAuthCookie(res, id);
      res.status(201).json({ user: { id, email, points: 0 } });
    } catch (e) {
      // unique_violation — keep the message generic to limit enumeration.
      if (e instanceof Error && (e as { code?: string }).code === "23505") {
        res
          .status(409)
          .json({ error: "could not create an account with those details" });
        return;
      }
      throw e;
    }
  }),
);

authRouter.post(
  "/signin",
  authLimiter,
  wrap(async (req, res) => {
    const parsed = credentialsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "email and password required" });
      return;
    }
    const email = parsed.data.email.toLowerCase().trim();
    const row = await q1<UserRow>(
      "SELECT * FROM users WHERE lower(email) = $1",
      [email],
    );
    const ok = await bcrypt.compare(
      prehash(parsed.data.password),
      row?.password_hash ?? DUMMY_HASH,
    );
    if (!row || !ok) {
      res.status(401).json({ error: "invalid email or password" });
      return;
    }
    setAuthCookie(res, row.id);
    res.json({ user: { id: row.id, email: row.email, points: row.points } });
  }),
);

authRouter.post("/signout", (_req: Request, res: Response) => {
  res.clearCookie(config.cookieName, {
    path: "/",
    sameSite: config.cookieSameSite,
    secure: config.cookieSecure,
  });
  res.status(204).end();
});

authRouter.get("/me", requireAuth, (req: AuthedRequest, res: Response) => {
  res.json({ user: req.user });
});
