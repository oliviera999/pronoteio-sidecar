/**
 * Absences and late arrivals of a class, every subject, in ONE call (0.16.0): RecapAbsencesEleves, tab 138 of the web
 * Espace Professeurs. GET /classlife/absences, block "absences" of the grouped read (collect.ts).
 *
 * Shape recorded on 22/11/2026 (docs/olutionsuivi/formes/lifeAbsencesRecap.txt, names and types, no value): with the
 * request { classes, regimes, bourses, criteres: {}, domaine } the answer holds NO line (ListeLignes is an empty list)
 * and the totals of the class only: LigneCumul { nbEleves, nbAbsences, dureeTotale, nbRetards, minutesRetardTotal,
 * tauxAbsenteismeTotal… }. They are returned as "classTotals", with reason "totals_only" and no item. The request
 * probably needs criteria to list the students: none is invented here.
 *
 * The members of a line by student were therefore NEVER seen: the decoder of the lines is a supposition, written from
 * the names of LigneCumul (the same numbers, by student), from the summary of a student (RecapitulatifVSEleve,
 * classlife.ts) and from the tables of the web client, with lists of candidate names:
 * - a line is a student: an element under "eleve" (or the line itself) whose N or label is in the roster; lines nested
 *   in a line that is not a student (a class that unfolds) are read too;
 * - its numbers are members of the line (nbAbsences, dureeTotale, nbRetards…) or cells ("colonnes": { L, valeur,
 *   estUneDuree }, as the summary of a student), the titles of the cells being those of the columns of the table when
 *   the cells carry none;
 * - its dated events, if any, are a list of the line read as the call sheets are (classlife.ts eventFromItem).
 * A function that only gives numbers answers available: true, reason: "totals_only", events: []. Anything else is
 * format_unknown with the shape of the answer: that is what lets the decoder be corrected without access to Pronote.
 * Reasons of the absences never leave: they speak of health.
 */
import { translateToWeekNumber, type SessionHandle } from "pawnote";
import { HttpError } from "../errors.js";
import { listOf } from "../pronote/encoding.js";
import { labelKey, splitDisplayName, type LocalTimes } from "../normalise.js";
import { epochToWall } from "../time.js";
import { eventFromItem, mergeEvents } from "./classlife.js";
import { callFunction, functions } from "./functions.js";
import { resolveResource, rosterEntries, type RosterEntry } from "./roster.js";
import { shapeOf } from "./shape.js";
import { schoolYearRange } from "./studentSource.js";
import { boolOf, deniedWhere, hoursOf, isAccessDenied, isPlain, member, numberOf, textOf, unwrap } from "./tolerant.js";

export type AbsenceTotals = {
  absences: number | null;
  absenceHalfDays: number | null;
  unjustifiedAbsences: number | null;
  lateness: number | null;
  missedHours: number | null;
};

/** Totals of a class (LigneCumul): students counted, absences, hours missed, late arrivals and their minutes, rate. */
export type ClassTotals = {
  students: number | null;
  absences: number | null;
  missedHours: number | null;
  lateness: number | null;
  latenessMinutes: number | null;
  absenteeismRate: number | null;
};

export type AbsenceEvent = {
  id: string;
  kind: "absence" | "lateness";
  start: number;
  end: number;
  local: LocalTimes;
  justified: boolean | null;
  halfDays: number | null;
  hours: number | null;
  minutes: number | null;
  subject: string;
  /** Always empty: the reasons of an absence are not read by this route. */
  reasons: string[];
};

export type AbsenceStudent = {
  studentid: string;
  label: string;
  lastname: string;
  firstname: string;
  totals: AbsenceTotals;
  events: AbsenceEvent[];
  bySubject: { subject: string; hours: number | null; lateness: number | null }[];
};

export type ClassAbsences = {
  available: boolean;
  /** "", totals_only (numbers without dates), access_denied, format_unknown. */
  reason: string;
  validated: false;
  class: { id: string; name: string };
  from: number;
  to: number;
  shape?: string[];
  onglet?: number;
  space?: string;
  /**
   * Totals of the whole class as Pronote counts them (LigneCumul), null when the answer gives none. Recorded on
   * 22/11/2026: the only numbers the function gives with the request sent.
   */
  classTotals: ClassTotals | null;
  /** Students of the class, and lines of the answer that name no student of it. */
  total: number;
  unmatched: number;
  /** One item per student who has a line in the answer of Pronote, in roster order. */
  items: AbsenceStudent[];
};

const GENRE_CLASS = 1;
const TYPE_LIST = 24;
const TYPE_DOMAIN = 8;
/** Weeks of a school year in a Pronote domain. */
const MAX_WEEK = 62;

const LINES = ["ListeLignes", "lignes", "listeEleves", "liste"];
const NESTED = ["ListeLignes", "lignes", "listeEleves", "listeFils", "fils"];
const STUDENT = ["eleve", "ressource", "individu"];
const TITLES = ["listeColonnes", "colonnes", "listeTitres", "titres"];
const CELLS = ["colonnes", "listeColonnes", "cellules", "listeCellules", "valeurs", "listeValeurs", "listeTotal", "listeTotaux"];
const SUBJECTS = ["listeMatieres", "listeMatiere", "matieres", "listeServices"];
/** Lists of dated events of a line, with the school life genre of their elements that carry none (13 absence, 14 late). */
const EVENTS: [string[], number][] = [
  [["listeAbsences", "listeEvenements", "listeDetails", "details", "listeAbsencesRetards"], 13],
  [["listeRetards"], 14],
];

const DIRECT: Record<keyof AbsenceTotals, string[]> = {
  absences: ["nbAbsences", "nombreAbsences", "NbrAbsences", "nbAbs", "absences"],
  absenceHalfDays: ["nbDJAbsence", "nbDemiJournees", "NbrDemiJournees", "nbDJ", "demiJournees", "nbDJBulletin"],
  unjustifiedAbsences: ["nbAbsencesInjustifiees", "nbAbsInjustifiees", "nbInjustifiees", "nbAbsNonJustifiees", "nbNonJustifiees", "absencesInjustifiees"],
  lateness: ["nbRetards", "nombreRetards", "NbrRetards", "retards"],
  // dureeTotale: the name recorded in LigneCumul; the others are supposed.
  missedHours: ["dureeTotale", "nbHeures", "NbrHeures", "nbHeuresManquees", "heuresManquees", "heuresCoursManquees", "nbHeuresCoursManquees"],
};

/** Hours of a duration whose format was not seen: a number, "12h30" or "12,5"; null for anything else (never a guess). */
const strictHours = (value: unknown): number | null => {
  const raw = unwrap(value);
  if (typeof raw === "number") return hoursOf(raw);
  return typeof raw === "string" && /^\s*\d+(\s*h\s*\d{0,2}|[.,]\d+)?\s*$/i.test(raw) ? hoursOf(raw.trim().replace(/h$/i, "h00")) : null;
};

/** Totals of the class from the answer (recorded names of LigneCumul), null when it has none. */
export const classTotalsOf = (data: unknown): ClassTotals | null => {
  const line = unwrap(member(data, ["LigneCumul"]));
  if (!isPlain(line)) return null;
  const totals: ClassTotals = {
    students: numberOf(member(line, ["nbEleves"])),
    absences: numberOf(member(line, ["nbAbsences"])),
    // A string whose format was not seen: read when it is a duration ("12h30") or a number, null otherwise.
    missedHours: strictHours(member(line, ["dureeTotale"])),
    lateness: numberOf(member(line, ["nbRetards"])),
    latenessMinutes: numberOf(member(line, ["minutesRetardTotal"])),
    absenteeismRate: numberOf(member(line, ["tauxAbsenteismeTotal"])),
  };
  return Object.values(totals).some((value) => value !== null) ? totals : null;
};

const round = (value: number): number => Math.round(value * 100) / 100;

const noTotals = (): AbsenceTotals => ({ absences: null, absenceHalfDays: null, unjustifiedAbsences: null, lateness: null, missedHours: null });

/** Total a titled number belongs to, null when it is none of the five (meals, boarding school, punishments…). */
export const totalField = (label: string, item: Record<string, any> = {}): keyof AbsenceTotals | null => {
  const key = labelKey(label);
  if (key === "") {
    // No title: the genre of the event (7 absence, 8 late arrival in the summary of a student), else the school life
    // genre of the element (13 absence, 14 late arrival).
    if (item.genreEvenementVS === 7 || (item.genreEvenementVS === undefined && item.G === 13)) return "absences";
    if (item.genreEvenementVS === 8 || (item.genreEvenementVS === undefined && item.G === 14)) return "lateness";
    return null;
  }
  if (/repas|internat|demi pension|punition|sanction|exclu|infirmerie|dispense/.test(key)) return null;
  if (/retard/.test(key)) return "lateness";
  if (/heure|cours manqu/.test(key)) return "missedHours";
  const halfDays = /demi|\bdj\b/.test(key);
  if (/injustifi|non justifi/.test(key)) return halfDays ? null : "unjustifiedAbsences";
  if (halfDays) return "absenceHalfDays";
  return /absence/.test(key) ? "absences" : null;
};

/** Numbers of a line or of a subject: its own members first, then its cells (titled by themselves or by the columns). */
const totalsOfLine = (line: Record<string, any>, titles: string[]): { totals: AbsenceTotals; found: boolean } => {
  const totals = noTotals();
  let found = false;
  const set = (field: keyof AbsenceTotals, value: number | null) => {
    if (value === null || totals[field] !== null) return;
    totals[field] = round(value);
    found = true;
  };
  for (const field of Object.keys(DIRECT) as (keyof AbsenceTotals)[]) {
    const raw = member(line, DIRECT[field]);
    // A list under the same name ("absences": [...]) is not a number.
    if (raw !== undefined && !Array.isArray(unwrap(raw))) set(field, field === "missedHours" ? hoursOf(raw) : numberOf(raw));
  }
  listOf<unknown>(member(line, CELLS)).forEach((cell, index) => {
    const item = unwrap(cell);
    const plain = isPlain(item) ? item : {};
    const label = textOf(plain.L) || (titles[index] ?? "");
    const field = totalField(label, plain);
    if (field === null) return;
    const raw = isPlain(item) ? member(item, ["valeur", "nombre", "nb"]) : item;
    // A duration is a fraction of a day in the web client (classlife.ts officialCount): 0.125 is 3 hours.
    const duration = boolOf(member(plain, ["estUneDuree"])) === true;
    const value = field === "missedHours" ? (duration ? ((numberOf(raw) ?? NaN) * 24) : hoursOf(raw)) : numberOf(raw);
    set(field, value === null || Number.isNaN(value) ? null : value);
    if (field === "absences") set("absenceHalfDays", numberOf(member(plain, ["nbDJAbsence"])));
  });
  return { totals, found };
};

type Line = { entry: RosterEntry; line: Record<string, any> };

/** Lines that name a student of the roster, lines nested in the others included; the others are counted. */
const studentLines = (lines: unknown[], entries: RosterEntry[]): { found: Line[]; unmatched: number } => {
  const byPronote = new Map(entries.filter((entry) => entry.pronoteId !== "").map((entry) => [entry.pronoteId, entry]));
  const byLabel = new Map<string, RosterEntry | null>();
  // Two students with the same name are never matched by their name.
  for (const entry of entries) byLabel.set(labelKey(entry.label), byLabel.has(labelKey(entry.label)) ? null : entry);
  const found: Line[] = [];
  let unmatched = 0;
  const entryOf = (line: Record<string, any>): RosterEntry | undefined => {
    for (const candidate of [unwrap(member(line, STUDENT)), line]) {
      if (!isPlain(candidate)) continue;
      const entry = byPronote.get(String(candidate.N ?? "")) ?? byLabel.get(labelKey(textOf(candidate.L)));
      if (entry) return entry;
    }
    const name = [textOf(member(line, ["nom"])), textOf(member(line, ["prenom"]))].filter(Boolean).join(" ");
    return name === "" ? undefined : (byLabel.get(labelKey(name)) ?? undefined);
  };
  const walk = (list: unknown[], depth: number): void => {
    for (const value of list) {
      const line = unwrap(value);
      if (!isPlain(line)) continue;
      const entry = entryOf(line);
      if (entry) {
        found.push({ entry, line });
        continue;
      }
      const nested = member(line, NESTED);
      if (nested !== undefined && depth < 3) walk(listOf<unknown>(nested), depth + 1);
      else if (boolOf(member(line, ["estCumul", "estTotal", "estUnDeploiement"])) !== true) unmatched++;
    }
  };
  walk(lines, 0);
  return { found, unmatched };
};

export type RecapRead = { items: AbsenceStudent[]; dated: boolean; unmatched: number };

/**
 * Students of a RecapAbsencesEleves answer ("data" member) between two instants, null when the shape is not understood:
 * no list of lines, or lines in which neither a student of the roster nor a number nor a list of events is recognised.
 */
export const absencesFromRecap = (data: unknown, entries: RosterEntry[], fromEpoch: number, toEpoch: number): RecapRead | null => {
  const list = member(data, LINES);
  if (list === undefined || !Array.isArray(unwrap(list))) return null;
  const lines = listOf<unknown>(list);
  if (lines.length === 0) return { items: [], dated: false, unmatched: 0 };
  const titles = listOf<unknown>(member(data, TITLES)).map((title) => textOf(title));
  const { found, unmatched } = studentLines(lines, entries);
  let dated = false;
  let understood = false;
  const byStudent = new Map<string, AbsenceStudent>();
  for (const { entry, line } of found) {
    const raws: NonNullable<ReturnType<typeof eventFromItem>>[] = [];
    let lineDated = false;
    for (const [names, genre] of EVENTS) {
      const events = member(line, names);
      if (events === undefined || !Array.isArray(unwrap(events))) continue;
      lineDated = true;
      dated = true;
      understood = true;
      for (const item of listOf<unknown>(events)) {
        const event = eventFromItem(item, "recap", { genre });
        if (event && (event.kind === "absence" || event.kind === "lateness")) raws.push(event);
      }
    }
    const events: AbsenceEvent[] = mergeEvents(entry.id, raws, ["absences", "lateness"], fromEpoch, toEpoch).map((event) => ({
      id: event.id, kind: event.kind as "absence" | "lateness", start: event.start, end: event.end, local: event.local,
      justified: event.justified, halfDays: event.halfDays, hours: event.hours, minutes: event.minutes, subject: event.subject, reasons: [] }));
    const own = totalsOfLine(line, titles);
    understood = understood || own.found;
    const bySubject = listOf<unknown>(member(line, SUBJECTS)).map((value) => {
      const item = unwrap(value);
      if (!isPlain(item)) return null;
      const read = totalsOfLine(item, titles);
      understood = understood || read.found;
      return { subject: textOf(item.L) || textOf(member(item, ["matiere", "service"])), hours: read.totals.missedHours, lateness: read.totals.lateness };
    }).filter((item): item is AbsenceStudent["bySubject"][number] => item !== null && (item.subject !== "" || item.hours !== null || item.lateness !== null));
    const absences = events.filter((event) => event.kind === "absence");
    const hours = absences.filter((event) => event.hours !== null);
    // The numbers of Pronote first; what it does not count is counted on the dated events, when there are some.
    const counted: AbsenceTotals = !lineDated ? noTotals() : {
      absences: absences.length,
      absenceHalfDays: round(absences.reduce((sum, event) => sum + (event.halfDays ?? 0), 0)),
      unjustifiedAbsences: absences.filter((event) => event.justified === false).length,
      lateness: events.filter((event) => event.kind === "lateness").length,
      missedHours: hours.length === 0 ? null : round(hours.reduce((sum, event) => sum + (event.hours ?? 0), 0)),
    };
    const totals = Object.fromEntries((Object.keys(counted) as (keyof AbsenceTotals)[]).map((field) => [field, own.totals[field] ?? counted[field]])) as AbsenceTotals;
    const name = splitDisplayName(entry.label);
    const previous = byStudent.get(entry.id);
    // Two lines for one student (one per kind, or per class of a group): events added, first numbers kept.
    if (previous) {
      previous.events = [...previous.events, ...events.filter((event) => !previous.events.some((known) => known.id === event.id))].sort((a, b) => a.start - b.start);
      for (const field of Object.keys(totals) as (keyof AbsenceTotals)[]) previous.totals[field] = previous.totals[field] ?? totals[field];
      previous.bySubject.push(...bySubject);
    } else {
      byStudent.set(entry.id, { studentid: entry.id, label: entry.label, lastname: name.lastname, firstname: name.firstname, totals, events, bySubject });
    }
  }
  if (!understood) return null;
  const items = entries.map((entry) => byStudent.get(entry.id)).filter((item): item is AbsenceStudent => item !== undefined);
  return { items, dated, unmatched };
};

/** Weeks of the school year that hold a range of wall dates, as a Pronote domain ("[3..12]"). */
const weeksDomain = (session: SessionHandle, from: Date, to: Date): { _T: number; V: string } => {
  const firstMonday = (session.instance as { firstMonday?: unknown } | undefined)?.firstMonday;
  if (!(firstMonday instanceof Date)) return { _T: TYPE_DOMAIN, V: `[1..${MAX_WEEK}]` };
  const first = Math.min(MAX_WEEK, Math.max(1, translateToWeekNumber(from, firstMonday)));
  const last = Math.min(MAX_WEEK, Math.max(first, translateToWeekNumber(new Date(to.getTime() - 1), firstMonday)));
  return { _T: TYPE_DOMAIN, V: `[${first}..${last}]` };
};

/**
 * Absences and late arrivals of the students of a class between two instants (seconds; the school year by default).
 * One call to Pronote, sent with the weeks that hold the range; a refusal is answered available: false with the tab,
 * never bypassed: no other function is asked in its place.
 */
export const classAbsences = async (session: SessionHandle, resourceId: string, fromEpoch?: number, toEpoch?: number): Promise<ClassAbsences> => {
  const resource = resolveResource(session, resourceId);
  if (resource.genre !== GENRE_CLASS) throw new HttpError(409, "resource_not_class");
  const year = schoolYearRange(session);
  const from = fromEpoch ?? year.from;
  const to = toEpoch ?? Math.max(year.to, from + 1);
  const base: ClassAbsences = { available: false, reason: "", validated: false, class: { id: resourceId, name: resource.label }, from, to,
    classTotals: null, total: 0, unmatched: 0, items: [] };
  const refused = (): ClassAbsences => ({ ...base, reason: "access_denied", ...deniedWhere(session, functions.lifeAbsencesRecap.onglet) });
  let data: Record<string, any>;
  try {
    data = await callFunction(session, "lifeAbsencesRecap", {
      classes: { _T: TYPE_LIST, V: [{ N: resource.id, G: GENRE_CLASS, L: resource.label }] },
      regimes: { _T: TYPE_LIST, V: [] },
      bourses: { _T: TYPE_LIST, V: [] },
      criteres: {},
      domaine: weeksDomain(session, epochToWall(from), epochToWall(to)),
    });
  } catch (error) {
    if (isAccessDenied(error)) return refused();
    throw error;
  }
  if (!data || Object.keys(data).length === 0) return refused();
  const entries = await rosterEntries(session, resourceId);
  const read = absencesFromRecap(data, entries, from, to);
  if (read === null) return { ...base, total: entries.length, reason: "format_unknown", shape: shapeOf(data) };
  const classTotals = classTotalsOf(data);
  // Numbers without dates: those of the students, or (shape recorded on 22/11/2026: no line) those of the class alone.
  const totalsOnly = !read.dated && (read.items.length > 0 || classTotals !== null);
  return { ...base, available: true, reason: totalsOnly ? "totals_only" : "", classTotals, total: entries.length, unmatched: read.unmatched,
    items: read.items };
};
