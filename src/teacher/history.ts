/**
 * Results of the previous years of the students of a class (0.16.0): LivretScolaire (tab 83) and PageSuiviPluriannuel
 * (tab 44). GET /students/history, block "history" of the grouped read (collect.ts).
 *
 * What is known (GET /pp/check of 21/11/2026, no value seen): both requests answer ({ Classe, AvecDonneesClasse: true,
 * Eleve } and { eleve: { N } }); the multi-year page holds the report cards and averages of the past years. The members
 * of the answers were NOT read: the decoders are suppositions with candidate names, written from the report cards
 * (MoyenneEleve, MoyenneClasse, ListeAppreciations) and the tables of the web client. Three layouts are read:
 * - a list of years, each with its subjects;
 * - a list of subjects, each with one cell per year (the years named by the cells, or by a list of years beside);
 * - a list of subjects alone: one year (the school record of the current class).
 * Anything else is format_unknown with the shape of the answer, per source: one source not understood never hides the
 * other. The years of the two sources are merged by school year ("2025-2026").
 */
import type { SessionHandle } from "pawnote";
import { listOf } from "../pronote/encoding.js";
import { labelKey } from "../normalise.js";
import type { FunctionKey } from "./functions.js";
import { resolveResource, rosterEntries, type RosterEntry } from "./roster.js";
import { openSource, readStudentSource, type SourceOutcome, type StudentSource } from "./studentSource.js";
import { isPlain, member, numberOf, pageOf, readEach, textOf, unwrap, type PartialRead, type StudentPage } from "./tolerant.js";

/** Largest page of students (one Pronote call per student and per source). */
export const MAX_HISTORY_STUDENTS = 40;

export const HISTORY_SOURCES = ["livret", "multiyear"] as const;
export type HistorySource = (typeof HISTORY_SOURCES)[number];

const SOURCE_FUNCTION: Record<HistorySource, FunctionKey> = { livret: "schoolRecord", multiyear: "multiYear" };

export type HistorySubject = { subject: string; average: number | null; classAverage: number | null; comment: string };

export type HistoryYear = {
  /** School year "2025-2026", "" when the label of Pronote names none. */
  year: string;
  label: string;
  level: string;
  average: number | null;
  classAverage: number | null;
  subjects: HistorySubject[];
};

export type HistoryStudent = { studentid: string; label: string; sources: Record<HistorySource, SourceOutcome>; years: HistoryYear[] };

export type StudentHistory = PartialRead<HistoryStudent> & {
  available: boolean;
  reason: string;
  validated: false;
  class: { id: string; name: string };
  total: number;
  offset: number;
  /** State of each source after the page: the shape of an answer no decoder understands is here. */
  sources: Record<HistorySource, SourceOutcome>;
};

const WRAPPERS = ["livret", "livretScolaire", "suivi", "suiviPluriannuel", "donnees", "page"];
const YEARS = ["listeAnnees", "listeAnneesScolaires", "annees", "listeBulletins", "listeNiveaux", "listeClasses", "listeLivrets", "listeLivret"];
const SUBJECTS = ["listeMatieres", "listeServices", "listeDisciplines", "listeEnseignements", "matieres", "services", "listeLignes", "lignes"];
const CELLS = ["listeAnnees", "listeMoyennes", "moyennes", "listeColonnes", "colonnes", "listeValeurs", "valeurs", "listeNotes"];
const YEAR_LABEL = ["annee", "anneeScolaire", "libelleAnnee", "strAnnee", "millesime", "libelle"];
const LEVEL = ["niveau", "classe", "strClasse", "nomClasse", "libelleClasse", "formation"];
const SUBJECT = ["matiere", "service", "discipline", "enseignement"];
const AVERAGE = ["moyenneEleve", "moyEleve", "moyenne", "moyenneAnnuelle", "moyAnnuelle", "moyenneAnnuelleEleve", "note"];
const CLASS_AVERAGE = ["moyenneClasse", "moyClasse", "moyenneAnnuelleClasse", "moyenneGroupe", "moyGroupe"];
const GENERAL = ["moyenneGenerale", "moyGenerale", "moyenneGeneraleEleve", "moyGeneraleEleve", ...AVERAGE];
const GENERAL_CLASS = ["moyenneGeneraleClasse", "moyGeneraleClasse", ...CLASS_AVERAGE];
const COMMENT = ["appreciation", "appreciationAnnuelle", "commentaire", "avis"];
const COMMENTS = ["listeAppreciations", "appreciations"];

/** "2025-2026" of a label that names a school year ("Année 2025-2026", "2025/26"), "" otherwise. */
export const schoolYearOf = (label: string): string => {
  const match = /(?:^|\D)(20\d{2})\s*[-/–]\s*(?:20)?(\d{2})(?!\d)/.exec(label);
  if (!match) return "";
  const first = Number(match[1]);
  return Number(match[2]) === (first + 1) % 100 ? `${first}-${first + 1}` : "";
};

const isList = (value: unknown): boolean => value !== undefined && Array.isArray(unwrap(value));

const commentOf = (item: Record<string, any>): string =>
  textOf(member(item, COMMENT)) || listOf<unknown>(member(item, COMMENTS)).map((line) => textOf(line)).find((line) => line !== "") || "";

const subjectFrom = (value: unknown): HistorySubject | null => {
  const item = unwrap(value);
  if (!isPlain(item)) return null;
  const subject = textOf(item.L) || textOf(member(item, SUBJECT));
  if (subject === "") return null;
  return { subject, average: numberOf(member(item, AVERAGE)), classAverage: numberOf(member(item, CLASS_AVERAGE)), comment: commentOf(item) };
};

const yearLabelOf = (item: Record<string, any>): string => {
  const own = textOf(item.L);
  return schoolYearOf(own) !== "" ? own : (textOf(member(item, YEAR_LABEL)) || own);
};

/** Layout 1: a list of years, each with its subjects or at least an average. */
const fromYears = (root: Record<string, any>): HistoryYear[] | null => {
  const list = member(root, YEARS);
  if (!isList(list)) return null;
  const elements = listOf<unknown>(list).map(unwrap).filter(isPlain);
  const years: HistoryYear[] = [];
  for (const item of elements) {
    const subjects = member(item, SUBJECTS);
    const average = numberOf(member(item, GENERAL));
    if (!isList(subjects) && average === null) continue;
    const label = yearLabelOf(item);
    if (label === "") continue;
    years.push({ year: schoolYearOf(label), label, level: textOf(member(item, LEVEL)), average, classAverage: numberOf(member(item, GENERAL_CLASS)),
      subjects: listOf<unknown>(subjects).map(subjectFrom).filter((subject): subject is HistorySubject => subject !== null) });
  }
  // Elements, but none that is a year with results: the years of the columns of layout 2, or another shape.
  return elements.length > 0 && years.length === 0 ? null : years;
};

/** Layouts 2 and 3: a list of subjects, each with one cell per year, or alone (one year). */
const fromSubjects = (root: Record<string, any>): HistoryYear[] | null => {
  const list = member(root, SUBJECTS);
  if (!isList(list)) return null;
  const elements = listOf<unknown>(list).map(unwrap).filter(isPlain);
  const columns = listOf<unknown>(member(root, YEARS)).map((column) => {
    const item = unwrap(column);
    return isPlain(item) ? { label: yearLabelOf(item), level: textOf(member(item, LEVEL)), average: numberOf(member(item, GENERAL)),
      classAverage: numberOf(member(item, GENERAL_CLASS)) } : { label: textOf(column), level: "", average: null, classAverage: null };
  });
  const years = new Map<string, HistoryYear>();
  const yearOf = (label: string, column?: (typeof columns)[number]): HistoryYear => {
    let year = years.get(label);
    if (!year) {
      year = { year: schoolYearOf(label), label, level: column?.level ?? "", average: column?.average ?? null, classAverage: column?.classAverage ?? null, subjects: [] };
      years.set(label, year);
    }
    return year;
  };
  // The years named beside come first, in their order, even when no subject fills them.
  for (const column of columns) if (column.label !== "") yearOf(column.label, column);
  let named = 0;
  let flat = 0;
  for (const item of elements) {
    const subject = textOf(item.L) || textOf(member(item, SUBJECT));
    if (subject === "") continue;
    named++;
    const cells = member(item, CELLS);
    if (!isList(cells)) {
      flat++;
      continue;
    }
    listOf<unknown>(cells).forEach((cell, index) => {
      const raw = unwrap(cell);
      const plain = isPlain(raw) ? raw : null;
      const label = (plain ? yearLabelOf(plain) : "") || (columns[index]?.label ?? "");
      if (label === "") return;
      const average = plain ? numberOf(member(plain, AVERAGE)) : numberOf(raw);
      const classAverage = plain ? numberOf(member(plain, CLASS_AVERAGE)) : null;
      const comment = plain ? commentOf(plain) : "";
      if (average === null && classAverage === null && comment === "") return;
      yearOf(label, columns[index]).subjects.push({ subject, average, classAverage, comment });
    });
  }
  if (elements.length > 0 && named === 0) return null;
  if (flat > 0 && flat === named) {
    // Subjects alone: the results of one year, named by the answer when it names it.
    const label = textOf(member(root, YEAR_LABEL));
    return [{ year: schoolYearOf(label), label, level: textOf(member(root, LEVEL)), average: numberOf(member(root, GENERAL)),
      classAverage: numberOf(member(root, GENERAL_CLASS)),
      subjects: elements.map(subjectFrom).filter((subject): subject is HistorySubject => subject !== null) }];
  }
  // Cells that name no year (and no list of years beside): the subjects cannot be placed.
  if (named > 0 && years.size === 0) return null;
  return [...years.values()];
};

/**
 * Years of a LivretScolaire or PageSuiviPluriannuel answer ("data" member), null when the shape is not understood. A
 * known list that is empty is a student without past results.
 */
export const yearsFromAnswer = (data: unknown): HistoryYear[] | null => {
  if (!isPlain(data)) return null;
  const inner = unwrap(member(data, WRAPPERS));
  for (const root of [data, ...(isPlain(inner) ? [inner] : [])]) {
    const years = fromYears(root) ?? fromSubjects(root);
    if (years !== null) return years;
  }
  return null;
};

/** Years of several sources, the first source first: one entry per school year, what the first lacks filled by the next. */
export const mergeYears = (lists: HistoryYear[][]): HistoryYear[] => {
  const merged: HistoryYear[] = [];
  for (const list of lists) {
    for (const year of list) {
      const key = year.year || labelKey(year.label);
      const known = merged.find((item) => (item.year || labelKey(item.label)) === key);
      if (!known) {
        merged.push({ ...year, subjects: year.subjects.map((subject) => ({ ...subject })) });
        continue;
      }
      known.level = known.level || year.level;
      known.average = known.average ?? year.average;
      known.classAverage = known.classAverage ?? year.classAverage;
      for (const subject of year.subjects) {
        const same = known.subjects.find((item) => labelKey(item.subject) === labelKey(subject.subject));
        if (!same) known.subjects.push({ ...subject });
        else Object.assign(same, { average: same.average ?? subject.average, classAverage: same.classAverage ?? subject.classAverage, comment: same.comment || subject.comment });
      }
    }
  }
  // Most recent first; the years Pronote does not name keep their place after them.
  return [...merged.filter((year) => year.year !== "").sort((a, b) => b.year.localeCompare(a.year)), ...merged.filter((year) => year.year === "")];
};

const NOT_ASKED: SourceOutcome = { available: false, reason: "not_asked" };

/**
 * Past results of a page of students of a class or group, from the sources asked (both by default). A source Pronote
 * refuses is closed (no other call, nothing asked in its place); the other goes on. Unavailable when no source asked
 * answers. When the queue towards Pronote is full, the students read so far come back with "remaining" and "retry_after".
 */
export const studentHistory = async (
  session: SessionHandle,
  resourceId: string,
  page: StudentPage = {},
  asked: HistorySource[] = [],
): Promise<StudentHistory> => {
  const wanted = asked.length > 0 ? [...new Set(asked)] : [...HISTORY_SOURCES];
  const resource = resolveResource(session, resourceId);
  const { selected, offset, total } = pageOf(await rosterEntries(session, resourceId), page, MAX_HISTORY_STUDENTS, 10);
  const sources = new Map<HistorySource, StudentSource>();
  for (const name of wanted) sources.set(name, openSource(session, SOURCE_FUNCTION[name]));
  // The school record is the one of a class: for a group, the function is not asked.
  const livret = sources.get("livret");
  if (livret && resource.genre !== 1) livret.state = { available: false, reason: "resource_not_class" };
  const classe = { N: resource.id, G: 1, L: resource.label };
  const dataOf = (name: HistorySource, entry: RosterEntry): Record<string, unknown> => (name === "livret"
    ? { Classe: classe, AvecDonneesClasse: true, Eleve: { N: entry.pronoteId, G: 4, L: entry.label } }
    : { eleve: { N: entry.pronoteId } });
  const states = (): Record<HistorySource, SourceOutcome> => ({ livret: sources.get("livret")?.state ?? NOT_ASKED, multiyear: sources.get("multiyear")?.state ?? NOT_ASKED });
  const open = () => [...sources.values()].some((source) => source.state.available);
  const base = { validated: false as const, class: { id: resourceId, name: resource.label }, total, offset };

  const read = await readEach(selected, async (entry): Promise<HistoryStudent | null> => {
    if (!open()) return null;
    const outcomes: Record<HistorySource, SourceOutcome> = { livret: NOT_ASKED, multiyear: NOT_ASKED };
    const lists: HistoryYear[][] = [];
    for (const [name, source] of sources) {
      const one = await readStudentSource(session, source, dataOf(name, entry), yearsFromAnswer, []);
      // The shape of a closed source is given once, by the page: not repeated in every student.
      outcomes[name] = one.value === null && !source.state.available ? { available: false, reason: one.outcome.reason } : one.outcome;
      if (one.value !== null) lists.push(one.value);
    }
    return open() || lists.length > 0 ? { studentid: entry.id, label: entry.label, sources: outcomes, years: mergeYears(lists) } : null;
  });
  const items = read.items.filter((item): item is HistoryStudent => item !== null);
  if (!open() && items.length === 0) {
    const first = [...sources.values()][0]?.state ?? NOT_ASKED;
    return { ...base, available: false, reason: first.reason || "access_denied", sources: states(), items: [], read: [], remaining: [],
      partial: false, retry_after: 0 };
  }
  // A student after whom every source closed has no item: not counted as read.
  return { ...base, available: true, reason: "", sources: states(), ...read, items, read: items.map((item) => item.studentid) };
};
