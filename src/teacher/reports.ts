/**
 * Report cards ("bulletins") of a class, read in the teacher space (read only).
 *
 * PageBulletins (tab 13) answers for one student, one class and one period. The request and its
 * answer are decoded by the same client modules in the teacher and student spaces
 * (objetrequetepagebulletins.js, utilitairedeserialiserpiedbulletin.js, identical in PRONOTE 2026.2.8),
 * so the answer has the shape Pawnote decodes for students: ListeServices, ObjetListeAppreciations,
 * General and ListeAbsences. Only a teacher whose profile opens the tab can read them, usually the
 * main teacher ("professeur principal") of the class: the others get "Vos droits sont insuffisants".
 *
 * 0.12.0 (docs/pronoteio/vue-pp.md in mood_prod): pages of students with partial answers, the transcript of a student
 * (PageReleve, tab 12: same shape, with the assessments of each subject) and the results of the class
 * (ResultatsClasses, tab 64: answer shape unknown, read tolerantly). NOT VALIDATED on a real server.
 */
import { ServerSideError, type SessionHandle } from "pawnote";
import { HttpError } from "../errors.js";
import { answerData, callPronote } from "../pronote/request.js";
import { listOf } from "../pronote/encoding.js";
import { tabClosed, userData } from "../pronote/userdata.js";
import { splitDisplayName, type Report, type ReportAssessment, type ReportComment, type ReportContext, type ReportSubject } from "../normalise.js";
import { callFunction, functions, requireFunction, type FunctionKey } from "./functions.js";
import { loadPeriods, periodKey } from "./grades.js";
import { kindOf, resolve, stableId, stableIds } from "./ids.js";
import { rosterEntries, type RosterEntry } from "./roster.js";
import { shapeOf } from "./shape.js";
import { dateOf, dayString, deniedWhere, isPlain, member, numberOf, pageOf, readEach, textOf, unwrap, type PartialRead, type StudentPage } from "./tolerant.js";

/** Genres of Pronote entities. */
const GENRE_CLASS = 1;
const GENRE_STUDENT = 4;

/** Annotations written instead of a value ("|n"), as in the grade entry. */
const ANNOTATIONS: Record<string, string> = {
  "1": "Abs",
  "2": "Disp",
  "3": "N.Not",
  "4": "Inap",
  "5": "N.Rdu",
  "6": "Abs0",
  "7": "N.Rdu0",
};

const valueOf = (value: unknown): unknown =>
  value !== null && typeof value === "object" && "V" in (value as object) ? (value as { V: unknown }).V : value;

/** Number of a Pronote cell ("12,50", { _T: 10, V: "12,5" }), null for an annotation or nothing. */
export const reportNumber = (value: unknown): number | null => {
  const raw = valueOf(value);
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const text = raw.trim().replace(/\s/g, "").replace(",", ".");
  if (text === "" || text.startsWith("|")) return null;
  const number = Number.parseFloat(text);
  return Number.isFinite(number) ? number : null;
};

/** Annotation of a Pronote cell ("|1" -> "Abs"), "" when the cell holds a value or nothing. */
export const reportStatus = (value: unknown): string => {
  const raw = valueOf(value);
  if (typeof raw !== "string" || !raw.startsWith("|")) return "";
  return ANNOTATIONS[raw.slice(1)] ?? raw.slice(1);
};

const text = (value: unknown): string => {
  const raw = valueOf(value);
  return typeof raw === "string" ? raw.trim() : "";
};

const commentKind = (genre: unknown): ReportComment["kind"] => {
  if (genre === 0) return "general";
  if (genre === 1 || genre === 2 || genre === 3 || genre === 8) return "council";
  if (genre === 4 || genre === 5 || genre === 6) return "comment";
  if (genre === 7) return "cpe";
  return "other";
};

const teachersOf = (item: any): string[] =>
  listOf<any>(member(item, ["ListeProfesseurs", "listeProfesseurs", "professeurs"]))
    .map((teacher) => String(teacher?.L ?? "").trim())
    .filter(Boolean);

const averagesOf = (item: any) => ({
  coefficient: reportNumber(member(item, ["Coefficient"])),
  average: reportNumber(member(item, ["MoyenneEleve"])),
  classAverage: reportNumber(member(item, ["MoyenneClasse"])),
  min: reportNumber(member(item, ["MoyenneInf", "MoyenneMin"])),
  max: reportNumber(member(item, ["MoyenneSup", "MoyenneMax"])),
  status: reportStatus(member(item, ["MoyenneEleve"])),
});

const subjectLabel = (item: any): string =>
  String((valueOf(member(item, ["Matiere"])) as any)?.L ?? item?.L ?? "").trim();

/** Assessments of a transcript subject (PageReleve; member names are candidates, never captured). */
const assessmentsOf = (service: any): ReportAssessment[] =>
  listOf<any>(member(service, ["ListeDevoirs", "listeDevoirs", "devoirs"])).map((item) => {
    const grade = member(item, ["Note", "note"]);
    return {
      date: dayString(dateOf(member(item, ["Date", "date", "DateDevoir"]))),
      title: textOf(member(item, ["Commentaire", "commentaire", "Libelle", "L"])),
      grade: reportNumber(grade),
      status: reportStatus(grade),
      scale: reportNumber(member(item, ["Bareme", "bareme"])),
      coefficient: reportNumber(member(item, ["Coefficient", "coefficient"])),
      classAverage: reportNumber(member(item, ["Moyenne", "moyenne", "MoyenneClasse"])),
    };
  });

const subjectOf = (service: any): ReportSubject => {
  const elements = listOf<any>(member(service, ["ListeElements", "listeElements"]));
  const fromElements = elements.flatMap(teachersOf);
  const teachers = fromElements.length ? fromElements : teachersOf(service);
  // A service always carries one element (itself, with its teachers): sub-services only when there are several.
  const subservices = elements.length > 1
    ? elements.map((element) => ({ subject: subjectLabel(element), teachers: [...new Set(teachersOf(element))], ...averagesOf(element) }))
      .filter((item) => item.subject !== "")
    : [];
  return {
    subject: subjectLabel(service),
    teachers: [...new Set(teachers)],
    ...averagesOf(service),
    comments: listOf<any>(member(service, ["ListeAppreciations", "listeAppreciations"])).map((item) => String(item?.L ?? "").trim()).filter(Boolean),
    rank: reportNumber(member(service, ["Rang", "RangEleve", "rang"])),
    group: textOf(member(service, ["groupe", "strGroupe", "libelleGroupe", "nomGroupe"])),
    subservices,
    assessments: assessmentsOf(service),
  };
};

/** Report card of a PageBulletins answer, or transcript of a PageReleve answer (same shape; "data" member). */
export const reportFromAnswer = (
  data: any,
  student: { id: string; label: string },
  period: string,
): Report => {
  const name = splitDisplayName(student.label);
  const general = valueOf(member(data, ["General"])) as any;
  const appreciations = valueOf(member(data, ["ObjetListeAppreciations"])) as any;
  const footer = (valueOf(member(data, ["ListeAbsences"])) ?? {}) as any;
  const subjects = listOf<any>(member(data, ["ListeServices", "listeServices"])).map(subjectOf).filter((item) => item.subject !== "");
  const message = text(member(data, ["Message"]));
  return {
    studentid: student.id,
    lastname: name.lastname,
    firstname: name.firstname,
    period,
    state: subjects.length > 0 ? "published" : message !== "" ? "unpublished" : "empty",
    average: reportNumber(member(general, ["MoyenneEleve"])),
    classAverage: reportNumber(member(general, ["MoyenneClasse"])),
    rank: reportNumber(member(general, ["RangEleve", "Rang", "rang"])),
    classSize: reportNumber(member(general, ["NbrEleves", "NombreEleves", "Effectif", "nbEleves"])),
    subjects,
    comments: listOf<any>(member(appreciations, ["ListeAppreciations", "listeAppreciations"]))
      .map((item) => ({ kind: commentKind(item?.G), title: String(item?.Intitule ?? "").trim(), text: String(item?.L ?? "").trim() }))
      .filter((item) => item.text !== ""),
    attendance: {
      absences: text(footer.strAbsences),
      lates: text(footer.strRetards),
      punishments: text(footer.strPunitions),
      sanctions: text(footer.strSanctions),
    },
    publication: text(member(data, ["strInfoDatePublication"])),
    message,
  };
};

const reportTab = (): number | null => requireFunction("reportCard").onglet;

/** Classes (main teacher first) and periods for which report cards may be read. */
export const reportContext = async (session: SessionHandle): Promise<ReportContext> => {
  const { tabs, resources } = userData(session);
  const tab = reportTab();
  // 0.10.0: tab missing from the mobile session: the web session decides (space.ts), not the mobile list.
  const closed = tabs === null || tab === null ? null : tabClosed(session, tab, requireFunction("reportCard").name);
  const { periods, current } = await loadPeriods(session);
  const periodIds = stableIds("period", periods, periodKey);
  return {
    allowed: closed === null ? null : !closed,
    classes: resources
      .filter((item) => item.genre === GENRE_CLASS)
      .map((item) => ({ id: stableId("class", item.label), name: item.label, principal: item.principal, taught: item.taught }))
      .sort((a, b) => Number(b.principal) - Number(a.principal) || a.name.localeCompare(b.name, "fr", { numeric: true })),
    periods: periods.map((period, index) => ({ id: periodIds[index], name: String(period.L ?? ""), current: period === current })),
  };
};

const isAccessDenied = (error: unknown): boolean =>
  error instanceof ServerSideError && /droits/i.test(error.message);

export const reports = async (session: SessionHandle, resourceId: string, periodId: string): Promise<Report[]> => {
  const fn = requireFunction("reportCard");
  const { resources } = userData(session);
  // 0.10.0: a tab missing from the mobile session asks for the web session (space.ts) before concluding to a refusal.
  if (tabClosed(session, fn.onglet, fn.name)) throw new HttpError(403, "access_denied");
  if (kindOf(resourceId) !== "class") throw new HttpError(409, "resource_not_class");

  const classe = resolve("class", resourceId, resources.filter((item) => item.genre === GENRE_CLASS), (item) => item.label);
  const { periods } = await loadPeriods(session);
  const period = resolve("period", periodId, periods, periodKey);
  const students = await rosterEntries(session, resourceId);

  const result: Report[] = [];
  for (const student of students) {
    let answer: Record<string, any>;
    try {
      answer = await callPronote(session, {
        name: fn.name,
        data: {
          eleve: { N: student.pronoteId, G: GENRE_STUDENT, L: student.label },
          classe: { N: classe.id, G: GENRE_CLASS, L: classe.label },
          periode: { N: period.N, G: period.G, L: period.L },
        },
        signature: fn.onglet !== null ? { onglet: fn.onglet } : undefined,
      });
    } catch (error) {
      if (isAccessDenied(error)) throw new HttpError(403, "access_denied");
      throw error;
    }
    result.push(reportFromAnswer(answerData(session, answer), student, String(period.L ?? "")));
  }
  return result;
};

/* ---- 0.12.0: pages of report cards or transcripts, results of the class ---- */

/** Largest number of report cards read in one page (one Pronote call per student). */
export const MAX_REPORTS = 40;

export const REPORT_SOURCES = ["reportcard", "transcript"] as const;
export type ReportSource = (typeof REPORT_SOURCES)[number];

const SOURCE_FUNCTION: Record<ReportSource, FunctionKey> = { reportcard: "reportCard", transcript: "transcript" };

export type ReportsPage = PartialRead<Report> & {
  available: boolean;
  reason: string;
  validated: false;
  source: ReportSource;
  total: number;
  offset: number;
  onglet?: number;
  space?: string;
};

/**
 * Page of report cards (or transcripts) of a class: one student, or [offset, offset + limit) of the roster. A refusal
 * of Pronote is answered available: false with the tab and the space, never bypassed. When the queue towards Pronote
 * is full, the students read so far are returned with "remaining" and "retry_after" (tolerant.ts readEach).
 */
export const reportsPage = async (
  session: SessionHandle,
  resourceId: string,
  periodId: string,
  page: StudentPage = {},
  source: ReportSource = "reportcard",
): Promise<ReportsPage> => {
  const fn = requireFunction(SOURCE_FUNCTION[source]);
  if (kindOf(resourceId) !== "class") throw new HttpError(409, "resource_not_class");
  const { resources } = userData(session);
  const classe = resolve("class", resourceId, resources.filter((item) => item.genre === GENRE_CLASS), (item) => item.label);
  const { periods } = await loadPeriods(session);
  const period = resolve("period", periodId, periods, periodKey);
  const { selected, offset, total } = pageOf(await rosterEntries(session, resourceId), page, MAX_REPORTS, 10);
  const base = { validated: false as const, source, total, offset };
  let denied = false;
  const read = await readEach(selected, async (student: RosterEntry): Promise<Report | null> => {
    if (denied) return null;
    try {
      const answer = await callPronote(session, {
        name: fn.name,
        data: {
          eleve: { N: student.pronoteId, G: GENRE_STUDENT, L: student.label },
          classe: { N: classe.id, G: GENRE_CLASS, L: classe.label },
          periode: { N: period.N, G: period.G, L: period.L },
        },
        signature: fn.onglet !== null ? { onglet: fn.onglet } : undefined,
      });
      return reportFromAnswer(answerData(session, answer), student, String(period.L ?? ""));
    } catch (error) {
      if (!isAccessDenied(error)) throw error;
      denied = true;
      return null;
    }
  });
  if (denied) {
    return { ...base, available: false, reason: "access_denied", ...deniedWhere(session, fn.onglet), items: [], read: [],
      remaining: [], partial: false, retry_after: 0 };
  }
  return { ...base, available: true, reason: "", ...read, items: read.items.filter((item): item is Report => item !== null) };
};

export type ClassResultsSubject = {
  /** Title of the column as Pronote writes it ("" when the answer names no column: see columnsUnnamed). */
  subject: string;
  /** Other lines of the title of the column: heading above (grouping) and line below, "" when absent. */
  heading: string;
  detail: string;
  teachers: string[];
  classAverage: number | null;
  min: number | null;
  max: number | null;
  /** 0.14.0, foot of the grid: median of the column and average of the group of the service. */
  median: number | null;
  groupAverage: number | null;
};

export type ClassResults = {
  available: boolean;
  reason: string;
  validated: false;
  class: { id: string; name: string };
  period: { id: string; name: string };
  subjects: ClassResultsSubject[];
  students: { studentid: string; label: string; average: number | null; rank: number | null;
    /** 0.14.0: late arrivals and half-days of absence of the period, as the grid shows them. */
    lateness: number | null; absenceHalfDays: number | null;
    /** One cell per column, in the order of "subjects" ("column" is its position). */
    averages: { subject: string; column: number; value: number | null; status: string }[];
    /** Lines of the sub-periods of the student, when the period asked is the year. */
    periods?: { period: string; average: number | null; rank: number | null }[] }[];
  /** General averages of the class (foot of the grid), when Pronote gives them. */
  general?: { average: number | null; min: number | null; max: number | null; median: number | null };
  /** The answer holds the cells but no title of column: subjects[].subject is "", never a guessed label. */
  columnsUnnamed?: true;
  shape?: string[];
  onglet?: number;
  space?: string;
};

const COLUMN_LISTS = ["listeColonnes", "ListeServices", "listeServices", "services", "listeMatieres", "colonnes"];
const LINE_LISTS = ["listeLignes", "ListeEleves", "listeEleves", "eleves", "lignes"];
const CELL_LISTS = ["listeMoyennes", "moyennes", "listeNotes", "listeCellules", "cellules", "listeColonnes", "ListeServices", "listeValeurs"];

const cellValue = (cell: unknown): unknown => {
  const raw = unwrap(cell);
  if (!isPlain(raw)) return raw;
  return member(raw, ["moyenne", "MoyenneEleve", "note", "valeur"]);
};

const NO_FOOT = { median: null, groupAverage: null, heading: "", detail: "" };

/** Table supposed before the first real answer (0.12.0): a list of columns and a list of lines. Kept as a second reading. */
const tableFromAnswer = (data: any, students: RosterEntry[]): Pick<ClassResults, "subjects" | "students"> | null => {
  const columns = listOf<any>(member(data, COLUMN_LISTS));
  const lines = listOf<any>(member(data, LINE_LISTS)).filter((line) => isPlain(line));
  if (columns.length === 0 || lines.length === 0) return null;
  const subjects = columns.map((column) => ({
    subject: subjectLabel(column) || textOf(member(column, ["matiere", "service"])),
    teachers: [...new Set(teachersOf(column))],
    classAverage: reportNumber(member(column, ["MoyenneClasse", "moyenne"])),
    min: reportNumber(member(column, ["MoyenneInf", "MoyenneMin", "min"])),
    max: reportNumber(member(column, ["MoyenneSup", "MoyenneMax", "max"])),
    ...NO_FOOT,
  }));
  if (subjects.every((item) => item.subject === "")) return null;
  const byPronoteId = new Map(students.map((entry) => [entry.pronoteId, entry]));
  const byLabel = new Map<string, RosterEntry | null>();
  for (const entry of students) byLabel.set(entry.label, byLabel.has(entry.label) ? null : entry);
  const rows: ClassResults["students"] = [];
  for (const line of lines) {
    const owner = (unwrap(member(line, ["eleve"])) ?? line) as any;
    const label = String(owner?.L ?? "").trim();
    if (label === "") continue;
    const entry = byPronoteId.get(String(owner?.N ?? "")) ?? byLabel.get(label) ?? null;
    const cells = listOf<any>(member(line, CELL_LISTS));
    const averages = subjects.map((subject, index) => {
      const named = cells.find((cell) => isPlain(unwrap(cell)) && (subjectLabel(unwrap(cell)) || textOf(member(unwrap(cell), ["matiere", "service"]))) === subject.subject);
      const value = cellValue(named ?? cells[index]);
      return { subject: subject.subject, column: index, value: reportNumber(value), status: reportStatus(value) };
    });
    rows.push({
      studentid: entry?.id ?? stableId("student", label),
      label,
      average: reportNumber(member(line, ["moyenneGenerale", "MoyenneEleve", "moyenne"])),
      rank: reportNumber(member(line, ["rang", "RangEleve"])),
      lateness: null,
      absenceHalfDays: null,
      averages,
    });
  }
  if (rows.length === 0) return null;
  return { subjects: subjects.filter((item) => item.subject !== ""), students: rows.map((row) => ({ ...row, averages: row.averages.filter((cell) => cell.subject !== "") })) };
};

/** Text of a title of column: Pronote writes some of them in HTML ("<div class=…>MATHS</div>", "&nbsp;"). */
export const titleText = (value: unknown): string =>
  textOf(value).replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, " ").trim();

/** Members that may hold the titles of the columns: the name the client reads first, then candidates. */
const TITLE_LISTS = ["titresColonnes", "listeColonnes", "colonnes", "services", "listeServices", "titres"];

const positive = (value: unknown): number | null => {
  const number = numberOf(value);
  return number !== null && number > 0 ? number : null;
};

/**
 * Grid of a real ResultatsClasses answer (first real check of 20/11/2026, read with the web client that displays it:
 * interfacepageresultatsclasses.js and donneesliste_resultatsclasse.js, PRONOTE 2026.2):
 * - resultats[]: one line per student and period (nom, rang, moyenneGenerale, nbRetard, demiJourneesAbs, ressource,
 *   lignePere, notesEleve[]). The line whose lignePere is 0 is the line of the student for the period asked; the others
 *   (only when the period is the year) are its sub-periods, attached to it. notesEleve[] follows the order of the
 *   columns: { ColMoy: { moyenne }, ColPos, ColAbs };
 * - titresColonnes[]: titles of the columns ({ ColMoy: { titre1, titre2, titre3, hint, estPere }, ColPos, ColAbs }). This
 *   member was cut out of the shape seen on 20/11 (60 lines): when it is missing, the columns stay unnamed;
 * - moyennes[]: foot of each column (moyenneService, noteMediane, noteHaute, noteBasse, moyenneGroupeService);
 * - moyenneGeneraleClasse, moyenneHauteClasse, moyenneBasseClasse, moyenneMedianeClasse.
 * numeroNational, dateNaissance, dernierEtablissement, redoublant, sexe and the support plans of a line are never read.
 */
const gridFromAnswer = (data: any, students: RosterEntry[]): Pick<ClassResults, "subjects" | "students" | "general" | "columnsUnnamed"> | null => {
  const rawRows = member(data, ["resultats"]);
  if (rawRows === undefined) return null;
  const rows = listOf<any>(rawRows).map(unwrap).filter(isPlain);
  const titles = listOf<any>(member(data, TITLE_LISTS)).map(unwrap);
  const foot = listOf<any>(member(data, ["moyennes"])).map(unwrap);
  const cellsOf = (row: Record<string, any>) => listOf<any>(member(row, ["notesEleve"])).map(unwrap);
  const width = Math.max(titles.length, foot.length, ...rows.map((row) => cellsOf(row).length), 0);
  const subjects: ClassResultsSubject[] = [];
  for (let index = 0; index < width; index++) {
    const title = titles[index];
    const column = (unwrap(member(title, ["ColMoy"])) ?? title) as unknown;
    const lines = [titleText(member(column, ["titre2"])), titleText(member(column, ["titre3"])), titleText(member(column, ["titre1"]))];
    const subject = lines[0] || titleText(member(column, ["hint"])) || (isPlain(column) ? subjectLabel(column) : "");
    subjects.push({
      subject,
      heading: lines[2],
      detail: lines[1] === subject ? "" : lines[1],
      teachers: [...new Set(teachersOf(title))],
      classAverage: reportNumber(member(foot[index], ["moyenneService"])),
      min: reportNumber(member(foot[index], ["noteBasse"])),
      max: reportNumber(member(foot[index], ["noteHaute"])),
      median: reportNumber(member(foot[index], ["noteMediane"])),
      groupAverage: reportNumber(member(foot[index], ["moyenneGroupeService"])),
    });
  }
  const byLabel = new Map<string, RosterEntry | null>();
  for (const entry of students) byLabel.set(entry.label, byLabel.has(entry.label) ? null : entry);
  // Lines of one student share "ressource"; without it, each line stands for itself.
  const groups = new Map<string, Record<string, any>[]>();
  rows.forEach((row, index) => {
    const key = row.ressource === undefined || row.ressource === null ? `#${index}` : `r${String(textOf(row.ressource) || index)}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  });
  const result: ClassResults["students"] = [];
  for (const lines of groups.values()) {
    const main = lines.find((line) => line.lignePere === 0) ?? lines[0];
    const label = textOf(member(main, ["nom"])) || textOf(main.L);
    if (label === "") continue;
    const entry = byLabel.get(label) ?? null;
    const cells = cellsOf(main);
    const periods = lines.filter((line) => line !== main).map((line) => ({ period: textOf(member(line, ["periode"])),
      average: reportNumber(member(line, ["moyenneGenerale"])), rank: positive(member(line, ["rang"])) }));
    result.push({
      studentid: entry?.id ?? stableId("student", label),
      label,
      average: reportNumber(member(main, ["moyenneGenerale"])),
      rank: positive(member(main, ["rang"])),
      lateness: numberOf(member(main, ["nbRetard"])),
      absenceHalfDays: numberOf(member(main, ["demiJourneesAbs"])),
      averages: subjects.map((subject, index) => {
        const cell = cells[index];
        const value = member(unwrap(member(cell, ["ColMoy"])) ?? cell, ["moyenne", "MoyenneEleve", "note", "valeur"]);
        return { subject: subject.subject, column: index, value: reportNumber(value), status: reportStatus(value) };
      }),
      ...(periods.length > 0 ? { periods } : {}),
    });
  }
  const general = { average: reportNumber(member(data, ["moyenneGeneraleClasse"])), min: reportNumber(member(data, ["moyenneBasseClasse"])),
    max: reportNumber(member(data, ["moyenneHauteClasse"])), median: reportNumber(member(data, ["moyenneMedianeClasse"])) };
  return {
    subjects,
    students: result,
    ...(Object.values(general).some((value) => value !== null) ? { general } : {}),
    ...(width > 0 && subjects.every((item) => item.subject === "") ? { columnsUnnamed: true as const } : {}),
  };
};

/**
 * Results of a class from a ResultatsClasses answer ("data" member), null when the shape is not understood: the real
 * grid first (gridFromAnswer), then the table supposed in 0.12.0.
 */
export const resultsFromAnswer = (
  data: any,
  students: RosterEntry[],
): Pick<ClassResults, "subjects" | "students" | "general" | "columnsUnnamed"> | null =>
  gridFromAnswer(data, students) ?? tableFromAnswer(data, students);

/**
 * Results of a class for a period, every subject (ResultatsClasses, tab 64). Decoded from the real shape of 20/11/2026
 * and from the web client; the titles of the columns and the values were never seen: validated: false.
 */
export const classResults = async (session: SessionHandle, resourceId: string, periodId: string): Promise<ClassResults> => {
  if (kindOf(resourceId) !== "class") throw new HttpError(409, "resource_not_class");
  const { resources } = userData(session);
  const classe = resolve("class", resourceId, resources.filter((item) => item.genre === GENRE_CLASS), (item) => item.label);
  const { periods } = await loadPeriods(session);
  const period = resolve("period", periodId, periods, periodKey);
  const periodIds = stableIds("period", periods, periodKey);
  const base: ClassResults = { available: false, reason: "", validated: false, class: { id: resourceId, name: classe.label },
    period: { id: periodIds[periods.indexOf(period)], name: String(period.L ?? "") }, subjects: [], students: [] };
  let data: Record<string, any>;
  try {
    data = await callFunction(session, "classResults", {
      classe: { N: classe.id, G: GENRE_CLASS, L: classe.label },
      periode: { N: period.N, G: period.G, L: period.L },
      absences: false,
      competences: false,
      afficherSousServices: false,
      afficherSeulementSousServices: false,
      masquerSansNotes: false,
      avecCouleurMoyenne: false,
    });
  } catch (error) {
    if (isAccessDenied(error)) return { ...base, reason: "access_denied", ...deniedWhere(session, functions.classResults.onglet) };
    throw error;
  }
  if (!data || Object.keys(data).length === 0) return { ...base, reason: "access_denied", ...deniedWhere(session, functions.classResults.onglet) };
  const read = resultsFromAnswer(data, await rosterEntries(session, resourceId));
  if (read === null) return { ...base, reason: "format_unknown", shape: shapeOf(data) };
  // Columns without title: the cells are returned by position, with the whole shape to find where the titles are.
  return { ...base, available: true, ...read, ...(read.columnsUnnamed ? { shape: shapeOf(data) } : {}) };
};
