/**
 * Lessons of the teacher read in the teacher space (PageEmploiDuTemps, tab 16), week by week.
 *
 * The answer carries what the student timetable of Pawnote does not: the notebook of each lesson ("cahier de
 * textes", AvecCdT and its identifier), its publication and the call sheet state. The routes /timetable still
 * use Pawnote (validated earlier); this module may replace it later.
 */
import { translateToWeekNumber, type SessionHandle } from "pawnote";
import { HttpError } from "../errors.js";
import { answerData, callPronote } from "../pronote/request.js";
import { listOf, parsePronoteDate, pronoteDate } from "../pronote/encoding.js";
import { normalise, seconds, type TeacherLesson } from "../normalise.js";
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

/** Lesson with the session-bound data needed by the next calls (never sent back to Moodle). */
export type LessonRef = { lesson: TeacherLesson; pronoteId: string; week: number; notebookId: string | null };

const pad = (value: number) => String(value).padStart(2, "0");
const dayKey = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const minuteKey = (date: Date) => `${dayKey(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;

/** Stable lesson id: date and time, class or group, subject. */
export const lessonIdFor = (start: Date, groups: string[], subject: string): string =>
  stableId("lesson", `${minuteKey(start)}|${groups.join("+")}|${subject}`);

/**
 * End of a lesson: DateDuCoursFin when given, else the school ending of its last block (Pawnote's rule), else
 * start + blocks × 55 minutes.
 */
export const lessonEnd = (session: SessionHandle, cours: any, start: Date): Date => {
  const explicit = parsePronoteDate(cours?.DateDuCoursFin?.V);
  if (explicit) return explicit;
  const blocks = Math.max(1, Number(cours?.duree ?? 1));
  const endings: string[] = (session.instance as { endings?: string[] })?.endings ?? [];
  const perDay = Number((session.instance as { blocksPerDay?: number })?.blocksPerDay ?? 0);
  if (endings.length > 0 && perDay > 0 && typeof cours?.place === "number") {
    let index = (cours.place % perDay) + blocks - 1;
    if (index >= endings.length) index %= endings.length - 1;
    const [hours, minutes] = String(endings[index] ?? "").split("h").map(Number);
    if (Number.isFinite(hours) && Number.isFinite(minutes)) {
      const end = new Date(start);
      end.setHours(hours, minutes, 0, 0);
      if (end > start) return end;
    }
  }
  return new Date(start.getTime() + blocks * DEFAULT_BLOCK_MINUTES * 60_000);
};

/** Normalised lesson of a PageEmploiDuTemps answer, null when the entry is not a lesson or has no date. */
export const lessonFromPage = (session: SessionHandle, cours: any, week: number): LessonRef | null => {
  const start = parsePronoteDate(cours?.DateDuCours?.V);
  if (!start || typeof cours?.N !== "string") return null;
  const contents = listOf<any>(cours.ListeContenus);
  const labels = (genres: number[]) =>
    contents.filter((item) => genres.includes(Number(item?.G))).map((item) => String(item?.L ?? "").trim()).filter(Boolean);
  const subject = labels([GENRE_SUBJECT])[0] ?? "";
  const groups = labels([GENRE_CLASS, GENRE_GROUP, GENRE_CLASS_PART]);
  const teachers = labels([GENRE_TEACHER]);
  const lesson: TeacherLesson = {
    id: lessonIdFor(start, groups, subject),
    subject,
    teacher: teachers.length ? teachers.join(", ") : session.user.name,
    rooms: labels([GENRE_ROOM]),
    groups,
    start: seconds(start),
    end: seconds(lessonEnd(session, cours, start)),
    cancelled: cours.estAnnule === true,
    status: statusLabel(cours.Statut),
    hasNotebook: cours.AvecCdT === true,
    notebookPublished: cours.AvecCdTPublie === true,
    attendanceDone: cours.AppelFait === true,
  };
  const notebook = cours.cahierDeTextes?.V?.N;
  return { lesson, pronoteId: cours.N, week, notebookId: typeof notebook === "string" ? notebook : null };
};

/** Statut of a lesson (typestatutcours.js): 0 normal, 1 class council, 2 replacement, 3 history, 4 substitute. */
export const statusLabel = (status: unknown): string => {
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
export const weeksOf = (session: SessionHandle, from: Date, to: Date): number[] => {
  const firstMonday = session.instance.firstMonday;
  const first = translateToWeekNumber(from, firstMonday);
  const last = translateToWeekNumber(new Date(to.getTime() - 1), firstMonday);
  if (last < first) return [];
  if (last - first + 1 > MAX_WEEKS) throw new HttpError(400, "range_too_large");
  const weeks: number[] = [];
  for (let week = first; week <= last; week++) weeks.push(week);
  return weeks;
};

/** Lessons of the teacher in [from, to), sorted by date. */
export const lessons = async (session: SessionHandle, from: Date, to: Date): Promise<LessonRef[]> => {
  const fn = requireFunction("timetablePage");
  const me = session.user.resources[0];
  const found: LessonRef[] = [];
  for (const week of weeksOf(session, from, to)) {
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
    for (const cours of listOf<any>(answerData(session, answer).ListeCours)) {
      const ref = lessonFromPage(session, cours, week);
      if (!ref) continue;
      const start = ref.lesson.start * 1000;
      if (start >= from.getTime() && start < to.getTime()) found.push(ref);
    }
  }
  return found.sort((a, b) => a.lesson.start - b.lesson.start || a.lesson.id.localeCompare(b.lesson.id));
};

/** Keeps the lessons of the given class or group labels (empty: all), compared without case nor accents. */
export const filterByGroups = <T extends { lesson: { groups: string[] } }>(items: T[], classes: string[]): T[] => {
  const wanted = classes.map(normalise).filter(Boolean);
  if (wanted.length === 0) return items;
  return items.filter((item) => item.lesson.groups.some((group) => wanted.includes(normalise(group))));
};

/** Pronote date range members, for the functions that take dateDebut / dateFin. */
export const dateRange = (from: Date, to: Date) => ({ dateDebut: pronoteDate(from), dateFin: pronoteDate(to) });
