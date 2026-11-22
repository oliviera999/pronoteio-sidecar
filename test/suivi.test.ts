import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// First: the helper sets the signing secret before config.ts is loaded.
import { buildApp, createSession, get } from "./helpers/app.js";
import { PRIORITY, priorityOf } from "../src/context.js";
import { AccessLog } from "../src/logs.js";
import { seconds } from "../src/normalise.js";
import { callCost } from "../src/pronote/limiter.js";
import { rememberUserData } from "../src/pronote/userdata.js";
import { absencesFromRecap, classAbsences, classTotalsOf, totalField } from "../src/teacher/absencesRecap.js";
import { livretFromAnswer, mergeYears, schoolYearOf, studentHistory, yearsFromAnswer } from "../src/teacher/history.js";
import { planFrom, plansFromAnswer, studentPlans } from "../src/teacher/plans.js";
import { resetSourceMemory, schoolYearRange } from "../src/teacher/studentSource.js";
import { fakeSession, type FakeCall } from "./fake-session.js";

const { readCache } = await import("../src/cache.js");
const { accountKey } = await import("../src/tokenStore.js");

/*
 * Class follow-up (0.16.0, docs/olutionsuivi/CONTRAT_SIDECAR.md): absences of a class in one call, support plans,
 * results of the previous years. The fixtures marked "recorded" follow the shapes of docs/olutionsuivi/formes/ (names
 * and types read on 22/11/2026, no value): the multi-year page, the frame of the school record, the totals of a class.
 * The others are the shapes the decoders SUPPOSE (a line of absences by student, a line of the school record, a support
 * plan). Generated names and values everywhere, never read on a real server; every decoder is also given a shape it
 * must not understand.
 */
const note = (value: string) => ({ _T: 10, V: value });
const typed = <T>(items: T[]) => ({ _T: 24, V: items });
const date = (value: string) => ({ _T: 7, V: value });
const denied = { Erreur: { Titre: "Vos droits sont insuffisants pour effectuer cette opération." } };

const classT06 = { id: "1#c1", label: "T06", genre: 1 as const, taught: true, principal: true };
const groupSpe = { id: "2#g1", label: "T-SPE SVT 1", genre: 2 as const, taught: true, principal: false };
const students = Array.from({ length: 31 }, (_, i) => ({ N: `4#e${i + 1}`, L: `ELEVE${String(i + 1).padStart(2, "0")} Prénom`, G: 4 }));
const entries = students.map((item) => ({ pronoteId: item.N, label: item.L, id: `e:${item.L}` }));
const FROM = seconds(new Date(2026, 8, 1));
const TO = seconds(new Date(2027, 6, 5));

const session = (handlers: Record<string, (data: any, call: FakeCall) => any> = {}) => {
  const fake = fakeSession({ ListeEleves: () => ({ listeEleves: typed(students) }), ...handlers });
  Object.assign(fake.instance, { firstMonday: new Date(2026, 8, 7), firstDate: new Date(2026, 8, 1), lastDate: new Date(2027, 6, 3) });
  rememberUserData(fake, { resources: [classT06, groupSpe], tabs: [16, 44, 83, 105, 138] });
  return fake;
};

const names = (fake: { calls: FakeCall[] }) => fake.calls.map((call) => call.name);

/* ---- 7.1 Absences of a class: RecapAbsencesEleves ---- */

/** Supposed dated shape: one line per student, its numbers as members and its absences and late arrivals as lists. */
const datedRecap = () => ({
  ListeLignes: typed([
    { eleve: { _T: 24, V: { N: "4#e2", L: "ELEVE02 Prénom" } }, nbAbsences: 2, nbDJAbsence: 3, nbRetards: 1, nbHeures: "5h30",
      listeAbsences: typed([
        { G: 13, DateDebut: date("05/10/2026 08:00:00"), DateFin: date("05/10/2026 11:55:00"), justifie: false, NbrHeures: "4h00",
          listeMotifs: typed([{ L: "Maladie secrète" }]), listeMatieres: typed([{ L: "MATHEMATIQUES" }]) },
        { G: 13, DateDebut: date("12/11/2026 14:00:00"), DateFin: date("12/11/2026 15:25:00"), justifie: true, NbrHeures: "1h30",
          listeMatieres: typed([{ L: "PHILOSOPHIE" }]) },
        // Out of the range asked: not returned.
        { G: 13, DateDebut: date("02/07/2026 08:00:00"), DateFin: date("02/07/2026 08:55:00"), justifie: true }]),
      listeRetards: typed([{ DateDebut: date("06/10/2026 08:00:00"), Duree: 10, justifie: false, listeMatieres: typed([{ L: "ANGLAIS LV1" }]) }]) },
    { eleve: { _T: 24, V: { N: "4#e1", L: "ELEVE01 Prénom" } }, listeAbsences: typed([]), listeRetards: typed([]) },
    { eleve: { _T: 24, V: { N: "4#zz", L: "AUTRE Élève" } }, nbAbsences: 9 },
  ]),
  LigneCumul: { nbAbsences: 2, nbRetards: 1 },
});

/** Supposed shape without dates: one line per student, numbers in titled cells, the same per subject. */
const totalsRecap = () => ({
  ListeLignes: typed(students.slice(0, 3).map((student, index) => ({ N: student.N, L: student.L,
    colonnes: typed([{ L: "Absences", valeur: index + 1, nbDJAbsence: index + 2 }, { L: "Absences injustifiées", valeur: index },
      { L: "Heures de cours manquées", valeur: 0.125, estUneDuree: true }, { L: "Retards", valeur: 2 }, { L: "Absences aux repas", valeur: 7 },
      { L: "Demi-journées injustifiées", valeur: 9 }]),
    listeMatieres: typed([{ L: "MATHEMATIQUES", colonnes: typed([{ L: "Heures de cours manquées", valeur: "2h00" }, { L: "Retards", valeur: 1 }]) },
      { L: "EPS", colonnes: typed([{ L: "Heures de cours manquées", valeur: "1h00" }]) }]) }))),
  LigneCumul: { colonnes: typed([{ L: "Absences", valeur: 6 }]) },
});

test("absences of a class: dated events of every subject, in the range asked, without any reason", () => {
  const read = absencesFromRecap(datedRecap(), entries, FROM, TO)!;
  assert.equal(read.dated, true);
  assert.equal(read.unmatched, 1, "a line that names no student of the class");
  // Roster order, whatever the order of the lines.
  assert.deepEqual(read.items.map((item) => item.studentid), ["e:ELEVE01 Prénom", "e:ELEVE02 Prénom"]);
  const [nothing, second] = read.items;
  assert.deepEqual(nothing.totals, { absences: 0, absenceHalfDays: 0, unjustifiedAbsences: 0, lateness: 0, missedHours: null });
  assert.deepEqual(nothing.events, []);
  assert.deepEqual([second.lastname, second.firstname], ["ELEVE02", "Prénom"]);
  assert.deepEqual(second.events.map((event) => [event.kind, event.local.start, event.justified, event.hours, event.minutes, event.subject]), [
    ["absence", "2026-10-05 08:00", false, 4, null, "MATHEMATIQUES"],
    ["lateness", "2026-10-06 08:00", false, null, 10, "ANGLAIS LV1"],
    ["absence", "2026-11-12 14:00", true, 1.5, null, "PHILOSOPHIE"]]);
  assert.match(second.events[0].id, /^a:/);
  assert.equal(second.events[0].halfDays, 1);
  for (const event of second.events) assert.deepEqual(event.reasons, []);
  // The numbers of Pronote first (2 absences, 3 half-days, 5 h 30, 1 late arrival); what it does not count is counted on the events.
  assert.deepEqual(second.totals, { absences: 2, absenceHalfDays: 3, unjustifiedAbsences: 1, lateness: 1, missedHours: 5.5 });
  assert.equal(JSON.stringify(read).includes("secrète"), false);
});

test("absences of a class: numbers without dates give totals and subjects, events stay empty", () => {
  const read = absencesFromRecap(totalsRecap(), entries, FROM, TO)!;
  assert.equal(read.dated, false);
  assert.equal(read.items.length, 3);
  const second = read.items[1];
  // 0.125 day is 3 hours; meals and unjustified half-days are none of the five numbers.
  assert.deepEqual(second.totals, { absences: 2, absenceHalfDays: 3, unjustifiedAbsences: 1, lateness: 2, missedHours: 3 });
  assert.deepEqual(second.events, []);
  assert.deepEqual(second.bySubject, [{ subject: "MATHEMATIQUES", hours: 2, lateness: 1 }, { subject: "EPS", hours: 1, lateness: null }]);
  assert.deepEqual(["Retards", "Absences", "Demi-journées d'absence", "Absences injustifiées", "Heures de cours manquées", "Absences aux repas",
    "Punitions", "Demi-journées injustifiées"].map((label) => totalField(label)),
  ["lateness", "absences", "absenceHalfDays", "unjustifiedAbsences", "missedHours", null, null, null]);
  assert.deepEqual([totalField("", { genreEvenementVS: 8 }), totalField("", { G: 13 }), totalField("", { G: 99 })], ["lateness", "absences", null]);
  // Cells titled by the columns of the table, by position.
  const positional = absencesFromRecap({ listeColonnes: typed([{ L: "Absences" }, { L: "Retards" }]),
    ListeLignes: typed([{ eleve: { _T: 24, V: { L: "ELEVE03 Prénom" } }, valeurs: typed([4, 1]) }]) }, entries, FROM, TO)!;
  assert.deepEqual([positional.items[0].studentid, positional.items[0].totals.absences, positional.items[0].totals.lateness], ["e:ELEVE03 Prénom", 4, 1]);
  // A class that unfolds: its students are lines of its line.
  const nested = absencesFromRecap({ ListeLignes: typed([{ L: "T06", estUnDeploiement: true, ListeLignes: typed([{ N: "4#e5", nbRetards: 3 }]) }]) }, entries, FROM, TO)!;
  assert.deepEqual([nested.items[0].studentid, nested.items[0].totals.lateness, nested.unmatched], ["e:ELEVE05 Prénom", 3, 0]);
  // No line: nobody was absent.
  assert.deepEqual(absencesFromRecap({ ListeLignes: typed([]), LigneCumul: {} }, entries, FROM, TO), { items: [], dated: false, unmatched: 0 });
});

/** Recorded shape (lifeAbsencesRecap.txt): no line by student, the totals of the class only. */
const recordedRecap = () => ({ ListeLignes: typed([]), LigneCumul: { nbClasses: 1, nbEleves: 31, nbAbsences: 42, dureeTotale: "118h30", motifRecevableOui: "Motif secret",
  motifRecevableNon: "Autre motif secret", nbAbsRepas: 3, nbAbsInternat: 0, nbRetardInternat: 0, nbRetards: 17, nbInfirmerie: 5, tauxAbsenteismeTotal: 2.4,
  minutesRetardTotal: 95 } });

test("absences of a class, recorded shape: no line by student, the totals of the class and nothing else", async () => {
  assert.deepEqual(absencesFromRecap(recordedRecap(), entries, FROM, TO), { items: [], dated: false, unmatched: 0 });
  assert.deepEqual(classTotalsOf(recordedRecap()), { students: 31, absences: 42, missedHours: 118.5, lateness: 17, latenessMinutes: 95, absenteeismRate: 2.4 });
  // A duration whose format is not the one read stays unknown; no LigneCumul, or an empty one, gives nothing.
  assert.equal(classTotalsOf({ LigneCumul: { nbAbsences: 2, dureeTotale: "3 jours" } })?.missedHours, null);
  assert.deepEqual(["7h", "7h05", "7,5", 7].map((dureeTotale) => classTotalsOf({ LigneCumul: { dureeTotale } })?.missedHours), [7, 7.08, 7.5, 7]);
  assert.deepEqual([classTotalsOf({ ListeLignes: typed([]) }), classTotalsOf({ LigneCumul: {} })], [null, null]);
  const fake = session({ RecapAbsencesEleves: () => recordedRecap() });
  const result = await classAbsences(fake, "c:T06", FROM, TO);
  assert.deepEqual([result.available, result.reason, result.items, result.total], [true, "totals_only", [], 31]);
  assert.deepEqual(result.classTotals, { students: 31, absences: 42, missedHours: 118.5, lateness: 17, latenessMinutes: 95, absenteeismRate: 2.4 });
  // Neither the infirmary nor the reasons of the totals leave.
  assert.equal(JSON.stringify(result).toLowerCase().includes("secret"), false);
  assert.deepEqual(Object.keys(result.classTotals!), ["students", "absences", "missedHours", "lateness", "latenessMinutes", "absenteeismRate"]);
  // A line by student named as the totals of the class are (supposed): the same numbers, for the student.
  const byStudent = absencesFromRecap({ ListeLignes: typed([{ eleve: { _T: 24, V: { N: "4#e4" } }, nbAbsences: 3, dureeTotale: "7h00", nbRetards: 2 }]) }, entries, FROM, TO)!;
  assert.deepEqual(byStudent.items[0].totals, { absences: 3, absenceHalfDays: null, unjustifiedAbsences: null, lateness: 2, missedHours: 7 });
});

test("absences of a class: an unknown shape is not guessed", () => {
  assert.equal(absencesFromRecap({ autre: 1 }, entries, FROM, TO), null);
  assert.equal(absencesFromRecap({ ListeLignes: { texte: "x" } }, entries, FROM, TO), null);
  // Lines of students, but nothing recognised in them.
  assert.equal(absencesFromRecap({ ListeLignes: typed([{ N: "4#e1", inconnu: "Valeur secrète" }]) }, entries, FROM, TO), null);
  // Lines with numbers, but no student of the class.
  assert.equal(absencesFromRecap({ ListeLignes: typed([{ L: "Ligne secrète", nbAbsences: 3 }]) }, entries, FROM, TO), null);
});

test("GET /classlife/absences: one call per class, the school year by default, totals_only, format_unknown, access_denied", async () => {
  const fake = session({ RecapAbsencesEleves: () => datedRecap() });
  const dated = await classAbsences(fake, "c:T06");
  assert.deepEqual([dated.available, dated.reason, dated.validated, dated.total, dated.unmatched], [true, "", false, 31, 1]);
  assert.deepEqual(dated.classTotals, { students: null, absences: 2, missedHours: null, lateness: 1, latenessMinutes: null, absenteeismRate: null });
  assert.deepEqual(dated.class, { id: "c:T06", name: "T06" });
  assert.deepEqual([dated.from, dated.to], [seconds(new Date(2026, 8, 1)), seconds(new Date(2027, 6, 4))]);
  assert.deepEqual(schoolYearRange(fake), { from: dated.from, to: dated.to });
  assert.equal(dated.items.length, 2);
  assert.deepEqual(names(fake), ["RecapAbsencesEleves", "ListeEleves"]);
  // The request that answered on 21/11/2026, with the weeks of the range as domain.
  const sent = fake.calls[0];
  assert.equal(sent.onglet, 138);
  assert.deepEqual(sent.data?.classes, typed([{ N: "1#c1", G: 1, L: "T06" }]));
  assert.deepEqual([sent.data?.regimes, sent.data?.bourses, sent.data?.criteres], [typed([]), typed([]), {}]);
  assert.equal(sent.data?.domaine?._T, 8);
  assert.match(sent.data?.domaine?.V, /^\[1\.\.\d+\]$/);
  const october = await classAbsences(fake, "c:T06", seconds(new Date(2026, 9, 5)), seconds(new Date(2026, 9, 12)));
  assert.equal(fake.calls[2].data?.domaine?.V, "[5..5]");
  assert.deepEqual(october.items[1].events.map((event) => event.kind), ["absence", "lateness"]);

  const totals = await classAbsences(session({ RecapAbsencesEleves: () => totalsRecap() }), "c:T06", FROM, TO);
  assert.deepEqual([totals.available, totals.reason, totals.items.length], [true, "totals_only", 3]);

  const odd = session({ RecapAbsencesEleves: () => ({ recap: { lignes: [{ texte: "Absence secrète", eleve: "ELEVE01 Secret" }] } }) });
  const unknown = await classAbsences(odd, "c:T06", FROM, TO);
  assert.deepEqual([unknown.available, unknown.reason, unknown.items], [false, "format_unknown", []]);
  assert.deepEqual(unknown.shape, ["recap: object", "recap.lignes: list[1]", "recap.lignes[]: object", "recap.lignes[].texte: string",
    "recap.lignes[].eleve: string"]);
  assert.equal(JSON.stringify(unknown).toLowerCase().includes("secr"), false);

  // Refused by the profile: said, with the tab, and nothing else is asked.
  const closed = session({ RecapAbsencesEleves: () => denied });
  const refused = await classAbsences(closed, "c:T06", FROM, TO);
  assert.deepEqual([refused.available, refused.reason, refused.onglet, refused.items], [false, "access_denied", 138, []]);
  assert.deepEqual(names(closed), ["RecapAbsencesEleves"]);
  const empty = session({ RecapAbsencesEleves: () => ({}) });
  assert.equal((await classAbsences(empty, "c:T06", FROM, TO)).reason, "access_denied");
  assert.deepEqual(names(empty), ["RecapAbsencesEleves"]);
  await assert.rejects(classAbsences(session(), "g:T-SPE SVT 1", FROM, TO), /resource_not_class/);
});

/* ---- 7.2 Support plans: DetailsPIEleve ---- */

/** Supposed shape: the plans of the student, each with its type, dates, comment and accommodations. */
const plansAnswer = (index: number) => ({ listeProjets: typed(index % 3 === 0 ? [
  { L: "PAP", typeProjet: { _T: 24, V: { L: "Plan d'accompagnement personnalisé" } }, dateDebut: date("01/09/2026"), dateFin: date("03/07/2027"),
    commentaire: "Commentaire fictif du plan", motif: "Trouble fictif",
    listeAmenagements: typed([{ L: "Pédagogiques", listeAmenagements: typed([{ L: "Temps majoré" }, { L: "Sujets agrandis" }]) },
      { L: "Tiers-temps aux examens" }]) },
  { L: "AMENAGTS EXAMS", avecAmenagementsExamen: true },
] : []) });

test("support plans: type, dates, comment and accommodations of each plan; an unknown shape is not guessed", () => {
  const plans = plansFromAnswer(plansAnswer(0))!;
  assert.deepEqual(plans, [
    { type: "PAP", label: "PAP", title: "Trouble fictif", start: "2026-09-01", end: "2027-07-03", comment: "Commentaire fictif du plan",
      accommodations: ["Temps majoré", "Sujets agrandis", "Tiers-temps aux examens"], examAccommodations: true },
    { type: "accommodation", label: "AMENAGTS EXAMS", title: "", start: "", end: "", comment: "", accommodations: [], examAccommodations: true }]);
  assert.deepEqual(plansFromAnswer(plansAnswer(1)), [], "a known list that is empty: no plan");
  // The type named by a member when the element has no label.
  assert.deepEqual([planFrom({ type: { _T: 24, V: { L: "PAI." } } })?.type, planFrom({ type: { _T: 24, V: { L: "PAI." } } })?.label, planFrom({ autre: 1 })], ["PAI", "PAI.", null]);
  // No known name: the only list whose elements look like plans.
  assert.deepEqual(plansFromAnswer({ listeInconnue: typed([{ L: "PPS", dateDebut: date("01/09/2026") }]), autres: typed([{ L: "x" }]) })?.map((plan) => plan.type), ["PPS"]);
  assert.equal(plansFromAnswer({ a: typed([{ L: "PPS", dateDebut: 1 }]), b: typed([{ L: "PAP", dateFin: 1 }]) }), null, "two candidate lists: not guessed");
  // One plan given alone under a known name.
  assert.deepEqual(plansFromAnswer({ projet: { L: "PPRE", commentaire: "Commentaire fictif" } })?.map((plan) => [plan.type, plan.comment]), [["PPRE", "Commentaire fictif"]]);
  assert.equal(plansFromAnswer({ estPubliable: true }), null);
  assert.equal(plansFromAnswer({ listeProjets: typed([{ inconnu: "Valeur secrète" }]) }), null);
});

test("GET /students/plans: a page of students, an unreadable student named, format_unknown, access_denied without other call", async () => {
  const fake = session({ DetailsPIEleve: (data) => plansAnswer(Number(String(data?.eleve?.N).slice(3)) - 1) });
  const page = await studentPlans(fake, "c:T06", { offset: 0, limit: 4 });
  assert.deepEqual([page.available, page.reason, page.validated, page.total, page.offset, page.partial], [true, "", false, 31, 0, false]);
  assert.deepEqual(page.items.map((item) => [item.studentid, item.plans.length]), [["e:ELEVE01 Prénom", 2], ["e:ELEVE02 Prénom", 0],
    ["e:ELEVE03 Prénom", 0], ["e:ELEVE04 Prénom", 2]]);
  assert.deepEqual(page.read, entries.slice(0, 4).map((entry) => entry.id));
  const sent = fake.calls.find((call) => call.name === "DetailsPIEleve")!;
  assert.deepEqual([sent.data, sent.onglet], [{ eleve: { N: "4#e1", G: 4, L: "ELEVE01 Prénom" } }, 105]);
  assert.equal(callCost("DetailsPIEleve"), 2);
  assert.deepEqual((await studentPlans(fake, "c:T06", { student: "e:ELEVE07 Prénom" })).items.map((item) => item.plans.length), [2]);
  await assert.rejects(studentPlans(fake, "c:T06", { student: "e:INCONNU Élève" }), /student_not_found/);

  // The function answers, one student is not understood: named, never given "no plan"; an empty answer is "nothing".
  const mixed = session({ DetailsPIEleve: (data) => (data?.eleve?.N === "4#e2" ? { projetSecret: { texte: "Valeur secrète" }, autre: { nombre: 3 } }
    : data?.eleve?.N === "4#e3" ? {} : plansAnswer(0)) });
  const some = await studentPlans(mixed, "c:T06", { offset: 0, limit: 4 });
  assert.equal(some.available, true);
  assert.deepEqual(some.items.map((item) => [item.studentid, item.plans.length]), [["e:ELEVE01 Prénom", 2], ["e:ELEVE03 Prénom", 0], ["e:ELEVE04 Prénom", 2]]);
  assert.deepEqual(some.unreadable, ["e:ELEVE02 Prénom"]);
  // Sensitive names are left out of the shape (shape.ts SENSITIVE), and no value is in it.
  assert.deepEqual(some.shape, ["autre: object", "autre.nombre: number"]);
  assert.equal(JSON.stringify(some).includes("secrète"), false);

  // No answer was ever understood: the decoder is wrong, one call is enough, for this page and the next ones.
  const odd = session({ DetailsPIEleve: () => ({ detail: { lignes: [{ texte: "Plan secret" }] }, planSecretPAP: typed([{ texte: "PAP secret" }]) }) });
  const unknown = await studentPlans(odd, "c:T06", { offset: 0, limit: 5 });
  assert.deepEqual([unknown.available, unknown.reason, unknown.items, unknown.read, unknown.remaining], [false, "format_unknown", [], [], []]);
  assert.deepEqual(unknown.shape, ["detail: object", "detail.lignes: list[1]", "detail.lignes[]: object", "detail.lignes[].texte: string"]);
  assert.equal(JSON.stringify(unknown).includes("secret"), false);
  assert.equal((await studentPlans(odd, "c:T06", { offset: 5, limit: 5 })).reason, "format_unknown");
  assert.equal(odd.calls.filter((call) => call.name === "DetailsPIEleve").length, 1);

  // Refused by the profile: one call, then nothing, and no other function in its place.
  const closed = session({ DetailsPIEleve: () => denied });
  const refused = await studentPlans(closed, "c:T06", { offset: 0, limit: 10 });
  assert.deepEqual([refused.available, refused.reason, refused.onglet, refused.items], [false, "access_denied", 105, []]);
  assert.deepEqual(names(closed), ["ListeEleves", "DetailsPIEleve"]);
  await studentPlans(closed, "c:T06", { offset: 10, limit: 10 });
  assert.deepEqual(names(closed), ["ListeEleves", "DetailsPIEleve", "ListeEleves"]);
  // An empty answer while the function never answered is a refusal too.
  const empty = session({ DetailsPIEleve: () => ({}) });
  assert.equal((await studentPlans(empty, "c:T06", { limit: 3 })).reason, "access_denied");
  assert.equal(empty.calls.filter((call) => call.name === "DetailsPIEleve").length, 1);
  resetSourceMemory(closed);
  await studentPlans(closed, "c:T06", { limit: 1 });
  assert.equal(closed.calls.filter((call) => call.name === "DetailsPIEleve").length, 2, "forgotten: asked again");
});

/* ---- 7.3 Previous years: LivretScolaire and PageSuiviPluriannuel ---- */

/**
 * Recorded shape of the multi-year page (multiYear.txt): listeDonnees[] is one entry per year, listeSuivis[] one line
 * per subject, numbers are typed strings. What the strings hold was not seen: the first year is named by its label,
 * the second by its two ends.
 */
const suivi = (subject: string, moyenne: string, moyenneClasse: string, appreciation: string) => ({ L: subject, meta: { _T: 24, V: { L: "Pôle fictif", N: "m1" } },
  strMeta: "Pôle fictif", moyenne: note(moyenne), moyenneClasse: note(moyenneClasse), appreciation, coefficient: note("2,00"), facultatif: false, Bonus: false,
  strAnnotation: "", hintAnnotation: "", positionnement: 0 });
const multiYearAnswer = () => ({ avecMoyennesSaisies: true,
  listeDonnees: typed([
    { L: "2025-2026", identifiant: 2, strAnnee: "2025", strFinAnnee: "2026", bareme: note("20"), couleur: "#4A90D9", strClasses: "1G4", moyenne: note("13,42"),
      moyenneClasse: note("12,10"), nbMaxPeriode: 3, avecBulletins: true,
      listeBulletins: typed([{ ident: "b1", nomFichier: "bulletin-secret.pdf", libelle: "Trimestre 1", annee: 2025, libelleAnnee: "2025-2026", libelleClasse: "1G4",
        libellePeriodeNotation: "Trimestre 1" }, { ident: "b2", nomFichier: "bulletin-secret-2.pdf", libelle: "Trimestre 2", annee: 2025 }]),
      listeSuivis: typed([suivi("MATHEMATIQUES", "14,50", "11,20", "Appréciation fictive A"), suivi("PHILOSOPHIE", "|1", "", "Appréciation fictive B")]) },
    { L: "Seconde", identifiant: 1, strAnnee: "2024", strFinAnnee: "2025", bareme: note("20"), couleur: "#D94A4A", strClasses: "2D3", moyenne: note("12,00"),
      moyenneClasse: note(""), nbMaxPeriode: 3, avecBulletins: false, listeBulletins: typed([]), listeSuivis: typed([suivi("MATHEMATIQUES", "11,00", "", "")]) }]),
  listeMetas: typed([{ L: "Pôle fictif", N: "m1" }, { L: "Autre pôle", N: "m2" }]),
  listeAnnees: typed([{ L: "2025-2026" }, { L: "2024-2025" }]),
  grapheAvecMoyenne: { _T: 25, V: 1 }, grapheSansMoyenne: { _T: 25, V: 2 }, afficherMoyenneGenerale: true });

/** Recorded frame of the school record (schoolRecord.txt); the lines of the student are a supposition. */
const livretFrame = (lines: Record<string, unknown>[] = []) => ({ listeEngagements: typed([{ L: "Délégué fictif", N: "e1", code: "D" }, { L: "Autre", N: "e2", code: "A" }]),
  strInfoDatePublication: "", avecFiliere: false, estFilierePro: false, tailleMaxSaisie: 300,
  classe: { L: "T06", N: "1#c1", nombrePeriodes: 3, listeLivret: [] }, estFiliereNew: true,
  eleve: { L: "ELEVE01 Prénom", N: "4#e1", P: 0, estRedoublant: false, listeLivret: lines, libelleEnseignement: "Enseignement fictif" },
  piedDePage: { editable: false, editablePourAvisCE: false, avecAvisCE: true, estIssueDUnBOLycee: false,
    avisCE: { listeAvis: typed([{ L: "Avis secret", N: "a1", nbEleves: 12 }, { L: "Autre avis secret", N: "a2", nbEleves: 19 }]), libelleRepatition: "", nbElevesTotal: 31 },
    avecEngagements: false, engagements: { listeEngagements: typed([]) }, avecInvestissement: false, investissement: {}, avecParcoursDifferencie: false } });

/** Supposed shape of the school record: one line per subject, one cell per year named by a list of years beside. */
const livretAnswer = () => ({ livret: { _T: 24, V: {
  listeAnnees: typed([{ L: "Première", annee: "2025-2026" }, { L: "Terminale", annee: "2026-2027" }]),
  listeMatieres: typed([
    { L: "MATHEMATIQUES", listeMoyennes: typed([{ moyenneEleve: "14,00", moyenneClasse: "11,00", appreciationAnnuelle: "Livret fictif A" }, { moyenneEleve: "15,10" }]) },
    { L: "SVT", listeMoyennes: typed([{ moyenneEleve: "16,00" }, {}]) }]) } } });

test("previous years: years with their subjects, subjects with one cell per year, subjects alone; unknown shapes are not guessed", () => {
  const multi = yearsFromAnswer(multiYearAnswer())!;
  assert.deepEqual(multi, [
    { year: "2025-2026", label: "2025-2026", level: "1G4", average: 13.42, classAverage: 12.1, subjects: [
      { subject: "MATHEMATIQUES", average: 14.5, classAverage: 11.2, comment: "Appréciation fictive A" },
      { subject: "PHILOSOPHIE", average: null, classAverage: null, comment: "Appréciation fictive B" }] },
    // "Seconde" names no school year: the two ends of the year (2024, 2025) do, and give the label.
    { year: "2024-2025", label: "2024-2025", level: "2D3", average: 12, classAverage: null, subjects: [
      { subject: "MATHEMATIQUES", average: 11, classAverage: null, comment: "" }] }]);
  assert.equal(JSON.stringify(multi).includes("secret"), false, "the files of the report cards are not read");
  assert.deepEqual(yearsFromAnswer({ listeDonnees: typed([]), listeAnnees: typed([]) }), [], "a student without past year");
  // Recorded frame of the school record: not filled yet, it is available and gives no year.
  assert.deepEqual(livretFromAnswer(livretFrame()), []);
  // A line of the school record was never seen: read as a subject (supposed names), the class of the frame as level.
  assert.deepEqual(livretFromAnswer(livretFrame([{ L: "EPS", moyenneEleve: note("15,00"), moyenneClasse: note("13,00"), appreciation: "Livret fictif" }])),
    [{ year: "", label: "T06", level: "T06", average: null, classAverage: null, subjects: [{ subject: "EPS", average: 15, classAverage: 13, comment: "Livret fictif" }] }]);
  assert.equal(livretFromAnswer(livretFrame([{ inconnu: "Valeur secrète" }])), null, "lines in which no subject is recognised");
  assert.equal(JSON.stringify(livretFromAnswer(livretFrame())).includes("secret"), false);
  // Supposed layout, still read: a list of years named "listeAnnees", each with its "listeMatieres".
  assert.deepEqual(yearsFromAnswer({ listeAnnees: typed([{ L: "Année 2024/25", niveau: "Seconde", moyenne: 12, listeMatieres: typed([{ L: "MATHEMATIQUES", moyenne: 11 }]) }]) }),
    [{ year: "2024-2025", label: "Année 2024/25", level: "Seconde", average: 12, classAverage: null, subjects: [{ subject: "MATHEMATIQUES", average: 11, classAverage: null, comment: "" }] }]);
  const livret = yearsFromAnswer(livretAnswer())!;
  assert.deepEqual(livret.map((year) => [year.year, year.label, year.subjects.map((subject) => [subject.subject, subject.average])]), [
    ["2025-2026", "2025-2026", [["MATHEMATIQUES", 14], ["SVT", 16]]], ["2026-2027", "2026-2027", [["MATHEMATIQUES", 15.1]]]]);
  assert.equal(livret[0].subjects[0].comment, "Livret fictif A");
  // Subjects alone: one year, named by the answer when it names it.
  assert.deepEqual(yearsFromAnswer({ anneeScolaire: "2026-2027", classe: "T06", listeServices: typed([{ L: "EPS", MoyenneEleve: "15", MoyenneClasse: "13" }]) }),
    [{ year: "2026-2027", label: "2026-2027", level: "T06", average: null, classAverage: null, subjects: [{ subject: "EPS", average: 15, classAverage: 13, comment: "" }] }]);
  assert.deepEqual(yearsFromAnswer({ listeAnnees: typed([]) }), [], "a known list that is empty: no past result");
  assert.deepEqual(["2025-2026", "Année 2024/25", "2025 - 2026", "2025-2027", "Première", "12025-2026"].map(schoolYearOf),
    ["2025-2026", "2024-2025", "2025-2026", "", "", ""]);
  assert.equal(yearsFromAnswer({ autre: 1 }), null);
  assert.equal(yearsFromAnswer({ listeAnnees: typed([{ inconnu: "Valeur secrète" }]) }), null);
  assert.equal(yearsFromAnswer({ listeMatieres: typed([{ L: "MATHS", listeMoyennes: typed([{ moyenneEleve: 12 }]) }]) }), null, "cells that name no year");
  // The two sources merged by school year: the first one first, what it lacks filled by the second.
  const merged = mergeYears([livret, multi]);
  assert.deepEqual(merged.map((year) => [year.year, year.level, year.average, year.subjects.map((subject) => subject.subject)]), [
    ["2026-2027", "", null, ["MATHEMATIQUES"]], ["2025-2026", "1G4", 13.42, ["MATHEMATIQUES", "SVT", "PHILOSOPHIE"]], ["2024-2025", "2D3", 12, ["MATHEMATIQUES"]]]);
  const maths = merged[1].subjects[0];
  assert.deepEqual(maths, { subject: "MATHEMATIQUES", average: 14, classAverage: 11, comment: "Livret fictif A" });
});

test("GET /students/history: both sources per student, one source unknown or refused never hides the other", async () => {
  const fake = session({ LivretScolaire: () => livretAnswer(), PageSuiviPluriannuel: () => multiYearAnswer() });
  const page = await studentHistory(fake, "c:T06", { offset: 0, limit: 3 });
  assert.deepEqual([page.available, page.reason, page.validated, page.total, page.items.length], [true, "", false, 31, 3]);
  assert.deepEqual(page.sources, { livret: { available: true, reason: "" }, multiyear: { available: true, reason: "" } });
  assert.deepEqual(page.items[0].sources, page.sources);
  assert.deepEqual(page.items[0].years.map((year) => year.year), ["2026-2027", "2025-2026", "2024-2025"]);
  const livret = fake.calls.find((call) => call.name === "LivretScolaire")!;
  assert.deepEqual([livret.data, livret.onglet], [{ Classe: { N: "1#c1", G: 1, L: "T06" }, AvecDonneesClasse: true, Eleve: { N: "4#e1", G: 4, L: "ELEVE01 Prénom" } }, 83]);
  const multi = fake.calls.find((call) => call.name === "PageSuiviPluriannuel")!;
  assert.deepEqual([multi.data, multi.onglet], [{ eleve: { N: "4#e1" } }, 44]);
  assert.deepEqual([callCost("LivretScolaire"), callCost("PageSuiviPluriannuel"), callCost("RecapAbsencesEleves")], [2, 2, 2]);
  // Recorded shapes of both sources: the school record not filled yet is available and empty, the years are those of the multi-year page.
  const recorded = session({ LivretScolaire: () => livretFrame(), PageSuiviPluriannuel: () => multiYearAnswer() });
  const real = await studentHistory(recorded, "c:T06", { offset: 0, limit: 2 });
  assert.deepEqual([real.available, real.sources.livret, real.sources.multiyear], [true, { available: true, reason: "" }, { available: true, reason: "" }]);
  assert.deepEqual(real.items.map((item) => item.years.map((year) => [year.year, year.level, year.average])), [[["2025-2026", "1G4", 13.42], ["2024-2025", "2D3", 12]],
    [["2025-2026", "1G4", 13.42], ["2024-2025", "2D3", 12]]]);
  // One source asked: the other is not called.
  const only = await studentHistory(fake, "c:T06", { student: "e:ELEVE02 Prénom" }, ["multiyear"]);
  assert.deepEqual(only.items[0].sources.livret, { available: false, reason: "not_asked" });
  assert.equal(fake.calls.filter((call) => call.name === "LivretScolaire").length, 3);
  // The school record is the one of a class: not asked for a group.
  const group = await studentHistory(fake, "g:T-SPE SVT 1", { limit: 1 });
  assert.deepEqual(group.sources.livret, { available: false, reason: "resource_not_class" });
  assert.equal(group.items[0].years.length, 2);

  // The school record is not understood, the multi-year page is refused: each says so, once.
  const odd = session({ LivretScolaire: () => ({ livretInconnu: { pages: [{ texte: "Livret secret" }] } }), PageSuiviPluriannuel: () => denied });
  const nothing = await studentHistory(odd, "c:T06", { offset: 0, limit: 5 });
  assert.deepEqual([nothing.available, nothing.reason, nothing.items], [false, "format_unknown", []]);
  assert.deepEqual(nothing.sources.livret.shape, ["livretInconnu: object", "livretInconnu.pages: list[1]", "livretInconnu.pages[]: object",
    "livretInconnu.pages[].texte: string"]);
  assert.deepEqual([nothing.sources.multiyear.reason, nothing.sources.multiyear.onglet], ["access_denied", 44]);
  assert.equal(JSON.stringify(nothing).includes("secret"), false);
  assert.deepEqual(names(odd), ["ListeEleves", "LivretScolaire", "PageSuiviPluriannuel"], "no other call after the refusals");

  // One source refused: no other call of it, the other goes on for every student.
  const half = session({ LivretScolaire: () => denied, PageSuiviPluriannuel: () => multiYearAnswer() });
  const kept = await studentHistory(half, "c:T06", { offset: 0, limit: 4 });
  assert.equal(kept.available, true);
  assert.deepEqual([kept.sources.livret.reason, kept.sources.livret.onglet, kept.sources.multiyear.available], ["access_denied", 83, true]);
  assert.deepEqual(kept.items.map((item) => [item.sources.livret.reason, item.years.length]), [["access_denied", 2], ["access_denied", 2], ["access_denied", 2], ["access_denied", 2]]);
  assert.deepEqual([half.calls.filter((call) => call.name === "LivretScolaire").length, half.calls.filter((call) => call.name === "PageSuiviPluriannuel").length], [1, 4]);
  await studentHistory(half, "c:T06", { offset: 4, limit: 4 });
  assert.equal(half.calls.filter((call) => call.name === "LivretScolaire").length, 1, "the refusal is remembered for the next pages");
});

/* ---- Routes ---- */

test("the three routes: parameters checked, priorities, cache; no health data in the cache nor in the logs", async () => {
  readCache.clear();
  const file = join(mkdtempSync(join(tmpdir(), "sidecar-suivi-")), "access.log");
  const lines: string[] = [];
  const app = await buildApp({ logStream: { write: (line) => lines.push(line) }, accessLog: new AccessLog(file) });
  const fake = session({ RecapAbsencesEleves: () => datedRecap(), DetailsPIEleve: () => plansAnswer(0), LivretScolaire: () => livretAnswer(),
    PageSuiviPluriannuel: () => multiYearAnswer() });
  const login = { url: "https://demo.example/pronote", username: "prof-suivi", deviceuuid: "device-suivi" };
  const id = createSession(fake, { key: accountKey(login.url, login.username, login.deviceuuid), login });

  const absences = await get(app, "/classlife/absences?resource=c%3AT06", id);
  assert.equal(absences.statusCode, 200, absences.body);
  assert.equal(absences.json().items.length, 2);
  assert.equal((await get(app, "/classlife/absences?resource=c%3AT06", id)).headers["x-cache"], "hit");
  assert.equal((await get(app, `/classlife/absences?resource=c%3AT06&from=${FROM}&to=${FROM + 500 * 86400}`, id)).json().error, "range_too_large");
  assert.equal((await get(app, "/classlife/absences", id)).statusCode, 400);

  const history = await get(app, "/students/history?resource=c%3AT06&limit=2&sources=multiyear", id);
  assert.equal(history.statusCode, 200, history.body);
  assert.deepEqual(history.json().items.map((item: any) => item.years.length), [2, 2]);
  assert.equal((await get(app, "/students/history?resource=c%3AT06&sources=bulletins", id)).json().error, "invalid_sources:bulletins");
  assert.equal((await get(app, "/students/history?resource=c%3AT06&limit=41", id)).statusCode, 400);

  const entriesBefore = readCache.stats().entries;
  const plans = await get(app, "/students/plans?resource=c%3AT06&limit=2", id);
  assert.equal(plans.statusCode, 200, plans.body);
  assert.equal(plans.json().items[0].plans[0].comment, "Commentaire fictif du plan");
  const again = await get(app, "/students/plans?resource=c%3AT06&limit=2", id);
  assert.equal(again.headers["x-cache"], undefined, "never cached");
  assert.equal(readCache.stats().entries, entriesBefore);
  assert.equal(fake.calls.filter((call) => call.name === "DetailsPIEleve").length, 4);
  assert.equal((await get(app, `/students/plans?resource=c%3AT06&student=${encodeURIComponent("e:ELEVE01 Prénom")}`, id)).json().items.length, 1);
  assert.equal((await get(app, "/students/plans?resource=c%3AT06&limit=41", id)).statusCode, 400);
  await app.close();

  // The logs: the route, never the answer, not even its size (for one student it would tell whether a plan exists).
  const access = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const logged = access.filter((line) => line.route === "/students/plans");
  assert.equal(logged.length, 4);
  for (const line of logged) assert.deepEqual([line.bytes, line.shape], [0, undefined]);
  assert.ok(access.find((line) => line.route === "/classlife/absences").bytes > 0);
  const everything = `${readFileSync(file, "utf8")}\n${lines.join("\n")}`;
  for (const secret of ["PAP", "Commentaire fictif", "Temps majoré", "Trouble fictif", "ELEVE01", "Prénom"]) assert.equal(everything.includes(secret), false, secret);

  // One student is a unit read, a page a bulk read.
  assert.equal(priorityOf("GET", "/students/plans", { student: "e:X Y" }), PRIORITY.read);
  assert.equal(priorityOf("GET", "/students/plans", {}), PRIORITY.bulk);
  assert.equal(priorityOf("GET", "/students/history", {}), PRIORITY.bulk);
  assert.equal(priorityOf("GET", "/classlife/absences", {}), PRIORITY.bulk);
});
