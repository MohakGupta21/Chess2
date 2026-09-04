import { createHash } from "node:crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { nanoid } from "nanoid";
import rateLimit from "express-rate-limit";
import { credentialsSchema, type PublicUser } from "./shared.js";
import { config } from "./config.js";
import { db, type UserRow } from "./db.js";

const insertUser = db.prepare(
  "INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)",
);
const findByEmail = db.prepare("SELECT * FROM users WHERE email = ?");
const findById = db.prepare("SELECT * FROM users WHERE id = ?");

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
    sameSite: "lax",
    secure: config.isProd,
    maxAge: config.tokenTtlSeconds * 1000,
    path: "/",
  });
}

export interface AuthedRequest extends Request {
  user?: PublicUser;
}

export function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
): void {
  const token = req.cookies?.[config.cookieName];
  if (!token) {
    res.status(401).json({ error: "not authenticated" });
    return;
  }
  try {
    const payload = jwt.verify(token, config.jwtSecret) as { sub: string };
    const row = findById.get(payload.sub) as UserRow | undefined;
    if (!row) {
      res.status(401).json({ error: "not authenticated" });
      return;
    }
    req.user = { id: row.id, email: row.email, points: row.points };
    next();
  } catch {
    res.status(401).json({ error: "not authenticated" });
  }
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
      insertUser.run(id, email, passwordHash);
      setAuthCookie(res, id);
      res.status(201).json({ user: { id, email, points: 0 } });
    } catch (e) {
      // UNIQUE(email) violation — keep the message generic to limit enumeration.
      if (e instanceof Error && /UNIQUE/i.test(e.message)) {
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
    const row = findByEmail.get(email) as UserRow | undefined;
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
  res.clearCookie(config.cookieName, { path: "/" });
  res.status(204).end();
});

authRouter.get("/me", requireAuth, (req: AuthedRequest, res: Response) => {
  res.json({ user: req.user });
});
