import assert from "node:assert/strict";
import { test } from "node:test";
import "./helpers/app.js";

/* 0.17.1 (lot N9s): the new request members through the whole application (signed requests, fake Pronote session). */
const { buildApp, createSession, post } = await import("./helpers/app.js");
const { gridSession, lyceeService } = await import("./helpers/report-grid-fixtures.js");
const { stableId } = await import("../src/teacher/ids.js");

test("routes: e:NOM Prénom on both writes, service on POST /reports/comments (kept by the schema, unknown → 404)", async () => {
  const app = await buildApp({ logger: false });
  const svt = { N: "5#svt", L: "SVT", matiere: { _T: 24, V: { N: "9#svt", L: "SVT" } }, classe: lyceeService.classe };
  const fake = gridSession({ extra: { ListeServices: () => ({ services: { _T: 24, V: [{ ...lyceeService, N: "5#es" }, svt] } }) } });
  const id = createSession(fake, { key: "route-n9s", login: { url: "https://demo.example/pronote", username: "prof-n9s", deviceuuid: "d" } });
  const comments = (extra: Record<string, unknown>) => post(app, "/reports/comments",
    { class: "c:T06", period: "p:Trimestre 1", items: [{ student: "e:ELEVE L02", kind: "subject", text: "Essai" }], dryRun: true, ...extra }, id);
  const chosen = await comments({ service: stableId("service", "SVT|T06") });
  assert.equal(chosen.statusCode, 200);
  assert.deepEqual(chosen.json().requests[0].service, { N: "5#svt", L: "SVT" });
  assert.equal(chosen.json().requests[0].eleve.N, "46#L02");
  const unknown = await comments({ service: stableId("service", "PHYSIQUE|T06") });
  assert.deepEqual([unknown.statusCode, unknown.json().error], [404, "service_not_found"]);
  const positioning = await post(app, "/reports/positioning", { resource: "g:6-SC-603", period: "T1",
    service: stableId("service", "SCIENCES ET TECHNOLOGIE|6-SC-603"), items: [{ student: "e:ELEVE E02", kind: "positioning", value: 4 }], dryRun: true }, id);
  assert.equal(positioning.statusCode, 200);
  assert.equal(positioning.json().requests[0].eleve.N, "46#E02");
  assert.equal(fake.calls.some((call) => /^Saisie/.test(call.name)), false, "nothing written");
  await app.close();
});
