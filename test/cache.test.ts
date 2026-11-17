import assert from "node:assert/strict";
import fs from "node:fs";
import { mock, test } from "node:test";
import Fastify from "fastify";
import { rememberUserData } from "../src/pronote/userdata.js";
import { fakeSession } from "./fake-session.js";
import { buildApp, createSession, get } from "./helpers/app.js";

const { ReadCache, cacheTtls, readCache, registerCache } = await import("../src/cache.js");

const classT06 = { id: "1#c1", label: "T06", genre: 1 as const, taught: true, principal: false };

const rosterSession = () => {
  const session = fakeSession({
    ListeEleves: () => ({ listeEleves: { _T: 24, V: [{ N: "4#e1", L: "MARTIN Léa", G: 4 }, { N: "4#e2", L: "PETIT Hugo", G: 4 }] } }),
  });
  rememberUserData(session, { resources: [classT06], tabs: [105, 16] });
  return session;
};

test("two identical reads within 10 s: one Pronote call, X-Cache miss then hit", async () => {
  readCache.clear();
  const app = await buildApp({ logger: false });
  const session = rosterSession();
  const id = createSession(session);
  const writes = mock.method(fs, "writeFileSync");
  const first = await get(app, "/roster?resource=c%3AT06", id);
  const second = await get(app, "/roster?resource=c%3AT06", id);
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers["x-cache"], "miss");
  assert.equal(second.headers["x-cache"], "hit");
  assert.equal(second.body, first.body);
  assert.equal(session.calls.filter((call) => call.name === "ListeEleves").length, 1);
  // Another session does not see the entry.
  const other = rosterSession();
  const third = await get(app, "/roster?resource=c%3AT06", createSession(other));
  assert.equal(third.headers["x-cache"], "miss");
  assert.equal(writes.mock.callCount(), 0, "nothing written on disk");
  writes.mock.restore();
  assert.ok(readCache.stats().hitRate > 0);
  await app.close();
});

test("a write invalidates the reads it changes, a simulation does not", async () => {
  const cache = new ReadCache({ "/roster": 60, "/grades/context": 60 });
  const app = Fastify();
  let reads = 0;
  registerCache(app, cache);
  app.get("/grades/context", async () => ({ read: ++reads }));
  app.get("/roster", async () => ({ read: ++reads }));
  app.post("/grades", async () => ({ ok: true }));
  const headers = { "x-pronoteio-session": "s1" };
  await app.inject({ method: "GET", url: "/grades/context?resource=c%3AT06", headers });
  await app.inject({ method: "GET", url: "/grades/context?resource=c%3AT05", headers });
  await app.inject({ method: "GET", url: "/roster?resource=c%3AT06", headers });
  assert.equal(cache.stats().entries, 3);
  await app.inject({ method: "POST", url: "/grades", headers, payload: { resource: "c:T06", dryRun: true } });
  assert.equal(cache.stats().entries, 3);
  await app.inject({ method: "POST", url: "/grades", headers, payload: { resource: "c:T06" } });
  // Grade context of T06 dropped; T05 and the roster (not changed by a grade) kept.
  assert.equal(cache.stats().entries, 2);
  const again = await app.inject({ method: "GET", url: "/grades/context?resource=c%3AT06", headers });
  assert.equal(again.headers["x-cache"], "miss");
  assert.equal((await app.inject({ method: "GET", url: "/grades/context?resource=c%3AT05", headers })).headers["x-cache"], "hit");
  await app.close();
});

test("lifetimes, expiry, size limit and unknown writes", () => {
  let now = 0;
  const cache = new ReadCache({ "/roster": 60, "/timetable": 0 }, 1000, () => now);
  const entry = (payload: string) => ({ session: "s", route: "/roster", params: { resource: "c:A" }, payload, contentType: "application/json" });
  cache.set("k1", entry("x".repeat(100)));
  assert.ok(cache.get("k1"));
  now = 61_000;
  assert.equal(cache.get("k1"), null);
  cache.set("k2", { ...entry("{}"), route: "/timetable" });
  assert.equal(cache.get("k2"), null, "lifetime 0: not cached");
  for (let i = 0; i < 6; i++) cache.set(`big${i}`, entry("y".repeat(240)));
  assert.ok(cache.stats().bytes <= 1000);
  assert.equal(cache.get("big0"), null, "oldest dropped first");
  assert.ok(cache.invalidate("s", "/unknown/write") > 0);
  assert.equal(cache.stats().entries, 0, "unknown write route: every entry of the session");
  const ttls = cacheTtls({ PRONOTEIO_CACHE_TTL: "30", PRONOTEIO_CACHE_TTLS: "/students/files=10,/nope=5" });
  assert.equal(ttls["/timetable"], 30);
  assert.equal(ttls["/students/files"], 10);
  assert.equal(ttls["/roster"], 120);
  assert.equal(ttls["/nope"], undefined);
  assert.equal(cacheTtls({ PRONOTEIO_CACHE_TTL: "0" })["/roster"], 0);
});

test("the cache module never touches the disk", () => {
  const code = fs.readFileSync(new URL("../src/cache.ts", import.meta.url), "utf8");
  assert.doesNotMatch(code, /from "node:fs"|require\("fs"\)|from "fs"/);
});
