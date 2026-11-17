import assert from "node:assert/strict";
import { test } from "node:test";
import { rememberUserData } from "../src/pronote/userdata.js";
import { fakeSession } from "./fake-session.js";
import { buildApp, createSession, signedHeaders } from "./helpers/app.js";

const { proxyStats } = await import("../src/auth.js");
const { readCache } = await import("../src/cache.js");

test("a read delivered twice by the web server while it runs: same answer, one Pronote call, delay measured", async () => {
  readCache.clear();
  const app = await buildApp({ logger: false });
  await app.ready();
  let release!: () => void;
  const slow = new Promise<void>((resolve) => (release = resolve));
  const session = fakeSession({
    ListeEleves: () => ({ listeEleves: { _T: 24, V: [{ N: "4#e1", L: "MARTIN Léa", G: 4 }] } }),
  });
  // Slow Pronote: the first delivery is still running when the second arrives.
  const fetcher = session.fetcher;
  (session as any).fetcher = async (request: unknown) => {
    await slow;
    return fetcher(request as any);
  };
  rememberUserData(session, { resources: [{ id: "1#c1", label: "T06", genre: 1 as const, taught: true, principal: false }], tabs: [16] });
  const id = createSession(session);
  const url = "/roster?resource=c%3AT06";
  const headers = signedHeaders("GET", url, "", id);
  const before = proxyStats().duplicates;
  const first = app.inject({ method: "GET", url, headers });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const second = app.inject({ method: "GET", url, headers });
  await new Promise((resolve) => setTimeout(resolve, 30));
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  assert.equal(b.body, a.body);
  assert.equal(b.headers["x-pronoteio-duplicate"], "shared");
  assert.equal(session.calls.filter((call) => call.name === "ListeEleves").length, 1);
  const stats = proxyStats();
  assert.equal(stats.duplicates, before + 1);
  assert.ok(stats.minDelayMs !== null && stats.minDelayMs >= 0, JSON.stringify(stats));
  assert.ok(stats.whileRunning >= 1);
  await app.close();
});
