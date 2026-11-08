import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { SessionHandle } from "pawnote";
import { assertAllowed, buildAttendanceRequest, plannedState, sheetOf, stateOf } from "../src/teacher/absencesWrite.js";
import type { LessonRef } from "../src/teacher/timetable.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

const session = { user: { name: "M. PROFESSEUR Maxime", resources: [{ id: "109#x1", name: "M. PROFESSEUR Maxime" }] } } as unknown as SessionHandle;

const ref = (locked = false): LessonRef => ({
  lesson: {
    id: "l:2026-11-06 09:00|6A|MATHÉMATIQUES",
    subject: "MATHÉMATIQUES",
    teacher: "M. PROFESSEUR Maxime",
    rooms: ["207"],
    groups: ["6A"],
    start: Math.floor(new Date(2026, 10, 6, 9, 0).getTime() / 1000),
    end: Math.floor(new Date(2026, 10, 6, 11, 0).getTime() / 1000),
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
  notebookId: null,
  label: "MATHÉMATIQUES 6A",
  rooms: [{ N: "129#r1", L: "207" }],
  place: 82,
  duration: 2,
  attendanceLocked: locked,
});

test("the call sheet keeps the places, the columns and the students without any sensitive member", () => {
  const sheet = sheetOf(fixture("call-sheet"));
  assert.equal(sheet.placeStart, 1342);
  assert.equal(sheet.placeEnd, 1343);
  assert.equal(sheet.lateMinutes, 5);
  assert.equal(sheet.columns[0].G, 13);
  assert.equal(sheet.students.length, 4);
  assert.deepEqual(Object.keys(sheet.students[0]), ["N", "L", "absences"]);
  const state = stateOf(sheet, false);
  assert.equal(state.entries.length, 4, "the week-long absences overlap the lesson");
  assert.deepEqual(state.entries[0], { student: "ELEVE Un", kind: "absence", minutes: null, justified: true, byTeacher: false, settled: false });
});

test("a locked lesson or a missing right is refused before any call", () => {
  assert.throws(() => assertAllowed(ref(true), {}, []), /attendance_locked/);
  assert.throws(() => assertAllowed(ref(), { absences: { avecSaisieAppel: false } }, []), /attendance_not_allowed/);
  assert.throws(() => assertAllowed(ref(), { absences: { avecSaisieAbsence: false } }, [{ student: "x", kind: "absence" }]), /absence_not_allowed/);
  assert.throws(() => assertAllowed(ref(), { absences: { avecSaisieRetard: false } }, [{ student: "x", kind: "late" }]), /late_not_allowed/);
  assert.doesNotThrow(() => assertAllowed(ref(), {}, [{ student: "x", kind: "late" }]), "unknown rights do not block");
  assert.doesNotThrow(() => assertAllowed(ref(), { absences: { avecSaisieAbsence: false } }, [{ student: "x", kind: "absence", delete: true }]));
});

test("SaisieAbsences carries the lesson, the done flag and only the modified students", () => {
  const sheet = sheetOf(fixture("call-sheet"));
  // ELEVE Un already has a (school life) absence on the lesson: a new one is refused, so use a late arrival.
  const request = buildAttendanceRequest(session, ref(), sheet, { items: [{ student: "eleve un", kind: "late", minutes: 10 }], done: true, dryRun: true }, {});
  assert.deepEqual(request.cours, { N: "29#x1", G: 0, L: "MATHÉMATIQUES 6A" });
  assert.equal(request.appelFait, true);
  assert.equal(request.numeroSemaine, 10);
  assert.equal(request.placeSaisieDebut, 1342);
  assert.equal(request.placeSaisieFin, 1343);
  assert.equal(request.placeCours, 82);
  assert.equal(request.dureeCours, 2);
  assert.deepEqual(request.professeur, { N: "109#x1", G: 3, L: "M. PROFESSEUR Maxime" });
  assert.deepEqual(request.date, { _T: 7, V: "6/11/2026 9:0:0" });
  const [student] = request.listeEleves as any[];
  assert.equal(student.L, "ELEVE Un");
  assert.equal(student.E, 2);
  assert.deepEqual(student.listeAbsences, [{ N: -1, G: 14, E: 1, placeDebut: 1342, placeFin: 1342, duree: 10 }]);
  assert.deepEqual(student.listePunitions, []);
});

test("an absence of the school life office is never deleted by the teacher, a duplicate is refused", () => {
  const sheet = sheetOf(fixture("call-sheet"));
  assert.throws(
    () => buildAttendanceRequest(session, ref(), sheet, { items: [{ student: "ELEVE Un", kind: "absence", delete: true }], dryRun: true }, {}),
    /absence_not_deletable:ELEVE Un/,
  );
  assert.doesNotThrow(() =>
    buildAttendanceRequest(session, ref(), sheet, { items: [{ student: "ELEVE Un", kind: "absence", delete: true }], dryRun: true }, { absences: { suppressionAbsenceDeVS: true } }),
  );
  assert.throws(
    () => buildAttendanceRequest(session, ref(), sheet, { items: [{ student: "ELEVE Un", kind: "absence" }], dryRun: true }, {}),
    /absence_already_entered:ELEVE Un/,
  );
  assert.throws(() => buildAttendanceRequest(session, ref(), sheet, { items: [{ student: "INCONNU", kind: "absence" }], dryRun: true }, {}), /student_not_found:INCONNU/);
  // A teacher's own absence (author of genre 3) can be deleted; a settled one cannot.
  const own = sheetOf(fixture("call-sheet"));
  own.students[1].absences[0].Professeur = { _T: 24, V: { N: "109#x1", G: 3, L: "M. PROFESSEUR Maxime" } };
  const deletion = buildAttendanceRequest(session, ref(), own, { items: [{ student: "ELEVE Deux", kind: "absence", delete: true }], dryRun: true }, {});
  assert.deepEqual((deletion.listeEleves as any[])[0].listeAbsences, [{ N: own.students[1].absences[0].N, G: 13, E: 3 }]);
  own.students[1].absences[0].reglee = true;
  assert.throws(() => buildAttendanceRequest(session, ref(), own, { items: [{ student: "ELEVE Deux", kind: "absence", delete: true }], dryRun: true }, {}), /absence_settled/);
});

test("the planned state adds and removes the requested entries", () => {
  const before = stateOf(sheetOf(fixture("call-sheet")), false);
  const planned = plannedState(before, { items: [{ student: "ELEVE Un", kind: "late", minutes: 10 }, { student: "ELEVE Deux", kind: "absence", delete: true }], done: true, dryRun: true });
  assert.equal(planned.done, true);
  assert.equal(planned.entries.length, before.entries.length);
  assert.ok(planned.entries.some((entry) => entry.student === "ELEVE Un" && entry.kind === "late" && entry.minutes === 10 && entry.byTeacher));
  assert.ok(!planned.entries.some((entry) => entry.student === "ELEVE Deux"));
});
