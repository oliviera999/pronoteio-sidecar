import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { SessionHandle } from "pawnote";
import { entryRefusal, entryReport } from "../src/pronote/request.js";
import { notebookFromPage } from "../src/teacher/notebook.js";
import {
  buildNotebookRequest,
  categoriesOf,
  contentMember,
  lessonDateOf,
  plannedEntry,
  studentsOf,
  verifyWritten,
} from "../src/teacher/notebookWrite.js";
import type { LessonRef } from "../src/teacher/timetable.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

const session = {
  information: { url: "https://demo.example/pronote", id: "sess1", aesKey: "0123456789abcdef", aesIV: "fedcba9876543210" },
} as unknown as SessionHandle;

const ref = (): LessonRef => ({
  lesson: {
    id: "l:2026-11-03 13:30|3D|MATHÉMATIQUES",
    subject: "MATHÉMATIQUES",
    teacher: "M. PROFESSEUR Maxime",
    rooms: ["207"],
    groups: ["3D"],
    start: Math.floor(new Date(2026, 10, 3, 13, 30).getTime() / 1000),
    end: Math.floor(new Date(2026, 10, 3, 15, 30).getTime() / 1000),
    cancelled: false,
    status: "",
    hasNotebook: true,
    notebookPublished: false,
    attendanceDone: false,
    editable: false,
    roomsEditable: false,
  },
  pronoteId: "29#x1",
  week: 10,
  notebookId: "18#x13",
  label: "",
  rooms: [{ N: "129#r1", L: "207" }],
});

/** Page with the students of the lesson (the captured page had an empty list). */
const pageWithStudents = () => {
  const page = fixture("lesson-page");
  page.listeClassesEleves = { _T: 24, V: [{ L: "3D", N: "23#k1", G: 1, listeEleves: { _T: 24, V: [
    { L: "ELEVE Un", N: "46#e1", G: 4 }, { L: "ELEVE Deux", N: "46#e2", G: 4 }, { L: "ELEVE Trois", N: "46#e3", G: 4 },
  ] } }] };
  return page;
};

const resolved = () => ({ categories: categoriesOf(fixture("lesson-settings")), students: studentsOf(pageWithStudents()), services: [], periods: [] });

test("the lesson date is read from the stable id", () => {
  assert.deepEqual(lessonDateOf("l:2026-11-03 13:30|3D|MATHÉMATIQUES"), new Date(2026, 10, 3, 13, 30));
  assert.equal(lessonDateOf("c:3D"), null);
});

test("categories and students are resolved from the settings and the page", () => {
  const categories = categoriesOf(fixture("lesson-settings"));
  assert.equal(categories.find((item) => item.G === 3)?.L, "Devoir sur table");
  assert.equal(studentsOf(pageWithStudents()).length, 3);
});

test("a new content is created with E 1, N 0 and its category", () => {
  const member = contentMember(
    { title: "TEST olution", description: "<p>Chapitre 3</p>", category: "cours", objectives: "<p>Savoir</p>" },
    null,
    resolved(),
  );
  assert.equal(member.N, 0);
  assert.equal(member.E, 1);
  assert.equal(member.L, "TEST olution");
  assert.deepEqual(member.Categorie, { N: "19#c1", L: "Cours" });
  assert.deepEqual(member.Descriptif, { _T: 21, V: "<p>Chapitre 3</p>" });
  assert.deepEqual(member.objectifs, { _T: 21, V: "<p>Savoir</p>" });
  assert.deepEqual(member.ListeDocumentsJoints, []);
  assert.equal(member.genreLienDS, undefined);
});

test("a written test carries genreLienDS and infosDS when the graded assessment is created", () => {
  const services = [{ N: "s1", L: "MATHÉMATIQUES", matiere: { V: { L: "MATHÉMATIQUES" } }, classe: { V: { L: "3D" } } }];
  const periods = [{ N: "p1", L: "Trimestre 1", G: 2 }];
  const member = contentMember(
    {
      title: "DS n°2",
      description: "<p>Fractions</p>",
      category: { kind: 3 },
      assessment: { kind: "written_test", createGraded: { service: "s:MATHÉMATIQUES|3D", period: "p:Trimestre 1", coefficient: 2, max: 20 } },
    },
    null,
    { ...resolved(), services, periods },
  );
  assert.equal(member.genreLienDS, 0);
  assert.deepEqual(member.infosDS, {
    service: { N: "s1", L: "MATHÉMATIQUES" },
    periode: { N: "p1", G: 2, L: "Trimestre 1" },
    coefficient: { _T: 10, V: "2" },
    bareme: { _T: 10, V: "20" },
    recalculerNotesDevoirSelonBareme: false,
  });
  assert.deepEqual((member.Categorie as { L: string }).L, "Devoir sur table");
  assert.throws(() => contentMember({ title: "x", description: "", category: "inconnue" }, null, resolved()), /category_not_found/);
});

test("the request only carries the contents and homework that change", () => {
  const page = pageWithStudents();
  const before = notebookFromPage(session, ref(), page);
  const request = buildNotebookRequest(
    ref(),
    page,
    before,
    {
      contents: [
        { id: before.contents[0].id, title: "Nombres premiers (suite)", description: "<p>Suite</p>", category: "Cours" },
        { id: before.contents[1].id, title: "DS n°1", description: "", category: "Devoir sur table", delete: true },
        { title: "Correction", description: "<p>Correction du DS</p>", category: "Correction", attachments: [{ name: "corrige.pdf", fileId: "reqUpl_1_1" }] },
      ],
      homework: [
        { description: "<p>Exercices 3 et 4</p>", due: Math.floor(new Date(2026, 10, 12, 8, 0).getTime() / 1000), minutes: 20, forAll: false, students: ["ELEVE Un", "eleve trois"] },
        { id: before.homework[0].id, description: "", due: before.homework[0].due, delete: true },
      ],
      noteForNext: "Apporter les copies",
    },
    resolved(),
  );
  assert.deepEqual(request.cours, { N: "29#x1" });
  assert.equal(request.numeroSemaine, 10);
  assert.equal(request.forcerSaisie, false);
  const entry = (request.ListeCahierDeTextes as any[])[0];
  assert.equal(entry.N, "18#x13");
  assert.equal(entry.E, 2);
  assert.equal(entry.Publie, false);
  assert.equal(entry.noteProchaineSeance, "Apporter les copies");
  assert.equal(entry.commentairePrive, "");
  const contents = entry.Contenus as any[];
  assert.equal(contents.length, 3, "unchanged contents are not sent");
  assert.deepEqual(contents.map((item) => [item.N, item.E]), [["27#x12", 2], ["27#c2", 3], [0, 1]]);
  assert.equal(contents[0].L, "Nombres premiers (suite)");
  assert.deepEqual(contents[2].ListeDocumentsJoints, [{ L: "corrige.pdf", G: 1, E: 1, IDFichier: "reqUpl_1_1" }]);
  assert.deepEqual(request.ListeFichiers, [{ L: "corrige.pdf", G: 1, E: 1, IDFichier: "reqUpl_1_1" }]);
  const homework = entry.ListeTravauxAFaire as any[];
  assert.equal(homework.length, 2);
  assert.deepEqual(homework[0].Date, { _T: 7, V: "12/11/2026 0:0:0" }, "due date is a day");
  assert.equal(homework[0].duree, 20);
  assert.equal(homework[0].estPourTous, false);
  assert.deepEqual(homework[0].ListeEleves, [{ N: "46#e1", G: 4 }, { N: "46#e3", G: 4 }]);
  assert.deepEqual([homework[1].N, homework[1].E], ["20#t1", 3]);
});

test("a new entry is created with N 0 and E 1, and unknown students or ids are refused", () => {
  const page = fixture("lesson-page-empty");
  const before = notebookFromPage(session, { ...ref(), notebookId: null, lesson: { ...ref().lesson, hasNotebook: false } }, page);
  const request = buildNotebookRequest(ref(), page, before, { contents: [{ title: "Séance 1", description: "<p>Intro</p>", category: "Cours" }], published: true }, resolved());
  const entry = (request.ListeCahierDeTextes as any[])[0];
  assert.equal(entry.N, 0);
  assert.equal(entry.E, 1);
  assert.equal(entry.Publie, true);
  assert.equal(entry.DatePublication, null);
  assert.throws(
    () => buildNotebookRequest(ref(), page, before, { homework: [{ description: "x", due: 1790000000, forAll: false, students: ["INCONNU Paul"] }] }, resolved()),
    /student_not_found/,
  );
  assert.throws(() => buildNotebookRequest(ref(), page, before, { contents: [{ id: "l:x|c9|y", title: "y", description: "", category: "Cours" }] }, resolved()), /content_not_found/);
});

test("the planned entry and the verification after write follow the requested changes", () => {
  const page = pageWithStudents();
  const before = notebookFromPage(session, ref(), page);
  const entry = {
    contents: [
      { id: before.contents[1].id, title: "DS n°1", description: "", category: "Devoir sur table", delete: true },
      { title: "Correction", description: "<p>Correction</p>", category: "Correction" },
    ],
  };
  const planned = plannedEntry(before, entry, categoriesOf(fixture("lesson-settings")));
  assert.deepEqual(planned.contents.map((item) => item.title), ["Nombres premiers", "Correction"]);
  assert.equal(planned.contents[1].category.name, "Correction");
  assert.doesNotThrow(() => verifyWritten(planned, entry));
  assert.throws(() => verifyWritten(before, entry), /notebook_not_saved:DS n°1/, "the deleted content is still there");
});

test("a refusal of RapportSaisie is read at the root of the decoded answer as the client does", () => {
  const decoded = { data: { ok: true }, RapportSaisie: { _erreurSaisie_: true, titre_Messages_Erreur: "Saisie impossible", _messagesErreur_: { _T: 24, V: [{ L: "Cahier de textes verrouillé" }] } } };
  assert.equal(entryReport(decoded)?._erreurSaisie_, true);
  assert.equal(entryRefusal(entryReport(decoded)), "Saisie impossible : Cahier de textes verrouillé");
  assert.equal(entryReport({ data: {} }), null);
});
