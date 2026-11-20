import assert from "node:assert/strict";
import { test } from "node:test";
import { isWriteFunction } from "../src/context.js";
import { HttpError } from "../src/errors.js";
import { rememberUserData } from "../src/pronote/userdata.js";
import { kindsFromAnswer, reportComments } from "../src/teacher/comments.js";
import { generalKindFor, writeComments } from "../src/teacher/commentsWrite.js";
import { functions, FUNCTION_KEYS } from "../src/teacher/functions.js";
import { studentPhotos } from "../src/teacher/photos.js";
import { MAX_SHAPE_PAGE, MAX_UNKNOWN_SHAPE, ppCheck } from "../src/teacher/ppcheck.js";
import { classResults, resultsFromAnswer, titleText } from "../src/teacher/reports.js";
import { MAX_SHAPE, shapeOf } from "../src/teacher/shape.js";
import { fileOf, guardianRead, levelOf, readMemos, resetGroupRosters, resetMemoRoute, responsibilityOf, studentFiles } from "../src/teacher/students.js";
import { fakeSession, type FakeCall } from "./fake-session.js";

/*
 * 0.14.0: main teacher view corrected after the first real check of 20/11/2026 (docs/olutionmcp/PROMPT_0.51.0.md in
 * mood_prod). The fixtures are BUILT from the shapes that check returned (member names and types only) and from the web
 * client that reads them; every name and value is generated. Nothing here was read from a real server.
 */
const period = { N: "1#t1", L: "Trimestre 1", G: 2 };
const classT06 = { id: "1#c1", label: "T06", genre: 1 as const, taught: true, principal: true };
const students = Array.from({ length: 31 }, (_, i) => ({ N: `4#e${i + 1}`, L: `ELEVE${String(i + 1).padStart(2, "0")} Prénom`, G: 4 }));
const entries = students.map((item) => ({ pronoteId: item.N, label: item.L, id: `e:${item.L}` }));
const denied = { Erreur: { Titre: "Vos droits sont insuffisants pour effectuer cette opération." } };
const typed = <T>(items: T[]) => ({ _T: 24, V: items });
const note = (value: string) => ({ _T: 10, V: value });

type Handlers = Record<string, (data: any, call: FakeCall) => any>;

const session = (handlers: Handlers = {}, resources: Record<string, unknown>[] = [classT06], tabs = [13, 19, 27, 64, 78, 105, 113, 23]) => {
  const fake = fakeSession({
    ListeEleves: () => ({ listeEleves: typed(students) }),
    ListePeriodes: () => ({ listePeriodes: typed([period]), periodeParDefaut: { _T: 24, V: period } }),
    ...handlers,
  });
  rememberUserData(fake, { resources: resources as never, tabs });
  return fake;
};

/** Every line of a shape: a member path, then types (with the class of length of a list) or a type code. */
const SHAPE_LINE = /^[\w.[\]]+(: \w+(\[(0|1|2\+)\])?(\|\w+(\[(0|1|2\+)\])?)*|=\d+(\|\d+)*)$/;

/* ---- Lot 1: the shape of an answer, and the check ---- */

test("shape: a first empty element no longer hides the others, members of five elements together, never a value", () => {
  const empty = { nom: "DUPONT Secret", rang: 3, notesEleve: typed([]), dateNaissance: { _T: 7, V: "02/05/2008" } };
  const answer = { resultats: typed([
    empty,
    { nom: "MARTIN Secret", rang: 1, seulDansLeDeuxieme: true, notesEleve: typed([]), cellule: null },
    ...Array.from({ length: 5 }, () => ({ ...empty, cellule: { texte: "Valeur secrète" } })),
    // Beyond the five elements described together: the first that fills "notesEleve".
    { nom: "PETIT Secret", notesEleve: typed([{ ColMoy: { moyenne: note("12,50") } }]) },
  ]), vide: [], un: [7], objetVide: {} };
  const shape = shapeOf(answer);
  for (const line of ["resultats._T=24", "resultats.V: list[2+]", "resultats.V[]: object", "resultats.V[].seulDansLeDeuxieme: boolean",
    "resultats.V[].dateNaissance._T=7", "resultats.V[].cellule: null|object", "resultats.V[].cellule.texte: string",
    "resultats.V[].notesEleve.V: list[1]", "resultats.V[].notesEleve.V[].ColMoy.moyenne._T=10", "resultats.V[].notesEleve.V[].ColMoy.moyenne.V: string",
    "vide: list[0]", "un: list[1]", "un[]: number", "objetVide: object"]) {
    assert.ok(shape.includes(line), `${line}\n${shape.join("\n")}`);
  }
  // Names of members, types, type codes and classes of length: no string, number or date of the answer.
  for (const line of shape) assert.match(line, SHAPE_LINE);
  for (const value of ["Secret", "secrète", "12,50", "02/05/2008", ": 3", "=3"]) assert.equal(shape.join("\n").includes(value), false, value);
  // Sensitive members are not even named, unless the caller describes them on purpose (memos of the check).
  assert.deepEqual(shapeOf({ listeMemos: [{ commentaire: "x" }], autre: 1 }), ["autre: number"]);
  assert.deepEqual(shapeOf({ listeMemos: [{ commentaire: "x" }] }, "", 0, [], null), ["listeMemos: list[1]", "listeMemos[]: object", "listeMemos[].commentaire: string"]);
});

test("shape: 150 lines by default, as many as asked for one function", () => {
  const big = Object.fromEntries(Array.from({ length: 400 }, (_, index) => [`membre${index}`, index]));
  assert.equal(MAX_SHAPE, 150);
  assert.equal(shapeOf(big).length, 150);
  assert.equal(shapeOf(big, "", 0, [], null, 1000).length, 400);
});

/** Functions the check must probe (docs/olutionmcp/PROMPT_0.51.0.md, lot 1), with the tab of the web client. */
const PROBED: [string, number][] = [["RecapAbsencesEleves", 138], ["RecapFeuilleAppel", 139], ["RecapPunitions", 140], ["AbsencesGrille", 155],
  ["PageSuivisAbsenceRetard", 74], ["ListePunitions", 192], ["DetailAbsences", 113], ["Incidents", 135], ["PageApprBulletin", 25],
  ["PageApprBulletin", 30], ["PageAppreciationsBulletinParEleve", 246], ["ListeElevesBIA", 227], ["BulletinBIA", 227],
  ["RecapitulatifScolarite", 161], ["LivretScolaire", 83], ["PageDossiers", 20], ["PageSuiviPluriannuel", 44], ["PageTrombinoscope", 77],
  ["ListeRegimesEleve", 138], ["DetailsPIEleve", 105], ["ListeAvisProfesseurs", 260]];

const checkSession = () => session({
  ListeServices: () => ({ services: typed([{ N: "5#es", matiere: { _T: 24, V: { N: "9#es", L: "ENSEIGNEMENT SCIENTIFIQUE" } }, classe: { _T: 24, V: { N: "1#c1", L: "T06", G: 1 } } }]) }),
  // 700 members: more than a page of the shape of one function.
  ResultatsClasses: () => ({ grille: Object.fromEntries(Array.from({ length: 700 }, (_, index) => [`membre${index}`, `Valeur secrète ${index}`])) }),
  DetailAbsences: () => ({ listeAbsences: typed([]), totalCoursManques: 0 }),
  ListePunitions: () => denied,
  PageSuivisAbsenceRetard: () => ({ Erreur: { Titre: "Erreur inattendue pour ELEVE01 Secret" } }),
  Incidents: () => ({ incidents: typed([{ L: "Incident secret", gravite: 2, protagonistes: typed([{ nom: "ELEVE01 Secret" }]) }]) }),
  FicheEleve: () => ({ Identite: { _T: 24, V: { nom: "ELEVE01", prenom: "Secret" } },
    Scolarite: { _T: 24, V: { listeEquipePeda: typed([{ L: "Mme PROF Secrète", matiere: { _T: 24, V: { L: "PHILOSOPHIE" } } }]), listePP: typed([{ L: "M. PP Secret" }]) } },
    Responsables: typed([{ nom: "Mme PARENT Secrète", niveauResponsabilite: "Responsable légal", profession: "Profession secrète" }]),
    listeRessources: typed([{ L: "Mme PARENT Secrète", G: 5 }]) }),
});

test("check: every probe of the lot is sent as a read; a refusal or an error does not stop the next; no value leaves", async () => {
  const fake = checkSession();
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(996, 1)]);
  const result = await ppCheck(fake, "c:T06", { downloader: async () => ({ contentType: "image/jpeg", bytes: jpeg }) });
  assert.deepEqual(result.groups, ["core", "life", "reports", "misc"]);
  for (const [name, onglet] of PROBED) {
    assert.ok(fake.calls.some((call) => call.name === name && call.onglet === onglet), `${name}@${onglet} is probed`);
  }
  // Reads only: neither a call nor a configured probe is a write function.
  for (const call of fake.calls) assert.equal(isWriteFunction(call.name), false, call.name);
  for (const check of result.checks) assert.doesNotMatch(check.function, /^(Saisie|Programmer)/);
  const by = (key: string, variant = "") => result.checks.find((check) => check.key === key && (variant === "" || check.variant === variant))!;
  // A refusal (tab 192 is not in the session: closed tab), then an error of Pronote, then the next probes all the same.
  assert.equal(by("lifePunishments").status, "tab_closed");
  assert.deepEqual([by("lifeFollowUp").status, by("lifeFollowUp").detail], ["error", "pronote_error"]);
  assert.equal(by("lifeGrid").status, "tab_closed");
  // A dated answer whose lists are known is understood; with the teacher is another line (variant).
  assert.deepEqual([by("lifeAbsenceDetail", "eleve+dates").status, by("lifeAbsenceDetail", "eleve+dates+professeur").status], ["ok", "ok"]);
  assert.equal(fake.calls.filter((call) => call.name === "DetailAbsences")[0].data?.professeur, undefined);
  assert.equal(fake.calls.filter((call) => call.name === "DetailAbsences")[1].data?.professeur?.G, 3);
  // A function without decoder answers format_unknown with its shape.
  assert.equal(by("lifeIncidents").status, "format_unknown");
  assert.ok(by("lifeIncidents").shape.includes("incidents.V[].protagonistes.V[].nom: string"));
  assert.equal(by("lifeIncidents").group, "life");
  // An unknown shape is cut at 150 lines in the whole check.
  assert.equal(by("classResults").shape.length, MAX_UNKNOWN_SHAPE);
  // The kinds of general comments and the memos: one line per request variant.
  assert.deepEqual(result.checks.filter((check) => check.key === "commentKinds").map((check) => check.variant),
    ["ressource+periode", "ressource+listeRessources+periode", "none", "classe+periode"]);
  assert.deepEqual(result.checks.filter((check) => check.key === "studentMemos").map((check) => check.variant),
    ["eleve@105", "Eleve@105", "eleve@113", "Eleve@113", "eleve@78", "Eleve@78"]);
  assert.deepEqual(result.checks.filter((check) => check.key === "studentLifeRecap").map((check) => check.variant), ["eleve+dates", "eleve"]);
  // The photo: whether a picture came, its type and its size; never the picture.
  assert.deepEqual([by("studentPhoto").status, by("studentPhoto").detail], ["ok", "available=true;mime=image/jpeg;size=1000"]);
  // Guardians and schooling people of the file, on their own.
  const members = by("studentFileMembers");
  assert.equal(members.detail, "members=Responsables,listeEquipePeda,listePP,listeRessources");
  assert.ok(members.shape.includes("Responsables.V[].niveauResponsabilite: string"));
  assert.ok(members.shape.includes("listeEquipePeda.V[].matiere.V.L: string"));
  assert.equal(fake.calls.filter((call) => call.name === "FicheEleve").length, 1, "the file is read once for both lines");
  const json = JSON.stringify(result);
  for (const secret of ["Secret", "secrète", "Secrète", jpeg.toString("base64").slice(0, 40)]) assert.equal(json.includes(secret), false, secret);
  for (const check of result.checks) for (const line of check.shape) assert.match(line, SHAPE_LINE);
});

test("check: one function gives its whole shape by pages; an unknown function is refused; groups are asked on their own", async () => {
  const fake = checkSession();
  const first = await ppCheck(fake, "c:T06", { function: "classResults" });
  assert.deepEqual(first.checks.map((check) => check.key), ["classResults"]);
  assert.deepEqual(fake.calls.map((call) => call.name), ["ListeEleves", "ListePeriodes", "ResultatsClasses"], "nothing else is called");
  assert.equal(first.checks[0].shape.length, MAX_SHAPE_PAGE);
  assert.deepEqual([first.shapeTotal, first.shapeOffset, first.shapeMore], [701, 0, true]);
  const second = await ppCheck(fake, "c:T06", { function: "classResults", shapeOffset: 300 });
  const last = await ppCheck(fake, "c:T06", { function: "classResults", shapeOffset: 600 });
  assert.deepEqual([second.checks[0].shape.length, second.shapeMore, last.checks[0].shape.length, last.shapeMore], [300, true, 101, false]);
  assert.equal(new Set([...first.checks[0].shape, ...second.checks[0].shape, ...last.checks[0].shape]).size, 701);

  await assert.rejects(ppCheck(fake, "c:T06", { function: "nope" }), (error: unknown) =>
    error instanceof HttpError && error.code === "invalid_function" && (error.extra.candidates as string[]).includes("classResults"));
  assert.ok(FUNCTION_KEYS.includes("lifeAbsencesRecap"));

  const misc = await ppCheck(checkSession(), "c:T06", { groups: ["misc"] });
  assert.deepEqual(misc.checks.map((check) => [check.key, check.function, check.onglet]), [["classPhotos", "PageTrombinoscope", 77],
    ["supportPlanDetails", "DetailsPIEleve", 105]]);
  // Every function of the check is configured as a read.
  for (const key of FUNCTION_KEYS.filter((item) => /^(life|past|school|multi|classPhotos|supportPlan|teacherOpinions|regimes|studentComments|studentFolders|transcriptComments)/.test(item))) {
    assert.equal(isWriteFunction(functions[key].name), false, key);
  }
});

/* ---- Lot 2: results of the class ---- */

const SUBJECTS = ["PHILOSOPHIE", "HISTOIRE-GEOGRAPHIE", "ENSEIGNEMENT SCIENTIFIQUE", "ANGLAIS LV1", "EPS", "MATHEMATIQUES SPE", "SVT SPE",
  "PHYSIQUE-CHIMIE SPE", "ENS. MORAL & CIVIQUE", "ESPAGNOL LV2", "ALLEMAND LV2", "LATIN"];
/** The last three columns are groups: a student follows one of them. */
const inColumn = (student: number, column: number) => column < 9 || column - 9 === student % 3;

/** ResultatsClasses as the real server shapes it (20/11/2026), with the titles the web client reads. */
const grid = (titles = true) => ({
  ...(titles ? { titresColonnes: typed(SUBJECTS.map((name, index) => ({
    ColMoy: { visible: true, titre1: " ", titre2: `<div class="NoWrap ">${name}</div>`, titre3: "Moy.", hint: `${name} - M. PROF${index}`, estPere: true },
    ColAbs: { visible: false, titre1: " ", titre2: "", titre3: "Abs." } }))) } : {}),
  resultats: typed([
    // Sub-periods of the first student (period = the year): attached to its line, never a student of their own.
    { nom: students[0].L, periode: "Trimestre 2", lignePere: 1, ressource: 0, rang: 4, moyenneGenerale: note("11,00"), notesEleve: typed([]) },
    ...students.map((student, index) => ({ nom: student.L, position: index, numeroNational: `INE-SECRET-${index}`, periode: "Trimestre 1",
      redoublant: false, dernierEtablissement: "COLLEGE SECRET", nbRetard: index % 3, demiJourneesAbs: index % 4, demiJourneesAbsStr: `${index % 4},0`,
      dateNaissance: { _T: 7, V: "01/01/2008" }, moyenneGenerale: note(`${10 + (index % 8)},50`), lignePere: 0, deploye: false, ressource: index,
      rang: index + 1, sexe: index % 2, chaineTitre: "", FormuleHTML: { _T: 27, V: "<b>secret</b>" },
      notesEleve: typed(SUBJECTS.map((_name, column) => ({ ColMoy: { moyenne: note(inColumn(index, column) ? (column === 4 && index === 2 ? "|2" : `${8 + column},00`) : "") },
        ColAbs: { detailAbsence: 0 } }))) })),
  ]),
  moyennes: typed(SUBJECTS.map((_name, column) => ({ moyenneService: note(`${9 + column},20`), noteMediane: note(`${9 + column},00`), noteHaute: note("18,00"),
    noteBasse: note("3,50"), totalAbsenceColonne: "", moyenneGroupeService: note(column >= 9 ? "10,40" : "") }))),
  moyenneGeneraleClasse: note("12,10"), moyenneHauteClasse: note("17,50"), moyenneBasseClasse: note("6,00"), moyenneMedianeClasse: note("12,00"),
});

test("results of the class: the real grid, 31 students and 12 columns of which 3 groups, foot of the grid, nothing off-topic", () => {
  const read = resultsFromAnswer(grid(), entries)!;
  assert.equal(read.students.length, 31, "the line of a sub-period is not a student");
  assert.deepEqual(read.subjects.map((item) => item.subject), SUBJECTS);
  assert.deepEqual(read.subjects[0], { subject: "PHILOSOPHIE", heading: "", detail: "Moy.", teachers: [], classAverage: 9.2, min: 3.5, max: 18,
    median: 9, groupAverage: null });
  assert.equal(read.subjects[9].groupAverage, 10.4);
  assert.deepEqual(read.general, { average: 12.1, min: 6, max: 17.5, median: 12 });
  const [first, second, third] = read.students;
  assert.deepEqual([first.studentid, first.label, first.average, first.rank, first.lateness, first.absenceHalfDays],
    ["e:ELEVE01 Prénom", "ELEVE01 Prénom", 10.5, 1, 0, 0]);
  assert.deepEqual(first.periods, [{ period: "Trimestre 2", average: 11, rank: 4 }]);
  assert.equal(second.periods, undefined);
  // Group columns: a cell only for the students of the group.
  assert.deepEqual(first.averages.slice(9).map((cell) => cell.value), [17, null, null]);
  assert.deepEqual(second.averages.slice(9).map((cell) => [cell.subject, cell.column, cell.value]),
    [["ESPAGNOL LV2", 9, null], ["ALLEMAND LV2", 10, 18], ["LATIN", 11, null]]);
  assert.deepEqual(third.averages[4], { subject: "EPS", column: 4, value: null, status: "Disp" });
  assert.deepEqual([second.lateness, second.absenceHalfDays, third.rank], [1, 1, 3]);
  const json = JSON.stringify(read);
  for (const secret of ["INE-SECRET", "COLLEGE SECRET", "01/01/2008", "secret", "redoublant", "numeroNational", "sexe"]) assert.equal(json.includes(secret), false, secret);
  assert.equal(titleText('<div class="x">MATHS&nbsp;EXP &amp; CO</div>'), "MATHS EXP & CO");
});

test("results of the class: columns without title stay unnamed, with the shape; another shape is unknown", async () => {
  const unnamed = await classResults(session({ ResultatsClasses: () => grid(false) }), "c:T06", "p:Trimestre 1");
  assert.equal(unnamed.available, true);
  assert.equal(unnamed.columnsUnnamed, true);
  assert.equal(unnamed.subjects.length, 12);
  assert.ok(unnamed.subjects.every((item) => item.subject === ""), "never a guessed label");
  assert.deepEqual(unnamed.students[1].averages[10], { subject: "", column: 10, value: 18, status: "" });
  assert.ok(unnamed.shape?.includes("resultats.V[].notesEleve.V[].ColMoy.moyenne.V: string"));
  assert.equal(unnamed.shape?.join("\n").includes("ELEVE"), false);

  const named = await classResults(session({ ResultatsClasses: () => grid() }), "c:T06", "p:Trimestre 1");
  assert.deepEqual([named.available, named.columnsUnnamed, named.shape], [true, undefined, undefined]);
  // The request of the web client: sub-services and absences per service are not asked.
  const fake = session({ ResultatsClasses: () => grid() });
  await classResults(fake, "c:T06", "p:Trimestre 1");
  assert.deepEqual(Object.keys(fake.calls.find((call) => call.name === "ResultatsClasses")!.data!).sort(), ["absences", "afficherSeulementSousServices",
    "afficherSousServices", "avecCouleurMoyenne", "classe", "competences", "masquerSansNotes", "periode"]);

  const unknown = await classResults(session({ ResultatsClasses: () => ({ autre: { lignes: [{ nom: "DUPONT Secret" }] } }) }), "c:T06", "p:Trimestre 1");
  assert.deepEqual([unknown.available, unknown.reason], [false, "format_unknown"]);
  assert.equal(JSON.stringify(unknown).includes("Secret"), false);
});

/* ---- Lot 4: general comments of the main teacher ---- */

const kindsList = [{ N: "50#r1", G: 1, L: "Conseil de classe", estUneRubrique: true }, { N: "50#k2", G: 2, L: "Appréciation du professeur principal" }];
const generalPage = { listeLignes: typed(students.slice(0, 2).map((student, index) => ({ eleve: { _T: 24, V: { N: student.N, G: 4, L: student.L } },
  appreciationGle: { _T: 24, V: { N: `17#g${index}`, G: 2, L: `Texte ${index}`, editable: true, cloture: false } } }))) };
const bulletin = (data: any) => ({ ListeServices: typed([{ L: "PHILOSOPHIE", MoyenneEleve: note("12,00") }]),
  ObjetListeAppreciations: { _T: 24, V: { ListeAppreciations: typed([
    { G: 0, Intitule: "Appréciation générale", L: `Bilan de ${String(data?.eleve?.L)}` }, { G: 1, Intitule: "Conseil de classe", L: "Encouragements" }]) } } });
const servicesOf = (teaches: boolean) => () => ({ services: typed(teaches ? [{ N: "5#es", matiere: { _T: 24, V: { N: "9#es", L: "ENSEIGNEMENT SCIENTIFIQUE" } },
  classe: { _T: 24, V: { N: "1#c1", L: "T06", G: 1 } } }] : []) });

test("general comments: the member is 'liste', empty with one request and filled with another", async () => {
  assert.deepEqual(kindsFromAnswer({ liste: typed(kindsList) }).map((item) => [item.name, item.rubric]),
    [["Conseil de classe", true], ["Appréciation du professeur principal", false]]);
  // The list comes back only when the class is sent in "listeRessources" too.
  const fake = session({ ListeServices: servicesOf(false), PageAppreciationsGenerales: () => generalPage,
    ListeAppreciations: (data) => ({ liste: typed(data?.listeRessources ? kindsList : []) }) });
  const result = await reportComments(fake, "c:T06", "p:Trimestre 1");
  assert.deepEqual([result.general.available, result.general.source, result.general.variant, result.general.kind],
    [true, "kinds", "ressource+listeRessources+periode", "Appréciation du professeur principal"]);
  assert.deepEqual(result.students.map((item) => item.general), ["Texte 0", "Texte 1"]);
  const asked = fake.calls.filter((call) => call.name === "ListeAppreciations");
  assert.deepEqual(asked.map((call) => Object.keys(call.data ?? {}).sort().join("+")), ["periode+ressource", "listeRessources+periode+ressource"]);
  assert.deepEqual(asked[0].data?.ressource, { N: "1#c1", G: 1, L: "T06" });
  assert.equal(asked[0].onglet, 27);
  assert.equal(fake.calls.some((call) => call.name === "PageBulletins"), false, "no report card is read when the kinds answer");
});

test("general comments: no kind for a main teacher, read from the report cards by pages, saying so", async () => {
  const fake = session({ ListeServices: servicesOf(false), ListeAppreciations: () => ({ liste: typed([]) }), PageBulletins: bulletin });
  const first = await reportComments(fake, "c:T06", "p:Trimestre 1", { offset: 0, limit: 20 });
  assert.equal(first.available, true);
  // The first cause stays the reason: nothing is silent.
  assert.deepEqual([first.general.available, first.general.reason, first.general.source, first.general.kind],
    [true, "no_kind", "reportcards", "Appréciation générale"]);
  assert.deepEqual([first.general.page?.total, first.general.page?.offset, first.general.page?.read.length, first.general.page?.partial], [31, 0, 20, false]);
  assert.equal(first.students.length, 20);
  assert.deepEqual(first.students[0], { student: "ELEVE01 Prénom", comment: null, general: "Bilan de ELEVE01 Prénom",
    generals: [{ kind: "Appréciation générale", text: "Bilan de ELEVE01 Prénom" }, { kind: "Conseil de classe", text: "Encouragements" }] });
  const second = await reportComments(fake, "c:T06", "p:Trimestre 1", { offset: 20, limit: 20 });
  assert.deepEqual([second.general.page?.offset, second.students.length, second.students[10].student], [20, 11, "ELEVE31 Prénom"]);
  assert.equal(fake.calls.filter((call) => call.name === "PageBulletins").length, 31, "one report card per student, none twice");
  // The four request variants were tried once before the report cards, not again for the second page.
  assert.equal(fake.calls.filter((call) => call.name === "ListeAppreciations").length, 4);
});

test("general comments: an account that is not main teacher gets no report card read in their place", async () => {
  const fake = session({ ListeServices: servicesOf(true), PageApprBulletin: () => ({ listeLignes: typed([]) }), PageBulletins: bulletin },
    [{ ...classT06, principal: false }]);
  const result = await reportComments(fake, "c:T06", "p:Trimestre 1");
  assert.deepEqual([result.general.available, result.general.reason, result.general.source], [false, "not_principal", undefined]);
  assert.equal(fake.calls.some((call) => call.name === "PageBulletins" || call.name === "ListeAppreciations"), false);
  // The report cards refused: the first cause is kept, the answer says the general comments are not available.
  const refused = await reportComments(session({ ListeServices: servicesOf(true), PageApprBulletin: () => ({ listeLignes: typed([]) }),
    ListeAppreciations: () => ({ liste: typed([]) }) }), "c:T06", "p:Trimestre 1");
  assert.deepEqual([refused.available, refused.general.available, refused.general.reason], [true, false, "no_kind"]);
});

/* ---- Lot 6: writing a general comment ---- */

test("writing a general comment: the kind is found as the read finds it, chosen by name when several, refused clearly otherwise", async () => {
  const handlers = (kinds: Record<string, unknown>[]): Handlers => ({ ListeServices: servicesOf(true), ListeAppreciations: () => ({ liste: typed(kinds) }),
    PageAppreciationsGenerales: () => generalPage });
  const write = { class: "c:T06", period: "p:Trimestre 1", dryRun: true, items: [{ student: "ELEVE01 Prénom", kind: "general" as const, text: "Bon trimestre" }] };
  // A kind that is not named "globale" (the only one that is not a rubric).
  const one = session(handlers(kindsList));
  const result = await writeComments(one, write);
  assert.equal(result.generalKind, "Appréciation du professeur principal");
  assert.deepEqual(result.requests[0].appreciation, { N: "17#g0", G: 2, L: "Bon trimestre", E: 2 });
  assert.equal(one.calls.find((call) => call.name === "PageAppreciationsGenerales")?.data?.appreciation?.N, "50#k2");
  assert.equal(one.calls.some((call) => /^Saisie/.test(call.name)), false, "a dry run writes nothing");

  // Several kinds, none named global or general: the candidates are given, nothing is chosen.
  const several = [...kindsList, { N: "50#k3", G: 6, L: "Appréciation CPE" }];
  await assert.rejects(writeComments(session(handlers(several)), write), (error: unknown) => error instanceof HttpError
    && error.status === 409 && error.code === "general_kind_ambiguous"
    && JSON.stringify(error.extra.candidates) === JSON.stringify(["Appréciation du professeur principal", "Appréciation CPE"]));
  const chosen = await writeComments(session(handlers(several)), { ...write, generalKind: "appreciation cpe" });
  assert.equal(chosen.generalKind, "Appréciation CPE");
  await assert.rejects(writeComments(session(handlers(several)), { ...write, generalKind: "Inconnue" }), /general_kind_not_found/);
  // No kind at all (rubrics only, or an empty list): refused clearly.
  await assert.rejects(writeComments(session(handlers([kindsList[0]])), write), (error: unknown) => error instanceof HttpError && error.code === "no_kind");
  await assert.rejects(writeComments(session(handlers([])), write), /no_kind/);
  // Among several, the one named global or general is the general comment.
  assert.equal(generalKindFor(kindsFromAnswer({ liste: typed([...several, { N: "50#k4", L: "Appréciation globale" }]) })).N, "50#k4");
});

/* ---- Lot 5: student file ---- */

const guardian = (extra: Record<string, unknown> = {}) => ({ nom: "Mme BENALI Nadia", lienParente: "Mère/Mother", niveauResponsabilite: "Responsable légal",
  delegueClasse: "T06", membreCA: true, profession: "Profession secrète", situation: "Situation secrète", couleurPanel: "#ffffff", couleurStr: "rouge",
  telPort: "600000001", indPort: "212", adresse1: "1 rue Fictive", CP: "20000", ville: "Casablanca", autoriseEmail: true, autoriseSMS: false,
  autoriseCourrier: true, ...extra });

/** FicheEleve as the web client reads it: Identite, Scolarite, Responsables, listeMemosEleves; listeRessources holds the guardians. */
const realFile = (extra: Record<string, unknown> = {}) => ({
  Identite: { _T: 24, V: { nom: "BENALI", prenom: "Yasmine", sexe: 1, dateNaiss: { _T: 7, V: "02/05/2008" }, estMajeur: true, villeNaiss: "Rabat" } },
  Scolarite: { _T: 24, V: { classe: { _T: 24, V: { L: "T06" } }, options: "LATIN, SECTION EURO ANGLAIS",
    listeEquipePeda: typed([{ L: "M. ALPHA", matiere: { _T: 24, V: { L: "SC. VIE & TERRE SPE" } } }, { L: "Mme BETA", matiere: { _T: 24, V: { L: "PHYSIQUE-CHIMIE SPE" } } },
      { L: "Mme GAMMA", matiere: { _T: 24, V: { L: "ESPAGNOL LV2" } } }, { L: "M. DELTA", matiere: { _T: 24, V: { L: "PHILOSOPHIE" } } }]),
    listePP: typed([{ L: "M. PP" }]), ...extra } },
  listeRessources: typed([{ L: "Mme BENALI Nadia", G: 5 }, { L: "M. BENALI Karim", G: 5 }]),
  Responsables: typed([guardian(), guardian({ nom: "M. BENALI Karim", lienParente: "Père/Father", niveauResponsabilite: 2, delegueClasse: "", membreCA: false })]),
  listeMemosEleves: typed([{ commentaire: "Mémo intégré", date: { _T: 7, V: "05/10/2026" }, publie: false }]),
});

test("student file: a terminale with two specialities and an option, read from the file itself; no guardian outside 'guardians'", () => {
  const { file, unmapped, unmappedGuardian } = fileOf(entries[0], realFile(), []);
  assert.deepEqual(file.groups, [], "no member of the file names the groups");
  assert.deepEqual(file.groupDetails, [
    { label: "LATIN", kind: "option", source: "file" },
    { label: "SECTION EURO ANGLAIS", kind: "option", source: "file" },
    { label: "SC. VIE & TERRE SPE", kind: "speciality", source: "team" },
    { label: "PHYSIQUE-CHIMIE SPE", kind: "speciality", source: "team" },
    { label: "ESPAGNOL LV2", kind: "language", source: "team" },
  ]);
  assert.deepEqual(file.options, ["LATIN", "SECTION EURO ANGLAIS", "SC. VIE & TERRE SPE", "PHYSIQUE-CHIMIE SPE", "ESPAGNOL LV2"]);
  assert.deepEqual([file.groupsReason, file.regime, file.regimeSource, file.regimeReason], ["", "", "", "not_in_file"]);
  assert.deepEqual([unmapped, unmappedGuardian], [[], []], "every key of the file and of its guardians is known");
  // The guardians (listeRessources, Responsables) and the memos are nowhere without their part.
  const json = JSON.stringify(file);
  for (const secret of ["Nadia", "Karim", "Mère", "secrète", "Mémo", "600000001"]) assert.equal(json.includes(secret), false, secret);
  assert.deepEqual(fileOf(entries[0], realFile({ regime: "Demi-pensionnaire" }), []).file.regimeSource, "file");
  // Without option nor team: empty lists and the reason, never a guessed label.
  const bare = fileOf(entries[0], { Identite: { _T: 24, V: { nom: "X" } }, Scolarite: { _T: 24, V: { classe: { _T: 24, V: { L: "T06" } } } } }, []).file;
  assert.deepEqual([bare.groups, bare.options, bare.groupDetails, bare.groupsReason], [[], [], [], "no_source"]);
});

test("guardians: the eight keys of the real file; the level of responsibility as a label, a number or an element", () => {
  const { file, unmappedGuardian } = fileOf(entries[0], realFile(), ["guardians"]);
  assert.deepEqual(unmappedGuardian, []);
  const [mother, father] = file.guardians!;
  assert.deepEqual([mother.name, mother.relation, mother.responsibility, mother.legal, mother.authority, mother.classDelegate, mother.boardMember],
    ["Mme BENALI Nadia", "Mère/Mother", "Responsable légal", true, true, true, true]);
  assert.deepEqual([mother.email, mother.emailReason, mother.emailAllowed, mother.sms, mother.mail], ["", "not_in_file", true, false, true]);
  assert.deepEqual(mother.phones, ["+212 600000001"]);
  assert.deepEqual([father.responsibility, father.legal, father.authority, father.classDelegate, father.boardMember], ["En charge", false, false, false, false]);
  // Job, work situation and display colours are known and never returned.
  const json = JSON.stringify(file.guardians);
  for (const secret of ["secrète", "#ffffff", "rouge", "profession", "situation", "couleur"]) assert.equal(json.includes(secret), false, secret);
  assert.deepEqual(responsibilityOf({ G: 1, L: "Responsable légal" }), { label: "Responsable légal", legal: true });
  assert.deepEqual(responsibilityOf(3), { label: "Contact", legal: false });
  assert.deepEqual(responsibilityOf("1"), { label: "Responsable légal", legal: true });
  // A value that is not understood: the raw label when there is one, and nothing asserted.
  assert.deepEqual(responsibilityOf("Autre niveau"), { label: "Autre niveau", legal: null });
  assert.deepEqual(responsibilityOf(undefined), { label: "", legal: null });
  assert.equal(guardianRead({ nom: "X", niveauResponsabilite: 9 }).guardian.authority, null);
  assert.equal(guardianRead({ nom: "X", eMail: "parent.fictif@example.org" }).guardian.emailReason, "");
  assert.equal(guardianRead({ L: "Avec L", nom: "Sans L" }).guardian.name, "Avec L");
});

test("groups on request: the lists of students of the groups of the level, then the report card; nothing found is said", async () => {
  const groups = [{ id: "2#g1", label: "T-SPE SVT 2", genre: 2 as const, taught: false, principal: false },
    { id: "2#g2", label: "TLVB ESP 3", genre: 2 as const, taught: false, principal: false },
    { id: "2#g3", label: "1-SPE MATHS 1", genre: 2 as const, taught: true, principal: false }];
  const members: Record<string, number[]> = { "T-SPE SVT 2": [0, 2], "TLVB ESP 3": [0], "1-SPE MATHS 1": [0, 1] };
  const handlers: Handlers = {
    ListeEleves: (data) => ({ listeEleves: typed(data?.ressource?.L === "T06" ? students : (members[String(data?.ressource?.L)] ?? []).map((index) => students[index])) }),
    FicheEleve: () => ({ Identite: { _T: 24, V: { nom: "X" } }, Scolarite: { _T: 24, V: { classe: { _T: 24, V: { L: "T06" } } } } }),
    PageBulletins: (data) => (data?.eleve?.L === students[1].L
      ? { ListeServices: typed([{ L: "MATHEMATIQUES", groupe: "T-OPT MATHS EXP" }, { L: "PHILOSOPHIE", groupe: "T06" }]) }
      : { Message: "Bulletin non publié" }),
  };
  const fake = session(handlers, [classT06, ...groups]);
  resetGroupRosters(fake);
  const result = await studentFiles(fake, "c:T06", ["groups"], "", { offset: 0, limit: 3 });
  const [first, second, third] = result.items;
  // From the lists of students of the groups of the level (the group of première is not even read).
  assert.deepEqual(first.groups, ["T-SPE SVT 2", "TLVB ESP 3"]);
  assert.deepEqual(first.groupDetails, [{ label: "T-SPE SVT 2", kind: "speciality", source: "rosters" }, { label: "TLVB ESP 3", kind: "language", source: "rosters" }]);
  assert.deepEqual(first.options, ["T-SPE SVT 2", "TLVB ESP 3"]);
  assert.deepEqual(fake.calls.filter((call) => call.name === "ListeEleves" && call.data?.ressource?.G === 2).map((call) => call.data?.ressource?.L),
    ["T-SPE SVT 2", "TLVB ESP 3"]);
  // In no list: the groups of the services of the report card (the class itself is not a group).
  assert.deepEqual([second.groups, second.groupDetails], [["T-OPT MATHS EXP"], [{ label: "T-OPT MATHS EXP", kind: "option", source: "reportcard" }]]);
  assert.deepEqual([third.groups, third.groupsReason], [["T-SPE SVT 2"], ""]);
  assert.deepEqual(fake.calls.filter((call) => call.name === "PageBulletins").map((call) => call.data?.eleve?.L), [students[1].L]);
  // The lists stay in memory: the next page reads no group again.
  await studentFiles(fake, "c:T06", ["groups"], "", { offset: 3, limit: 1 });
  assert.equal(fake.calls.filter((call) => call.name === "ListeEleves" && call.data?.ressource?.G === 2).length, 2);
  // Without the part: nothing but the file is read.
  const plain = session(handlers, [classT06, ...groups]);
  const without = await studentFiles(plain, "c:T06", [], "e:ELEVE01 Prénom");
  assert.deepEqual([without.items[0].groups, without.items[0].groupsReason], [[], "no_source"]);
  assert.equal(plain.calls.filter((call) => call.name === "ListeEleves").length, 1);
  // Nothing anywhere: empty, with the reason.
  const nothing = await studentFiles(session({ ...handlers, PageBulletins: () => ({ Message: "x" }) }, [classT06]), "c:T06", ["groups"], "e:ELEVE02 Prénom");
  assert.deepEqual([nothing.items[0].groups, nothing.items[0].groupsReason], [[], "no_source"]);
  assert.deepEqual([levelOf("T06"), levelOf("T-SPE SVT 2"), levelOf("[TLVB ESP 3]"), levelOf("1G3"), levelOf("6-SC-601-602"), levelOf("205"), levelOf("TRANSVERSAL")],
    ["t", "t", "t", "1", "6", "2", ""]);
});

test("memos: each request variant in turn, the one that answers kept for the session, the reason when none does", async () => {
  const answer = (data: any) => ({ listeMemosEleves: typed([{ commentaire: data?.estValorisation ? "Valorisation fictive" : "Mémo fictif",
    date: { _T: 7, V: "05/10/2026" }, publie: true }]) });
  // Tab 105 answers nothing; tab 113 answers only with "Eleve".
  const fake = session({ "ListeMemosEleves@105": () => ({}), "ListeMemosEleves@113": (data) => (data?.Eleve ? answer(data) : denied) });
  resetMemoRoute(fake);
  const first = await readMemos(fake, entries[0], []);
  assert.deepEqual(first.memos.map((memo) => [memo.kind, memo.text, memo.date]), [["memo", "Mémo fictif", "2026-10-05"], ["valorisation", "Valorisation fictive", "2026-10-05"]]);
  assert.equal(first.reason, "");
  assert.deepEqual(fake.calls.map((call) => `${Object.keys(call.data ?? {})[0]}@${call.onglet}:${call.data?.estValorisation}`),
    ["eleve@105:false", "Eleve@105:false", "eleve@113:false", "Eleve@113:false", "Eleve@113:true"]);
  // The next student: the request found, nothing else.
  await readMemos(fake, entries[1], []);
  assert.deepEqual(fake.calls.slice(5).map((call) => `${Object.keys(call.data ?? {})[0]}@${call.onglet}`), ["Eleve@113", "Eleve@113"]);

  // Each of the other variants answers too.
  for (const [handler, member] of [["ListeMemosEleves@105", "eleve"], ["ListeMemosEleves@78", "Eleve"]] as const) {
    const one = session({ "ListeMemosEleves@105": () => ({}), [handler]: (data: any) => (data?.[member] ? answer(data) : {}) });
    assert.equal((await readMemos(one, entries[0], [])).memos.length, 2, handler);
  }
  // Nothing answers: the memos the file carries, else the reason; the six variants are tried once for the session.
  const closed = session({ ListeMemosEleves: () => ({}) });
  const embedded = [{ date: "2026-10-05", text: "Mémo intégré", author: "", published: false, kind: "memo" as const }];
  assert.deepEqual(await readMemos(closed, entries[0], embedded), { memos: embedded, reason: "" });
  assert.deepEqual(await readMemos(closed, entries[1], []), { memos: [], reason: "access_denied" });
  assert.equal(closed.calls.length, 6);
  // Through the file: the memos it carries are read when the function refuses.
  const viaFile = session({ ListeMemosEleves: () => denied, FicheEleve: () => realFile() });
  const file = (await studentFiles(viaFile, "c:T06", ["memos"], "e:ELEVE01 Prénom")).items[0];
  assert.deepEqual([file.memos?.map((memo) => memo.text), file.memosReason], [["Mémo intégré"], ""]);
});

test("photos: a download without picture is 'no photo' or 'download refused' according to the photo board", async () => {
  const board = () => ({ ListeRessources: typed([{ N: "4#e1", L: students[0].L, G: 4, existePhoto: true }, { N: "4#e2", L: students[1].L, G: 4, existePhoto: false }]) });
  const fake = session({ PageTrombinoscope: board });
  const none = async () => null;
  const result = await studentPhotos(fake, "c:T06", { offset: 0, limit: 3 }, none);
  // The first has a photo Pronote did not serve; the second has none; the third is not on the board.
  assert.deepEqual(result.items.map((item) => item.reason), ["download_refused", "no_photo", "no_photo"]);
  const sent = fake.calls.filter((call) => call.name === "PageTrombinoscope");
  assert.equal(sent.length, 1, "the board is read once for the page");
  assert.deepEqual([sent[0].onglet, sent[0].data?.classe, sent[0].data?.periode?.L], [77, { N: "1#c1", G: 1, L: "T06" }, "Trimestre 1"]);
  // A picture that comes: the board is not read.
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]);
  const served = session({ PageTrombinoscope: board });
  const ok = await studentPhotos(served, "c:T06", { student: "e:ELEVE01 Prénom" }, async () => ({ contentType: "image/jpeg", bytes: jpeg }));
  assert.deepEqual([ok.items[0].available, ok.items[0].mime], [true, "image/jpeg"]);
  assert.equal(served.calls.some((call) => call.name === "PageTrombinoscope"), false);
  // The board refused: "no photo", as before.
  assert.deepEqual((await studentPhotos(session(), "c:T06", { offset: 0, limit: 2 }, none)).items.map((item) => item.reason), ["no_photo", "no_photo"]);
});
