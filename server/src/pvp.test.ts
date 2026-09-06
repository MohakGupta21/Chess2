import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./app.js";
import { closeDb, initDb, q } from "./db.js";

const app = createApp();

beforeAll(async () => {
  await initDb();
});
afterAll(async () => {
  await closeDb();
});
beforeEach(async () => {
  await q("TRUNCATE users, games, challenges RESTART IDENTITY CASCADE");
});

type Agent = ReturnType<typeof request.agent>;

async function signIn(email: string): Promise<Agent> {
  const agent = request.agent(app);
  await agent
    .post("/api/auth/signup")
    .send({ email, password: "hunter2hunter2" })
    .expect(201);
  return agent;
}

async function points(agent: Agent): Promise<number> {
  const res = await agent.get("/api/auth/me").expect(200);
  return res.body.user.points as number;
}

/** Challenge from `a` to `b`, `b` accepts. Returns the new game id. */
async function startPvpGame(a: Agent, b: Agent): Promise<string> {
  const bMe = await b.get("/api/auth/me").expect(200);
  const challenge = await a
    .post("/api/challenges")
    .send({ email: bMe.body.user.email })
    .expect(201);
  const accepted = await b
    .post(`/api/challenges/${challenge.body.challenge.id}/accept`)
    .expect(201);
  return accepted.body.game.id as string;
}

/** Play `ucis` (white, black, white, …) routing each to the right agent. */
async function playMoves(
  whiteAgent: Agent,
  blackAgent: Agent,
  gameId: string,
  ucis: string[],
) {
  let last: request.Response | undefined;
  for (let i = 0; i < ucis.length; i++) {
    const mover = i % 2 === 0 ? whiteAgent : blackAgent;
    last = await mover
      .post(`/api/games/${gameId}/move`)
      .send({ uci: ucis[i] })
      .expect(200);
  }
  return last!;
}

async function whoIsWhite(
  a: Agent,
  b: Agent,
): Promise<{ white: Agent; black: Agent }> {
  const g = await a.get("/api/games/current").expect(200);
  return g.body.game.userColor === "w"
    ? { white: a, black: b }
    : { white: b, black: a };
}

const FOOLS_MATE = ["f2f3", "e7e5", "g2g4", "d8h4"];

describe("challenges", () => {
  it("creates a game both players can load, with opposite colours", async () => {
    const a = await signIn("a@ex.com");
    const b = await signIn("b@ex.com");
    const gameId = await startPvpGame(a, b);

    const ga = await a.get("/api/games/current").expect(200);
    const gb = await b.get("/api/games/current").expect(200);
    expect(ga.body.game.id).toBe(gameId);
    expect(gb.body.game.id).toBe(gameId);
    expect(ga.body.game.mode).toBe("pvp");
    expect(ga.body.game.userColor).not.toBe(gb.body.game.userColor);
    expect(ga.body.game.opponent.email).toBe("b@ex.com");
    expect(gb.body.game.opponent.email).toBe("a@ex.com");
  });

  it("rejects self-challenge, unknown email and duplicates", async () => {
    const a = await signIn("a@ex.com");
    await signIn("b@ex.com");

    await a.post("/api/challenges").send({ email: "a@ex.com" }).expect(400);
    await a.post("/api/challenges").send({ email: "nobody@ex.com" }).expect(404);

    await a.post("/api/challenges").send({ email: "b@ex.com" }).expect(201);
    await a.post("/api/challenges").send({ email: "b@ex.com" }).expect(409);
  });

  it("only the recipient can accept; a third party cannot", async () => {
    const a = await signIn("a@ex.com");
    const b = await signIn("b@ex.com");
    const c = await signIn("c@ex.com");
    const ch = await a
      .post("/api/challenges")
      .send({ email: "b@ex.com" })
      .expect(201);
    await c.post(`/api/challenges/${ch.body.challenge.id}/accept`).expect(404);
    await a.post(`/api/challenges/${ch.body.challenge.id}/accept`).expect(404);
    await b.post(`/api/challenges/${ch.body.challenge.id}/accept`).expect(201);
  });

  it("decline and cancel end a challenge without a game", async () => {
    const a = await signIn("a@ex.com");
    const b = await signIn("b@ex.com");

    const ch1 = await a
      .post("/api/challenges")
      .send({ email: "b@ex.com" })
      .expect(201);
    const declined = await b
      .post(`/api/challenges/${ch1.body.challenge.id}/decline`)
      .expect(200);
    expect(declined.body.challenge.status).toBe("declined");
    await b.get("/api/games/current").expect(404);

    const ch2 = await a
      .post("/api/challenges")
      .send({ email: "b@ex.com" })
      .expect(201);
    const cancelled = await a
      .post(`/api/challenges/${ch2.body.challenge.id}/cancel`)
      .expect(200);
    expect(cancelled.body.challenge.status).toBe("cancelled");
  });

  it("lists incoming and outgoing pending challenges", async () => {
    const a = await signIn("a@ex.com");
    const b = await signIn("b@ex.com");
    await a.post("/api/challenges").send({ email: "b@ex.com" }).expect(201);

    const outA = await a.get("/api/challenges").expect(200);
    expect(outA.body.outgoing).toHaveLength(1);
    expect(outA.body.incoming).toHaveLength(0);

    const inB = await b.get("/api/challenges").expect(200);
    expect(inB.body.incoming).toHaveLength(1);
    expect(inB.body.incoming[0].from.email).toBe("a@ex.com");
  });
});

describe("pvp move authorisation", () => {
  it("refuses a move from the side not to play", async () => {
    const a = await signIn("a@ex.com");
    const b = await signIn("b@ex.com");
    const gameId = await startPvpGame(a, b);
    const { white, black } = await whoIsWhite(a, b);

    await black
      .post(`/api/games/${gameId}/move`)
      .send({ uci: "e7e5" })
      .expect(409);
    await white
      .post(`/api/games/${gameId}/move`)
      .send({ uci: "e2e4" })
      .expect(200);
    await white
      .post(`/api/games/${gameId}/move`)
      .send({ uci: "d2d4" })
      .expect(409);
    await black
      .post(`/api/games/${gameId}/move`)
      .send({ uci: "e7e5" })
      .expect(200);
  });
});

describe("points", () => {
  it("awards +100 / -25 on checkmate, floored at 0, once only", async () => {
    const a = await signIn("a@ex.com");
    const b = await signIn("b@ex.com");

    // Game 1: white is fool's-mated. Winner +100, loser floored at 0.
    const g1 = await startPvpGame(a, b);
    const r1 = await whoIsWhite(a, b);
    const end1 = await playMoves(r1.white, r1.black, g1, FOOLS_MATE);
    expect(end1.body.game.status).toBe("checkmate");
    expect(await points(r1.white)).toBe(0);
    expect(await points(r1.black)).toBe(100);

    // A second terminal write is refused and points do not move again.
    await r1.white
      .post(`/api/games/${g1}/move`)
      .send({ uci: "a2a3" })
      .expect(409);
    await r1.white.post(`/api/games/${g1}/resign`).expect(200);
    expect(await points(r1.white)).toBe(0);
    expect(await points(r1.black)).toBe(100);

    // Game 2: the game-1 winner (r1.black, 100 pts) resigns -> 100 - 25 = 75;
    // the game-1 loser (r1.white, 0 pts) takes the win -> 100.
    const g2 = await startPvpGame(b, a);
    await r1.black.post(`/api/games/${g2}/resign`).expect(200);
    expect(await points(r1.black)).toBe(75);
    expect(await points(r1.white)).toBe(100);
  });

  it("no points change on a draw", async () => {
    const a = await signIn("a@ex.com");
    const b = await signIn("b@ex.com");
    const gameId = await startPvpGame(a, b);
    const { white, black } = await whoIsWhite(a, b);

    const seq = ["g1f3", "g8f6", "f3g1", "f6g8", "g1f3", "g8f6", "f3g1"];
    await playMoves(white, black, gameId, seq);
    const last = await black
      .post(`/api/games/${gameId}/move`)
      .send({ uci: "f6g8" })
      .expect(200);
    expect(last.body.game.status).toBe("draw");
    expect(await points(white)).toBe(0);
    expect(await points(black)).toBe(0);
  });

  it("resigning a pvp game is a loss for the resigner", async () => {
    const a = await signIn("a@ex.com");
    const b = await signIn("b@ex.com");
    const gameId = await startPvpGame(a, b);
    const { white } = await whoIsWhite(a, b);
    await white.post(`/api/games/${gameId}/resign`).expect(200);
    // white resigned -> loss (floored at 0); black won -> +100.
    expect(await points(white)).toBe(0);
  });
});

describe("a ranked game cannot be silently abandoned (DB-H2)", () => {
  it("refuses a new solo game while a pvp game is active, until resigned", async () => {
    const a = await signIn("h2a@ex.com");
    const b = await signIn("h2b@ex.com");
    const gameId = await startPvpGame(a, b);

    const blocked = await a.post("/api/games").expect(409);
    expect(blocked.body.error).toMatch(/finish or resign/i);

    await a.post(`/api/games/${gameId}/resign`).expect(200);
    await a.post("/api/games").expect(201); // now allowed
  });

  it("refuses accepting a challenge while a pvp game is active", async () => {
    const a = await signIn("h2c@ex.com");
    const b = await signIn("h2d@ex.com");
    const c = await signIn("h2e@ex.com");
    await startPvpGame(a, b);

    const aEmail = (await a.get("/api/auth/me")).body.user.email as string;
    const ch = await c
      .post("/api/challenges")
      .send({ email: aEmail })
      .expect(201);
    const res = await a
      .post(`/api/challenges/${ch.body.challenge.id}/accept`)
      .expect(409);
    expect(res.body.error).toMatch(/finish or resign/i);
  });
});

describe("leaderboard", () => {
  it("orders players by points, highest first", async () => {
    const a = await signIn("a@ex.com");
    const b = await signIn("b@ex.com");
    const gameId = await startPvpGame(a, b);
    const { white, black } = await whoIsWhite(a, b);
    await playMoves(white, black, gameId, FOOLS_MATE); // white loses

    const lb = await a.get("/api/leaderboard").expect(200);
    expect(lb.body.entries[0].points).toBe(100);
    expect(lb.body.entries).toHaveLength(2);

    type Entry = { email: string; points: number; isMe: boolean };
    const entries = lb.body.entries as Entry[];
    const mine = entries.find((e) => e.isMe)!;
    const other = entries.find((e) => !e.isMe)!;
    expect(mine.email).toBe("a@ex.com"); // own row is unmasked
    expect(other.email).not.toContain("b@ex.com"); // others are masked
    expect(other.email).toMatch(/•••/);
  });
});
