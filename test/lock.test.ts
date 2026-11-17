import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { rememberUserData } from "../src/pronote/userdata.js";
import { fakeSession } from "./fake-session.js";
import { buildApp, createSession, get } from "./helpers/app.js";

const { acquireLock, lockState, releaseLock, tryAcquire } = await import("../src/lock.js");

test("a second process signals itself and never calls Pronote while the lock is held", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sidecar-lock-"));
  const file = join(dir, "pronoteio-sidecar.lock");
  // Lock held by another live process (the parent of the test runner), with a fresh heartbeat.
  writeFileSync(file, JSON.stringify({ pid: process.ppid, started: new Date().toISOString() }));
  const state = acquireLock(file);
  assert.equal(state.primary, false);
  assert.equal(state.holder, process.ppid);

  const app = await buildApp({ logger: false });
  const session = fakeSession({ ListeEleves: () => ({ listeEleves: { _T: 24, V: [] } }) });
  rememberUserData(session, { resources: [{ id: "1#c1", label: "T06", genre: 1 as const, taught: true, principal: false }], tabs: [16] });
  const answer = await get(app, "/roster?resource=c%3AT06", createSession(session));
  assert.equal(answer.statusCode, 503);
  assert.equal(answer.json().error, "pronote_unavailable");
  assert.equal(answer.json().reason, "second_process");
  assert.equal(session.calls.length, 0);

  // The other process stops: this one becomes the primary at its next try.
  rmSync(file);
  await new Promise((resolve) => setTimeout(resolve, 2_300));
  assert.equal(lockState().primary, true);
  assert.equal((await get(app, "/roster?resource=c%3AT06", createSession(session))).statusCode, 200);
  releaseLock();
  assert.equal(existsSync(file), false);
  await app.close();
  rmSync(dir, { recursive: true });
});

test("a stale lock (process gone) is taken over", () => {
  const dir = mkdtempSync(join(tmpdir(), "sidecar-lock-"));
  const file = join(dir, "lock");
  writeFileSync(file, JSON.stringify({ pid: 2147483646 }));
  assert.equal(tryAcquire(file), true);
  rmSync(dir, { recursive: true });
});
