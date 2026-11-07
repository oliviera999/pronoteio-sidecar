import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { SessionHandle } from "pawnote";
import { attachmentsOf, notebookFromPage } from "../src/teacher/notebook.js";
import type { LessonRef } from "../src/teacher/timetable.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

const session = {
  information: { url: "https://demo.example/pronote", id: "sess1", aesKey: "0123456789abcdef", aesIV: "fedcba9876543210" },
} as unknown as SessionHandle;

const ref = (notebookPublished = false): LessonRef => ({
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
    notebookPublished,
    attendanceDone: false,
    editable: false,
    roomsEditable: false,
  },
  pronoteId: "29#x1",
  week: 10,
  notebookId: "18#x1",
  label: "",
  rooms: [{ N: "129#r1", L: "207" }],
});

test("a notebook entry is read with its contents and homework", () => {
  const entry = notebookFromPage(session, ref(true), fixture("lesson-page"));
  assert.equal(entry.locked, false);
  assert.equal(entry.published, true, "publie is not sent on read: the timetable flag is used");
  assert.equal(entry.publication, null);
  assert.equal(entry.noteForNext, "");
  assert.equal(entry.contents.length, 2);
  const [lesson, test] = entry.contents;
  assert.equal(lesson.title, "Nombres premiers");
  assert.equal(lesson.category.name, "Cours");
  assert.equal(lesson.category.kind, 1);
  assert.equal(lesson.isAssessment, false);
  assert.match(lesson.description, /Multiples et diviseurs/);
  assert.equal(lesson.attachments.length, 2);
  assert.equal(lesson.attachments[0].kind, "file");
  assert.match(lesson.attachments[0].url!, /^https:\/\/demo\.example\/pronote\/FichiersExternes\/[0-9a-f]+\/cours\.pdf\?Session=sess1$/);
  assert.deepEqual(lesson.attachments[1], { name: "Vidéo", kind: "link", url: "https://example.org/video" });
  assert.equal(test.title, "DS n°1");
  assert.equal(test.category.kind, 3);
  assert.equal(test.isAssessment, true);
  assert.equal(test.id, "l:2026-11-03 13:30|3D|MATHÉMATIQUES|c2|DS n°1");

  assert.equal(entry.homework.length, 2);
  const [all, some] = entry.homework;
  assert.equal(all.due, Math.floor(new Date(2026, 10, 6).getTime() / 1000));
  assert.equal(all.given, Math.floor(new Date(2026, 10, 3).getTime() / 1000));
  assert.equal(all.minutes, 20);
  assert.equal(all.difficulty, 2);
  assert.equal(all.returnKind, 0);
  assert.equal(all.forAll, true);
  assert.deepEqual(all.students, []);
  assert.equal(some.forAll, false);
  assert.deepEqual(some.students, ["ELEVE Un", "ELEVE Deux"]);
  assert.equal(some.minutes, null);
  assert.equal(some.returnKind, 2);
  assert.equal(some.attachments[0].name, "fiche.pdf");
});

test("a lesson without entry gives an empty notebook", () => {
  const entry = notebookFromPage(session, ref(false), fixture("lesson-page-empty"));
  assert.equal(entry.published, false);
  assert.deepEqual(entry.contents, []);
  assert.deepEqual(entry.homework, []);
  assert.equal(entry.locked, false);
});

test("attachments never expose the Pronote identifier", () => {
  const items = attachmentsOf(session, { _T: 24, V: [{ L: "a.pdf", N: "37#secret", G: 1 }, { L: "site", G: 0 }] });
  assert.equal(JSON.stringify(items).includes("37#secret"), false);
  assert.equal(items[1].url, null);
});
