import assert from "node:assert/strict";
import { test } from "node:test";
import { rememberUserData } from "../src/pronote/userdata.js";
import { fakeSession } from "./fake-session.js";
import { buildApp, createSession, signedHeaders } from "./helpers/app.js";

const { config } = await import("../src/config.js");
const { ANSWER_TTL, securityStats } = await import("../src/auth.js");
const { addressAllowed } = await import("../src/address.js");
const { TokenStore } = await import("../src/tokenStore.js");
const { readCache } = await import("../src/cache.js");

const mutable = config as unknown as { secrets: string[]; allowedIps: string[]; maxSkew: number };

const rosterApp = async () => {
  readCache.clear();
  const app = await buildApp({ logger: false });
  const session = fakeSession({ ListeEleves: () => ({ listeEleves: { _T: 24, V: [] } }) });
  rememberUserData(session, { resources: [{ id: "1#c1", label: "T06", genre: 1 as const, taught: true, principal: false }], tabs: [16] });
  return { app, id: createSession(session) };
};

const url = "/roster?resource=c%3AT06";

test("the window of a signature is 60 s: an older signature is refused", async () => {
  assert.equal(config.maxSkew, 60);
  const { app, id } = await rosterApp();
  const old = await app.inject({ method: "GET", url, headers: signedHeaders("GET", url, "", id, { timestamp: Math.floor(Date.now() / 1000) - 61 }) });
  assert.equal(old.statusCode, 401);
  assert.equal(old.json().error, "invalid_timestamp");
  const fresh = await app.inject({ method: "GET", url, headers: signedHeaders("GET", url, "", id, { timestamp: Math.floor(Date.now() / 1000) - 30 }) });
  assert.equal(fresh.statusCode, 200);
  await app.close();
});

test("a replay is refused (duplicate_write); a late second delivery of a just-answered request is still served", async (t) => {
  const { app, id } = await rosterApp();
  const headers = signedHeaders("GET", url, "", id);
  assert.equal((await app.inject({ method: "GET", url, headers })).statusCode, 200);
  // 90 s later: beyond the window, but the answer is kept (web server delivering it again): same answer.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 90_000 });
  const late = await app.inject({ method: "GET", url, headers });
  assert.equal(late.statusCode, 200);
  assert.equal(late.headers["x-pronoteio-duplicate"], "shared");
  // Once the answer is forgotten: refused as a replay, not as a clock problem.
  t.mock.timers.setTime(Date.now() + ANSWER_TTL);
  const replay = await app.inject({ method: "GET", url, headers });
  t.mock.timers.reset();
  assert.equal(replay.statusCode, 401);
  assert.equal(replay.json().error, "replayed_request");
  assert.equal(replay.json().code, "duplicate_write");
  await app.close();
});

test("key rotation: the previous secret is accepted during the transition, an unknown one refused", async () => {
  const previous = "ancien-secret-0123456789abcdef";
  mutable.secrets.push(previous);
  try {
    const { app, id } = await rosterApp();
    const before = securityStats.previousKeyUses;
    const withOld = await app.inject({ method: "GET", url, headers: signedHeaders("GET", url, "", id, { key: previous }) });
    assert.equal(withOld.statusCode, 200);
    assert.equal(securityStats.previousKeyUses, before + 1);
    const unknown = await app.inject({ method: "GET", url, headers: signedHeaders("GET", url, "", id, { key: "inconnu-0123456789abcdef" }) });
    assert.equal(unknown.statusCode, 401);
    assert.equal(unknown.json().error, "invalid_signature");
    await app.close();
  } finally {
    mutable.secrets.pop();
  }
  // The token chain written with the previous secret stays readable after the rotation.
  const old = new TokenStore(null, "ancien-secret-0123456789abcdef");
  old.record("compte", null, "jeton-1");
  const store = new TokenStore(null, "nouveau-secret-0123456789abcdef", Date.now, ["ancien-secret-0123456789abcdef"]);
  (store as any).memory = (old as any).memory;
  assert.equal(store.latest("compte"), "jeton-1");
  assert.equal(new TokenStore(null, "nouveau-secret-0123456789abcdef").latest("compte"), null);
});

test("an address that is not the Moodle server is refused; public routes stay open", async () => {
  mutable.allowedIps.push("10.0.0.1", "192.168.10.0/24");
  try {
    const { app, id } = await rosterApp();
    const other = await app.inject({ method: "GET", url, headers: signedHeaders("GET", url, "", id), remoteAddress: "10.0.0.2" });
    assert.equal(other.statusCode, 403);
    assert.equal(other.json().error, "address_not_allowed");
    assert.equal(other.json().code, "forbidden");
    const moodle = await app.inject({ method: "GET", url, headers: signedHeaders("GET", url, "", id), remoteAddress: "10.0.0.1" });
    assert.equal(moodle.statusCode, 200);
    const network = await app.inject({ method: "GET", url: `${url}&n=1`, headers: signedHeaders("GET", `${url}&n=1`, "", id), remoteAddress: "192.168.10.42" });
    assert.equal(network.statusCode, 200);
    const health = await app.inject({ method: "GET", url: "/health/public", remoteAddress: "10.0.0.2" });
    assert.equal(health.statusCode, 200);
    await app.close();
  } finally {
    mutable.allowedIps.length = 0;
  }
  assert.equal(addressAllowed("::ffff:10.0.0.1", ["10.0.0.1"]), true);
  assert.equal(addressAllowed("10.0.1.1", ["10.0.0.0/24"]), false);
  assert.equal(addressAllowed("10.0.0.255", ["10.0.0.0/24"]), true);
  assert.equal(addressAllowed(undefined, ["10.0.0.1"]), false);
  assert.equal(addressAllowed("1.2.3.4", []), true);
});

test("credentials are never logged: the logger serializers keep neither URL, body nor headers", async () => {
  const lines: string[] = [];
  const app = await buildApp({ logStream: { write: (line: string) => void lines.push(line) } });
  const body = JSON.stringify({ url: "https://demo.example/pronote/professeur.html", username: "prof", deviceuuid: "device-0001", password: "mot-de-passe-secret" });
  await app.inject({ method: "POST", url: "/session/login", payload: body, headers: { ...signedHeaders("POST", "/session/login", body), "x-pronoteio-signature": "0".repeat(64) } });
  await app.close();
  const output = lines.join("");
  assert.equal(output.includes("mot-de-passe-secret"), false);
  assert.equal(output.includes("device-0001"), false);
});
