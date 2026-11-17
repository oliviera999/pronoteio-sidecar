import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { rememberUserData } from "../src/pronote/userdata.js";
import { fakeSession } from "./fake-session.js";
import { buildApp, createSession, get, signedHeaders } from "./helpers/app.js";

const { AccessLog } = await import("../src/logs.js");
const { readCache } = await import("../src/cache.js");

test("health: public view unsigned, full report signed, wrong signature refused", async () => {
  const app = await buildApp({ logger: false });
  const publicView = await app.inject({ method: "GET", url: "/health/public" });
  assert.equal(publicView.statusCode, 200);
  assert.deepEqual(Object.keys(publicView.json()).sort(), ["ok", "version"]);
  assert.equal(publicView.json().version, JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  const legacy = await app.inject({ method: "GET", url: "/health" });
  assert.deepEqual(legacy.json(), publicView.json());
  const forged = await app.inject({ method: "GET", url: "/health", headers: { ...signedHeaders("GET", "/health"), "x-pronoteio-signature": "0".repeat(64) } });
  assert.equal(forged.statusCode, 401);

  // An error, then the full report lists it.
  await get(app, "/roster?resource=c%3AT06", "session-inconnue");
  const full = await get(app, "/health");
  assert.equal(full.statusCode, 200);
  const health = full.json();
  for (const key of ["version", "commit", "node", "startedAt", "uptimeSeconds", "time", "session", "queue", "cache", "pronote", "errors", "proxy", "process"]) {
    assert.ok(key in health, key);
  }
  assert.equal(health.time.timezone, "Africa/Casablanca");
  assert.match(health.time.tzVersion, /^\d{4}[a-z]$/);
  assert.ok("size" in health.queue && "averageWaitMs" in health.queue && "tokens" in health.queue);
  assert.ok("hitRate" in health.cache);
  assert.ok("pronoteversion" in health.pronote && "validated" in health.pronote);
  assert.ok(health.errors.length <= 20);
  assert.equal(health.errors[0].code, "session_expired");
  assert.equal(health.errors[0].route, "/roster");
  assert.match(health.errors[0].at, /^\d{4}-\d{2}-\d{2}T/);
  await app.close();
});

test("logs: no student name nor id in the access log nor in the application log", async () => {
  readCache.clear();
  const dir = mkdtempSync(join(tmpdir(), "sidecar-logs-"));
  const file = join(dir, "access.log");
  const lines: string[] = [];
  const app = await buildApp({ logStream: { write: (line: string) => void lines.push(line) }, accessLog: new AccessLog(file) });
  const session = fakeSession({
    ListeEleves: () => ({ listeEleves: { _T: 24, V: [{ N: "4#e1", L: "MARTIN Léa", G: 4 }] } }),
    FicheEleve: () => ({ Erreur: { Titre: "Fiche de MARTIN Léa (4#e1) indisponible" } }),
  });
  rememberUserData(session, { resources: [{ id: "1#c1", label: "T06", genre: 1 as const, taught: true, principal: false }], tabs: [16, 105] });
  const id = createSession(session);
  assert.equal((await get(app, "/roster?resource=c%3AT06", id)).statusCode, 200);
  const failing = await get(app, `/students/files?resource=c%3AT06&student=${encodeURIComponent("e:MARTIN Léa")}`, id);
  assert.ok(failing.statusCode >= 200);
  await get(app, `/students/photo?resource=c%3AT06&student=${encodeURIComponent("e:MARTIN Léa")}`, id);
  await app.close();
  const access = readFileSync(file, "utf8");
  const output = `${access}\n${lines.join("")}`;
  assert.ok(access.split("\n").filter(Boolean).length >= 3);
  const entry = JSON.parse(access.split("\n")[0]);
  assert.equal(entry.route, "/roster");
  assert.equal(entry.status, 200);
  assert.ok(typeof entry.ms === "number" && typeof entry.bytes === "number");
  for (const forbidden of ["MARTIN", "Léa", "L%C3%A9a", "4#e1", "e%3AMARTIN", id]) {
    assert.equal(output.includes(forbidden), false, `log contains ${forbidden}`);
  }
  rmSync(dir, { recursive: true });
});

test("log rotation by size, number of files kept", () => {
  const dir = mkdtempSync(join(tmpdir(), "sidecar-rotate-"));
  const file = join(dir, "a.log");
  const log = new AccessLog(file, 400, 3);
  for (let i = 0; i < 40; i++) log.write({ method: "GET", route: "/roster", status: 200, ms: i, bytes: 10 });
  const files = readdirSync(dir).sort();
  assert.deepEqual(files, ["a.log", "a.log.1", "a.log.2"]);
  assert.ok(readFileSync(file, "utf8").length <= 400);
  assert.equal(existsSync(join(dir, "a.log.3")), false);
  rmSync(dir, { recursive: true });
});
