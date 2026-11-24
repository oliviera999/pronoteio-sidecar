import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "../src/errors.js";
import { stableId } from "../src/teacher/ids.js";
import { classPeriods, periodCode, periodKind, reportGrid } from "../src/teacher/reportGrid.js";
import { lsuValue, reportConfirms, writePositioning } from "../src/teacher/positioningWrite.js";
import { gridSession, semesterPeriods, sixthGrid } from "./helpers/report-grid-fixtures.js";

/* 0.17.0 (lot NS): periods of a class, grid of tab 25, positioning and LSU mark. Answers in the shapes of the capture
   of 24/11/2026 (test/helpers/report-grid-fixtures.ts); no call to a real Pronote. */

const sixthServiceId = stableId("service", "SCIENCES ET TECHNOLOGIE|6-SC-603");

const rejects = async (promise: Promise<unknown>, status: number, code: string) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof HttpError, String(error));
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });
};

/* ---- periods ---- */

test("periods of a class: trimesters, bac blancs and CCF with their kinds, codes and ranks (ListePeriodes, tab 25)", async () => {
  const fake = gridSession();
  const read = await classPeriods(fake, "c:T06");
  assert.deepEqual(read.resource, { id: "c:T06", name: "T06", genre: 1 });
  assert.equal(read.current, "p:Trimestre 1");
  assert.deepEqual(read.periods.map((item) => [item.code, item.kind, item.rank, item.genre, item.notation, item.current, item.closed]), [
    ["T1", "trimester", 1, 2, 1, true, false],
    ["T2", "trimester", 2, 2, 1, false, false],
    ["T3", "trimester", 3, 2, 1, false, false],
    ["BB1", "exam", 1, 4, 0, false, false],
    ["BB2", "exam", 2, 4, 0, false, false],
    ["CCF", "exam", 3, 4, 0, false, false],
  ]);
  assert.deepEqual([read.periods[0].id, read.periods[0].name, read.periods[0].start, read.periods[0].end], ["p:Trimestre 1", "Trimestre 1", null, null]);
  // The request of the client: { ressource, listeRessources } with tab 25.
  const call = fake.calls.find((item) => item.name === "ListePeriodes")!;
  assert.equal(call.onglet, 25);
  assert.deepEqual(call.data, { ressource: { N: "2#t06", G: 1, L: "T06" }, listeRessources: [{ N: "2#t06", G: 1, L: "T06" }] });
});

test("periods of a group: semesters, a closed one, dates from the instance when known", async () => {
  const fake = gridSession({ periods: semesterPeriods });
  Object.assign(fake.instance, { periods: [{ id: "105#s1", name: "Semestre 1", startDate: new Date(2026, 8, 1), endDate: new Date(2027, 0, 24) }] });
  const read = await classPeriods(fake, "g:6-SC-603");
  assert.equal(read.resource.genre, 2);
  assert.deepEqual(read.periods.map((item) => [item.code, item.kind, item.rank, item.closed, item.current, item.start, item.end]), [
    ["S1", "semester", 1, true, false, "2026-09-01", "2027-01-24"],
    ["S2", "semester", 2, false, true, null, null],
  ]);
  assert.equal(fake.calls.find((item) => item.name === "ListePeriodes")!.data?.ressource?.G, 2);
});

test("period kinds and codes: other periods, unnumbered exams, refusal of the periods", async () => {
  assert.equal(periodKind({ N: "1", G: 4, L: "Examen" }), "exam");
  assert.equal(periodKind({ N: "1", G: 3, L: "Année" }), "other");
  assert.equal(periodCode({ N: "1", L: "Épreuve commune" }, "exam", 2), "X2");
  assert.equal(periodCode({ N: "1", L: "Année" }, "other", 1), "P1");
  assert.equal(periodCode({ N: "1", L: "Brevet blanc" }, "exam", 1), "BB1");
  const refused = gridSession({ extra: { "ListePeriodes@25": () => ({ Erreur: { Titre: "Vos droits sont insuffisants" } }) } });
  await rejects(classPeriods(refused, "c:T06"), 403, "access_denied");
});

/* ---- grid ---- */

test("grid of a 6e group: positioning, LSU mark, levels, the student's own class, comments", async () => {
  const fake = gridSession();
  const grid = await reportGrid(fake, "g:6-SC-603", "T1", sixthServiceId);
  assert.equal(grid.available, true);
  assert.deepEqual(grid.class, { id: "g:6-SC-603", name: "6-SC-603" });
  assert.deepEqual(grid.period, { id: "p:Trimestre 1", name: "Trimestre 1" });
  assert.deepEqual(grid.service, { id: sixthServiceId, name: "SCIENCES ET TECHNOLOGIE - 6-SC-603" });
  assert.equal(grid.closed, false);
  assert.equal(grid.positioningType, 1);
  assert.deepEqual(grid.levels.slice(0, 2), [{ id: "93#1", genre: 1, name: "Très bonne maîtrise", status: "level" }, { id: "93#2", genre: 2, name: "Maîtrise satisfaisante", status: "level" }]);
  assert.equal(grid.levels.find((level) => level.genre === 7)?.status, "special");
  assert.deepEqual(grid.rows[0], { student: "ELEVE E01", classe: { id: "c:603", name: "603" }, positioning: { id: "93#2", genre: 2, name: "Maîtrise satisfaisante" },
    lsu: "15", positioningEditable: true, lsuEditable: true, nbEvals: 3, comment: { text: "", editable: true } });
  assert.deepEqual([grid.rows[1].positioning, grid.rows[1].lsu], [null, null]);
  assert.deepEqual([grid.rows[2].classe.name, grid.rows[2].positioningEditable, grid.rows[2].lsuEditable], ["604", false, false]);
  const page = fake.calls.find((item) => item.name === "PageApprBulletin")!;
  assert.equal(page.onglet, 25);
  assert.deepEqual(page.data, { ressource: { N: "60#g603", G: 2 }, periode: { N: "105#t1", G: 2 }, service: { N: "131#st" } });
});

test("grid of a lycée class without Pos. nor N. LSU: columns null, positioningType null; refusal → available false", async () => {
  const fake = gridSession();
  const grid = await reportGrid(fake, "c:T06", "p:Trimestre 1");
  assert.equal(grid.positioningType, null);
  assert.deepEqual(grid.levels, []);
  assert.deepEqual(grid.rows.map((row) => [row.student, row.positioning, row.lsu, row.positioningEditable, row.lsuEditable, row.comment?.text]), [
    ["ELEVE L01", null, null, false, false, "Bon trimestre"],
    ["ELEVE L02", null, null, false, false, ""],
  ]);
  assert.deepEqual(grid.rows[0].classe, { id: "c:T06", name: "T06" });
  const refused = gridSession({ extra: { PageApprBulletin: () => ({ Erreur: { Titre: "Vos droits sont insuffisants" } }) } });
  const none = await reportGrid(refused, "c:T06", "p:Trimestre 1");
  assert.deepEqual([none.available, none.reason, none.rows], [false, "access_denied", []]);
  await rejects(reportGrid(gridSession(), "g:6-SC-603", "T1", "s:INCONNU|X"), 404, "service_not_found");
});

/* ---- positioning ---- */

const write = (items: { student: string; kind: "positioning" | "lsu"; value: number | string | null }[], dryRun = false) =>
  ({ resource: "g:6-SC-603", period: "T1", service: sixthServiceId, items, dryRun });

test("positioning: creation and reset send exactly the requests of the capture, one per cell, then read again", async () => {
  const fake = gridSession();
  const result = await writePositioning(fake, write([
    { student: "ELEVE E02", kind: "positioning", value: 2 },
    { student: "ELEVE E01", kind: "positioning", value: null },
  ]));
  const sent = fake.calls.filter((item) => item.name === "SaisiePositionnement");
  assert.equal(sent.length, 2);
  assert.equal(sent[0].onglet, 25);
  assert.deepEqual(sent[0].data, {
    estPourElementCompetence: false,
    positionnement: { N: "93#2", G: 2, L: "Maîtrise satisfaisante" },
    classe: { N: "23#603", G: 1, L: "603" },
    periode: { N: "105#t1", G: 2, L: "Trimestre 1" },
    eleve: { N: "46#E02", G: 4, L: "ELEVE E02" },
    service: { N: "131#st", L: "SCIENCES ET TECHNOLOGIE" },
  });
  assert.deepEqual(sent[1].data?.positionnement, { N: 0, G: 0, L: "Aucun" });
  // Never a mass calculation.
  for (const call of fake.calls) {
    assert.ok(!/ValidationAuto|CalculAuto/.test(call.name));
    assert.ok(!JSON.stringify(call.data ?? {}).includes("estCalculAuto"));
  }
  assert.deepEqual(result.requests, sent.map((item) => item.data));
  assert.deepEqual(result.before, [{ student: "ELEVE E02", kind: "positioning", value: null }, { student: "ELEVE E01", kind: "positioning", value: 2 }]);
  assert.deepEqual(result.after, [{ student: "ELEVE E02", kind: "positioning", value: 2 }, { student: "ELEVE E01", kind: "positioning", value: null }]);
  assert.deepEqual([result.written, result.dryRun, result.done, result.stoppedAt, result.validated, result.skipped], [true, false, 2, null, false, []]);
  assert.equal(fake.calls.filter((item) => item.name === "PageApprBulletin").length, 2, "read before and after");
});

test("positioning: unchanged, not editable and unknown students are skipped; simulation sends nothing", async () => {
  const fake = gridSession();
  const result = await writePositioning(fake, write([
    { student: "ELEVE E01", kind: "positioning", value: 2 },
    { student: "ELEVE E03", kind: "positioning", value: 4 },
    { student: "ELEVE INCONNU", kind: "lsu", value: "12" },
    { student: "ELEVE E02", kind: "lsu", value: "12,5" },
  ], true));
  assert.deepEqual(result.skipped, [
    { student: "ELEVE E01", kind: "positioning", reason: "unchanged" },
    { student: "ELEVE E03", kind: "positioning", reason: "not_editable" },
    { student: "ELEVE INCONNU", kind: "lsu", reason: "student_not_found" },
  ]);
  assert.deepEqual(result.requests.map((item) => (item as any).posLSUNote), [{ _T: 10, V: "12,50" }]);
  assert.deepEqual([result.written, result.dryRun, result.done], [false, true, 0]);
  assert.equal(fake.calls.some((item) => /^Saisie/.test(item.name)), false);
  // A real write refuses an unknown student before any call.
  await rejects(writePositioning(fake, write([{ student: "ELEVE INCONNU", kind: "positioning", value: 2 }])), 404, "student_not_found:ELEVE INCONNU");
  assert.equal(fake.calls.some((item) => /^Saisie/.test(item.name)), false);
});

test("positioning: closed period skipped in simulation, 409 period_closed for a real write", async () => {
  const fake = gridSession({ grid: () => sixthGrid({}, "Saisie close") });
  const plan = await writePositioning(fake, write([{ student: "ELEVE E02", kind: "positioning", value: 1 }], true));
  assert.deepEqual(plan.skipped, [{ student: "ELEVE E02", kind: "positioning", reason: "period_closed" }]);
  await rejects(writePositioning(fake, write([{ student: "ELEVE E02", kind: "positioning", value: 1 }])), 409, "period_closed");
  assert.equal(fake.calls.some((item) => /^Saisie/.test(item.name)), false);
});

test("positioning: a refusal of Pronote and the exclusive mode are relayed, with what was done", async () => {
  const refused = gridSession({ writes: { SaisiePositionnement: () => ({ RapportSaisie: { _erreurSaisie_: true, _messagesErreur_: { _T: 24, V: ["Période clôturée"] } } }) } });
  await rejects(writePositioning(refused, write([{ student: "ELEVE E02", kind: "positioning", value: 1 }])), 409, "pronote_refused:Période clôturée");
  const exclusive = gridSession({ writes: { SaisieNoteLSU: () => ({ __signature: { ModeExclusif: true } }) } });
  await assert.rejects(writePositioning(exclusive, write([
    { student: "ELEVE E02", kind: "positioning", value: 1 },
    { student: "ELEVE E02", kind: "lsu", value: "10" },
  ])), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.deepEqual([error.status, error.code, error.extra.done], [409, "exclusive_mode", 1]);
    return true;
  });
});

test("positioning: stops at the first write whose RapportSaisie does not carry the value", async () => {
  const fake = gridSession({ writes: { SaisiePositionnement: (data) => ({ RapportSaisie: { service: data?.service, eleve: data?.eleve } }) } });
  await assert.rejects(writePositioning(fake, write([
    { student: "ELEVE E02", kind: "positioning", value: 4 },
    { student: "ELEVE E01", kind: "positioning", value: 1 },
  ])), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.deepEqual([error.status, error.code, error.extra.done], [502, "positioning_not_saved:ELEVE E02", 0]);
    return true;
  });
  assert.equal(fake.calls.filter((item) => item.name === "SaisiePositionnement").length, 1, "nothing after the first unconfirmed write");
});

test("LSU mark: write of \"15,00\", erasure with V \"\", out of range refused before any call", async () => {
  const fake = gridSession();
  const result = await writePositioning(fake, write([
    { student: "ELEVE E02", kind: "lsu", value: "15,00" },
    { student: "ELEVE E01", kind: "lsu", value: "" },
  ]));
  const sent = fake.calls.filter((item) => item.name === "SaisieNoteLSU");
  assert.deepEqual(sent[0].data, {
    classe: { N: "23#603", G: 1, L: "603" },
    periode: { N: "105#t1", G: 2, L: "Trimestre 1" },
    eleve: { N: "46#E02", G: 4, L: "ELEVE E02" },
    service: { N: "131#st", L: "SCIENCES ET TECHNOLOGIE" },
    posLSUNote: { _T: 10, V: "15,00" },
  });
  assert.deepEqual(sent[1].data?.posLSUNote, { _T: 10, V: "" });
  assert.deepEqual(result.after, [{ student: "ELEVE E02", kind: "lsu", value: "15" }, { student: "ELEVE E01", kind: "lsu", value: null }]);
  for (const bad of ["100,01", "-1", "abc", "15,123"]) {
    await rejects(writePositioning(fake, write([{ student: "ELEVE E02", kind: "lsu", value: bad }])), 400, "lsu_out_of_range");
  }
  assert.deepEqual([lsuValue("0"), lsuValue("100"), lsuValue("12.5"), lsuValue("")], ["0,00", "100,00", "12,50", ""]);
  assert.equal(reportConfirms({ posLSUNote: { _T: 10, V: "15" } }, "lsu", "15,00"), true);
  assert.equal(reportConfirms({ posLSUNote: { _T: 10, V: "14" } }, "lsu", "15,00"), false);
  assert.equal(reportConfirms({}, "lsu", ""), false);
  assert.equal(reportConfirms({ niveauAcqu: { G: 2 } }, "positioning", 2), true);
  assert.equal(reportConfirms({ service: {} }, "positioning", null), true);
});

test("positioning: an unknown level and a non integer value are refused before any call", async () => {
  const fake = gridSession();
  await rejects(writePositioning(fake, write([{ student: "ELEVE E02", kind: "positioning", value: 3 }])), 400, "positioning_level_unknown:3");
  await rejects(writePositioning(fake, write([{ student: "ELEVE E02", kind: "positioning", value: "2" }])), 400, "validation_failed:value");
  assert.equal(fake.calls.some((item) => /^Saisie/.test(item.name)), false);
});
