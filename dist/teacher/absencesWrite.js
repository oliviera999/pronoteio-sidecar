import { HttpError } from "../errors.js";
import { listOf, pronoteDate } from "../pronote/encoding.js";
import { userData } from "../pronote/userdata.js";
import { normalise } from "../normalise.js";
import { call as callFunction } from "./grades.js";
import { findLesson } from "./notebookWrite.js";
import { sendWrite } from "./write.js";
const GENRE_ABSENCE = 13;
const GENRE_LATE = 14;
const GENRE_TEACHER = 3;
const GENRE_STUDENT = 4;
const STATE_CREATED = 1;
const STATE_MODIFIED = 2;
const STATE_DELETED = 3;
/** Students and settings of a PageSaisieAbsences answer ("data" member); sensitive members are never read. */
export const sheetOf = (data) => ({
    placeStart: Number(data?.PlaceSaisieDebut ?? 0),
    placeEnd: Number(data?.PlaceSaisieFin ?? data?.PlaceSaisieDebut ?? 0),
    lateMinutes: Number(data?.DureeRetard ?? 5),
    columns: listOf(data?.ListeColonnes).map((column) => ({
        G: Number(column?.G ?? 0),
        A: column?.A !== false,
        ...(typeof column?.N === "string" ? { N: column.N } : {}),
    })),
    students: listOf(data?.ListeEleves)
        .filter((item) => typeof item?.N === "string")
        .map((item) => ({ N: String(item.N), L: String(item.L ?? "").trim(), absences: listOf(item?.ListeAbsences) })),
    raw: data,
});
const overlaps = (absence, sheet) => {
    const start = Number(absence?.PlaceDebut ?? NaN);
    const end = Number(absence?.PlaceFin ?? start);
    if (!Number.isFinite(start))
        return true;
    return start <= sheet.placeEnd && end >= sheet.placeStart;
};
const isTeacherEntry = (absence) => Number((absence?.Professeur?.V ?? absence?.Professeur)?.G ?? 0) === GENRE_TEACHER;
/** Absences and late arrivals of the lesson's students that overlap the lesson. */
export const stateOf = (sheet, done) => ({
    done,
    entries: sheet.students.flatMap((student) => student.absences
        .filter((absence) => (Number(absence?.G) === GENRE_ABSENCE || Number(absence?.G) === GENRE_LATE) && overlaps(absence, sheet))
        .map((absence) => ({
        student: student.L,
        kind: Number(absence?.G) === GENRE_LATE ? "late" : "absence",
        minutes: Number(absence?.G) === GENRE_LATE ? Number(absence?.Duree ?? absence?.duree ?? 0) || null : null,
        justified: absence?.justifie === true,
        byTeacher: isTeacherEntry(absence),
        settled: absence?.reglee === true,
    }))),
});
/** Refuses the call when the lesson, the rights or an item forbid it (before any call to Pronote). */
export const assertAllowed = (ref, rights, items) => {
    if (ref.attendanceLocked)
        throw new HttpError(409, "attendance_locked");
    const absences = rights?.absences;
    if (!absences || typeof absences !== "object")
        return;
    if (absences.avecSaisieAppel === false)
        throw new HttpError(403, "attendance_not_allowed");
    if (items.some((item) => item.kind === "absence" && !item.delete) && absences.avecSaisieAbsence === false)
        throw new HttpError(403, "absence_not_allowed");
    if (items.some((item) => item.kind === "late" && !item.delete) && absences.avecSaisieRetard === false)
        throw new HttpError(403, "late_not_allowed");
};
/** SaisieAbsences JSON: the lesson, the done flag and the modified students with their absence changes. */
export const buildAttendanceRequest = (session, ref, sheet, write, rights) => {
    const me = session.user.resources[0];
    const canDeleteSchoolLife = rights?.absences?.suppressionAbsenceDeVS === true;
    const byStudent = new Map();
    let negative = 0;
    for (const item of write.items) {
        const student = sheet.students.find((candidate) => normalise(candidate.L) === normalise(item.student));
        if (!student)
            throw new HttpError(404, `student_not_found:${item.student}`);
        const genre = item.kind === "late" ? GENRE_LATE : GENRE_ABSENCE;
        const entry = byStudent.get(student.N) ?? { student, changes: [] };
        if (item.delete) {
            const existing = student.absences.find((absence) => Number(absence?.G) === genre && overlaps(absence, sheet));
            if (!existing)
                throw new HttpError(404, `absence_not_found:${item.student}`);
            if (existing.reglee === true)
                throw new HttpError(409, `absence_settled:${item.student}`);
            if (!isTeacherEntry(existing) && !canDeleteSchoolLife)
                throw new HttpError(409, `absence_not_deletable:${item.student}`);
            entry.changes.push({ N: existing.N, G: genre, E: STATE_DELETED });
        }
        else {
            const duplicate = student.absences.find((absence) => Number(absence?.G) === genre && overlaps(absence, sheet));
            if (duplicate)
                throw new HttpError(409, `absence_already_entered:${item.student}`);
            negative--;
            entry.changes.push(item.kind === "late"
                ? { N: negative, G: GENRE_LATE, E: STATE_CREATED, placeDebut: sheet.placeStart, placeFin: sheet.placeStart, duree: Math.max(1, Math.round(item.minutes ?? sheet.lateMinutes)) }
                : { N: negative, G: GENRE_ABSENCE, E: STATE_CREATED, placeDebut: sheet.placeStart, placeFin: sheet.placeEnd, ouverte: false, reglee: false });
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
const readSheet = async (session, ref) => {
    const me = session.user.resources[0];
    return sheetOf(await callFunction(session, "absencesList", {
        Professeur: { N: me.id, G: GENRE_TEACHER, L: me.name },
        Ressource: { N: ref.pronoteId },
        Date: pronoteDate(new Date(ref.lesson.start * 1000)),
    }));
};
/** State as it should read after the write. */
export const plannedState = (before, write) => {
    const entries = [...before.entries];
    for (const item of write.items) {
        const index = entries.findIndex((entry) => normalise(entry.student) === normalise(item.student) && entry.kind === item.kind);
        if (item.delete) {
            if (index >= 0)
                entries.splice(index, 1);
        }
        else if (index < 0) {
            entries.push({ student: item.student, kind: item.kind, minutes: item.kind === "late" ? item.minutes ?? null : null, justified: false, byTeacher: true, settled: false });
        }
    }
    return { done: write.done !== false, entries };
};
export const writeAttendance = async (session, lessonId, write) => {
    if (write.items.length === 0 && write.done === undefined)
        throw new HttpError(400, "nothing_to_write");
    const ref = await findLesson(session, lessonId);
    const rights = userData(session).rights;
    assertAllowed(ref, rights, write.items);
    const sheet = await readSheet(session, ref);
    const before = stateOf(sheet, ref.lesson.attendanceDone);
    const request = buildAttendanceRequest(session, ref, sheet, write, rights);
    const planned = plannedState(before, write);
    if (write.dryRun)
        return { lesson: ref.lesson, before, after: planned, request, written: false, dryRun: true };
    await sendWrite(session, "attendanceSave", request, write.force === true);
    const reread = await findLesson(session, lessonId);
    const after = stateOf(await readSheet(session, reread), reread.lesson.attendanceDone);
    for (const item of write.items) {
        const found = after.entries.some((entry) => normalise(entry.student) === normalise(item.student) && entry.kind === item.kind);
        if (item.delete ? found : !found)
            throw new HttpError(502, `attendance_not_saved:${item.student}`);
    }
    return { lesson: reread.lesson, before, after, request, written: true, dryRun: false };
};
//# sourceMappingURL=absencesWrite.js.map