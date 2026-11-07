import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { SessionHandle } from "pawnote";
import { ServerSideError } from "pawnote";
import { rememberUserData } from "../src/pronote/userdata.js";
import { fromWrittenTests, gradedFromPage, merge, plannedIdFor, writtenTestsFromAnswer } from "../src/teacher/assessments.js";
import type { PlannedAssessment } from "../src/normalise.js";

const page = JSON.parse(readFileSync(new URL("./fixtures/grades-page.json", import.meta.url), "utf8"));
const from = new Date(2026, 10, 1);
const to = new Date(2026, 10, 30);

test("graded assessments of PageNotes dated in range", () => {
  const service = page.service.V;
  const items = gradedFromPage(service, page, from, to, [], new Date(2026, 10, 7));
  assert.equal(items.length, 1);
  const [item] = items;
  assert.equal(item.source, "grades");
  assert.equal(item.title, "1er devoir");
  assert.deepEqual(item.groups, ["3A"]);
  assert.equal(item.subject, "MATHÉMATIQUES");
  assert.equal(item.coefficient, 1);
  assert.equal(item.max, 20);
  assert.equal(item.published, false, "published on 10/11, read on 07/11");
  assert.equal(item.kind, "graded");
  assert.equal(item.id, plannedIdFor(item.date, ["3A"], "1er devoir"));
  assert.equal(gradedFromPage(service, page, from, to, ["3B"]).length, 0);
  assert.equal(gradedFromPage(service, page, new Date(2026, 9, 1), to, ["3a"]).length, 3);
});

test("written tests of ListeDevoirSurTable", () => {
  const data = {
    liste: {
      _T: 24,
      V: [
        { date: { _T: 7, V: "12/11/2026 10:00:00" }, strProfesseurs: "M. DUPONT", strPublic: "3A, 3B", strMatiere: "HISTOIRE", strSalle: "12", strInfosLien: "Contrôle chap. 2", G: 0 },
        { date: { _T: 7, V: "12/12/2026 10:00:00" }, strPublic: "3A", strMatiere: "SVT" },
      ],
    },
  };
  const items = writtenTestsFromAnswer(data, from, to);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "written test");
  assert.deepEqual(items[0].groups, ["3A", "3B"]);
  assert.equal(items[0].details, "M. DUPONT, salle 12, Contrôle chap. 2");
});

const planned = (overrides: Partial<PlannedAssessment>): PlannedAssessment => ({
  id: "ev:x",
  source: "notebook",
  date: Math.floor(new Date(2026, 10, 12, 10).getTime() / 1000),
  end: null,
  subject: "MATHÉMATIQUES",
  groups: ["3A"],
  title: "DS n°1",
  kind: "Devoir sur table",
  published: true,
  publication: null,
  coefficient: null,
  max: null,
  details: "Chapitre 2",
  ...overrides,
});

test("sources are merged on date, classes and subject, notebook first", () => {
  const notebook = planned({});
  const graded = planned({ source: "grades", kind: "graded", title: "Contrôle 2", coefficient: 2, max: 20, published: false, details: "" });
  const list = planned({ source: "dslist", kind: "written test", title: "MATHÉMATIQUES", details: "M. PROFESSEUR, salle 207" });
  const other = planned({ source: "grades", groups: ["3B"], title: "Interro" });
  const items = merge([[notebook], [graded], [list, other]]);
  assert.equal(items.length, 2);
  assert.equal(items[0].source, "notebook");
  assert.equal(items[0].coefficient, 2);
  assert.equal(items[0].published, true);
  assert.match(items[0].details, /grades : graded : Contrôle 2/);
  assert.match(items[0].details, /dslist : written test : MATHÉMATIQUES : M\. PROFESSEUR, salle 207/);
  assert.equal(items[1].title, "Interro");
});

/** Session whose Pronote calls answer with a given envelope (no encryption, no compression). */
const fakeSession = (answer: () => string): SessionHandle =>
  ({
    instance: { version: [2026, 2, 8] },
    user: { name: "Prof", resources: [{ id: "109#p", name: "Prof" }] },
    information: { url: "https://demo.example/pronote", id: "s", accountKind: 3, aesKey: "0123456789abcdef", aesIV: "fedcba9876543210", skipCompression: true, skipEncryption: true, order: 0 },
    queue: { push: (fn: () => Promise<unknown>) => fn() },
    fetcher: async () => ({ content: answer(), headers: {}, status: 200 }),
  }) as unknown as SessionHandle;

test("the written tests list is reported unavailable when Pronote refuses it", async () => {
  const session = fakeSession(() => JSON.stringify({ Erreur: { Titre: "Vos droits sont insuffisants pour effectuer cette opération" } }));
  rememberUserData(session, { resources: [{ id: "23#a", label: "3A", genre: 1, taught: true, principal: false }] });
  assert.equal(await fromWrittenTests(session, from, to, []), null);
});

test("an empty answer to the written tests list means unavailable too", async () => {
  const session = fakeSession(() => JSON.stringify({ dataSec: JSON.stringify({ data: {} }) }));
  rememberUserData(session, { resources: [{ id: "23#a", label: "3A", genre: 1, taught: true, principal: false }] });
  assert.equal(await fromWrittenTests(session, from, to, []), null);
});

test("other Pronote errors are propagated", async () => {
  const session = fakeSession(() => JSON.stringify({ Erreur: { Titre: "Server Error" } }));
  rememberUserData(session, { resources: [{ id: "23#a", label: "3A", genre: 1, taught: true, principal: false }] });
  await assert.rejects(fromWrittenTests(session, from, to, []), ServerSideError);
});

test("no taught class means an empty list without any call", async () => {
  const session = fakeSession(() => { throw new Error("must not be called"); });
  rememberUserData(session, { resources: [] });
  assert.deepEqual(await fromWrittenTests(session, from, to, []), []);
});
