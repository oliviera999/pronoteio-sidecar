/**
 * Assessments planned by the teacher, from three sources that complete each other (see
 * docs/pronote-matrice-droits.md, "Répondre à « ai-je prévu une évaluation ? »"):
 * - notebook: contents of the lessons flagged as tests (written test, skills assessment, CCF, certifying);
 * - grades: assessments of the grade entry (PageNotes) of every service of the current period, dated in range;
 * - dslist: the school-wide written tests list (ListeDevoirSurTable, tab 154), when the profile may read it.
 */
import { ServerSideError, type SessionHandle } from "pawnote";
import { answerData, callPronote } from "../pronote/request.js";
import { listOf, parsePronoteDate } from "../pronote/encoding.js";
import { userData } from "../pronote/userdata.js";
import { normalise, plainText, seconds, type AssessmentsResult, type PlannedAssessment, type Sources } from "../normalise.js";
import { requireFunction } from "./functions.js";
import { call, loadPeriods, loadServices, resourceOf, type Element } from "./grades.js";
import { stableId } from "./ids.js";
import { notebook } from "./notebook.js";
import { dateRange } from "./timetable.js";

const pad = (value: number) => String(value).padStart(2, "0");
const dayOf = (time: number) => {
  const date = new Date(time * 1000);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

export const plannedIdFor = (date: number, groups: string[], title: string): string =>
  stableId("planned", `${dayOf(date)}|${groups.join("+")}|${title.trim()}`);

const number = (value: unknown): number | null => {
  const raw = value !== null && typeof value === "object" && "V" in (value as object) ? (value as { V: unknown }).V : value;
  const parsed = Number.parseFloat(String(raw ?? "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
};

const isAccessDenied = (error: unknown): boolean =>
  error instanceof ServerSideError && /droits|insuffisant/i.test(error.message);

const inRange = (time: number, from: Date, to: Date): boolean => time * 1000 >= from.getTime() && time * 1000 < to.getTime();

const matchesClasses = (groups: string[], classes: string[]): boolean => {
  const wanted = classes.map(normalise).filter(Boolean);
  return wanted.length === 0 || groups.some((group) => wanted.includes(normalise(group)));
};

/** Assessments flagged in the notebook of the lessons in range. */
export const fromNotebook = async (session: SessionHandle, from: Date, to: Date, classes: string[]): Promise<PlannedAssessment[]> => {
  const { items } = await notebook(session, from, to, classes, false);
  const result: PlannedAssessment[] = [];
  for (const entry of items) {
    for (const content of entry.contents) {
      if (!content.isAssessment) continue;
      const title = content.title || content.category.name;
      result.push({
        id: plannedIdFor(entry.lesson.start, entry.lesson.groups, title),
        source: "notebook",
        date: entry.lesson.start,
        end: entry.lesson.end,
        subject: entry.lesson.subject,
        groups: entry.lesson.groups,
        title,
        kind: content.category.name,
        published: entry.published,
        publication: entry.publication,
        coefficient: null,
        max: null,
        details: plainText(content.description),
      });
    }
  }
  return result;
};

/** Graded assessments of a PageNotes answer ("data" member) dated in [from, to) and matching the classes. */
export const gradedFromPage = (
  service: Element,
  page: Record<string, any>,
  from: Date,
  to: Date,
  classes: string[],
  now = new Date(),
): PlannedAssessment[] => {
  const resource = resourceOf(service);
  const serviceGroups = resource?.L ? [String(resource.L)] : [];
  const subject = String(service.matiere?.V?.L ?? service.L ?? "");
  const result: PlannedAssessment[] = [];
  for (const devoir of listOf<Element>(page.listeDevoirs)) {
    const date = parsePronoteDate(devoir.date?.V);
    if (!date || !inRange(seconds(date), from, to)) continue;
    const groups = listOf<Element>(devoir.listeClasses).map((item) => String(item.L ?? "")).filter(Boolean);
    const finalGroups = groups.length ? groups : serviceGroups;
    if (!matchesClasses(finalGroups, classes)) continue;
    const publication = parsePronoteDate(devoir.datePublication?.V);
    const title = String(devoir.commentaire ?? "").trim() || subject;
    result.push({
      id: plannedIdFor(seconds(date), finalGroups, title),
      source: "grades",
      date: seconds(date),
      end: null,
      subject,
      groups: finalGroups,
      title,
      kind: "graded",
      published: publication ? publication.getTime() <= now.getTime() : null,
      publication: publication ? seconds(publication) : null,
      coefficient: number(devoir.coefficient),
      max: number(devoir.bareme),
      details: [devoir.verrouille === true ? "verrouillé" : "", devoir.existesDesNotes === true ? "notes saisies" : ""]
        .filter(Boolean)
        .join(", "),
    });
  }
  return result;
};

/** Graded assessments of the current period dated in range (PageNotes of every service). */
export const fromGrades = async (session: SessionHandle, from: Date, to: Date, classes: string[], now = new Date()): Promise<PlannedAssessment[]> => {
  const { periods, current } = await loadPeriods(session);
  const period = current ?? periods[0] ?? null;
  const services = await loadServices(session, period);
  const result: PlannedAssessment[] = [];
  for (const service of services) {
    const resource = resourceOf(service);
    if (!matchesClasses(resource?.L ? [String(resource.L)] : [], classes)) continue;
    const page = await call(session, "gradesPage", {
      service: { N: service.N, ...(service.L ? { L: service.L } : {}) },
      ...(period ? { periode: { N: period.N, ...(period.G !== undefined ? { G: period.G } : {}), ...(period.L ? { L: period.L } : {}) } } : {}),
    });
    result.push(...gradedFromPage(service, page, from, to, classes, now));
  }
  return result;
};

/** Written tests of a ListeDevoirSurTable answer ("data" member) dated in [from, to). */
export const writtenTestsFromAnswer = (data: Record<string, any>, from: Date, to: Date): PlannedAssessment[] =>
  listOf<any>(data?.liste).flatMap((item) => {
    const date = parsePronoteDate(item?.date?.V);
    if (!date || !inRange(seconds(date), from, to)) return [];
    const groups = String(item?.strPublic ?? "").split(/\s*[,;]\s*/).map((value) => value.trim()).filter(Boolean);
    const subject = String(item?.strMatiere ?? "").trim();
    const title = String(item?.strInfosLien ?? "").trim() || subject;
    const details = [item?.strProfesseurs, item?.strSalle ? `salle ${item.strSalle}` : "", item?.strInfosLien]
      .map((value) => String(value ?? "").trim())
      .filter(Boolean)
      .join(", ");
    return [{
      id: plannedIdFor(seconds(date), groups, title),
      source: "dslist" as const,
      date: seconds(date),
      end: null,
      subject,
      groups,
      title,
      kind: "written test",
      published: null,
      publication: null,
      coefficient: null,
      max: null,
      details,
    }];
  });

/** Written tests of the taught classes (school-wide list), or null when the profile may not read it. */
export const fromWrittenTests = async (session: SessionHandle, from: Date, to: Date, classes: string[]): Promise<PlannedAssessment[] | null> => {
  const fn = requireFunction("writtenTestsList");
  const taught = userData(session).resources.filter((item) => item.genre === 1 && item.taught && matchesClasses([item.label], classes));
  if (taught.length === 0) return [];
  let data: Record<string, any>;
  try {
    const answer = await callPronote(session, {
      name: fn.name,
      data: {
        ...dateRange(from, to),
        listeClasses: taught.map((item) => ({ N: item.id, G: 1, L: item.label })),
        mesDonnees: false,
      },
      signature: fn.onglet !== null ? { onglet: fn.onglet } : undefined,
    });
    data = answerData(session, answer);
  } catch (error) {
    if (isAccessDenied(error)) return null;
    throw error;
  }
  // An empty answer is how Pronote refuses a function it does not open to the profile.
  if (!data || Object.keys(data).length === 0) return null;
  return writtenTestsFromAnswer(data, from, to);
};

const dedupeKey = (item: PlannedAssessment): string =>
  `${dayOf(item.date)}|${[...item.groups].map(normalise).sort().join("+")}|${normalise(item.subject)}`;

/** Merges the sources: the notebook entry wins over the graded assessment, which wins over the list entry. */
export const merge = (lists: PlannedAssessment[][]): PlannedAssessment[] => {
  const byKey = new Map<string, PlannedAssessment>();
  for (const list of lists) {
    for (const item of list) {
      const key = dedupeKey(item);
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, { ...item });
        continue;
      }
      const extra = [item.kind, item.title !== existing.title ? item.title : "", item.details].filter(Boolean).join(" : ");
      existing.details = [existing.details, extra ? `${item.source} : ${extra}` : ""].filter(Boolean).join(" | ");
      existing.coefficient ??= item.coefficient;
      existing.max ??= item.max;
      existing.publication ??= item.publication;
      if (existing.published === null) existing.published = item.published;
    }
  }
  return [...byKey.values()].sort((a, b) => a.date - b.date || a.id.localeCompare(b.id));
};

export const assessments = async (session: SessionHandle, from: Date, to: Date, classes: string[] = []): Promise<AssessmentsResult> => {
  const sources: Sources = {};
  const fromNb = await fromNotebook(session, from, to, classes);
  sources.notebook = { available: true, reason: "", count: fromNb.length };
  const fromGr = await fromGrades(session, from, to, classes);
  sources.grades = { available: true, reason: "", count: fromGr.length };
  const fromDs = await fromWrittenTests(session, from, to, classes);
  sources.dslist = fromDs === null
    ? { available: false, reason: "access_denied", count: 0 }
    : { available: true, reason: "", count: fromDs.length };
  return { items: merge([fromNb, fromGr, fromDs ?? []]), sources };
};
