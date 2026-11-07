/**
 * Writes a notebook entry ("cahier de textes") of one lesson of the teacher: SaisieCahierDeTextes (tab 28),
 * built exactly like the web client (objetrequetesaisiecahierdetextes.js, serialiserCahierDeTextes):
 * - the entry is always sent (N of the existing entry, or 0 with E 1 to create it);
 * - only the contents and homework that change are sent, with their state E (1 created, 2 modified,
 *   3 deleted); unchanged ones are left out, Pronote keeps them;
 * - files to attach are uploaded first (src/pronote/upload.ts) and referenced by IDFichier both at the root
 *   (ListeFichiers) and in the content or homework; links are sent as documents of genre 0;
 * - a written test is flagged with genreLienDS 0 (graded assessment) or 1 (skills assessment) and infosDS
 *   creates the graded assessment at the same time when a service and a period are given.
 * The entry is read before (state for the plan) and after the write (Pronote answers an empty "data" to an
 * ignored write: only a re-read proves the write). Not validated on a real server yet.
 */
import { ServerSideError, type SessionHandle } from "pawnote";
import { HttpError } from "../errors.js";
import { answerData, callPronote, entryReport, propertyKeys } from "../pronote/request.js";
import { listOf, pronoteDate, pronoteNumber } from "../pronote/encoding.js";
import { normalise, type Notebook, type NotebookContent, type NotebookHomework, type TeacherLesson } from "../normalise.js";
import { requireFunction } from "./functions.js";
import { loadPeriods, periodKey, type Element } from "./grades.js";
import { resolve } from "./ids.js";
import { lessonPage, notebookFromPage } from "./notebook.js";
import { lessons, type LessonRef } from "./timetable.js";

const STATE_CREATED = 1;
const STATE_MODIFIED = 2;
const STATE_DELETED = 3;
const TYPE_HTML = 21;
const TYPE_NUMBER = 10;
/** EGenreLienDS: 0 graded assessment ("devoir"), 1 skills assessment ("évaluation"). */
const LINK_GRADED = 0;
const LINK_SKILLS = 1;
/** Genre of an attached document: 0 URL, 1 file. */
const DOCUMENT_LINK = 0;
const DOCUMENT_FILE = 1;

export type WriteAttachment = { name: string; fileId?: string; url?: string };

export type WriteContent = {
  /** Stable id of an existing content (as read), null or absent to create one. */
  id?: string | null;
  title: string;
  /** HTML. */
  description: string;
  objectives?: string;
  /** Category name ("Cours", "Devoir sur table"...) or kind (ListeCategories G). */
  category: string | { kind: number };
  attachments?: WriteAttachment[];
  delete?: boolean;
  assessment?: {
    kind: "written_test" | "skills";
    /** Creates the graded assessment with the content (service and period stable ids of the grade entry). */
    createGraded?: { service: string; period: string; coefficient: number; max: number };
  };
};

export type WriteHomework = {
  id?: string | null;
  description: string;
  /** Due date (seconds). */
  due: number;
  minutes?: number | null;
  difficulty?: number;
  returnKind?: number;
  forAll?: boolean;
  /** "NOM Prénom" of the targeted students when not for all. */
  students?: string[];
  attachments?: WriteAttachment[];
  delete?: boolean;
};

export type WriteEntry = {
  published?: boolean;
  /** Publication date (seconds), null for none. */
  publication?: number | null;
  noteForNext?: string;
  privateComment?: string;
  contents?: WriteContent[];
  homework?: WriteHomework[];
};

export type NotebookWriteResult = {
  lesson: TeacherLesson;
  before: Notebook;
  /** Planned (dryRun) or re-read (written) entry. */
  after: Notebook;
  /** JSON sent to SaisieCahierDeTextes, kept for the journal. */
  request: Record<string, unknown>;
  written: boolean;
  dryRun: boolean;
};

export type Category = { N: string; L: string; G: number };
export type StudentRef = { N: string; L: string };

type Resolved = {
  categories: Category[];
  students: StudentRef[];
  services: Element[];
  periods: Element[];
};

const html = (value: string | undefined) => ({ _T: TYPE_HTML, V: String(value ?? "") });
const number = (value: number) => ({ _T: TYPE_NUMBER, V: pronoteNumber(value) });
const ref = (item: { N: unknown; G?: unknown; L?: unknown }) => ({
  N: item.N,
  ...(item.G !== undefined ? { G: item.G } : {}),
  ...(item.L ? { L: item.L } : {}),
});

/** Date encoded in a stable lesson id ("l:2026-11-03 13:30|3D|MATHÉMATIQUES"), null when malformed. */
export const lessonDateOf = (lessonId: string): Date | null => {
  const match = lessonId.match(/^l:(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})\|/);
  if (!match) return null;
  const [, y, m, d, h, i] = match;
  return new Date(Number(y), Number(m) - 1, Number(d), Number(h), Number(i), 0);
};

/** Lesson of the teacher matching a stable id (read on its day), or HTTP 404 lesson_not_found. */
export const findLesson = async (session: SessionHandle, lessonId: string): Promise<LessonRef> => {
  const date = lessonDateOf(lessonId);
  if (!date) throw new HttpError(400, "invalid_lesson_id");
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const next = new Date(day.getTime() + 24 * 3600 * 1000);
  const found = (await lessons(session, day, next)).find((item) => item.lesson.id === lessonId);
  if (!found) throw new HttpError(404, "lesson_not_found");
  return found;
};

export const categoriesOf = (settings: Record<string, any>): Category[] =>
  listOf<any>(settings?.ListeCategories)
    .filter((item) => typeof item?.N === "string")
    .map((item) => ({ N: String(item.N), L: String(item.L ?? "").trim(), G: Number(item.G ?? 0) }));

export const studentsOf = (page: Record<string, any>): StudentRef[] =>
  listOf<any>(page?.listeClassesEleves).flatMap((group) =>
    listOf<any>(group?.listeEleves)
      .filter((item) => typeof item?.N === "string")
      .map((item) => ({ N: String(item.N), L: String(item.L ?? "").trim() })),
  );

export const resolveCategory = (categories: Category[], wanted: string | { kind: number }): Category => {
  const found =
    typeof wanted === "string"
      ? categories.find((item) => normalise(item.L) === normalise(wanted))
      : categories.find((item) => item.G === wanted.kind && item.G !== 0) ?? categories.find((item) => item.G === wanted.kind);
  if (!found) throw new HttpError(404, "category_not_found");
  return found;
};

const resolveStudents = (students: StudentRef[], labels: string[]): StudentRef[] =>
  labels.map((label) => {
    const found = students.find((item) => normalise(item.L) === normalise(label));
    if (!found) throw new HttpError(404, `student_not_found:${label}`);
    return found;
  });

const documentsOf = (attachments: WriteAttachment[] | undefined): Record<string, unknown>[] =>
  (attachments ?? []).map((item) => {
    if (item.fileId) return { L: item.name, G: DOCUMENT_FILE, E: STATE_CREATED, IDFichier: item.fileId };
    if (item.url) return { L: item.name || item.url, G: DOCUMENT_LINK, E: STATE_CREATED, url: item.url, estUnLienInterne: false };
    throw new HttpError(400, "attachment_without_file_or_url");
  });

/** Raw contents and homework of a PageSaisieCahierDeTextes answer, in the order of the normalised entry. */
const rawEntry = (page: Record<string, any>) => {
  const entry = listOf<any>(page?.listeCahiersDeTexte)[0] ?? null;
  return {
    entry,
    contents: listOf<any>(entry?.listeContenus),
    homework: listOf<any>(entry?.ListeTravailAFaire),
  };
};

const existingContent = (before: Notebook, raw: any[], id: string | null | undefined): { index: number; raw: any } | null => {
  if (!id) return null;
  const index = before.contents.findIndex((item) => item.id === id);
  if (index < 0 || !raw[index]) throw new HttpError(404, `content_not_found:${id}`);
  return { index, raw: raw[index] };
};

const existingHomework = (before: Notebook, raw: any[], id: string | null | undefined): { index: number; raw: any } | null => {
  if (!id) return null;
  const index = before.homework.findIndex((item) => item.id === id);
  if (index < 0 || !raw[index]) throw new HttpError(404, `homework_not_found:${id}`);
  return { index, raw: raw[index] };
};

const serviceKey = (service: Element) => `${service.matiere?.V?.L ?? service.L ?? ""}|${(service.classe?.V ?? service.groupe?.V)?.L ?? ""}`;

const assessmentMembers = (content: WriteContent, resolved: Resolved): Record<string, unknown> => {
  if (!content.assessment) return {};
  const members: Record<string, unknown> = { genreLienDS: content.assessment.kind === "skills" ? LINK_SKILLS : LINK_GRADED };
  const graded = content.assessment.createGraded;
  if (graded) {
    if (content.assessment.kind === "skills") throw new HttpError(400, "skills_assessment_creation_unsupported");
    const service = resolve("service", graded.service, resolved.services, serviceKey);
    const period = resolve("period", graded.period, resolved.periods, periodKey);
    members.infosDS = {
      service: ref(service),
      periode: ref(period),
      coefficient: number(graded.coefficient),
      bareme: number(graded.max),
      recalculerNotesDevoirSelonBareme: false,
    };
  }
  return members;
};

/** JSON of one content for SaisieCahierDeTextes (only sent when it changes). */
export const contentMember = (content: WriteContent, existing: any | null, resolved: Resolved): Record<string, unknown> => {
  if (content.delete) {
    if (!existing) throw new HttpError(400, "delete_without_id");
    return {
      N: existing.N,
      E: STATE_DELETED,
      L: String(existing.L ?? ""),
      Categorie: existing.categorie?.V ? ref(existing.categorie.V) : undefined,
      parcoursEducatif: existing.parcoursEducatif ?? -1,
      ListeThemes: listOf<any>(existing.ListeThemes).map(ref),
      Descriptif: existing.descriptif ?? html(""),
      ListeDocumentsJoints: [],
    };
  }
  const category = resolveCategory(resolved.categories, content.category);
  return {
    N: existing ? existing.N : 0,
    E: existing ? STATE_MODIFIED : STATE_CREATED,
    L: content.title.trim(),
    Categorie: { N: category.N, L: category.L },
    parcoursEducatif: existing?.parcoursEducatif ?? -1,
    ListeThemes: listOf<any>(existing?.ListeThemes).map(ref),
    Descriptif: html(content.description),
    ...(content.objectives ? { objectifs: html(content.objectives) } : {}),
    ListeDocumentsJoints: documentsOf(content.attachments),
    ...assessmentMembers(content, resolved),
  };
};

/** JSON of one homework for SaisieCahierDeTextes (only sent when it changes). */
export const homeworkMember = (homework: WriteHomework, existing: any | null, resolved: Resolved): Record<string, unknown> => {
  if (homework.delete) {
    if (!existing) throw new HttpError(400, "delete_without_id");
    return {
      N: existing.N,
      E: STATE_DELETED,
      Date: existing.PourLe ?? pronoteDate(new Date(homework.due * 1000)),
      niveauDifficulte: existing.niveauDifficulte ?? 0,
      genreRendu: existing.genreRendu ?? 0,
      duree: existing.duree ?? 0,
      Descriptif: existing.descriptif ?? html(""),
      avecMiseEnForme: true,
      ListeDocumentsJoints: [],
      ListeThemes: [],
      estPourTous: existing.estPourTous !== false,
    };
  }
  const due = new Date(homework.due * 1000);
  const forAll = homework.forAll !== false;
  const students = forAll ? [] : resolveStudents(resolved.students, homework.students ?? []);
  if (!forAll && students.length === 0) throw new HttpError(400, "homework_without_students");
  return {
    N: existing ? existing.N : 0,
    E: existing ? STATE_MODIFIED : STATE_CREATED,
    Date: pronoteDate(new Date(due.getFullYear(), due.getMonth(), due.getDate())),
    niveauDifficulte: Number(homework.difficulty ?? 0),
    genreRendu: Number(homework.returnKind ?? 0),
    duree: Number(homework.minutes ?? 0),
    Descriptif: html(homework.description),
    avecMiseEnForme: true,
    ListeDocumentsJoints: documentsOf(homework.attachments),
    ListeThemes: listOf<any>(existing?.ListeThemes).map(ref),
    estPourTous: forAll,
    ...(forAll ? {} : { ListeEleves: students.map((item) => ({ N: item.N, G: 4 })) }),
  };
};

/** Whole SaisieCahierDeTextes JSON for a lesson, from the page read before and the requested entry. */
export const buildNotebookRequest = (
  lessonRef: LessonRef,
  page: Record<string, any>,
  before: Notebook,
  entry: WriteEntry,
  resolved: Resolved,
  force = false,
): Record<string, unknown> => {
  const raw = rawEntry(page);
  const contents = (entry.contents ?? []).map((content) =>
    contentMember(content, existingContent(before, raw.contents, content.id)?.raw ?? null, resolved),
  );
  const homework = (entry.homework ?? []).map((item) =>
    homeworkMember(item, existingHomework(before, raw.homework, item.id)?.raw ?? null, resolved),
  );
  const files: Record<string, unknown>[] = [];
  for (const member of [...contents, ...homework]) {
    for (const document of (member.ListeDocumentsJoints as Record<string, unknown>[]) ?? []) {
      if (document.IDFichier) files.push({ L: document.L, G: DOCUMENT_FILE, E: STATE_CREATED, IDFichier: document.IDFichier });
    }
  }
  const published = entry.published ?? before.published;
  const publication = entry.publication === undefined
    ? raw.entry?.DatePublication ?? null
    : entry.publication === null
      ? null
      : pronoteDate(new Date(entry.publication * 1000));
  return {
    cours: { N: lessonRef.pronoteId },
    numeroSemaine: lessonRef.week,
    ListeModeles: [],
    listeCategories: [],
    ListeCahierDeTextes: [
      {
        N: raw.entry?.N ?? 0,
        E: raw.entry ? STATE_MODIFIED : STATE_CREATED,
        Publie: published,
        DatePublication: publication,
        noteProchaineSeance: entry.noteForNext ?? before.noteForNext,
        commentairePrive: entry.privateComment ?? before.privateComment,
        Contenus: contents,
        ListeTravauxAFaire: homework,
        listeElementsProgrammeCDT: [],
        servicePourComptabilisationBulletin: null,
      },
    ],
    ListeFichiers: files,
    forcerSaisie: force,
  };
};

/** Entry as it should read after the write (dryRun answer): contents and homework merged locally. */
export const plannedEntry = (before: Notebook, entry: WriteEntry, categories: Category[]): Notebook => {
  const contents: NotebookContent[] = [...before.contents];
  for (const content of entry.contents ?? []) {
    const index = content.id ? contents.findIndex((item) => item.id === content.id) : -1;
    if (content.delete) {
      if (index >= 0) contents.splice(index, 1);
      continue;
    }
    const category = resolveCategory(categories, content.category);
    const planned: NotebookContent = {
      id: content.id ?? `${before.lesson.id}|c?|${content.title.trim()}`,
      title: content.title.trim(),
      description: content.description,
      objectives: content.objectives ?? "",
      category: { name: category.L, kind: category.G },
      isAssessment: [3, 7, 13, 14].includes(category.G) || content.assessment !== undefined,
      attachments: (content.attachments ?? []).map((item) => ({ name: item.name, kind: item.url ? "link" : "file", url: item.url ?? null })),
      themes: index >= 0 ? contents[index].themes : [],
    };
    if (index >= 0) contents[index] = planned;
    else contents.push(planned);
  }
  const homework: NotebookHomework[] = [...before.homework];
  for (const item of entry.homework ?? []) {
    const index = item.id ? homework.findIndex((existing) => existing.id === item.id) : -1;
    if (item.delete) {
      if (index >= 0) homework.splice(index, 1);
      continue;
    }
    const planned: NotebookHomework = {
      id: item.id ?? `${before.lesson.id}|h?`,
      description: item.description,
      due: item.due,
      given: index >= 0 ? homework[index].given : before.lesson.start,
      minutes: item.minutes ?? null,
      difficulty: Number(item.difficulty ?? 0),
      returnKind: Number(item.returnKind ?? 0),
      forAll: item.forAll !== false,
      students: item.forAll === false ? [...(item.students ?? [])] : [],
      attachments: (item.attachments ?? []).map((file) => ({ name: file.name, kind: file.url ? "link" : "file", url: file.url ?? null })),
    };
    if (index >= 0) homework[index] = planned;
    else homework.push(planned);
  }
  return {
    ...before,
    published: entry.published ?? before.published,
    publication: entry.publication === undefined ? before.publication : entry.publication,
    noteForNext: entry.noteForNext ?? before.noteForNext,
    privateComment: entry.privateComment ?? before.privateComment,
    contents,
    homework,
  };
};

const call = async (session: SessionHandle, key: "lessonSettings" | "assessmentPlanning", data: Record<string, unknown>) => {
  const fn = requireFunction(key);
  const answer = await callPronote(session, { name: fn.name, data, signature: fn.onglet !== null ? { onglet: fn.onglet } : undefined });
  return answerData(session, answer);
};

/** Checks that each created or modified content and homework is found in the re-read entry. */
export const verifyWritten = (after: Notebook, entry: WriteEntry): void => {
  for (const content of entry.contents ?? []) {
    const title = normalise(content.title ?? "");
    const found = after.contents.some((item) => normalise(item.title) === title);
    if (content.delete ? found && !(entry.contents ?? []).some((other) => !other.delete && normalise(other.title ?? "") === title) : !found) {
      throw new HttpError(502, `notebook_not_saved:${content.title}`);
    }
  }
  for (const item of entry.homework ?? []) {
    const due = new Date(item.due * 1000);
    const day = new Date(due.getFullYear(), due.getMonth(), due.getDate()).getTime() / 1000;
    const found = after.homework.some((existing) => {
      const date = new Date(existing.due * 1000);
      return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() / 1000 === day
        && (item.delete || normalise(existing.description.replace(/<[^>]+>/g, "")) === normalise(item.description.replace(/<[^>]+>/g, "")));
    });
    if (item.delete ? false : !found) throw new HttpError(502, "notebook_homework_not_saved");
  }
};

export type WriteOptions = { dryRun: boolean; force?: boolean };

/** Reads, builds, writes (unless dryRun) and re-reads the notebook entry of a lesson. */
export const writeNotebook = async (
  session: SessionHandle,
  lessonId: string,
  entry: WriteEntry,
  options: WriteOptions,
): Promise<NotebookWriteResult> => {
  const lessonRef = await findLesson(session, lessonId);
  const page = lessonRef.lesson.hasNotebook ? await lessonPage(session, lessonRef) : await lessonPage(session, lessonRef);
  const before = notebookFromPage(session, lessonRef, page);
  if (before.locked) throw new HttpError(409, "notebook_locked");

  const needsCategories = (entry.contents ?? []).some((content) => !content.delete);
  const needsGraded = (entry.contents ?? []).some((content) => content.assessment?.createGraded);
  const resolved: Resolved = {
    categories: needsCategories ? categoriesOf(await call(session, "lessonSettings", { DemandeDomainePresence: true })) : [],
    students: studentsOf(page),
    services: [],
    periods: [],
  };
  if (needsGraded) {
    const planning = await call(session, "assessmentPlanning", { cours: { N: lessonRef.pronoteId }, numeroCycle: lessonRef.week, genreLienDS: LINK_GRADED });
    resolved.services = listOf<Element>(planning.services);
    if (resolved.services.length === 0) throw new HttpError(409, "no_service_for_graded_assessment");
    resolved.periods = (await loadPeriods(session)).periods;
  }
  const request = buildNotebookRequest(lessonRef, page, before, entry, resolved, options.force === true);
  const planned = plannedEntry(before, entry, resolved.categories);
  if (options.dryRun) {
    return { lesson: lessonRef.lesson, before, after: planned, request, written: false, dryRun: true };
  }

  const fn = requireFunction("notebookSave");
  const answer = await callPronote(session, {
    name: fn.name,
    data: request,
    signature: fn.onglet !== null ? { onglet: fn.onglet } : undefined,
    keepRefusal: true,
  });
  const report = entryReport(answer, propertyKeys(session).data);
  if (report) {
    const pending = listOf<any>(report.listeFichiersSuppressionAConfirmer);
    const messages = listOf<unknown>(report._messagesErreur_).map((item) => (typeof item === "string" ? item : String((item as any)?.L ?? ""))).filter(Boolean);
    if (pending.length > 0 && !options.force) {
      throw new HttpError(409, `confirmation_required:${[report.titre_Messages_Erreur, ...messages].filter(Boolean).join(" : ") || "fichiers à supprimer"}`);
    }
    if (report._erreurSaisie_ === true || messages.length > 0) {
      throw new HttpError(409, `pronote_refused:${[report.titre_Messages_Erreur, ...messages].filter(Boolean).join(" : ")}`);
    }
  }
  const reread = await findLesson(session, lessonId);
  const after = notebookFromPage(session, reread, await lessonPage(session, reread));
  verifyWritten(after, entry);
  return { lesson: reread.lesson, before, after, request, written: true, dryRun: false };
};

export { ServerSideError };
