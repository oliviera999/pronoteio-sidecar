import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { SessionHandle } from "pawnote";
import { filterByGroups, lessonEnd, lessonFromPage, lessonIdFor, statusLabel, weeksOf } from "../src/teacher/timetable.js";

const page = JSON.parse(readFileSync(new URL("./fixtures/timetable-page.json", import.meta.url), "utf8"));
const lessons = page.ListeCours.V as any[];

/** Session with the school endings of the demo (blocks of 55 minutes from 8:00) and a first Monday. */
const session = (endings: string[] = ["8h55", "9h55", "10h55", "11h55", "12h55", "13h55", "14h55", "15h55", "16h55", "17h55"]) =>
  ({
    user: { name: "M. PROFESSEUR Maxime", resources: [{ id: "109#p", name: "M. PROFESSEUR Maxime" }] },
    instance: { firstMonday: new Date(2026, 8, 7), endings, blocksPerDay: 10, version: [2026, 2, 8] },
  }) as unknown as SessionHandle;

test("a lesson of PageEmploiDuTemps is normalised with its notebook flags", () => {
  const ref = lessonFromPage(session(), lessons[0], 11);
  assert.ok(ref);
  assert.equal(ref.pronoteId, "29#x1");
  assert.equal(ref.week, 11);
  assert.equal(ref.notebookId, "18#x1");
  const lesson = ref.lesson;
  assert.equal(lesson.subject, "MATHÉMATIQUES");
  assert.deepEqual(lesson.groups, ["6A"]);
  assert.deepEqual(lesson.rooms, ["207"]);
  assert.equal(lesson.teacher, "M. PROFESSEUR Maxime");
  assert.equal(lesson.start, Math.floor(new Date(2026, 10, 9, 8, 0, 0).getTime() / 1000));
  assert.equal(lesson.end, Math.floor(new Date(2026, 10, 9, 9, 55, 0).getTime() / 1000));
  assert.equal(lesson.hasNotebook, true);
  assert.equal(lesson.notebookPublished, true);
  assert.equal(lesson.attendanceDone, true);
  assert.equal(lesson.cancelled, false);
  assert.equal(lesson.status, "");
  assert.equal(lesson.id, lessonIdFor(new Date(2026, 10, 9, 8, 0), ["6A"], "MATHÉMATIQUES"));
  assert.equal(lesson.id, "l:2026-11-09 08:00|6A|MATHÉMATIQUES");
});

test("a lesson without notebook, and a cancelled replacement", () => {
  const plain = lessonFromPage(session(), lessons[1], 11)!;
  assert.equal(plain.lesson.hasNotebook, false);
  assert.equal(plain.notebookId, null);
  const cancelled = lessonFromPage(session(), lessons[5], 11)!;
  assert.equal(cancelled.lesson.cancelled, true);
  assert.equal(cancelled.lesson.status, "replacement");
  assert.equal(statusLabel(1), "class council");
  assert.equal(statusLabel(undefined), "");
});

test("the end of a lesson falls back to 55-minute blocks without school endings", () => {
  const start = new Date(2026, 10, 9, 8, 0);
  assert.equal(lessonEnd(session([]), { place: 0, duree: 2 }, start).getTime(), start.getTime() + 110 * 60_000);
  assert.equal(lessonEnd(session(), { DateDuCoursFin: { _T: 7, V: "09/11/2026 09:30:00" } }, start).getHours(), 9);
});

test("entries without date or id are ignored", () => {
  assert.equal(lessonFromPage(session(), { N: "29#x", ListeContenus: [] }, 1), null);
  assert.equal(lessonFromPage(session(), { DateDuCours: { _T: 7, V: "09/11/2026 08:00:00" } }, 1), null);
});

test("week numbers cover the range and are bounded", () => {
  const s = session();
  assert.deepEqual(weeksOf(s, new Date(2026, 10, 9), new Date(2026, 10, 16)), [10]);
  assert.deepEqual(weeksOf(s, new Date(2026, 10, 9), new Date(2026, 10, 23)), [10, 11]);
  assert.throws(() => weeksOf(s, new Date(2026, 8, 7), new Date(2026, 11, 7)), /range_too_large/);
});

test("lessons are filtered by class or group label, without case nor accents", () => {
  const refs = lessons.map((item) => lessonFromPage(session(), item, 11)!);
  assert.equal(filterByGroups(refs, ["3d"]).length, 2);
  assert.equal(filterByGroups(refs, ["6A", "3A"]).length, 3);
  assert.equal(filterByGroups(refs, []).length, 6);
});
