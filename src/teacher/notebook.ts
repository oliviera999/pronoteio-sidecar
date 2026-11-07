/**
 * Notebook ("cahier de textes") of the teacher's lessons, read in the teacher space: PageEmploiDuTemps for the
 * lessons, then PageSaisieCahierDeTextes (tab 28, a read despite its name) for each lesson that has an entry.
 *
 * Pawnote's assignmentsFromIntervals reads the student page and fails on a teacher account.
 */
import type { SessionHandle } from "pawnote";
import { answerData, callPronote } from "../pronote/request.js";
import { downloadUrl } from "../pronote/files.js";
import { listOf, parsePronoteDate } from "../pronote/encoding.js";
import {
  ASSESSMENT_KINDS,
  seconds,
  type Attachment,
  type Notebook,
  type NotebookContent,
  type NotebookHomework,
  type NotebookResult,
} from "../normalise.js";
import { requireFunction } from "./functions.js";
import { filterByGroups, lessons, type LessonRef } from "./timetable.js";

/** Largest number of lessons whose notebook is read in one call. */
export const MAX_LESSONS = 60;

/** Genre of an attached document: 0 URL, 1 file (ListePieceJointe / ListeDocumentsJoints). */
const GENRE_LINK = 0;

const html = (value: unknown): string => {
  const raw = value !== null && typeof value === "object" && "V" in (value as object) ? (value as { V: unknown }).V : value;
  return typeof raw === "string" ? raw : "";
};

const text = (value: unknown): string => (typeof value === "string" ? value : "");

const number = (value: unknown): number | null => {
  const raw = value !== null && typeof value === "object" && "V" in (value as object) ? (value as { V: unknown }).V : value;
  const parsed = Number.parseFloat(String(raw ?? "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
};

/** Attachments of a content or homework: files get a session-bound download URL, links their URL. */
export const attachmentsOf = (session: SessionHandle, items: unknown): Attachment[] =>
  listOf<any>(items)
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const name = String(item.L ?? "").trim();
      if (Number(item.G ?? 1) === GENRE_LINK) {
        return { name, kind: "link" as const, url: typeof item.url === "string" && item.url !== "" ? item.url : null };
      }
      return { name, kind: "file" as const, url: typeof item.N === "string" ? downloadUrl(session, { N: item.N, L: name }) : null };
    });

const contentOf = (session: SessionHandle, lessonId: string, item: any, index: number): NotebookContent => {
  const category = item?.categorie?.V ?? {};
  const kind = Number(category.G ?? 0);
  const title = String(item?.L ?? "").trim();
  return {
    id: `${lessonId}|c${index + 1}|${title}`,
    title,
    description: html(item?.descriptif),
    objectives: html(item?.objectifs),
    category: { name: String(category.L ?? "").trim(), kind },
    isAssessment: ASSESSMENT_KINDS.includes(kind) || (item?.genreLienDS !== undefined && item?.genreLienDS !== null && Number(item.genreLienDS) >= 0 && item?.infosDS !== undefined),
    attachments: attachmentsOf(session, item?.ListePieceJointe),
    themes: listOf<any>(item?.ListeThemes).map((theme) => String(theme?.L ?? "").trim()).filter(Boolean),
  };
};

const homeworkOf = (session: SessionHandle, lessonId: string, item: any, index: number): NotebookHomework | null => {
  const due = parsePronoteDate(item?.PourLe?.V);
  if (!due) return null;
  const given = parsePronoteDate(item?.DonneLe?.V);
  const forAll = item?.estPourTous !== false;
  return {
    id: `${lessonId}|h${index + 1}`,
    description: html(item?.descriptif),
    due: seconds(due),
    given: given ? seconds(given) : null,
    minutes: number(item?.duree),
    difficulty: Number(item?.niveauDifficulte ?? 0),
    returnKind: Number(item?.genreRendu ?? 0),
    forAll,
    students: forAll ? [] : listOf<any>(item?.listeEleves).map((student) => String(student?.L ?? "").trim()).filter(Boolean),
    attachments: attachmentsOf(session, item?.ListePieceJointe),
  };
};

/**
 * Notebook entry of a lesson from a PageSaisieCahierDeTextes answer ("data" member). Publication: the entry's
 * own "publie" flag when Pronote sends it, else the AvecCdTPublie flag of the lesson in the timetable (the demo
 * server sends neither "publie" nor "DatePublication" on read).
 */
export const notebookFromPage = (session: SessionHandle, ref: LessonRef, data: any): Notebook => {
  const entry = listOf<any>(data?.listeCahiersDeTexte)[0] ?? null;
  const lessonId = ref.lesson.id;
  const publication = parsePronoteDate(entry?.DatePublication?.V);
  const published = typeof entry?.publie === "boolean" ? entry.publie : ref.lesson.notebookPublished;
  return {
    lesson: ref.lesson,
    locked: entry?.verrouille === true,
    published,
    publication: publication ? seconds(publication) : null,
    noteForNext: text(entry?.noteProchaineSeance),
    privateComment: text(entry?.commentairePrive),
    contents: listOf<any>(entry?.listeContenus).map((item, index) => contentOf(session, lessonId, item, index)),
    homework: listOf<any>(entry?.ListeTravailAFaire)
      .map((item, index) => homeworkOf(session, lessonId, item, index))
      .filter((item): item is NotebookHomework => item !== null),
  };
};

/** Reads the notebook page of one lesson. */
export const lessonPage = async (session: SessionHandle, ref: LessonRef): Promise<Record<string, any>> => {
  const fn = requireFunction("lessonPage");
  const answer = await callPronote(session, {
    name: fn.name,
    data: { cours: { N: ref.pronoteId }, numeroSemaine: ref.week, avecJoursPresence: false, avecCDT: true },
    signature: fn.onglet !== null ? { onglet: fn.onglet } : undefined,
  });
  return answerData(session, answer);
};

/** Notebook of the lessons in [from, to) of the given classes (empty: all), one entry per lesson. */
export const notebook = async (
  session: SessionHandle,
  from: Date,
  to: Date,
  classes: string[] = [],
  includeEmpty = false,
): Promise<NotebookResult> => {
  const all = filterByGroups(await lessons(session, from, to), classes);
  const wanted = includeEmpty ? all : all.filter((ref) => ref.lesson.hasNotebook);
  const kept = wanted.slice(0, MAX_LESSONS);
  const items: Notebook[] = [];
  for (const ref of kept) {
    if (!ref.lesson.hasNotebook && !includeEmpty) continue;
    const data = ref.lesson.hasNotebook ? await lessonPage(session, ref) : {};
    items.push(notebookFromPage(session, ref, data));
  }
  return { items, lessons: all.length, truncated: wanted.length > kept.length };
};
