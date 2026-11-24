import assert from "node:assert/strict";
import { test } from "node:test";
import "./helpers/app.js";

/* 0.17.0 (lot NS): the new routes through the whole application (signed requests, fake Pronote session). */
const { buildApp, createSession, get, post } = await import("./helpers/app.js");
const { gridSession } = await import("./helpers/report-grid-fixtures.js");
const { config } = await import("../src/config.js");
const { stableId } = await import("../src/teacher/ids.js");

const service = stableId("service", "SCIENCES ET TECHNOLOGIE|6-SC-603");
const body = (dryRun: boolean, items: unknown[] = [{ student: "ELEVE E02", kind: "positioning", value: 2 }]) =>
  ({ resource: "g:6-SC-603", period: "T1", service, items, dryRun });

test("routes: periods, grid, positioning; a real write outside the live mode is refused before any call", async () => {
  const app = await buildApp({ logger: false });
  const fake = gridSession();
  const id = createSession(fake, { key: "route-ns", login: { url: "https://demo.example/pronote", username: "prof-ns", deviceuuid: "d" } });
  const periods = await get(app, "/reports/periods?resource=c%3AT06", id);
  assert.equal(periods.statusCode, 200);
  assert.deepEqual(periods.json().periods.map((item: { code: string }) => item.code), ["T1", "T2", "T3", "BB1", "BB2", "CCF"]);
  const grid = await get(app, `/reports/grid?resource=g%3A6-SC-603&period=T1&service=${encodeURIComponent(service)}`, id);
  assert.deepEqual([grid.statusCode, grid.json().rows.length], [200, 3]);
  const plan = await post(app, "/reports/positioning", body(true, [{ student: "ELEVE E02", kind: "positioning", value: null },
    { student: "ELEVE E01", kind: "positioning", value: null }]), id);
  // null is kept (no coercion to 0): E02 is already empty (unchanged), E01 is reset with { N: 0, G: 0, L: "Aucun" }.
  assert.deepEqual(plan.json().skipped, [{ student: "ELEVE E02", kind: "positioning", reason: "unchanged" }]);
  assert.deepEqual(plan.json().requests[0].positionnement, { N: 0, G: 0, L: "Aucun" });
  if (config.writeMode !== "live") {
    const refused = await post(app, "/reports/positioning", body(false), id);
    assert.deepEqual([refused.statusCode, refused.json().error, refused.json().code], [403, "write_mode_simulate", "forbidden"]);
  }
  const tooMany = await post(app, "/reports/positioning", body(true, Array.from({ length: 101 }, () => ({ student: "ELEVE E02", kind: "lsu", value: "1" }))), id);
  assert.equal(tooMany.statusCode, 400);
  const outOfRange = await post(app, "/reports/positioning", body(true, [{ student: "ELEVE E02", kind: "lsu", value: "100,5" }]), id);
  assert.deepEqual([outOfRange.statusCode, outOfRange.json().error, outOfRange.json().code], [400, "lsu_out_of_range", "validation_failed"]);
  assert.equal(fake.calls.some((call) => /^Saisie/.test(call.name)), false, "nothing written");
  await app.close();
});
