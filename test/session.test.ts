import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionHandle } from "pawnote";
import { rememberUserData } from "../src/pronote/userdata.js";
import { fakeSession } from "./fake-session.js";
import { buildApp, createSession, get, post } from "./helpers/app.js";

const { readCache } = await import("../src/cache.js");
const { callPronote } = await import("../src/pronote/request.js");
const { keepAlive, sessionStats, setPresenceSender, setReconnector } = await import("../src/session.js");
const { StateStore } = await import("../src/state.js");
const { accountKey } = await import("../src/tokenStore.js");

const classT06 = { id: "1#c1", label: "T06", genre: 1 as const, taught: true, principal: false };
const login = { url: "https://demo.example/pronote", username: "prof", deviceuuid: "device-0001" };

const rosterSession = () => {
  const session = fakeSession({
    ListeEleves: () => ({ listeEleves: { _T: 24, V: [{ N: "4#e1", L: "MARTIN Léa", G: 4 }] } }),
    SaisieNotes: () => ({}),
  });
  rememberUserData(session, { resources: [classT06], tabs: [16, 105] });
  return session;
};

/** Session whose Pronote calls all answer "La page a expiré" (Pronote session gone). */
const expiredSession = () => {
  const session = rosterSession();
  (session as any).fetcher = async () => ({ content: "<html>La page a expiré</html>", headers: {}, status: 200 });
  return session;
};

test("expired session: reconnection with the token chain, then the request is replayed once", async () => {
  readCache.clear();
  const app = await buildApp({ logger: false });
  let logins = 0;
  const fresh = rosterSession();
  setReconnector(async () => {
    logins++;
    return fresh;
  });
  const old = expiredSession();
  const id = createSession(old, { key: accountKey(login.url, login.username, login.deviceuuid), login });
  const answer = await get(app, "/roster?resource=c%3AT06", id);
  assert.equal(answer.statusCode, 200, answer.body);
  assert.equal(answer.json().items.length, 1);
  assert.equal(logins, 1);
  assert.equal(fresh.calls.filter((call) => call.name === "ListeEleves").length, 1);
  const stats = sessionStats();
  assert.ok(stats.states.some((item) => item.reconnects === 1 && item.state === "open"));
  setReconnector(null);
  await app.close();
});

test("two requests during a reconnection: one login only", async () => {
  readCache.clear();
  const app = await buildApp({ logger: false });
  let logins = 0;
  setReconnector(async () => {
    logins++;
    await new Promise((resolve) => setTimeout(resolve, 100));
    return rosterSession();
  });
  const id = createSession(expiredSession(), { key: accountKey(login.url, "prof2", login.deviceuuid), login: { ...login, username: "prof2" } });
  const [a, b] = await Promise.all([get(app, "/roster?resource=c%3AT06", id), get(app, "/roster?resource=c%3AT06&x=1", id)]);
  assert.equal(a.statusCode, 200, a.body);
  assert.equal(b.statusCode, 200, b.body);
  assert.equal(logins, 1);
  setReconnector(null);
  await app.close();
});

test("a write whose write call was sent is not replayed after a lost session", async () => {
  const app = await buildApp({ logger: false });
  let logins = 0;
  setReconnector(async () => {
    logins++;
    return rosterSession();
  });
  const session = rosterSession();
  const fetcher = session.fetcher;
  let calls = 0;
  (session as any).fetcher = async (request: any) => (++calls === 1 ? fetcher(request) : { content: "La page a expiré", headers: {}, status: 200 });
  app.post("/test/write", async (request) => {
    const handle = (await import("../src/session.js")).requireSession(request);
    await callPronote(handle, { name: "SaisieNotes", data: {} });
    await callPronote(handle, { name: "ListeEleves", data: {} });
    return { ok: true };
  });
  const id = createSession(session, { key: accountKey(login.url, "prof3", login.deviceuuid), login: { ...login, username: "prof3" } });
  const answer = await post(app, "/test/write", {}, id);
  assert.equal(answer.statusCode, 401);
  assert.equal(answer.json().error, "session_expired");
  assert.equal(logins, 0);
  setReconnector(null);
  await app.close();
});

test("a token login of an account whose session is open gets it back, without a new Pronote login", async () => {
  const app = await buildApp({ logger: false });
  const handle = rosterSession() as SessionHandle;
  const id = createSession(handle, { key: accountKey(login.url, "prof4", login.deviceuuid), login: { ...login, username: "prof4" } });
  const answer = await post(app, "/session/login", { url: `${login.url}/professeur.html`, username: "prof4", deviceuuid: login.deviceuuid,
    token: "jeton-courant" });
  assert.equal(answer.statusCode, 200, answer.body);
  assert.equal(answer.json().sessionid, id);
  assert.equal(answer.json().token, "jeton-courant");
  assert.equal(answer.json().reused, true);
  await app.close();
});

test("keep-alive: presence on idle sessions, reconnection when the presence finds the session gone", async () => {
  const sent: SessionHandle[] = [];
  let logins = 0;
  setReconnector(async () => {
    logins++;
    return rosterSession();
  });
  const idle = rosterSession();
  createSession(idle, { key: accountKey(login.url, "prof5", login.deviceuuid), login: { ...login, username: "prof5" } });
  setPresenceSender(async (handle) => {
    sent.push(handle);
    if (handle === idle) {
      const { SessionExpiredError } = await import("pawnote");
      throw new SessionExpiredError();
    }
  });
  await keepAlive(Date.now() + 10 * 60_000 - 1);
  assert.ok(sent.includes(idle));
  assert.equal(logins, 1);
  setPresenceSender(null);
  setReconnector(null);
});

test("restart: counters of the rate limiter, last errors and reconnections are found again", () => {
  const dir = mkdtempSync(join(tmpdir(), "sidecar-state-"));
  const file = join(dir, "state.json");
  const first = new StateStore(file);
  first.state.limiter = { served: 42, refused: 3 };
  first.recordError({ code: "rate_limited", error: "rate_limited", route: "/students/files", status: 429 });
  first.recordReconnect("expired", true);
  first.state.pronote = { version: "2026.2.8", validated: true, seenAt: new Date().toISOString() };
  first.save();
  const second = new StateStore(file);
  assert.deepEqual(second.state.limiter, { served: 42, refused: 3 });
  assert.equal(second.state.errors[0].code, "rate_limited");
  assert.equal(second.state.errors[0].route, "/students/files");
  assert.equal(second.state.reconnects.expired, 1);
  assert.equal(second.state.pronote.version, "2026.2.8");
  rmSync(dir, { recursive: true });
});
