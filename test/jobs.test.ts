import assert from "node:assert/strict";
import { test } from "node:test";
import { rememberUserData } from "../src/pronote/userdata.js";
import { fakeSession } from "./fake-session.js";
import { buildApp, createSession, get, post } from "./helpers/app.js";

const { readCache } = await import("../src/cache.js");
const { jobRoute } = await import("../src/jobs.js");

const classes = Array.from({ length: 10 }, (_, i) => ({ id: `1#c${i}`, label: `T0${i}`, genre: 1 as const, taught: true, principal: false }));

test("asynchronous job on 10 classes: 202 with a jobid, progress, then the results", async () => {
  readCache.clear();
  const app = await buildApp({ logger: false });
  const session = fakeSession({
    ListeEleves: (data) => ({ listeEleves: { _T: 24, V: [{ N: `4#${data?.Ressource?.N ?? "x"}`, L: `ELEVE ${data?.Ressource?.L ?? "?"}`, G: 4 }] } }),
  });
  rememberUserData(session, { resources: classes, tabs: [105, 16] });
  const id = createSession(session);
  const requests = classes.map((item) => ({ url: `/roster?resource=${encodeURIComponent(`c:${item.label}`)}` }));
  const created = await post(app, "/jobs", { requests }, id);
  assert.equal(created.statusCode, 202, created.body);
  const { jobid, progress } = created.json();
  assert.match(jobid, /^[0-9a-f-]{36}$/);
  assert.equal(progress.total, 10);

  const seen: number[] = [];
  let state: any;
  for (let i = 0; i < 200; i++) {
    state = (await get(app, `/jobs/${jobid}`, id)).json();
    seen.push(state.progress.done);
    if (state.status === "done") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(state.status, "done");
  assert.equal(state.progress.done, 10);
  assert.equal(state.results.length, 10);
  assert.ok(state.results.every((item: any) => item.status === 200 && item.body.items.length === 1));
  assert.deepEqual(state.results.map((item: any) => item.url), requests.map((item) => item.url));
  assert.ok(seen.some((value) => value > 0 && value < 10) || seen[0] === 10, "progress seen");
  assert.equal(session.calls.filter((call) => call.name === "ListeEleves").length, 10);

  // Another session does not see the job; unknown job: 404.
  const other = createSession(fakeSession({}));
  assert.equal((await get(app, `/jobs/${jobid}`, other)).statusCode, 404);
  assert.equal((await get(app, "/jobs/00000000-0000-0000-0000-000000000000", id)).statusCode, 404);
  await app.close();
});

test("jobs run reads of the listed routes only", async () => {
  assert.equal(jobRoute("/roster?resource=c%3AT06"), "/roster");
  assert.equal(jobRoute("/students/files?resource=c%3AT06&ids=e%3AA"), "/students/files");
  assert.equal(jobRoute("/session/login"), null);
  assert.equal(jobRoute("/jobs"), null);
  assert.equal(jobRoute("http://evil/roster"), null);
  const app = await buildApp({ logger: false });
  const id = createSession(fakeSession({}));
  const refused = await post(app, "/jobs", { requests: [{ url: "/grades" }, { url: "/session/logout" }] }, id);
  assert.equal(refused.statusCode, 400);
  await app.close();
});

test("the internal token is required to skip the signature", async () => {
  const app = await buildApp({ logger: false });
  const forged = await app.inject({ method: "GET", url: "/roster?resource=c%3AT06", headers: { "x-pronoteio-internal": "0".repeat(64) } });
  assert.equal(forged.statusCode, 401);
  await app.close();
});
