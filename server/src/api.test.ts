import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./app.js";
import { db } from "./db.js";

const app = createApp();

beforeEach(() => {
  db.exec("DELETE FROM games; DELETE FROM users;");
});

async function signedInAgent(email = "player@example.com") {
  const agent = request.agent(app);
  await agent
    .post("/api/auth/signup")
    .send({ email, password: "hunter2hunter2" })
    .expect(201);
  return agent;
}

describe("auth", () => {
  it("signs up, reads me, signs out, then blocks", async () => {
    const agent = request.agent(app);
    await agent
      .post("/api/auth/signup")
      .send({ email: "a@b.com", password: "longenough1" })
      .expect(201);
    await agent.get("/api/auth/me").expect(200);
    await agent.post("/api/auth/signout").expect(204);
    await agent.get("/api/auth/me").expect(401);
  });

  it("rejects a weak password and a bad login", async () => {
    await request(app)
      .post("/api/auth/signup")
      .send({ email: "x@y.com", password: "short" })
      .expect(400);
    await request(app)
      .post("/api/auth/signin")
      .send({ email: "nobody@y.com", password: "whatever12" })
      .expect(401);
  });

  it("rejects a duplicate signup with a generic message", async () => {
    await request(app)
      .post("/api/auth/signup")
      .send({ email: "dup@y.com", password: "longenough1" })
      .expect(201);
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email: "dup@y.com", password: "longenough1" })
      .expect(409);
    expect(res.body.error).not.toMatch(/exists/i);
  });

  it("authenticates a long (>72 byte) password by its full contents", async () => {
    const email = "long@y.com";
    const base = "x".repeat(80);
    await request(app)
      .post("/api/auth/signup")
      .send({ email, password: base + "AAAA" })
      .expect(201);
    // Same first 72 bytes, different tail -> must be rejected.
    await request(app)
      .post("/api/auth/signin")
      .send({ email, password: base + "BBBB" })
      .expect(401);
    await request(app)
      .post("/api/auth/signin")
      .send({ email, password: base + "AAAA" })
      .expect(200);
  });

  it("blocks game routes without a session", async () => {
    await request(app).get("/api/games/current").expect(401);
  });

  it("returns JSON 404 for an unknown API route", async () => {
    const res = await request(app).get("/api/nope").expect(404);
    expect(res.body).toEqual({ error: "not found" });
  });
});

describe("CSRF origin guard", () => {
  it("rejects a state-changing request from a foreign Origin", async () => {
    const res = await request(app)
      .post("/api/auth/signup")
      .set("Origin", "https://evil.example")
      .send({ email: "csrf@example.com", password: "longenough1" })
      .expect(403);
    expect(res.body).toEqual({ error: "cross-origin request refused" });
  });

  it("allows a request from the configured client origin", async () => {
    await request(app)
      .post("/api/auth/signup")
      .set("Origin", "http://localhost:5173")
      .send({ email: "okorigin@example.com", password: "longenough1" })
      .expect(201);
  });

  it("allows a request with no Origin/Referer (non-browser client)", async () => {
    await request(app)
      .post("/api/auth/signup")
      .send({ email: "noorigin@example.com", password: "longenough1" })
      .expect(201);
  });

  it("still allows safe methods cross-origin", async () => {
    await request(app)
      .get("/api/health")
      .set("Origin", "https://evil.example")
      .expect(200);
  });
});

describe("games", () => {
  it("creates a game with a random colour and no active game before that", async () => {
    const agent = await signedInAgent();
    await agent.get("/api/games/current").expect(404);
    const res = await agent.post("/api/games").expect(201);
    expect(["w", "b"]).toContain(res.body.game.userColor);
    expect(res.body.game.status).toBe("active");
    expect(res.body.game.createdAt).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
    await agent.get("/api/games/current").expect(200);
  });

  it("resumes the active game on a fresh request (persistence)", async () => {
    const agent = await signedInAgent();
    const created = await agent.post("/api/games").expect(201);
    const again = await agent.get("/api/games/current").expect(200);
    expect(again.body.game.id).toBe(created.body.game.id);
  });

  it("applies legal moves and rejects illegal ones", async () => {
    const agent = await signedInAgent();
    const { body } = await agent.post("/api/games").expect(201);
    const id = body.game.id;
    const ok = await agent
      .post(`/api/games/${id}/move`)
      .send({ uci: "e2e4" })
      .expect(200);
    expect(ok.body.game.moves).toEqual(["e2e4"]);
    expect(ok.body.game.san).toEqual(["e4"]);
    expect(ok.body.game.turn).toBe("b");

    await agent
      .post(`/api/games/${id}/move`)
      .send({ uci: "e2e4" })
      .expect(422); // e2 is now empty

    await agent
      .post(`/api/games/${id}/move`)
      .send({ uci: "zzzz" })
      .expect(400); // not even UCI shaped
  });

  it("plays a full fool's mate and reports the result", async () => {
    const agent = await signedInAgent();
    const { body } = await agent.post("/api/games").expect(201);
    const id = body.game.id;
    let last;
    for (const uci of ["f2f3", "e7e5", "g2g4", "d8h4"]) {
      last = await agent.post(`/api/games/${id}/move`).send({ uci }).expect(200);
    }
    expect(last!.body.game.status).toBe("checkmate");
    expect(last!.body.game.result).toBe("0-1");
    await agent
      .post(`/api/games/${id}/move`)
      .send({ uci: "a2a3" })
      .expect(409);
  });

  it("resigns and records the loss for the resigning colour", async () => {
    const agent = await signedInAgent();
    const { body } = await agent.post("/api/games").expect(201);
    const res = await agent
      .post(`/api/games/${body.game.id}/resign`)
      .expect(200);
    expect(res.body.game.status).toBe("resigned");
    expect(res.body.game.result).toBe(body.game.userColor === "w" ? "0-1" : "1-0");
  });

  it("abandons a prior active game when a new one is created", async () => {
    const agent = await signedInAgent();
    const first = await agent.post("/api/games").expect(201);
    const second = await agent.post("/api/games").expect(201);
    expect(second.body.game.id).not.toBe(first.body.game.id);
    const current = await agent.get("/api/games/current").expect(200);
    expect(current.body.game.id).toBe(second.body.game.id);
    // The superseded game is 'abandoned', not 'resigned'.
    const stale = await agent
      .post(`/api/games/${first.body.game.id}/resign`)
      .expect(200);
    expect(stale.body.game.status).toBe("abandoned");
  });

  it("draws by threefold repetition (RULES.md §9)", async () => {
    const agent = await signedInAgent();
    const { body } = await agent.post("/api/games").expect(201);
    const id = body.game.id;
    // Shuffle both knights out and back twice: the initial position occurs a
    // third time on the 8th ply.
    const seq = ["g1f3", "g8f6", "f3g1", "f6g8", "g1f3", "g8f6", "f3g1"];
    for (const uci of seq) {
      await agent.post(`/api/games/${id}/move`).send({ uci }).expect(200);
    }
    const last = await agent
      .post(`/api/games/${id}/move`)
      .send({ uci: "f6g8" })
      .expect(200);
    expect(last.body.game.status).toBe("draw");
    expect(last.body.game.endReason).toBe("threefold_repetition");
    expect(last.body.game.result).toBe("1/2-1/2");
  });

  it("does not let a user touch another user's game", async () => {
    const a = await signedInAgent("one@example.com");
    const b = await signedInAgent("two@example.com");
    const { body } = await a.post("/api/games").expect(201);
    await b.post(`/api/games/${body.game.id}/move`).send({ uci: "e2e4" }).expect(404);
  });
});
