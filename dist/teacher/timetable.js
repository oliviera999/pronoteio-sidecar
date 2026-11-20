/**
 * Lessons of the teacher read in the teacher space (PageEmploiDuTemps, tab 16), week by week.
 *
 * The answer carries what the student timetable of Pawnote does not: the notebook of each lesson ("cahier de
 * textes", AvecCdT and its identifier), its publication and the call sheet state. The routes /timetable still
 * use Pawnote (validated earlier); this module may replace it later.
 */
import { translateToWeekNumber } from "pawnote";
import { HttpError } from "../errors.js";
import { answerData, callPronote } from "../pronote/request.js";
import { listOf, parsePronoteDate, pronoteDate } from "../pronote/encoding.js";
import { localTimes, matchesLabels, seconds } from "../normalise.js";
import { requireFunction } from "./functions.js";
import { stableId } from "./ids.js";
/** Genres of the ListeContenus entries of a lesson. */
const GENRE_CLASS = 1;
const GENRE_GROUP = 2;
const GENRE_TEACHER = 3;
const GENRE_SUBJECT = 16;
const GENRE_ROOM = 17;
const GENRE_CLASS_PART = 57;
/** Largest range read in one call (one Pronote call per week). */
export const MAX_WEEKS = 9;
/** Length of a timetable block when the school endings are unknown (minutes). */
const DEFAULT_BLOCK_MINUTES = 55;
const pad = (value) => String(value).padStart(2, "0");
const dayKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const minuteKey = (date) => `${dayKey(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
/** Stable lesson id: date and time, class or group, subject. */
export const lessonIdFor = (start, groups, subject) => stableId("lesson", `${minuteKey(start)}|${groups.join("+")}|${subject}`);
/**
 * End of a lesson: DateDuCoursFin when given, else the school ending of its last block (Pawnote's rule), else
 * start + blocks × 55 minutes.
 */
export const lessonEnd = (session, cours, start) => {
    const explicit = parsePronoteDate(cours?.DateDuCoursFin?.V);
    if (explicit)
        return explicit;
    const blocks = Math.max(1, Number(cours?.duree ?? 1));
    const endings = session.instance?.endings ?? [];
    const perDay = Number(session.instance?.blocksPerDay ?? 0);
    if (endings.length > 0 && perDay > 0 && typeof cours?.place === "number") {
        let index = (cours.place % perDay) + blocks - 1;
        if (index >= endings.length)
            index %= endings.length - 1;
        const [hours, minutes] = String(endings[index] ?? "").split("h").map(Number);
        if (Number.isFinite(hours) && Number.isFinite(minutes)) {
            const end = new Date(start);
            end.setHours(hours, minutes, 0, 0);
            if (end > start)
                return end;
        }
    }
    return new Date(start.getTime() + blocks * DEFAULT_BLOCK_MINUTES * 60_000);
};
/**
 * Normalised lesson of a PageEmploiDuTemps answer, null when the entry is not a lesson or has no date. Without a
 * teacher in the lesson, "teacher" is the account (its own timetable) or the given fallback (another resource).
 */
export const lessonFromPage = (session, cours, week, fallbackTeacher) => {
    const start = parsePronoteDate(cours?.DateDuCours?.V);
    if (!start || typeof cours?.N !== "string")
        return null;
    const contents = listOf(cours.ListeContenus);
    const labels = (genres) => contents.filter((item) => genres.includes(Number(item?.G))).map((item) => String(item?.L ?? "").trim()).filter(Boolean);
    const subject = labels([GENRE_SUBJECT])[0] ?? "";
    const groups = labels([GENRE_CLASS, GENRE_GROUP, GENRE_CLASS_PART]);
    const teachers = labels([GENRE_TEACHER]);
    const id = lessonIdFor(start, groups, subject);
    const end = lessonEnd(session, cours, start);
    const lesson = {
        id,
        subject,
        teacher: teachers.length ? teachers.join(", ") : (fallbackTeacher ?? session.user.name),
        rooms: labels([GENRE_ROOM]),
        groups,
        start: seconds(start),
        end: seconds(end),
        cancelled: cours.estAnnule === true,
        status: statusLabel(cours.Statut),
        hasNotebook: cours.AvecCdT === true,
        notebookPublished: cours.AvecCdTPublie === true,
        attendanceDone: cours.AppelFait === true,
        editable: cours.modifiable === true,
        roomsEditable: cours.modifiable === true && cours.ressourcesModifiables === true,
        baseId: id,
        duplicates: 1,
        local: localTimes({ start, end }),
    };
    const notebook = cours.cahierDeTextes?.V?.N;
    const rooms = contents
        .filter((item) => Number(item?.G) === GENRE_ROOM && typeof item?.N === "string")
        .map((item) => ({ N: String(item.N), L: String(item.L ?? "").trim() }));
    return {
        lesson,
        pronoteId: cours.N,
        week,
        notebookId: typeof notebook === "string" ? notebook : null,
        label: typeof cours.L === "string" ? cours.L : "",
        rooms,
        place: typeof cours.place === "number" ? cours.place : null,
        duration: Math.max(1, Number(cours.duree ?? 1)),
        attendanceLocked: cours.verrouille === true || cours.estAppelVerrouille === true || cours.utilisableAppel === false,
    };
};
/** Statut of a lesson (typestatutcours.js): 0 normal, 1 class council, 2 replacement, 3 history, 4 substitute. */
export const statusLabel = (status) => {
    switch (Number(status ?? 0)) {
        case 1:
            return "class council";
        case 2:
            return "replacement";
        case 3:
            return "history";
        case 4:
            return "substitute";
        default:
            return "";
    }
};
/** Week numbers (Pronote numbering from the first Monday of the school year) covering [from, to). */
export const weeksOf = (session, from, to) => {
    const firstMonday = session.instance.firstMonday;
    const first = translateToWeekNumber(from, firstMonday);
    const last = translateToWeekNumber(new Date(to.getTime() - 1), firstMonday);
    if (last < first)
        return [];
    if (last - first + 1 > MAX_WEEKS)
        throw new HttpError(400, "range_too_large");
    const weeks = [];
    for (let week = first; week <= last; week++)
        weeks.push(week);
    return weeks;
};
/** Lessons of the teacher for one Pronote week (not discriminated, in the order of the answer). */
export const lessonsOfWeek = async (session, week) => {
    const fn = requireFunction("timetablePage");
    const me = session.user.resources[0];
    const answer = await callPronote(session, {
        name: fn.name,
        data: {
            // Keys are case sensitive: with "numeroSemaine" Pronote silently answers the current week.
            Ressource: { N: me.id, G: GENRE_TEACHER, L: me.name },
            NumeroSemaine: week,
            avecAbsencesEleve: false,
            avecConseilDeClasse: false,
            avecRetenuesEleve: false,
            estEDTPermanence: false,
            avecCoursSortiePeda: true,
        },
        signature: fn.onglet !== null ? { onglet: fn.onglet } : undefined,
    });
    const found = [];
    for (const cours of listOf(answerData(session, answer).ListeCours)) {
        const ref = lessonFromPage(session, cours, week);
        if (ref)
            found.push(ref);
    }
    return found;
};
/** Lessons of the teacher in [from, to), sorted by date. */
export const lessons = async (session, from, to) => {
    const found = [];
    for (const week of weeksOf(session, from, to)) {
        for (const ref of await lessonsOfWeek(session, week)) {
            // Wall Dates from/to compared in the school's zone with the lesson timestamp.
            const start = ref.lesson.start;
            if (start >= seconds(from) && start < seconds(to))
                found.push(ref);
        }
    }
    return discriminate(found).sort((a, b) => a.lesson.start - b.lesson.start || a.lesson.id.localeCompare(b.lesson.id));
};
/** Room part of a discriminated lesson id: room labels, spaces collapsed, "|" replaced, joined with "+". */
export const roomKey = (rooms) => rooms.map((room) => room.normalize("NFC").replace(/\s+/g, " ").replace(/\|/g, "/").trim()).filter(Boolean).join("+");
/**
 * Deterministic order of the lessons sharing a stable id: lesson held first (not cancelled), then by end, rooms,
 * label and status. Pronote ids are encrypted per session and never used for the order, except to break a complete
 * tie (identical lessons in every visible field).
 */
const compareDuplicates = (a, b) => Number(a.lesson.cancelled) - Number(b.lesson.cancelled)
    || a.lesson.end - b.lesson.end
    || roomKey(a.lesson.rooms).localeCompare(roomKey(b.lesson.rooms))
    || a.label.localeCompare(b.label)
    || a.lesson.status.localeCompare(b.lesson.status)
    || a.pronoteId.localeCompare(b.pronoteId);
/**
 * Unique ids when several lessons share the same stable id (same minute, classes or groups and subject: the cancelled
 * lesson and the moved one after a change of room, or a split lesson). A lesson alone keeps its id exactly; each
 * duplicate gets "<id>|r:<rooms>" when its rooms are given and differ from the other duplicates', else
 * "<id>|n:<rank>" (rank in compareDuplicates order, from 1). Every lesson gets baseId and duplicates. Mutates and
 * returns the refs.
 */
export const discriminate = (refs) => {
    const groups = new Map();
    for (const ref of refs) {
        const base = ref.lesson.baseId || ref.lesson.id;
        const list = groups.get(base) ?? [];
        list.push(ref);
        groups.set(base, list);
    }
    for (const [base, list] of groups) {
        for (const ref of list) {
            ref.lesson.baseId = base;
            ref.lesson.duplicates = list.length;
            ref.lesson.id = base;
        }
        if (list.length < 2)
            continue;
        const rooms = new Map();
        for (const ref of list) {
            const key = roomKey(ref.lesson.rooms);
            rooms.set(key, (rooms.get(key) ?? 0) + 1);
        }
        [...list].sort(compareDuplicates).forEach((ref, index) => {
            const key = roomKey(ref.lesson.rooms);
            ref.lesson.id = key !== "" && rooms.get(key) === 1 ? `${base}|r:${key}` : `${base}|n:${index + 1}`;
        });
    }
    return refs;
};
/**
 * Lesson matching a stable id among the lessons of its day: the exact id (discriminated or not); else, for a base id
 * shared by several lessons, the only one that is not cancelled. HTTP 404 lesson_not_found when none matches, HTTP 409
 * "lesson_ambiguous:<id> ; <id>…" (full ids of the candidates) when several remain.
 */
export const pickLesson = (refs, lessonId) => {
    const exact = refs.find((item) => item.lesson.id === lessonId);
    if (exact)
        return exact;
    const candidates = refs.filter((item) => item.lesson.baseId === lessonId);
    if (candidates.length === 0)
        throw new HttpError(404, "lesson_not_found");
    const held = candidates.filter((item) => !item.lesson.cancelled);
    if (held.length === 1)
        return held[0];
    throw new HttpError(409, `lesson_ambiguous:${candidates.map((item) => item.lesson.id).join(" ; ")}`);
};
/**
 * Element id (content "…|c1|Title" or homework "…|h1") rebuilt on the resolved lesson: an id built on the base id
 * of a duplicated lesson (before 0.7.0, or copied from the base id) is moved onto the full id. Ids of another
 * duplicate ("<base>|r:…", "<base>|n:…") and ids of other lessons are left as they are (then not found).
 */
export const rebaseElementId = (lesson, id) => {
    if (!id || lesson.duplicates < 2 || lesson.id === lesson.baseId)
        return id;
    if (id.startsWith(`${lesson.id}|`) || !id.startsWith(`${lesson.baseId}|`))
        return id;
    const rest = id.slice(lesson.baseId.length + 1);
    return /^(c\d+|h\d+)(\||$)/.test(rest) ? `${lesson.id}|${rest}` : id;
};
/**
 * Keeps the lessons of the given class or group labels (empty: all): labelMatches() rule, without case, accents nor
 * brackets, prefix at a word boundary accepted ("T06AP" keeps "[T06AP ORIENT]", "1G" keeps "1G3").
 */
export const filterByGroups = (items, classes) => items.filter((item) => matchesLabels(item.lesson.groups, classes));
/** Pronote date range members, for the functions that take dateDebut / dateFin. */
export const dateRange = (from, to) => ({ dateDebut: pronoteDate(from), dateFin: pronoteDate(to) });
//# sourceMappingURL=timetable.js.map