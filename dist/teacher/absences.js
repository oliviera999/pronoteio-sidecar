/**
 * Absences of a class or group (read only).
 *
 * A teacher account has no access to the absence summary tabs (138, 155): only the call sheet of
 * its own lessons (tab 113, PageSaisieAbsences). The sidecar reads the call sheet of every lesson
 * of the teacher over the date range and keeps the absences of the students of the class or group.
 * Absences are therefore limited to those overlapping a lesson of this teacher.
 */
import { parseTimetable, timetableFromIntervals } from "pawnote";
import { answerData, callPronote } from "../pronote/request.js";
import { listOf, parsePronoteDate, pronoteDate } from "../pronote/encoding.js";
import { seconds } from "../normalise.js";
import { requireFunction } from "./functions.js";
import { stableId } from "./ids.js";
import { rosterEntries } from "./roster.js";
/** Genre of an absence in ListeAbsences (14 = late arrival, 15 = infirmary...). */
const GENRE_ABSENCE = 13;
/** Genre of a teacher resource. */
const GENRE_TEACHER = 3;
/** Absences of the call sheet answer that belong to the given students, keyed to be deduplicated. */
export const absencesFromCallSheet = (data, students) => {
    const byPronoteId = new Map(students.map((entry) => [entry.pronoteId, entry]));
    const byLabel = new Map();
    for (const entry of students) {
        byLabel.set(entry.label, byLabel.has(entry.label) ? null : entry);
    }
    const result = [];
    for (const student of listOf(data?.ListeEleves)) {
        for (const item of listOf(student?.ListeAbsences)) {
            if (item?.G !== GENRE_ABSENCE)
                continue;
            const owner = item.eleve?.V ?? student;
            const entry = byPronoteId.get(String(owner?.N ?? "")) ?? byLabel.get(String(owner?.L ?? ""));
            if (!entry)
                continue;
            const start = parsePronoteDate(item.DateDebut?.V);
            const end = parsePronoteDate(item.DateFin?.V) ?? start;
            if (!start || !end)
                continue;
            result.push({
                id: stableId("absence", `${entry.id}|${item.DateDebut.V}|${item.DateFin?.V ?? ""}`),
                studentid: entry.id,
                start: seconds(start),
                end: seconds(end),
                justified: item.justifie === true,
                reason: listOf(item.listeMotifs).map((motif) => String(motif?.L ?? "")).filter(Boolean).join(", "),
            });
        }
    }
    return result;
};
/** Keeps the first occurrence of each absence: a day-long absence appears on every lesson of the day. */
export const uniqueAbsences = (items) => {
    const seen = new Map();
    for (const item of items) {
        if (!seen.has(item.id))
            seen.set(item.id, item);
    }
    return [...seen.values()].sort((a, b) => a.start - b.start || a.studentid.localeCompare(b.studentid));
};
export const absences = async (session, resourceId, from, to) => {
    const fn = requireFunction("absencesList");
    const students = await rosterEntries(session, resourceId);
    if (students.length === 0)
        return [];
    const now = new Date();
    const until = to < now ? to : now;
    if (until <= from)
        return [];
    const timetable = await timetableFromIntervals(session, from, until);
    parseTimetable(session, timetable, { withSuperposedCanceledClasses: false, withCanceledClasses: false, withPlannedClasses: true });
    const lessons = timetable.classes.filter((item) => item.is === "lesson" && item.startDate >= from && item.startDate < until);
    const me = session.user.resources[0];
    const found = [];
    for (const lesson of lessons) {
        const answer = await callPronote(session, {
            name: fn.name,
            data: {
                Professeur: { N: me.id, G: GENRE_TEACHER, L: me.name },
                Ressource: { N: lesson.id },
                Date: pronoteDate(lesson.startDate),
            },
            signature: fn.onglet !== null ? { onglet: fn.onglet } : undefined,
        });
        found.push(...absencesFromCallSheet(answerData(session, answer), students));
    }
    return uniqueAbsences(found);
};
//# sourceMappingURL=absences.js.map