import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { rememberUserData } from "../src/pronote/userdata.js";
import { fakeSession } from "./fake-session.js";
import { buildApp, createSession, get, post } from "./helpers/app.js";

const { callFunction } = await import("../src/teacher/functions.js");
const { checkFormat, isValidated, validatedVersions } = await import("../src/pronote/formats.js");
const { readCache } = await import("../src/cache.js");

const page = JSON.parse(readFileSync(new URL("./fixtures/timetable-page.json", import.meta.url), "utf8"));

test("a renamed member of a Pronote answer gives pronote_format_changed with the function and the member", async () => {
  const { ListeCours, ...rest } = page;
  const renamed = { ...rest, ListeDesCours: ListeCours };
  const session = fakeSession({ PageEmploiDuTemps: () => renamed });
  await assert.rejects(callFunction(session, "timetablePage", {}), (error: any) => {
    assert.equal(error.status, 502);
    assert.equal(error.code, "pronote_format_changed:PageEmploiDuTemps:ListeCours");
    assert.equal(error.extra.function, "PageEmploiDuTemps");
    assert.equal(error.extra.field, "ListeCours");
    return true;
  });
  // The real format and an empty answer pass.
  assert.ok(await callFunction(fakeSession({ PageEmploiDuTemps: () => page }), "timetablePage", {}));
  assert.deepEqual(await callFunction(fakeSession({ PageEmploiDuTemps: () => ({}) }), "timetablePage", {}), {});
  assert.doesNotThrow(() => checkFormat("FonctionInconnue", { x: 1 }));
  assert.doesNotThrow(() => checkFormat("PageEmploiDuTemps", { autre: 1 }, { PRONOTEIO_FORMAT_CHECK: "off" }));
});

test("unknown Pronote version: reads allowed with a warning header, writes refused unless allowed", async () => {
  readCache.clear();
  const app = await buildApp({ logger: false });
  const session = fakeSession({ ListeEleves: () => ({ listeEleves: { _T: 24, V: [] } }) });
  (session as any).instance.version = [2026, 3, 1];
  rememberUserData(session, { resources: [{ id: "1#c1", label: "T06", genre: 1 as const, taught: true, principal: false }], tabs: [16] });
  const id = createSession(session);

  const read = await get(app, "/roster?resource=c%3AT06", id);
  assert.equal(read.statusCode, 200);
  assert.equal(read.headers["x-pronoteio-pronote-version"], "2026.3.1");
  assert.equal(read.headers["x-pronoteio-pronote-validated"], "false");

  const write = await post(app, "/timetable/lesson", { lesson: "l:2026-11-12 17:10|T06|AP", memo: "x" }, id);
  assert.equal(write.statusCode, 409);
  assert.equal(write.json().error, "pronote_format_changed");
  assert.equal(write.json().reason, "unvalidated_version");
  assert.equal(write.json().pronoteversion, "2026.3.1");
  assert.equal(session.calls.length, 1, "no call for the refused write");

  // A simulation is still allowed (nothing is written).
  const simulated = await post(app, "/timetable/lesson", { lesson: "l:2026-11-12 17:10|T06|AP", memo: "x", dryRun: true }, id);
  assert.notEqual(simulated.statusCode, 409);

  process.env.PRONOTEIO_ALLOW_UNVALIDATED_WRITES = "true";
  const allowed = await post(app, "/timetable/lesson", { lesson: "l:2026-11-12 17:10|T06|AP", memo: "x" }, id);
  delete process.env.PRONOTEIO_ALLOW_UNVALIDATED_WRITES;
  assert.equal(allowed.json().error, "write_mode_simulate", "passes the version check, stopped by the write mode");
  await app.close();
});

test("validated versions", () => {
  assert.deepEqual(validatedVersions({}), ["2026.2.8"]);
  assert.equal(isValidated("2026.2.8", {}), true);
  assert.equal(isValidated("2026.2.9", {}), false);
  assert.equal(isValidated("2026.2.9", { PRONOTEIO_VALIDATED_VERSIONS: "2026.2.8, 2026.2.9" }), true);
});
