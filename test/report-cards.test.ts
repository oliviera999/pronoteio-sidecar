import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PRIORITY, requestContext } from "../src/context.js";
import { limiterOf } from "../src/pronote/limiter.js";
import { rememberUserData } from "../src/pronote/userdata.js";
import { classResults, reportFromAnswer, reportsPage, resultsFromAnswer } from "../src/teacher/reports.js";
import { fakeSession, type FakeCall } from "./fake-session.js";
import { buildApp, createSession, get } from "./helpers/app.js";

const { readCache } = await import("../src/cache.js");
const { accountKey } = await import("../src/tokenStore.js");

/*
 * Main teacher view, report cards (0.12.0). Fixture: report card of a "terminale" student with 12 subjects, group
 * services (specialities, languages, option), one subject with sub-services and one dispensed. Built from the shape
 * decoded by the web client (PageBulletins); generated names; NOT VALIDATED on a real report card.
 */
const card = JSON.parse(readFileSync(new URL("./fixtures/report-card-terminale.json", import.meta.url), "utf8"));
const period = { N: "1#t1", L: "Trimestre 1", G: 2 };
const classT06 = { id: "1#c1", label: "T06", genre: 1 as const, taught: true, principal: true };

/** 31 generated students of T06. */
const students = Array.from({ length: 31 }, (_, i) => ({ N: `4#e${i + 1}`, L: `ELEVE${String(i + 1).padStart(2, "0")} Prénom`, G: 4 }));

const session = (extra: Record<string, (data: any, call: FakeCall) => any> = {}) => {
  const fake = fakeSession({
    ListePeriodes: () => ({ listePeriodes: { _T: 24, V: [period, { N: "1#bb", L: "BAC BLANC", G: 2 }] }, periodeParDefaut: { _T: 24, V: period } }),
    ListeEleves: () => ({ listeEleves: { _T: 24, V: students } }),
    PageBulletins: () => card,
    ...extra,
  });
  rememberUserData(fake, { resources: [classT06], tabs: [13, 12, 23, 64, 105] });
  return fake;
};

test("a terminale report card: 12 subjects, group services, sub-services, ranks, council and footer", () => {
  const report = reportFromAnswer(card, { id: "e:ELEVE01 Prénom", label: "ELEVE01 Prénom" }, "Trimestre 1");
  assert.equal(report.state, "published");
  assert.equal(report.subjects.length, 12);
  assert.equal(report.average, 13.42);
  assert.equal(report.classAverage, 12.05);
  assert.equal(report.rank, 7);
  assert.equal(report.classSize, 31);
  assert.equal(report.publication, "Bulletin publié le 05/12/2026");
  const by = new Map(report.subjects.map((subject) => [subject.subject, subject]));
  // Group services (specialities, languages, option) carry the label of their group.
  assert.equal(by.get("SC. VIE & TERRE SPE")?.group, "T-SPE SVT 2");
  assert.equal(by.get("ANGLAIS LV1")?.group, "TLVA ANG 3");
  assert.equal(by.get("MATHS COMPLEMENTAIRES")?.group, "T-OPT MATHS COMP");
  assert.equal(by.get("PHILOSOPHIE")?.group, "");
  assert.equal(by.get("SC. VIE & TERRE SPE")?.rank, 3);
  assert.equal(by.get("SC. VIE & TERRE SPE")?.coefficient, 16);
  assert.deepEqual(by.get("SC. VIE & TERRE SPE")?.comments, ["Très bon niveau."]);
  // Sub-services: their own teachers and averages; the teachers of the subject are theirs.
  const science = by.get("ENSEIGNEMENT SCIENTIFIQUE")!;
  assert.deepEqual(science.teachers, ["M. EVRARD O.", "Mme FABRE N."]);
  assert.deepEqual(science.subservices.map((item) => [item.subject, item.teachers[0], item.average, item.classAverage]), [
    ["SVT", "M. EVRARD O.", 14.2, 12.6],
    ["PHYSIQUE-CHIMIE", "Mme FABRE N.", 13, 11.6],
  ]);
  assert.deepEqual(by.get("PHILOSOPHIE")?.subservices, []);
  // A dispensed subject and a subject without grade.
  assert.equal(by.get("ED.PHYSIQUE & SPORT.")?.average, null);
  assert.equal(by.get("ED.PHYSIQUE & SPORT.")?.status, "Disp");
  assert.equal(by.get("ORIENTATION")?.average, null);
  assert.deepEqual(report.comments.map((item) => [item.kind, item.title]), [
    ["general", "Appréciation générale"], ["council", "Avis du conseil de classe"], ["council", "Mention"], ["cpe", "Vie scolaire"]]);
  assert.equal(report.attendance.absences, "3 demi-journées dont 1 non justifiée");
  assert.deepEqual(by.get("PHILOSOPHIE")?.assessments, []);
});

test("member names are read without case, and a period without published report card says so", () => {
  const lower = { listeServices: { _T: 24, V: [{ L: "SVT", matiere: { _T: 24, V: { L: "SVT" } }, moyenneEleve: { _T: 10, V: "12,00" },
    moyenneClasse: "11,5", rang: 4, listeProfesseurs: { _T: 24, V: [{ L: "M. EVRARD O." }] } }] }, general: { V: { moyenneEleve: "12,00" } } };
  const report = reportFromAnswer(lower, { id: "e:X Y", label: "X Y" }, "T1");
  assert.equal(report.subjects[0].average, 12);
  assert.equal(report.subjects[0].classAverage, 11.5);
  assert.equal(report.subjects[0].rank, 4);
  assert.deepEqual(report.subjects[0].teachers, ["M. EVRARD O."]);
  assert.equal(report.average, 12);
  const unpublished = reportFromAnswer({ Message: "Le bulletin sera publié à partir du 05/12/26." }, { id: "e:X Y", label: "X Y" }, "T1");
  assert.equal(unpublished.state, "unpublished");
  assert.deepEqual(unpublished.subjects, []);
});

test("a page reads only its students, with the roster total; one student by id", async () => {
  const fake = session();
  const page = await reportsPage(fake, "c:T06", "p:Trimestre 1", { offset: 10, limit: 5 });
  assert.equal(page.available, true);
  assert.equal(page.validated, false);
  assert.equal(page.source, "reportcard");
  assert.equal(page.total, 31);
  assert.equal(page.offset, 10);
  assert.equal(page.items.length, 5);
  assert.deepEqual(page.items.map((item) => item.studentid), page.read);
  assert.equal(page.items[0].studentid, "e:ELEVE11 Prénom");
  assert.deepEqual(page.remaining, []);
  assert.equal(page.partial, false);
  assert.equal(page.retry_after, 0);
  assert.equal(fake.calls.filter((call) => call.name === "PageBulletins").length, 5);
  const sent = fake.calls.find((call) => call.name === "PageBulletins")!;
  assert.deepEqual(sent.data?.eleve, { N: "4#e11", G: 4, L: "ELEVE11 Prénom" });
  assert.deepEqual(sent.data?.periode, { N: "1#t1", G: 2, L: "Trimestre 1" });
  assert.equal(sent.onglet, 13);

  const one = await reportsPage(session(), "c:T06", "p:BAC BLANC", { student: "e:ELEVE31 Prénom" });
  assert.equal(one.items.length, 1);
  assert.equal(one.offset, 30);
  assert.equal(one.items[0].period, "BAC BLANC");
  await assert.rejects(reportsPage(session(), "c:T06", "p:Trimestre 1", { student: "e:INCONNU Élève" }), /student_not_found/);
  // The last page is shorter; beyond the roster nothing is read.
  assert.equal((await reportsPage(session(), "c:T06", "p:Trimestre 1", { offset: 30, limit: 10 })).items.length, 1);
  assert.equal((await reportsPage(session(), "c:T06", "p:Trimestre 1", { offset: 40, limit: 10 })).items.length, 0);
});

test("a full queue gives the students read so far, the remaining ids and retry_after; nothing is lost", async () => {
  const fake = session();
  // Periods and roster (2 tokens) + 2 report cards (2 tokens each); then 1 token per 200 ms, 1 s of wait at most.
  limiterOf(fake, { ratePerMinute: 300, burst: 6, minSpacingMs: 0, maxWaitMs: 1_000 });
  const first = await requestContext.run(
    { priority: PRIORITY.bulk, deadline: Date.now() + 1_000, calls: 0, route: "/reports" },
    () => reportsPage(fake, "c:T06", "p:Trimestre 1", { offset: 0, limit: 10 }),
  );
  assert.equal(first.available, true);
  assert.equal(first.partial, true);
  assert.ok(first.read.length >= 2 && first.read.length < 10, String(first.read.length));
  assert.ok(first.retry_after >= 1);
  assert.equal(first.items.length, first.read.length);
  assert.deepEqual([...first.read, ...first.remaining], students.slice(0, 10).map((item) => `e:${item.L}`));
  // The next request starts at the first student not read: every student is read once.
  await new Promise((resolve) => setTimeout(resolve, first.retry_after * 1000));
  const rest = await requestContext.run(
    { priority: PRIORITY.bulk, deadline: Date.now() + 10_000, calls: 0, route: "/reports" },
    () => reportsPage(fake, "c:T06", "p:Trimestre 1", { offset: first.read.length, limit: 10 - first.read.length }),
  );
  assert.equal(rest.partial, false);
  assert.deepEqual(rest.read, first.remaining);
  assert.equal(fake.calls.filter((call) => call.name === "PageBulletins").length, 10);
});

test("a refusal of Pronote is relayed with the tab, never bypassed", async () => {
  const refused = session({ PageBulletins: () => ({ Erreur: { Titre: "Vos droits sont insuffisants pour effectuer cette opération." } }) });
  const page = await reportsPage(refused, "c:T06", "p:Trimestre 1", { limit: 5 });
  assert.equal(page.available, false);
  assert.equal(page.reason, "access_denied");
  assert.equal(page.onglet, 13);
  assert.deepEqual(page.items, []);
  // One call, not one per student.
  assert.equal(refused.calls.filter((call) => call.name === "PageBulletins").length, 1);
});

test("the transcript (PageReleve, tab 12) carries the assessments of each subject", async () => {
  const transcript = { ListeServices: { _T: 24, V: [{ L: "SVT", Matiere: { _T: 24, V: { L: "SVT" } }, MoyenneEleve: { _T: 10, V: "14,00" },
    ListeDevoirs: { _T: 24, V: [
      { Date: { _T: 7, V: "12/10/2026" }, Commentaire: "DS 1", Note: { _T: 10, V: "15,5" }, Bareme: { _T: 10, V: "20" }, Coefficient: { _T: 10, V: "2" }, Moyenne: { _T: 10, V: "11,2" } },
      { Date: { _T: 7, V: "09/11/2026" }, Commentaire: "TP noté", Note: { _T: 10, V: "|1" }, Bareme: { _T: 10, V: "10" } },
    ] } }] } };
  const fake = session({ PageReleve: () => transcript });
  const page = await reportsPage(fake, "c:T06", "p:Trimestre 1", { limit: 1 }, "transcript");
  assert.equal(page.source, "transcript");
  assert.equal(fake.calls.find((call) => call.name === "PageReleve")?.onglet, 12);
  assert.deepEqual(page.items[0].subjects[0].assessments, [
    { date: "2026-10-12", title: "DS 1", grade: 15.5, status: "", scale: 20, coefficient: 2, classAverage: 11.2 },
    { date: "2026-11-09", title: "TP noté", grade: null, status: "Abs", scale: 10, coefficient: null, classAverage: null },
  ]);
});

test("results of the class: a table of subjects and students, an unknown shape is described without any value", async () => {
  const table = {
    listeColonnes: { _T: 24, V: [
      { L: "PHILOSOPHIE", MoyenneClasse: { _T: 10, V: "10,80" }, MoyenneInf: "4,00", MoyenneSup: "16,50", ListeProfesseurs: { _T: 24, V: [{ L: "Mme ARNAUD C." }] } },
      { L: "SVT", MoyenneClasse: "12,6" },
    ] },
    listeLignes: { _T: 24, V: students.slice(0, 3).map((student, index) => ({ eleve: { _T: 24, V: { N: student.N, L: student.L } },
      moyenneGenerale: { _T: 10, V: `${12 + index},00` }, rang: index + 1,
      listeMoyennes: { _T: 24, V: [{ _T: 10, V: `${10 + index},50` }, { _T: 10, V: index === 2 ? "|2" : "13,00" }] } })) },
  };
  const read = resultsFromAnswer(table, students.map((item) => ({ pronoteId: item.N, label: item.L, id: `e:${item.L}` })));
  assert.ok(read);
  assert.deepEqual(read.subjects[0], { subject: "PHILOSOPHIE", teachers: ["Mme ARNAUD C."], classAverage: 10.8, min: 4, max: 16.5,
    median: null, groupAverage: null, heading: "", detail: "" });
  assert.equal(read.students.length, 3);
  assert.deepEqual(read.students[2], { studentid: "e:ELEVE03 Prénom", label: "ELEVE03 Prénom", average: 14, rank: 3,
    lateness: null, absenceHalfDays: null,
    averages: [{ subject: "PHILOSOPHIE", column: 0, value: 12.5, status: "" }, { subject: "SVT", column: 1, value: null, status: "Disp" }] });

  const known = await classResults(session({ ResultatsClasses: () => table }), "c:T06", "p:Trimestre 1");
  assert.equal(known.available, true);
  assert.deepEqual(known.class, { id: "c:T06", name: "T06" });
  assert.deepEqual(known.period, { id: "p:Trimestre 1", name: "Trimestre 1" });

  const unknown = await classResults(session({ ResultatsClasses: () => ({ tableau: { lignes: [{ nom: "DUPONT Secret", note: "12,5" }] } }) }),
    "c:T06", "p:Trimestre 1");
  assert.equal(unknown.available, false);
  assert.equal(unknown.reason, "format_unknown");
  assert.deepEqual(unknown.shape, ["tableau: object", "tableau.lignes: list[1]", "tableau.lignes[]: object", "tableau.lignes[].nom: string",
    "tableau.lignes[].note: string"]);
  assert.equal(JSON.stringify(unknown).includes("Secret"), false);

  const refused = await classResults(session(), "c:T06", "p:Trimestre 1");
  assert.equal(refused.available, false);
  assert.equal(refused.reason, "access_denied");
  assert.equal(refused.onglet, 64);
});

test("GET /reports: pages through the route, the whole class without page parameters as before 0.12.0", async () => {
  readCache.clear();
  const app = await buildApp({ logger: false });
  const fake = session();
  // No pacing here: the whole class at once is 62 tokens, more than the queue serves in its 20 s (the reason for pages).
  limiterOf(fake, { ratePerMinute: 0, burst: 1000, minSpacingMs: 0, maxWaitMs: 20_000 });
  const login = { url: "https://demo.example/pronote", username: "prof-bulletins", deviceuuid: "device-bulletins" };
  const id = createSession(fake, { key: accountKey(login.url, login.username, login.deviceuuid), login });
  const page = await get(app, "/reports?resource=c%3AT06&period=p%3ATrimestre%201&offset=0&limit=3", id);
  assert.equal(page.statusCode, 200, page.body);
  assert.equal(page.json().total, 31);
  assert.equal(page.json().items.length, 3);
  assert.equal(page.json().items[0].subjects.length, 12);
  const legacy = await get(app, "/reports?resource=c%3AT06&period=p%3ATrimestre%201", id);
  assert.equal(legacy.statusCode, 200, legacy.body);
  assert.deepEqual(Object.keys(legacy.json()), ["items"]);
  assert.equal(legacy.json().items.length, 31);
  assert.equal((await get(app, "/reports?resource=c%3AT06&period=p%3ATrimestre%201&limit=41", id)).statusCode, 400);
  assert.equal((await get(app, "/reports?resource=c%3AT06&period=p%3ATrimestre%201&source=livret", id)).statusCode, 400);
  const results = await get(app, "/reports/results?resource=c%3AT06&period=p%3ATrimestre%201", id);
  assert.equal(results.statusCode, 200, results.body);
  assert.equal(results.json().reason, "access_denied");
  await app.close();
});
