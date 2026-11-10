import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { test } from "node:test";
import Fastify from "fastify";

process.env.PRONOTEIO_SECRET = "test-secret-0123456789abcdef";
const { signedPayload, registerAuth } = await import("../src/auth.js");
const { toHttp } = await import("../src/errors.js");

/**
 * Reproduction of the replayed_request seen in production on 10/11/2026: the web server in front of the sidecar
 * (Apache + Passenger) delivered the same signed request a second time while a slow read (one FicheEleve call per
 * student) was still running. The second delivery carries the same timestamp, nonce and signature: the replay
 * protection refused it with 401 replayed_request, and that answer is the one Moodle received.
 */
const sign = (timestamp: string, nonce: string, method: string, url: string, body = "") =>
  createHmac("sha256", process.env.PRONOTEIO_SECRET!).update(signedPayload(timestamp, nonce, method, url, body)).digest("hex");

const signedHeaders = (method: string, url: string, body = "") => {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString("hex");
  return {
    "x-pronoteio-timestamp": timestamp,
    "x-pronoteio-nonce": nonce,
    "x-pronoteio-signature": sign(timestamp, nonce, method, url, body),
  };
};

/** Sidecar-like app: the same auth hooks as server.ts, a slow read and a write. */
const buildApp = async () => {
  const app = Fastify();
  let reads = 0;
  let writes = 0;
  registerAuth(app);
  app.setErrorHandler((error, _request, reply) => {
    const [status, code] = toHttp(error);
    reply.status(status).send({ error: code });
  });
  app.get("/students/files", async () => {
    reads++;
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { available: true, read: reads };
  });
  app.post("/grades", async () => {
    writes++;
    return { saved: writes };
  });
  await app.ready();
  return { app, counts: () => ({ reads, writes }) };
};

test("a read delivered twice while it runs is answered twice, and Pronote is read only once", async () => {
  const { app, counts } = await buildApp();
  const url = "/students/files?resource=c%3AT06";
  const headers = signedHeaders("GET", url);
  const [first, second] = await Promise.all([
    app.inject({ method: "GET", url, headers }),
    // Second delivery of the very same request, 50 ms later (web server retry).
    new Promise<Awaited<ReturnType<typeof app.inject>>>((resolve) => {
      setTimeout(() => resolve(app.inject({ method: "GET", url, headers })), 50);
    }),
  ]);
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200, `second delivery refused: ${second.body}`);
  assert.deepEqual(second.json(), first.json());
  assert.equal(counts().reads, 1);
  await app.close();
});

test("a read replayed after its answer is still refused, with an explicit code", async () => {
  const { app } = await buildApp();
  const url = "/students/files?resource=c%3AT06";
  const headers = signedHeaders("GET", url);
  assert.equal((await app.inject({ method: "GET", url, headers })).statusCode, 200);
  const replay = await app.inject({ method: "GET", url, headers });
  assert.equal(replay.statusCode, 401);
  assert.equal(replay.json().error, "replayed_request");
  await app.close();
});

test("a write delivered twice is never executed twice", async () => {
  const { app, counts } = await buildApp();
  const body = JSON.stringify({ value: 12 });
  const headers = { ...signedHeaders("POST", "/grades", body), "content-type": "application/json" };
  const [first, second] = await Promise.all([
    app.inject({ method: "POST", url: "/grades", headers, payload: body }),
    app.inject({ method: "POST", url: "/grades", headers, payload: body }),
  ]);
  const statuses = [first.statusCode, second.statusCode].sort();
  assert.deepEqual(statuses, [200, 401]);
  assert.equal([first, second].find((r) => r.statusCode === 401)!.json().error, "replayed_request");
  assert.equal(counts().writes, 1);
  await app.close();
});

test("distinct requests (fresh nonce) are never confused", async () => {
  const { app, counts } = await buildApp();
  const url = "/students/files?resource=c%3AT06";
  const [a, b] = await Promise.all([
    app.inject({ method: "GET", url, headers: signedHeaders("GET", url) }),
    app.inject({ method: "GET", url, headers: signedHeaders("GET", url) }),
  ]);
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  assert.equal(counts().reads, 2);
  await app.close();
});
