/**
 * Does the call sheet of one of the teacher's lessons: SaisieAbsences (tab 113), one request carrying the state
 * of the modified students only, as valider() of interfacepagesaisieabsences.js does (see
 * docs/pronote-matrice/5-6-vie-scolaire-edt.md in mood_prod). Absences are expressed in annual places: the call
 * sheet answer gives PlaceSaisieDebut / PlaceSaisieFin for the lesson, and the lesson of the timetable its weekly
 * place and duration (placeCours, dureeCours); no conversion from hours is needed here. Not validated on a real
 * server (the demo ignores writes). An absence or a late arrival is visible to families at once.
 *
 * Guards reproduced from the client: a locked lesson or one not usable for the call is refused; the rights
 * absences.avecSaisieAbsence / avecSaisieRetard / avecSaisieAppel are checked when the profile rights are known;
 * an absence entered by the school life office (author of genre other than teacher) is never deleted by a teacher
 * unless the right suppressionAbsenceDeVS is granted; a settled absence (reglee) is never touched.
 * Nothing sensitive of the call sheet (support plans, diet, birthday, memos) is ever returned.
 */
import type { SessionHandle } from "pawnote";
import { HttpError } from "../errors.js";
import { listOf, pronoteDate } from "../pronote/encoding.js";
import { userData } from "../pronote/userdata.js";
import { normalise } from "../normalise.js";
import { call as callFunction } from "./grades.js";
import { findLesson } from "./notebookWrite.js";
import { sendWrite } from "./write.js";
import type { LessonRef } from "./timetable.js";
import type { TeacherLesson } from "../normalise.js";

const GENRE_ABSENCE = 13;
const GENRE_LATE = 14;
const GENRE_TEACHER = 3;
const GENRE_STUDENT = 4;
const STATE_CREATED = 1;
const STATE_MODIFIED = 2;
const STATE_DELETED = 3;

export type AttendanceItem = { student: string; kind: "absence" | "late"; minutes?: number; delete?: boolean };

export type AttendanceWrite = { items: AttendanceItem[]; done?: boolean; dryRun: boolean; force?: boolean };

/** One absence or late arrival of a student on the lesson, as read (no sensitive data). */
export type AttendanceEntry = { student: string; kind: "absence" | "late"; minutes: number | null; justified: boolean; byTeacher: boolean; settled: boolean };

export type AttendanceState = { done: boolean; entries: AttendanceEntry[] };

export type AttendanceWriteResult = {
  lesson: TeacherLesson;
  before: AttendanceState;
  after: AttendanceState;
  request: Record<string, unknown>;
  written: boolean;
  dryRun: boolean;
};

type SheetStudent = { N: string; L: string; absences: any[] };

type Sheet = { placeStart: number; placeEnd: number; lateMinutes: number; columns: Record<string, unknown>[]; students: SheetStudent[]; raw: Record<string, any> };

/** Students and settings of a PageSaisieAbsences answer ("data" member); sensitive members are never read. */
export const sheetOf = (data: Record<string, any>): Sheet => ({
  placeStart: Number(data?.PlaceSaisieDebut ?? 0),
  placeEnd: Number(data?.PlaceSaisieFin ?? data?.PlaceSaisieDebut ?? 0),
  lateMinutes: Number(data?.DureeRetard ?? 5),
  columns: listOf<any>(data?.ListeColonnes).map((column) => ({
    G: Number(column?.G ?? 0),
    A: column?.A !== false,
    ...(typeof column?.N === "string" ? { N: column.N } : {}),
  })),
  students: listOf<any>(data?.ListeEleves)
    .filter((item) => typeof item?.N === "string")
    .map((item) => ({ N: String(item.N), L: String(item.L ?? "").trim(), absences: listOf<any>(item?.ListeAbsences) })),
  raw: data,
});

const overlaps = (absence: any, sheet: Sheet): boolean => {
  const start = Number(absence?.PlaceDebut ?? NaN);
  const end = Number(absence?.PlaceFin ?? start);
  if (!Number.isFinite(start)) return true;
  return start <= sheet.placeEnd && end >= sheet.placeStart;
};

const isTeacherEntry = (absence: any): boolean => Number((absence?.Professeur?.V ?? absence?.Professeur)?.G ?? 0) === GENRE_TEACHER;

/** Absences and late arrivals of the lesson's students that overlap the lesson. */
export const stateOf = (sheet: Sheet, done: boolean): AttendanceState => ({
  done,
  entries: sheet.students.flatMap((student) =>
    student.absences
      .filter((absence) => (Number(absence?.G) === GENRE_ABSENCE || Number(absence?.G) === GENRE_LATE) && overlaps(absence, sheet))
      .map((absence) => ({
        student: student.L,
        kind: Number(absence?.G) === GENRE_LATE ? ("late" as const) : ("absence" as const),
        minutes: Number(absence?.G) === GENRE_LATE ? Number(absence?.Duree ?? absence?.duree ?? 0) || null : null,
        justified: absence?.justifie === true,
        byTeacher: isTeacherEntry(absence),
        settled: absence?.reglee === true,
      })),
  ),
});

/** Refuses the call when the lesson, the rights or an item forbid it (before any call to Pronote). */
export const assertAllowed = (ref: LessonRef, rights: Record<string, unknown>, items: AttendanceItem[]): void => {
  if (ref.attendanceLocked) throw new HttpError(409, "attendance_locked");
  const absences = rights?.absences as Record<string, unknown> | undefined;
  if (!absences || typeof absences !== "object") return;
  if (absences.avecSaisieAppel === false) throw new HttpError(403, "attendance_not_allowed");
  if (items.some((item) => item.kind === "absence" && !item.delete) && absences.avecSaisieAbsence === false) throw new HttpError(403, "absence_not_allowed");
  if (items.some((item) => item.kind === "late" && !item.delete) && absences.avecSaisieRetard === false) throw new HttpError(403, "late_not_allowed");
};

/** SaisieAbsences JSON: the lesson, the done flag and the modified students with their absence changes. */
export const buildAttendanceRequest = (
  session: SessionHandle,
  ref: LessonRef,
  sheet: Sheet,
  write: AttendanceWrite,
  rights: Record<string, unknown>,
): Record<string, unknown> => {
  const me = session.user.resources[0];
  const canDeleteSchoolLife = (rights?.absences as Record<string, unknown> | undefined)?.suppressionAbsenceDeVS === true;
  const byStudent = new Map<string, { student: SheetStudent; changes: Record<string, unknown>[] }>();
  let negative = 0;
  for (const item of write.items) {
    const student = sheet.students.find((candidate) => normalise(candidate.L) === normalise(item.student));
    if (!student) throw new HttpError(404, `student_not_found:${item.student}`);
    const genre = item.kind === "late" ? GENRE_LATE : GENRE_ABSENCE;
    const entry = byStudent.get(student.N) ?? { student, changes: [] };
    if (item.delete) {
      const existing = student.absences.find((absence) => Number(absence?.G) === genre && overlaps(absence, sheet));
      if (!existing) throw new HttpError(404, `absence_not_found:${item.student}`);
      if (existing.reglee === true) throw new HttpError(409, `absence_settled:${item.student}`);
      if (!isTeacherEntry(existing) && !canDeleteSchoolLife) throw new HttpError(409, `absence_not_deletable:${item.student}`);
      entry.changes.push({ N: existing.N, G: genre, E: STATE_DELETED });
    } else {
      const duplicate = student.absences.find((absence) => Number(absence?.G) === genre && overlaps(absence, sheet));
      if (duplicate) throw new HttpError(409, `absence_already_entered:${item.student}`);
      negative--;
      entry.changes.push(
        item.kind === "late"
          ? { N: negative, G: GENRE_LATE, E: STATE_CREATED, placeDebut: sheet.placeStart, placeFin: sheet.placeStart, duree: Math.max(1, Math.round(item.minutes ?? sheet.lateMinutes)) }
          : { N: negative, G: GENRE_ABSENCE, E: STATE_CREATED, placeDebut: sheet.placeStart, placeFin: sheet.placeEnd, ouverte: false, reglee: false },
      );
    }
    byStudent.set(student.N, entry);
  }
  return {
    cours: { N: ref.pronoteId, G: 0, ...(ref.label ? { L: ref.label } : {}) },
    appelFait: write.done !== false,
    numeroSemaine: ref.week,
    placeSaisieDebut: sheet.placeStart,
    placeSaisieFin: sheet.placeEnd,
    placeCours: ref.place ?? sheet.placeStart,
    dureeCours: ref.duration,
    professeur: { N: me.id, G: GENRE_TEACHER, L: me.name },
    date: pronoteDate(new Date(ref.lesson.start * 1000)),
    listeColonnes: sheet.columns,
    listeEleves: [...byStudent.values()].map(({ student, changes }) => ({
      N: student.N,
      G: GENRE_STUDENT,
      L: student.L,
      E: STATE_MODIFIED,
      listeAbsences: changes,
      listePunitions: [],
      listeDispenses: [],
      listeMemos: [],
      listeValorisations: [],
      listeAbsencesNonReglees: [],
    })),
    listeFichiers: [],
  };
};

const readSheet = async (session: SessionHandle, ref: LessonRef): Promise<Sheet> => {
  const me = session.user.resources[0];
  return sheetOf(await callFunction(session, "absencesList", {
    Professeur: { N: me.id, G: GENRE_TEACHER, L: me.name },
    Ressource: { N: ref.pronoteId },
    Date: pronoteDate(new Date(ref.lesson.start * 1000)),
  }));
};

/** State as it should read after the write. */
export const plannedState = (before: AttendanceState, write: AttendanceWrite): AttendanceState => {
  const entries = [...before.entries];
  for (const item of write.items) {
    const index = entries.findIndex((entry) => normalise(entry.student) === normalise(item.student) && entry.kind === item.kind);
    if (item.delete) {
      if (index >= 0) entries.splice(index, 1);
    } else if (index < 0) {
      entries.push({ student: item.student, kind: item.kind, minutes: item.kind === "late" ? item.minutes ?? null : null, justified: false, byTeacher: true, settled: false });
    }
  }
  return { done: write.done !== false, entries };
};

export const writeAttendance = async (session: SessionHandle, lessonId: string, write: AttendanceWrite): Promise<AttendanceWriteResult> => {
  if (write.items.length === 0 && write.done === undefined) throw new HttpError(400, "nothing_to_write");
  const ref = await findLesson(session, lessonId);
  const rights = userData(session).rights as Record<string, unknown>;
  assertAllowed(ref, rights, write.items);
  const sheet = await readSheet(session, ref);
  const before = stateOf(sheet, ref.lesson.attendanceDone);
  const request = buildAttendanceRequest(session, ref, sheet, write, rights);
  const planned = plannedState(before, write);
  if (write.dryRun) return { lesson: ref.lesson, before, after: planned, request, written: false, dryRun: true };

  await sendWrite(session, "attendanceSave", request, write.force === true);
  const reread = await findLesson(session, lessonId);
  const after = stateOf(await readSheet(session, reread), reread.lesson.attendanceDone);
  for (const item of write.items) {
    const found = after.entries.some((entry) => normalise(entry.student) === normalise(item.student) && entry.kind === item.kind);
    if (item.delete ? found : !found) throw new HttpError(502, `attendance_not_saved:${item.student}`);
  }
  return { lesson: reread.lesson, before, after, request, written: true, dryRun: false };
};
