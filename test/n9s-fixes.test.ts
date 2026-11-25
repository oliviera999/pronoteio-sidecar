import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "../src/errors.js";
import { requestShape, writeComments } from "../src/teacher/commentsWrite.js";
import { matchStudent, stableId } from "../src/teacher/ids.js";
import { positioningRequest, writePositioning } from "../src/teacher/positioningWrite.js";
import { gridSession, lyceeGrid, lyceeService, sixthGrid, sixthLine } from "./helpers/report-grid-fixtures.js";

/* 0.17.1 (lot N9s): corrections of the overall review. Fake Pronote session only (never a real server). */

const sixthServiceId = stableId("service", "SCIENCES ET TECHNOLOGIE|6-SC-603");

const rejects = async (promise: Promise<unknown>, status: number, code: string) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof HttpError, String(error));
    assert.deepEqual([error.status, error.code], [status, code]);
    return true;
  });
};

/** Grid of the 6e group with a homonym of ELEVE E02 (another student, another N), after the first one. */
const homonymGrid = () => {
  const grid = sixthGrid();
  const second = { ...sixthLine("E02", { N: "23#604", G: 1, L: "604" }), eleve: { N: "46#E02b", G: 4, L: "ELEVE E02" } };
  grid.listeLignes.V.push(second as (typeof grid.listeLignes.V)[number]);
  return grid;
};

/* ---- 1. student identifier ---- */

test("matchStudent: bare name as before, stable id e:NOM Prénom, ~n of a homonym, hashed id", () => {
  const rows = [{ L: "ELEVE Un" }, { L: "ÉLÈVE Deux" }, { L: "ELEVE Un" }];
  const label = (row: { L: string }) => row.L;
  assert.equal(matchStudent(rows, "eleve un", label), rows[0]);
  assert.equal(matchStudent(rows, "ELEVE Deux", label), rows[1]);
  assert.equal(matchStudent(rows, "e:ELEVE Un", label), rows[0]);
  assert.equal(matchStudent(rows, "e:ELEVE Un~2", label), rows[2]);
  assert.equal(matchStudent(rows, "e:eleve un~2", label), rows[2], "compared as a bare name once the prefix is removed");
  assert.equal(matchStudent(rows, "e:ÉLÈVE Deux", label), rows[1]);
  assert.equal(matchStudent(rows, "e:ELEVE Un~3", label), undefined);
  assert.equal(matchStudent(rows, "e:ELEVE Trois", label), undefined);
  assert.equal(matchStudent(rows, "ELEVE Trois", label), undefined);
  const long = [{ L: `ELEVE ${"X".repeat(90)}` }];
  assert.equal(matchStudent(long, stableId("student", long[0].L), label), long[0]);
});

test("POST /reports/positioning: the student may be named e:NOM Prénom, and ~2 picks the homonym", async () => {
  const write = (student: string, dryRun = true) =>
    ({ resource: "g:6-SC-603", period: "T1", service: sixthServiceId, items: [{ student, kind: "positioning" as const, value: 4 }], dryRun });
  const fake = gridSession({ grid: homonymGrid });
  const first = await writePositioning(fake, write("e:ELEVE E02"));
  assert.equal((first.requests[0].eleve as { N: string }).N, "46#E02");
  const second = await writePositioning(fake, write("e:ELEVE E02~2"));
  assert.equal((second.requests[0].eleve as { N: string }).N, "46#E02b");
  const bare = await writePositioning(fake, write("ELEVE E02"));
  assert.equal((bare.requests[0].eleve as { N: string }).N, "46#E02", "a bare name is the first of that name, as before");
  const missing = await writePositioning(fake, write("e:ELEVE E02~3"));
  assert.deepEqual(missing.skipped, [{ student: "e:ELEVE E02~3", kind: "positioning", reason: "student_not_found" }]);
  assert.equal(fake.calls.some((item) => /^Saisie/.test(item.name)), false, "simulation sends nothing");
  // A real write goes to the homonym's own cell.
  await writePositioning(fake, write("e:ELEVE E02~2", false));
  const sent = fake.calls.filter((item) => item.name === "SaisiePositionnement");
  assert.deepEqual(sent.map((item) => item.data?.eleve?.N), ["46#E02b"]);
  await rejects(writePositioning(fake, write("e:ELEVE E02~3", false)), 404, "student_not_found:e:ELEVE E02~3");
});

test("POST /reports/comments: the student may be named e:NOM Prénom, and ~2 picks the homonym", async () => {
  const grid = () => ({ ...lyceeGrid, listeLignes: { _T: 24, V: [...lyceeGrid.listeLignes.V,
    { eleve: { N: "46#L01b", G: 4, L: "ELEVE L01" }, appA: { G: 1, estEditable: true } }] } });
  const fake = gridSession({ grid });
  const write = (student: string) => ({ class: "c:T06", period: "p:Trimestre 1", items: [{ student, kind: "subject" as const, text: "Essai" }], dryRun: true });
  const first = await writeComments(fake, write("e:ELEVE L01"));
  assert.equal((first.requests[0].eleve as { N: string }).N, "46#L01");
  const second = await writeComments(fake, write("e:ELEVE L01~2"));
  assert.equal((second.requests[0].eleve as { N: string }).N, "46#L01b");
  assert.deepEqual(second.before, [{ student: "ELEVE L01", kind: "subject", text: "" }]);
  const bare = await writeComments(fake, write("ELEVE L02"));
  assert.equal((bare.requests[0].eleve as { N: string }).N, "46#L02");
  await rejects(writeComments(fake, write("e:ELEVE L01~3")), 404, "student_not_found:e:ELEVE L01~3");
  assert.equal(fake.calls.some((item) => /^Saisie/.test(item.name)), false);
});

/* ---- 2. service of the comments ---- */

test("POST /reports/comments: optional service chooses among several services of the class; unknown → 404", async () => {
  const svt = { N: "5#svt", L: "SVT", matiere: { _T: 24, V: { N: "9#svt", L: "SVT" } }, classe: lyceeService.classe };
  const fake = gridSession({ extra: { ListeServices: () => ({ services: { _T: 24, V: [{ ...lyceeService, N: "5#es" }, svt] } }) } });
  const write = (service?: string) => ({ class: "c:T06", period: "p:Trimestre 1", items: [{ student: "ELEVE L02", kind: "subject" as const, text: "Essai" }],
    dryRun: true, ...(service === undefined ? {} : { service }) });
  // Without service: the service found as before (the first one of the class).
  const before = await writeComments(fake, write());
  assert.deepEqual(before.requests[0].service, { N: "5#es", L: "ENSEIGNEMENT SCIENTIFIQUE" });
  const empty = await writeComments(fake, write(""));
  assert.deepEqual(empty.requests[0].service, { N: "5#es", L: "ENSEIGNEMENT SCIENTIFIQUE" });
  // With the stable id of the second service: its grid is read and its N is sent.
  const chosen = await writeComments(fake, write(stableId("service", "SVT|T06")));
  assert.deepEqual(chosen.requests[0].service, { N: "5#svt", L: "SVT" });
  assert.equal(fake.calls.filter((item) => item.name === "PageApprBulletin").at(-1)!.data?.service?.N, "5#svt");
  await rejects(writeComments(fake, write(stableId("service", "PHYSIQUE|T06"))), 404, "service_not_found");
  assert.equal(fake.calls.some((item) => /^Saisie/.test(item.name)), false);
});

/* ---- 3. access log ---- */

test("requestShape of SaisiePositionnement: the genre of positionnement (the value entered) is not kept", () => {
  const row = { student: { N: "46#E02", G: 4, L: "ELEVE E02" }, classe: { N: "23#603", G: 1, L: "603" }, service: { N: "131#st", L: "ST" } } as any;
  const target = { period: { N: "105#t1", G: 2, L: "Trimestre 1" } } as any;
  const shape = requestShape(positioningRequest(row, target, { N: "93#4", G: 4, L: "Très bonne maîtrise" }));
  assert.equal(shape, "classe{G=1,L,N}|eleve{G=4,L,N}|estPourElementCompetence=boolean|periode{G=2,L,N}|positionnement{G,L,N}|service{L,N}");
  assert.doesNotMatch(shape, /positionnement\{[^}]*G=|Très|93#/);
  // The other members keep their genre (comments unchanged).
  assert.match(requestShape({ appreciation: { G: 1, L: "x", E: 2 } }), /^appreciation\{E=2,G=1,L\}$/);
});
