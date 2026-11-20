import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mock, test } from "node:test";
import { PRIORITY, requestContext } from "../src/context.js";
import { RateLimitedError } from "../src/errors.js";
import { seconds } from "../src/normalise.js";
import { limiterOf } from "../src/pronote/limiter.js";
import { rememberUserData } from "../src/pronote/userdata.js";
import { classLife, decodeRecap, eventsFromCallSheet, eventsFromNotebook, eventsFromRecap, eventsFromSummary, halfDaysBetween, lessonConcerns,
  mergeEvents, observationKind, officialFor, officialFromRecap, officialKind, regimeSeen, resetWeekCache, totalsOf,
  type LifeInclude } from "../src/teacher/classlife.js";
import { studentFiles } from "../src/teacher/students.js";
import { fakeSession, type FakeCall } from "./fake-session.js";
import { buildApp, createSession, get } from "./helpers/app.js";

const { readCache } = await import("../src/cache.js");
const { accountKey } = await import("../src/tokenStore.js");

/*
 * School life of a class for its main teacher (0.12.0). Fixtures: the summary of a student as the student space types
 * it (genres 13, 14, 15, 21, 40, 41, 46), the correspondence notebook captured on the demo server, call sheets of the
 * web client. Generated names; the summary (RecapitulatifVSEleve) is NOT VALIDATED on a real server.
 */
const recap = JSON.parse(readFileSync(new URL("./fixtures/student-life-recap.json", import.meta.url), "utf8"));
const notebook = JSON.parse(readFileSync(new URL("./fixtures/student-notebook.json", import.meta.url), "utf8"));
const ALL: LifeInclude[] = ["absences", "lateness", "exclusions", "punishments", "observations", "infirmary", "exemptions"];
const FROM = seconds(new Date(2026, 8, 1));
const TO = seconds(new Date(2027, 6, 5));

const classT06 = { id: "1#c1", label: "T06", genre: 1 as const, taught: true, principal: true };
const classT11 = { id: "1#c2", label: "T11", genre: 1 as const, taught: true, principal: false };
const students = Array.from({ length: 31 }, (_, i) => ({ N: `4#e${i + 1}`, L: `ELEVE${String(i + 1).padStart(2, "0")} Prénom`, G: 4 }));
const entries = students.map((item) => ({ pronoteId: item.N, label: item.L, id: `e:${item.L}` }));
const denied = { Erreur: { Titre: "Vos droits sont insuffisants pour effectuer cette opération." } };

const session = (handlers: Record<string, (data: any, call: FakeCall) => any> = {}) => {
  const fake = fakeSession({
    ListeEleves: () => ({ listeEleves: { _T: 24, V: students } }),
    RecapitulatifVSEleve: () => recap,
    PageSaisieCarnetCorrespondance: () => notebook,
    ...handlers,
  });
  Object.assign(fake.instance, { firstMonday: new Date(2026, 8, 7), blocksPerDay: 10,
    endings: ["8h55", "9h55", "10h55", "11h55", "12h55", "13h55", "14h55", "15h55", "16h55", "17h55"] });
  rememberUserData(fake, { resources: [classT06, classT11], tabs: [16, 19, 78, 105, 113] });
  return fake;
};

test("the summary of a student: every genre, with the member names of the student space", () => {
  const events = eventsFromRecap(recap)!;
  assert.equal(events.length, 11);
  assert.deepEqual(events.map((event) => event.kind), ["absence", "absence", "lateness", "exclusion", "punishment", "observation",
    "observation", "observation", "observation", "infirmary", "exemption"]);
  const [long, short, late, exclusion, punishment, observation, encouragement, carnet, other] = events;
  assert.equal(long.justified, true);
  assert.equal(long.settled, true);
  assert.equal(long.hours, 12);
  assert.equal(long.halfDays, 4, "two whole days");
  assert.equal(short.justified, false);
  assert.equal(short.halfDays, 1);
  assert.equal(short.local.start, "2026-10-05 14:00");
  assert.equal(late.minutes, 10);
  assert.deepEqual(late.reasons, ["Retard injustifié", "Réveil"]);
  assert.equal(exclusion.author, "Mme FABRE N.");
  assert.equal(exclusion.subject, "PHYSIQUE-CHIMIE SPE");
  assert.equal(exclusion.text, "Exclusion fictive du cours");
  assert.equal(punishment.subkind, "Retenue");
  assert.equal(punishment.minutes, 60);
  assert.deepEqual(punishment.reasons, ["Travail non fait"]);
  assert.deepEqual([observation.subkind, observation.text, observation.author, observation.subject],
    ["observation", "Bavardages répétés", "Mme COLLIN S.", "ANGLAIS LV1"]);
  assert.equal(encouragement.subkind, "encouragement");
  assert.equal(carnet.subkind, "notebook");
  assert.deepEqual([other.subkind, other.text], ["other", "Leçon non apprise : Chapitre 3"]);
  assert.equal(eventsFromRecap({ autre: [] }), null, "no known list: the shape is unknown");
  assert.deepEqual(eventsFromRecap({ listeAbsences: { _T: 24, V: [] } }), []);
});

test("reasons only with motives, never the comment of an infirmary visit; totals computed on the events returned", () => {
  const events = eventsFromRecap(recap)!;
  const without = mergeEvents("e:X", events, ALL, FROM, TO);
  assert.equal(without.length, 11);
  for (const event of without.filter((item) => ["absence", "lateness", "infirmary", "exemption"].includes(item.kind))) {
    assert.deepEqual(event.reasons, [], event.kind);
    assert.equal(event.text, "", event.kind);
  }
  // Reasons of a punishment or an exclusion speak of behaviour, not of health: returned with their kind.
  assert.deepEqual(without.find((item) => item.kind === "punishment")?.reasons, ["Travail non fait"]);
  const json = JSON.stringify(without);
  for (const secret of ["Maladie", "Réveil", "Symptôme", "Entorse"]) assert.equal(json.includes(secret), false, secret);

  const withMotives = mergeEvents("e:X", events, [...ALL, "motives"], FROM, TO);
  assert.deepEqual(withMotives.find((item) => item.kind === "absence")?.reasons, ["Maladie avec certificat"]);
  assert.equal(withMotives.find((item) => item.kind === "exemption")?.text, "Entorse fictive");
  assert.equal(withMotives.find((item) => item.kind === "infirmary")?.text, "", "never the comment of the infirmary");
  assert.equal(JSON.stringify(withMotives).includes("Symptôme"), false);

  assert.deepEqual(totalsOf(without), { absences: 2, absenceHalfDays: 5, unjustifiedAbsences: 1, unjustifiedHalfDays: 1, missedHours: 14,
    lateness: 1, exclusions: 1, punishments: 1, infirmary: 1, exemptions: 1,
    observations: { observation: 1, encouragement: 1, notebook: 1, parents: 0, other: 1 } });
  // Only the kinds asked, only the range asked: the totals follow.
  const absencesOnly = mergeEvents("e:X", events, ["absences"], FROM, seconds(new Date(2026, 9, 1)));
  assert.deepEqual(absencesOnly.map((item) => item.kind), ["absence"]);
  assert.equal(totalsOf(absencesOnly).absences, 1);
  assert.equal(totalsOf(absencesOnly).lateness, 0);
  assert.match(absencesOnly[0].id, /^a:/);
});

test("half-days, kinds of observations, lessons that concern a class", () => {
  assert.equal(halfDaysBetween(new Date(2026, 8, 14, 8), new Date(2026, 8, 14, 8, 55)), 1);
  assert.equal(halfDaysBetween(new Date(2026, 8, 14, 8), new Date(2026, 8, 14, 17)), 2);
  assert.equal(halfDaysBetween(new Date(2026, 8, 14, 14), new Date(2026, 8, 14, 17)), 1);
  // Friday morning to Monday evening: the Sunday is not counted.
  assert.equal(halfDaysBetween(new Date(2026, 8, 18, 8), new Date(2026, 8, 21, 17)), 6);
  assert.equal(observationKind(0, "Défaut de carnet"), "notebook");
  assert.equal(observationKind(1, "Observation aux parents"), "parents");
  assert.equal(observationKind(undefined, "Encouragements"), "encouragement");
  assert.equal(observationKind(undefined, "Oubli de matériel"), "other");
  assert.equal(lessonConcerns(["T06"], classT06, ["T06", "T11"]), true);
  assert.equal(lessonConcerns(["T11"], classT06, ["T06", "T11"]), false, "a lesson of another whole class");
  assert.equal(lessonConcerns(["[T06AP ORIENT]"], classT06, ["T06", "T11"]), true, "a group may hold students of the class");
  assert.equal(lessonConcerns(["T-SPE SVT 2"], { ...classT06, genre: 2, label: "T-SPE PC 1" }, ["T06"]), false);
});

test("the correspondence notebook: observations, encouragements and the events of colleagues", () => {
  const events = eventsFromNotebook(notebook)!;
  assert.deepEqual(events.map((event) => [event.subkind, event.text, event.author, event.subject, event.source]), [
    ["observation", "Bavardages répétés", "Mme COLLIN S.", "", "carnet"],
    ["encouragement", "Exposé remarquable", "M. EVRARD O.", "", "carnet"],
    ["other", "Oubli de matériel", "Mme ARNAUD C.", "PHILOSOPHIE", "carnet"],
  ]);
  assert.equal(eventsFromNotebook({ estPubliable: true }), null);
});

test("a page of students: summary and notebook merged, the same observation kept once", async () => {
  const fake = session();
  const result = await classLife(fake, "c:T06", FROM, TO, { include: ALL, page: { offset: 0, limit: 3 } });
  assert.equal(result.available, true);
  assert.equal(result.validated, false);
  assert.deepEqual(result.class, { id: "c:T06", name: "T06" });
  assert.equal(result.total, 31);
  assert.equal(result.items.length, 3);
  assert.deepEqual(result.read, entries.slice(0, 3).map((entry) => entry.id));
  assert.deepEqual(Object.keys(result.sources), ["recap", "carnet"]);
  assert.deepEqual(result.sources.recap, { available: true, reason: "", scope: "all", function: "RecapitulatifVSEleve", onglet: 19, detail: true });
  const first = result.items[0];
  assert.equal(first.lastname, "ELEVE01");
  assert.equal(first.key.length, 16);
  // 11 events of the summary + 2 of the notebook that the summary lacks (the observation of 06/11 is in both).
  assert.equal(first.events.length, 13);
  assert.equal(first.events.filter((event) => event.text === "Bavardages répétés").length, 1);
  assert.equal(first.events.find((event) => event.text === "Bavardages répétés")?.source, "recap");
  assert.equal(first.totals.observations.encouragement, 2);
  assert.equal(first.totals.observations.other, 2);
  assert.equal(first.totals.absences, first.events.filter((event) => event.kind === "absence").length);
  // Request of the summary: the student and the range.
  const sent = fake.calls.find((call) => call.name === "RecapitulatifVSEleve")!;
  assert.deepEqual(sent.data?.eleve, { N: "4#e1", G: 4, L: "ELEVE01 Prénom" });
  assert.equal(sent.data?.DateDebut?._T, 7);
  assert.equal(sent.onglet, 19);
  assert.equal(fake.calls.filter((call) => call.name === "RecapitulatifVSEleve").length, 3);
  assert.equal(fake.calls.filter((call) => call.name === "PageSaisieCarnetCorrespondance").length, 3);
});

test("by default absences and late arrivals only: the notebook is not read, no reason leaves", async () => {
  const fake = session();
  const result = await classLife(fake, "c:T06", FROM, TO, { page: { student: "e:ELEVE05 Prénom" } });
  assert.deepEqual(result.include, ["absences", "lateness"]);
  assert.equal(result.offset, 4);
  assert.deepEqual(result.items[0].events.map((event) => event.kind), ["absence", "absence", "lateness"]);
  assert.equal(fake.calls.some((call) => call.name === "PageSaisieCarnetCorrespondance"), false);
  assert.deepEqual(Object.keys(result.sources), ["recap"]);
  assert.equal(JSON.stringify(result).includes("Maladie"), false);
});

test("a full queue gives the students read, the remaining ids and retry_after", async () => {
  const fake = session();
  // Roster (1 token) + 2 summaries (2 tokens each) at once; then 1 token per 200 ms, 1 s of wait at most.
  limiterOf(fake, { ratePerMinute: 300, burst: 5, minSpacingMs: 0, maxWaitMs: 1_000 });
  const result = await requestContext.run(
    { priority: PRIORITY.bulk, deadline: Date.now() + 1_000, calls: 0, route: "/classlife" },
    () => classLife(fake, "c:T06", FROM, TO, { page: { offset: 0, limit: 10 } }),
  );
  assert.equal(result.partial, true);
  assert.ok(result.read.length >= 2 && result.read.length < 10, String(result.read.length));
  assert.deepEqual([...result.read, ...result.remaining], entries.slice(0, 10).map((entry) => entry.id));
  assert.equal(result.items.length, result.read.length);
  assert.ok(result.retry_after >= 1);
});

/** Timetable of the account: each week two lessons of T06, one of its group and one of another class. */
const timetable = (data: Record<string, any> | undefined) => {
  const week = Number(data?.NumeroSemaine);
  const monday = new Date(2026, 8, 7 + (week - 1) * 7);
  const lesson = (n: string, day: number, hour: number, group: string, genre: number) => ({
    N: `29#w${week}${n}`, G: 0, place: (hour - 8) + day * 10, duree: 1,
    DateDuCours: { _T: 7, V: `${monday.getDate() + day}/${monday.getMonth() + 1}/${monday.getFullYear()} ${hour}:00:00`.replace(/^(\d+)\/(\d+)\/(\d+)/,
      (_all, _d, _m, _y) => { const date = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + day);
        return `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")}/${date.getFullYear()}`; }) },
    ListeContenus: { _T: 24, V: [{ L: "ENSEIGNEMENT SCIENTIFIQUE", G: 16, N: "79#es" }, { L: group, G: genre, N: `23#${group}` }] },
  });
  return { ListeCours: { _T: 24, V: [lesson("a", 0, 8, "T06", 1), lesson("b", 2, 10, "T06", 1), lesson("c", 3, 14, "[T06AP ORIENT]", 2),
    lesson("d", 4, 9, "T11", 1)] } };
};

/** Call sheet of a lesson: the student of the week absent to the Monday lesson, late on Wednesday, observed in the group. */
const callSheet = (data: Record<string, any> | undefined) => {
  const id = String(data?.Ressource?.N ?? "");
  const week = Number(/w(\d+)/.exec(id)?.[1] ?? 0);
  const date = String(data?.Date?.V ?? "").replace(/^(\d+)\/(\d+)\/(\d+) (\d+):.*$/, (_all, d, m, y, h) => `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}/${y} ${String(h).padStart(2, "0")}`);
  const student = students[(week - 1) % students.length];
  const items: Record<string, any>[] = [];
  if (id.endsWith("a")) items.push({ N: `13#${id}`, G: 13, justifie: week % 2 === 0, reglee: false, regime: { _T: 24, V: { L: "DP 4 jours" } },
    DateDebut: { _T: 7, V: `${date}:00:00` },
    DateFin: { _T: 7, V: `${date}:55:00` }, listeMotifs: { _T: 24, V: [{ L: "Maladie" }] } });
  if (id.endsWith("b")) items.push({ N: `14#${id}`, G: 14, Duree: 5, DateDebut: { _T: 7, V: `${date}:00:00` }, DateFin: { _T: 7, V: `${date}:00:00` } });
  if (id.endsWith("c")) items.push({ N: `46#${id}`, G: 46, observation: { _T: 24, V: { N: "45#enc" } }, commentaire: "Bonne séance",
    DateDebut: { _T: 7, V: `${date}:00:00` }, DateFin: { _T: 7, V: `${date}:55:00` } });
  return {
    ListeColonnes: { _T: 24, V: [{ G: 13, L: "Absence" }, { G: 45, N: "45#enc", L: "Encouragements", genreObservation: 2 }] },
    ListeEleves: { _T: 24, V: [{ N: student.N, L: student.L, ListeAbsences: { _T: 24, V: items } }] },
  };
};

test("a whole school year from the call sheets when the summary does not answer: week by week, own lessons only", async () => {
  mock.timers.enable({ apis: ["Date"], now: new Date(2027, 5, 30, 18).getTime() });
  try {
    const fake = session({ RecapitulatifVSEleve: () => denied, PageEmploiDuTemps: timetable, PageSaisieAbsences: callSheet,
      PageSaisieCarnetCorrespondance: () => ({ ListeObservations: { _T: 24, V: [] }, ListeEncouragements: { _T: 24, V: [] } }) });
    limiterOf(fake, { ratePerMinute: 0, burst: 1000, minSpacingMs: 0, maxWaitMs: 20_000 });
    const result = await classLife(fake, "c:T06", FROM, TO, { include: [...ALL, "motives"], page: { offset: 0, limit: 40 } });
    assert.equal(result.available, true);
    assert.equal(result.items.length, 31);
    assert.equal(result.sources.recap?.available, false);
    assert.equal(result.sources.recap?.reason, "access_denied");
    assert.equal(result.sources.recap?.onglet, 19);
    // 43 weeks from the first Monday (07/09/2026) to 30/06/2027; the lesson of the other class is never read.
    const weeks = 43;
    assert.deepEqual(result.sources.callsheets, { available: true, reason: "", scope: "own_lessons", function: "PageSaisieAbsences", onglet: 113,
      lessons: weeks * 3 - 1, skipped: 0, detail: true });
    assert.equal(fake.calls.filter((call) => call.name === "PageEmploiDuTemps").length, weeks);
    assert.equal(fake.calls.filter((call) => call.name === "PageSaisieAbsences").length, weeks * 3 - 1);
    assert.equal(fake.calls.filter((call) => call.name === "RecapitulatifVSEleve").length, 1, "one refusal is enough");
    // Each week one student is absent, late and encouraged; 43 weeks over 31 students: 12 students twice.
    const totals = result.items.map((item) => item.totals);
    assert.equal(totals.reduce((sum, item) => sum + item.absences, 0), weeks);
    assert.equal(totals.reduce((sum, item) => sum + item.lateness, 0), weeks);
    assert.equal(totals.reduce((sum, item) => sum + item.observations.encouragement, 0), weeks - 1, "the last group lesson is after now");
    assert.equal(result.items[0].totals.absences, 2);
    assert.equal(result.items[30].totals.absences, 1);
    for (const item of result.items) {
      assert.equal(item.totals.absences, item.events.filter((event) => event.kind === "absence").length);
      assert.equal(item.totals.unjustifiedAbsences, item.events.filter((event) => event.kind === "absence" && event.justified === false).length);
      for (const event of item.events) assert.equal(event.source, "callsheets");
    }
    const absence = result.items[0].events.find((event) => event.kind === "absence")!;
    assert.equal(absence.local.start, "2026-09-07 08:00");
    assert.equal(absence.subject, "ENSEIGNEMENT SCIENTIFIQUE");
    assert.deepEqual(absence.reasons, ["Maladie"]);
    assert.equal(result.items[0].events.find((event) => event.kind === "lateness")?.minutes, 5);
    assert.equal(result.items[0].events.find((event) => event.kind === "observation")?.subkind, "encouragement");

    // The weeks read stay in memory: the next page, or the same request sent again, calls Pronote for nothing more.
    const before = fake.calls.length;
    const again = await classLife(fake, "c:T06", FROM, TO, { include: ALL, page: { student: "e:ELEVE02 Prénom" } });
    assert.equal(again.items[0].totals.absences, 2);
    assert.deepEqual(again.items[0].events.find((event) => event.kind === "absence")?.reasons, [], "no reason without motives");
    assert.equal(fake.calls.filter((call, index) => index >= before && ["PageEmploiDuTemps", "PageSaisieAbsences"].includes(call.name)).length, 0);
    resetWeekCache(fake);
  } finally {
    mock.timers.reset();
  }
});

test("call sheets of a long range refused for lack of time: the weeks read are kept, the same request goes further", async () => {
  const fake = session({ RecapitulatifVSEleve: () => denied, PageEmploiDuTemps: timetable, PageSaisieAbsences: callSheet });
  // 5 weeks of 4 calls each; the bucket serves about 8 calls per attempt.
  const from = seconds(new Date(2026, 8, 7));
  const to = seconds(new Date(2026, 9, 12));
  limiterOf(fake, { ratePerMinute: 600, burst: 8, minSpacingMs: 0, maxWaitMs: 300 });
  const attempt = () => requestContext.run(
    { priority: PRIORITY.bulk, deadline: Date.now() + 300, calls: 0, route: "/classlife" },
    () => classLife(fake, "c:T06", from, to, { page: { offset: 0, limit: 5 } }),
  );
  let result: Awaited<ReturnType<typeof classLife>> | null = null;
  let refusals = 0;
  for (let i = 0; i < 12 && result === null; i++) {
    try {
      result = await attempt();
    } catch (error) {
      assert.ok(error instanceof RateLimitedError, String(error));
      assert.ok(error.retryAfter >= 1);
      refusals++;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  assert.ok(result, "the request ends by being served");
  assert.ok(refusals >= 1, "the first attempt cannot read five weeks");
  assert.equal(result.sources.callsheets?.lessons, 15);
  // No week was read twice: the weeks read before a refusal came from memory.
  assert.equal(fake.calls.filter((call) => call.name === "PageEmploiDuTemps").length <= 5 + refusals, true);
  assert.equal(new Set(fake.calls.filter((call) => call.name === "PageSaisieAbsences").map((call) => call.data?.Ressource?.N)).size, 15);
  assert.equal(result.items.reduce((sum, item) => sum + item.totals.absences, 0), 5);
});

test("call sheet: punishments, exemptions and exclusions of a lesson, students outside the class ignored", () => {
  const lesson = { start: new Date(2026, 10, 9, 8), end: new Date(2026, 10, 9, 8, 55), subject: "SVT" };
  const sheet = { ListeEleves: { _T: 24, V: [
    { N: "4#e1", L: "ELEVE01 Prénom", ListeAbsences: { _T: 24, V: [
      { G: 15, DateDebut: { _T: 7, V: "09/11/2026 08:00:00" }, DateFin: { _T: 7, V: "09/11/2026 08:55:00" }, circonstance: "Refus de travailler",
        listeMotifs: { _T: 24, V: [{ L: "Insolence" }] }, Professeur: { _T: 24, V: { L: "M. EVRARD O." } } },
      { G: 21, DateDebut: { _T: 7, V: "09/11/2026 08:20:00" }, DateFin: { _T: 7, V: "09/11/2026 08:40:00" }, commentaire: "Secret médical" }] },
      listePunitions: { _T: 24, V: [{ nature: { _T: 24, V: { L: "Devoir supplémentaire" } }, circonstance: "Oubli répété", listeMotifs: { _T: 24, V: [{ L: "Travail non fait" }] } }] },
      ListeDispenses: { _T: 24, V: [{ matiere: { _T: 24, V: { L: "EPS" } }, commentaire: "Certificat" }] } },
    { N: "4#zz", L: "AUTRE Élève", ListeAbsences: { _T: 24, V: [{ G: 13, DateDebut: { _T: 7, V: "09/11/2026 08:00:00" } }] } },
  ] } };
  const events = eventsFromCallSheet(sheet, entries, lesson).get("e:ELEVE01 Prénom")!;
  assert.deepEqual(events.map((event) => event.kind), ["exclusion", "infirmary", "punishment", "exemption"]);
  assert.deepEqual([events[0].text, events[0].author, events[0].reasons], ["Refus de travailler", "M. EVRARD O.", ["Insolence"]]);
  assert.equal(events[2].subkind, "Devoir supplémentaire");
  assert.equal(events[2].local.start, "2026-11-09 08:00", "an element without date takes the times of the lesson");
  assert.equal(events[3].subject, "EPS");
  assert.equal(eventsFromCallSheet(sheet, entries, lesson).size, 1);
  const merged = mergeEvents("e:ELEVE01 Prénom", events, ALL, FROM, TO);
  assert.equal(JSON.stringify(merged).includes("Secret médical"), false);
  assert.equal(JSON.stringify(merged).includes("Certificat"), false);
});

test("no source answers: unavailable with the reason; an unknown shape is described without any value", async () => {
  const closed = session({ RecapitulatifVSEleve: () => denied, PageEmploiDuTemps: timetable, PageSaisieAbsences: () => denied });
  const nothing = await classLife(closed, "c:T06", seconds(new Date(2026, 8, 7)), seconds(new Date(2026, 8, 14)), { page: { limit: 2 } });
  assert.equal(nothing.available, false);
  assert.equal(nothing.reason, "access_denied");
  assert.deepEqual(nothing.items, []);
  assert.equal(nothing.sources.callsheets?.available, false);

  const odd = session({ RecapitulatifVSEleve: () => ({ recapitulatif: { lignes: [{ texte: "Absence secrète" }] } }) });
  const unknown = await classLife(odd, "c:T06", FROM, TO, { sources: ["recap"], page: { limit: 2 } });
  assert.equal(unknown.available, false);
  assert.equal(unknown.reason, "format_unknown");
  assert.deepEqual(unknown.sources.recap?.shape, ["recapitulatif: object", "recapitulatif.lignes: list[1]", "recapitulatif.lignes[]: object",
    "recapitulatif.lignes[].texte: string"]);
  assert.equal(JSON.stringify(unknown).includes("secrète"), false);
  assert.equal(odd.calls.filter((call) => call.name === "RecapitulatifVSEleve").length, 1);
});

test("GET /classlife: parameters checked, a page through the route", async () => {
  readCache.clear();
  const app = await buildApp({ logger: false });
  const fake = session();
  const login = { url: "https://demo.example/pronote", username: "prof-vie-scolaire", deviceuuid: "device-vie-scolaire" };
  const id = createSession(fake, { key: accountKey(login.url, login.username, login.deviceuuid), login });
  const base = `/classlife?resource=c%3AT06&from=${FROM}&to=${TO}`;
  const page = await get(app, `${base}&include=absences,lateness,observations&limit=2`, id);
  assert.equal(page.statusCode, 200, page.body);
  assert.equal(page.json().items.length, 2);
  assert.deepEqual(page.json().include, ["absences", "lateness", "observations"]);
  assert.equal((await get(app, `${base}&include=sante`, id)).statusCode, 400);
  assert.equal((await get(app, `${base}&sources=vie`, id)).statusCode, 400);
  assert.equal((await get(app, `/classlife?resource=c%3AT06&from=${FROM}&to=${FROM + 500 * 86400}`, id)).json().error, "range_too_large");
  assert.equal((await get(app, `${base}&limit=41`, id)).statusCode, 400);
  // A second identical read comes from the cache of the reads.
  const cached = await get(app, `${base}&include=absences,lateness,observations&limit=2`, id);
  assert.equal(cached.headers["x-cache"], "hit");
  await app.close();
});

/* ---- 0.14.0: the real shape of the summary (first real check of 20/11/2026) ---- */

const typedList = <T>(items: T[]) => ({ _T: 24, V: items });

/**
 * RecapitulatifVSEleve as the real server answers it: numbers by type (listeTotal) and by subject (listeMatiere), no
 * date. Built from the shape of 20/11/2026 and from the web client that shows it; generated values.
 */
const officialRecap = (absences: number) => ({
  listeMatiere: typedList(["MATHEMATIQUES", "PHILOSOPHIE", "ANGLAIS LV1", "EPS"].map((subject, index) => ({ L: subject, N: `m${index}`,
    colonnes: typedList([{ L: "Absences", valeur: index + 1, genreEvenementVS: 7 }, { L: "Heures de cours manquées", valeur: 0.125, estUneDuree: true, genreEvenementVS: 7 },
      { L: "Retards", valeur: index, genreEvenementVS: 8 }]) }))),
  listeTotal: typedList([{ G: 0, L: "Absences", valeur: absences, nbDJAbsence: absences + 2 }, { G: 1, L: "Retards", valeur: 3 },
    { G: 3, L: "Punitions", valeur: 1 }]),
});

test("the real summary: official totals by type and by subject, without any dated event", () => {
  const official = officialFromRecap(officialRecap(5))!;
  assert.deepEqual(official.counts, [
    { kind: "absence", label: "Absences", count: 5, minutes: null, halfDays: 7 },
    { kind: "lateness", label: "Retards", count: 3, minutes: null, halfDays: null },
    { kind: "punishment", label: "Punitions", count: 1, minutes: null, halfDays: null },
  ]);
  assert.deepEqual(official.summary, { absences: 5, absenceHalfDays: 7, lateness: 3, exclusions: null, punishments: 1, observations: null,
    infirmary: null, exemptions: null });
  assert.equal(official.bySubject.length, 4);
  // A duration is a fraction of a day in the web client: 0.125 day is 3 hours.
  assert.deepEqual(official.bySubject[1], { subject: "PHILOSOPHIE", counts: [
    { kind: "absence", label: "Absences", count: 2, minutes: null, halfDays: null },
    { kind: "other", label: "Heures de cours manquées", count: null, minutes: 180, halfDays: null },
    { kind: "lateness", label: "Retards", count: 1, minutes: null, halfDays: null }] });
  assert.deepEqual(decodeRecap(officialRecap(5))?.events, []);
  assert.equal(decodeRecap(officialRecap(5))?.detail, false);
  // A student with nothing: the lists are there, empty; no list at all is another shape.
  const nothing = officialFromRecap({ listeMatiere: typedList([]), listeTotal: typedList([]) })!;
  assert.deepEqual([nothing.counts, nothing.bySubject, nothing.summary.absences], [[], [], null]);
  assert.equal(officialFromRecap({ autre: [] }), null);
  assert.equal(decodeRecap({ autre: [] }), null);
  // The kind of a line: its label, else its genre (school life genres, or genres of the student folder).
  assert.deepEqual(["Passages à l'infirmerie", "Exclusions de cours", "Dispenses", "Observations", "Absences aux repas", "Sanctions", "Incidents"].map((label) => officialKind(label)),
    ["infirmary", "exclusion", "exemption", "observation", "other", "sanction", "incident"]);
  assert.deepEqual([officialKind("", { G: 14 }), officialKind("", { G: 9 }), officialKind("", { genreEvenementVS: 8 }), officialKind("", { genreObservation: 2 }),
    officialKind("", { G: 999 })], ["lateness", "infirmary", "lateness", "observation", "other"]);
  // Only the kinds asked leave: a line of another kind is not even named.
  const reduced = officialFor(official, ["absences"]);
  assert.deepEqual(reduced.counts.map((line) => line.label), ["Absences"]);
  assert.deepEqual([reduced.summary.lateness, reduced.summary.punishments, reduced.bySubject[0].counts.map((line) => line.label)], [null, null, ["Absences"]]);
});

test("official totals of every subject beside the detail of the lessons of the account: each says what it covers", async () => {
  mock.timers.enable({ apis: ["Date"], now: new Date(2027, 5, 30, 18).getTime() });
  try {
    const fake = session({ RecapitulatifVSEleve: (data) => (data?.eleve?.L === students[2].L ? { listeMatiere: typedList([]), listeTotal: typedList([]) } : officialRecap(5)),
      PageEmploiDuTemps: timetable, PageSaisieAbsences: callSheet,
      FicheEleve: () => ({ Identite: { _T: 24, V: { nom: "X" } }, Scolarite: { _T: 24, V: { classe: { _T: 24, V: { L: "T06" } } } } }) });
    resetWeekCache(fake);
    limiterOf(fake, { ratePerMinute: 0, burst: 1000, minSpacingMs: 0, maxWaitMs: 20_000 });
    const result = await classLife(fake, "c:T06", FROM, TO, { page: { offset: 0, limit: 3 } });
    assert.equal(result.available, true);
    // The summary answers (numbers, every subject); the dated detail still comes from the lessons of the account.
    assert.deepEqual(result.sources.recap, { available: true, reason: "", scope: "all", function: "RecapitulatifVSEleve", onglet: 19, detail: false });
    assert.deepEqual([result.sources.callsheets?.available, result.sources.callsheets?.scope, result.sources.callsheets?.detail], [true, "own_lessons", true]);
    assert.equal(result.totalsScope, "own_lessons");
    const [first, , third] = result.items;
    // Pronote counts 5 absences in every subject; the call sheets of the account saw 2.
    assert.deepEqual([first.official?.summary.absences, first.official?.summary.absenceHalfDays, first.totals.absences], [5, 7, 2]);
    assert.deepEqual(first.official?.counts.map((line) => line.kind), ["absence", "lateness"], "punishments were not asked");
    assert.ok(first.events.every((event) => event.source === "callsheets"));
    assert.deepEqual([third.official?.counts, third.official?.summary.absences], [[], null], "a student without anything");
    // The regime named by an absence of a call sheet fills the file that does not carry it.
    assert.equal(regimeSeen(fake, "e:ELEVE01 Prénom"), "DP 4 jours");
    const file = (await studentFiles(fake, "c:T06", [], "e:ELEVE01 Prénom")).items[0];
    assert.deepEqual([file.regime, file.regimeSource, file.regimeReason], ["DP 4 jours", "callsheets", ""]);
  } finally {
    mock.timers.reset();
  }
});

test("dated summary on request: a known list is read for every subject, an unknown shape is described, a refusal is not asked again", async () => {
  const absences = (data: any) => ({ totalCoursManques: 1, listeAbsences: typedList([
    { estUnDeploiement: true, L: "Matière" },
    { DateDebut: { _T: 7, V: data?.genreAbsence === 14 ? "06/10/2026 08:00:00" : "05/10/2026 08:00:00" }, DateFin: { _T: 7, V: "05/10/2026 09:55:00" },
      justifie: false, reglee: true, Duree: 10, listeMotifs: typedList([{ L: "Motif secret" }]), listeMatieres: typedList([{ L: "MATHEMATIQUES" }]),
      Professeur: { _T: 24, V: { L: "M. PROF" } } }]) });
  const fake = session({ RecapitulatifVSEleve: () => officialRecap(5), DetailAbsences: absences,
    PageSuivisAbsenceRetard: () => ({ suivis: { lignes: [{ texte: "Suivi secret" }] } }) });
  resetWeekCache(fake);
  const result = await classLife(fake, "c:T06", FROM, TO, { sources: ["recap", "summary"], include: ["absences", "lateness", "punishments"],
    page: { offset: 0, limit: 2 } });
  assert.equal(result.totalsScope, "all");
  assert.equal(result.sources.callsheets, undefined);
  assert.equal(fake.calls.some((call) => call.name === "PageEmploiDuTemps"), false, "no call sheet is read");
  const summary = result.sources.summary!;
  assert.deepEqual([summary.available, summary.scope, summary.detail], [true, "all", true]);
  assert.deepEqual(summary.parts?.map((part) => [part.function, part.onglet, part.available, part.reason]), [["DetailAbsences", 113, true, ""],
    ["ListePunitions", 192, false, "access_denied"], ["PageSuivisAbsenceRetard", 74, false, "format_unknown"]]);
  assert.deepEqual(summary.parts?.[2].shape, ["suivis: object", "suivis.lignes: list[1]", "suivis.lignes[]: object", "suivis.lignes[].texte: string"]);
  // One call per genre asked, without the teacher: every subject.
  const sent = fake.calls.filter((call) => call.name === "DetailAbsences");
  assert.deepEqual(sent.slice(0, 2).map((call) => [call.data?.genreAbsence, call.data?.professeur, call.data?.dateDebut?._T]), [[13, undefined, 7], [14, undefined, 7]]);
  const events = result.items[0].events;
  assert.deepEqual(events.map((event) => [event.kind, event.source, event.local.start, event.subject, event.author, event.justified]),
    [["absence", "summary", "2026-10-05 08:00", "MATHEMATIQUES", "M. PROF", false], ["lateness", "summary", "2026-10-06 08:00", "MATHEMATIQUES", "M. PROF", false]]);
  assert.deepEqual([events[0].reasons, events[1].minutes], [[], 10], "reasons only with include=motives");
  assert.deepEqual([result.items[0].totals.absences, result.items[0].official?.summary.absences], [1, 5]);
  // The functions refused or not understood are asked once for the session, not for every student nor every page.
  await classLife(fake, "c:T06", FROM, TO, { sources: ["summary"], include: ["absences", "punishments"], page: { offset: 2, limit: 2 } });
  assert.deepEqual([fake.calls.filter((call) => call.name === "PageSuivisAbsenceRetard").length, fake.calls.filter((call) => call.name === "ListePunitions").length], [1, 1]);
  assert.equal(JSON.stringify(result).includes("secret"), false);

  // No known list anywhere: the source says so; the official totals are still there, and nothing dated is claimed.
  const unknown = session({ RecapitulatifVSEleve: () => officialRecap(2), DetailAbsences: () => ({ autre: 1 }) });
  resetWeekCache(unknown);
  const none = await classLife(unknown, "c:T06", FROM, TO, { sources: ["recap", "summary"], page: { offset: 0, limit: 1 } });
  assert.deepEqual([none.available, none.totalsScope, none.sources.summary?.available, none.sources.summary?.reason], [true, "none", false, "format_unknown"]);
  assert.deepEqual([none.items[0].events, none.items[0].official?.summary.absences], [[], 2]);
  assert.equal(eventsFromSummary({ autre: 1 }, 13), null);
  assert.deepEqual(eventsFromSummary({ listePunitions: typedList([{ date: { _T: 7, V: "05/10/2026 08:00:00" }, nature: { _T: 24, V: { L: "Retenue" } } }]) }, 41)?.map((event) => [event.kind, event.subkind]),
    [["punishment", "Retenue"]]);
});

test("a call sheet names the regime of a student: kept apart, never in an event", () => {
  const seen: [string, string][] = [];
  const sheet = { ListeEleves: typedList([{ N: students[0].N, L: students[0].L, ListeAbsences: typedList([{ G: 13, regime: { _T: 24, V: { L: "Externe" } },
    DateDebut: { _T: 7, V: "05/10/2026 08:00:00" }, DateFin: { _T: 7, V: "05/10/2026 08:55:00" } }]) }]) };
  const events = eventsFromCallSheet(sheet, entries, { start: new Date(2026, 9, 5, 8), end: new Date(2026, 9, 5, 8, 55), subject: "X" },
    (student, regime) => seen.push([student, regime]));
  assert.deepEqual(seen, [["e:ELEVE01 Prénom", "Externe"]]);
  assert.equal(JSON.stringify([...events.values()]).includes("Externe"), false);
});
