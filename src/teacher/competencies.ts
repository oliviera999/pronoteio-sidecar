/**
 * Skills assessments ("évaluations par compétences") of the teacher's services, read only.
 *
 * NOT VALIDATED ON THE DEMO SERVER: its teacher profile does not open the skills tabs (65, 56) and Pronote refuses
 * the functions whatever the tab sent. Request and answer shapes come from the web client code (see
 * docs/pronote-matrice/2-3-notes-competences.md in mood_prod): ListeEvaluations { service, ressource, periode } →
 * listeEvaluations[], then PageCompetencesParEvaluation { evaluation, devoir, ressource, periodeEvaluation } →
 * ListeElevesCompetences[]. A refusal ("droits insuffisants") or an empty answer gives available: false.
 *
 * 0.8.0: the services come from both tabs (grade entry, tab 23, and skills, tab 65: ListeServices with the signature
 * of tab 65), so that a "collège" group assessed by skills only is read; each assessment gives its coefficient, its
 * "bilan de cycle" flag, its publication to parents and the domain code and number of its skills ("D2", "4.1"); the
 * referential of a service (ListePiliers and listeReferentielsUniques) is read on demand. Still NOT VALIDATED.
 *
 * 0.13.0, from the code of the web client (interfacepagelisteevaluations.js, objetrequetepagecompetencesparevaluation.js,
 * parametres.js; first real try of 20/11/2026):
 * - the assessments of ONE service, class or group and period are those of "Saisie des évaluations" (tab 56): on tab 65
 *   ("Liste des évaluations") the client sends neither service nor resource and Pronote answers every assessment of the
 *   teacher, which is what the sidecar received for two different groups. ListeEvaluations is now signed with tab 56;
 *   when Pronote refuses it, the list of tab 65 is read instead. In both cases an assessment is kept only when its own
 *   class or group (member "classe") is the one asked, and its levels are read with that class (as the client does);
 * - two assessments with the same date and title in one group get distinct ids ("~2");
 * - the levels of the school are General.ListeNiveauxDAcquisitions of FonctionParametres (see userdata.ts): "levels"
 *   gives the active mastery levels only, "statuses" the active annotations (absent, not assessed, exempted, not
 *   handed in), "levelsSource" says whether they are the school's ("school") or the client enumeration ("fallback").
 */
import { ServerSideError, type SessionHandle } from "pawnote";
import { listOf, parseNumberSet, parsePronoteDate } from "../pronote/encoding.js";
import { userData } from "../pronote/userdata.js";
import { HttpError } from "../errors.js";
import {
  labelKey,
  matchesLabels,
  normalise,
  seconds,
  type AcquisitionLevel,
  type CompetencyItem,
  type CompetencyOverview,
  type CompetencyRating,
  type CompetencySkill,
  type ReferentialItem,
  type Service,
} from "../normalise.js";
import { localTimes } from "../normalise.js";
import { legacySeconds } from "../time.js";
import {
  call,
  describeService,
  loadAllServices,
  pickPeriod,
  ref,
  resolveService,
  resourceOf,
  resourceType,
  serviceIdsOf,
  type Element,
  type MergedService,
} from "./grades.js";
import { stableId, stableIds } from "./ids.js";
import { isTabClosed, requireFunction } from "./functions.js";
import { currentContext } from "../context.js";
import { spaceOf, WebSessionRequired } from "../space.js";

/**
 * 0.10.0: skills read or written in the session that opens their tabs. On a mobile session lacking the skills tabs (65,
 * 56), WebSessionRequired before any call (the request is replayed on the web session, see space.ts); elsewhere nothing.
 */
export const ensureSkillsSpace = (session: SessionHandle): void => {
  // 0.13.0: "Saisie des évaluations" (tab 56) carries the list of a service, the levels and the writes.
  isTabClosed(session, "competencyList");
  isTabClosed(session, "competencyPage");
};

/** Tab and space of a refusal of the skills functions (0.10.0), added to available: false. */
const deniedWhere = (session: SessionHandle, onglet: number | null) => ({
  ...(onglet !== null ? { onglet } : {}),
  ...(spaceOf(session) ? { space: spaceOf(session) as string } : {}),
});

/** Largest number of assessments whose levels are read in one call. */
export const MAX_ITEMS = 30;

/** EGenreNiveauDAcquisition of the client, used when the school's list was not received at login. */
export const DEFAULT_LEVELS: { code: number; name: string }[] = [
  { code: 1, name: "Expert" },
  { code: 2, name: "Acquis" },
  { code: 3, name: "Presque acquis" },
  { code: 4, name: "En cours d'acquisition" },
  { code: 5, name: "Début d'acquisition" },
  { code: 6, name: "Non acquis" },
  { code: 7, name: "Absent" },
  { code: 8, name: "Non évalué" },
  { code: 9, name: "Dispensé" },
  { code: 10, name: "Non rendu" },
];

/** First genre of the annotations (Absent 7, Non évalué 8, Dispensé 9, Non rendu 10): not mastery levels. */
export const FIRST_STATUS = 7;

/** TypeGenreValidationCompetence.tGVC_EvaluationEtItem: a level usable in an assessment has it in "actifPour". */
const ACTIVE_FOR_ASSESSMENTS = 0;

export const isAccessDenied = (error: unknown): boolean =>
  error instanceof ServerSideError && /droits|insuffisant/i.test(error.message);

const unwrap = (value: unknown): unknown =>
  value !== null && typeof value === "object" && "V" in (value as object) ? (value as { V: unknown }).V : value;

const numberOrNull = (value: unknown): number | null => {
  const raw = unwrap(value);
  if (raw === null || raw === undefined || raw === "") return null;
  const number = Number.parseFloat(String(raw).replace(",", "."));
  return Number.isFinite(number) ? number : null;
};

/** A Pronote identifier that designates a stored object ("16#…"): the "none" entry of the list has "0". */
const hasNumber = (value: unknown): boolean => typeof value === "string" && /^\d{1,3}#/.test(value);

/**
 * One level of General.ListeNiveauxDAcquisitions: genre (G), label, abbreviation, colour, weighting ("ponderation"),
 * points for the brevet, LSU positionings, and whether the school lets it be used in assessments (actifPour holds 0).
 * A list without "actifPour" (older server) gives every level as active.
 */
export const levelFromRaw = (item: any): AcquisitionLevel => {
  const activeFor = item?.actifPour === undefined ? null : parseNumberSet(item.actifPour);
  const code = Number(item?.G);
  return {
    code,
    name: String(item?.L ?? "").trim(),
    abbreviation: String(unwrap(item?.abbreviation) ?? "").trim(),
    color: String(unwrap(item?.couleur) ?? "").trim(),
    active: activeFor === null ? true : activeFor.includes(ACTIVE_FOR_ASSESSMENTS),
    status: code >= FIRST_STATUS,
    points: numberOrNull(item?.ponderation),
    brevetPoints: numberOrNull(item?.nombrePointsBrevet),
    positions: listOf<any>(item?.listePositionnements)
      .filter((position) => position && typeof position === "object")
      .map((position) => ({
        kind: Number(position.G ?? 0),
        name: String(position.L ?? "").trim(),
        abbreviation: String(unwrap(position.abbreviation) ?? "").trim(),
      })),
  };
};

/** Raw levels of the school that designate a real level (genre 1 and above, with an identifier). */
export const rawSchoolLevels = (session: SessionHandle): any[] =>
  listOf<any>(userData(session).acquisitionLevels)
    .filter((item) => item && typeof item === "object" && Number.isFinite(Number(item.G)) && Number(item.G) >= 1 && hasNumber(item.N));

export type LevelsOf = { source: "school" | "fallback"; all: AcquisitionLevel[] };

/**
 * Levels of the school (captured at login), else the client enumeration with source "fallback": the codes of the
 * enumeration are the genres of the client, not the levels the school enabled, so nothing is written with them.
 */
export const levelsOf = (session: SessionHandle): LevelsOf => {
  const raw = rawSchoolLevels(session);
  if (raw.length) return { source: "school", all: raw.map(levelFromRaw) };
  if (listOf(userData(session).acquisitionLevels).length === 0) {
    const context = currentContext();
    if (context && !context.shape) context.shape = "levels:missing";
  }
  return {
    source: "fallback",
    all: DEFAULT_LEVELS.map(({ code, name }) => ({
      code, name, abbreviation: "", color: "", active: true, status: code >= FIRST_STATUS, points: null, brevetPoints: null, positions: [],
    })),
  };
};

/** Members of an overview: active mastery levels, active annotations, and where they come from. */
export const levelMembers = (session: SessionHandle): Pick<CompetencyOverview, "levels" | "statuses" | "levelsSource"> => {
  const { source, all } = levelsOf(session);
  const active = all.filter((level) => level.active);
  return {
    levels: active.filter((level) => !level.status),
    statuses: active.filter((level) => level.status),
    levelsSource: source,
  };
};

const text = (value: unknown): string => {
  const raw = value !== null && typeof value === "object" && "V" in (value as object) ? (value as { V: unknown }).V : value;
  return typeof raw === "string" ? raw.trim() : "";
};

/** Levels given in one assessment (PageCompetencesParEvaluation answer, "data" member). */
/** Member names of an object (never its values), sorted, for the access log of an answer not understood. */
const memberNames = (value: unknown): string =>
  value && typeof value === "object" ? Object.keys(value).filter((key) => /^[\w$]{1,40}$/.test(key)).sort().slice(0, 20).join(",") : "";

/** Students listed beside the levels (listeEleves…), by id: the label of a level row may only give the id. */
export const studentNamesOf = (data: Record<string, any> | null | undefined): Map<string, string> => {
  const names = new Map<string, string>();
  for (const list of [data?.listeEleves, data?.ListeEleves, data?.eleves, data?.listeRessources]) {
    for (const item of listOf<any>(list)) {
      const label = String(item?.L ?? item?.Libelle ?? "").trim();
      if (typeof item?.N === "string" && label) names.set(item.N, label);
    }
  }
  return names;
};

/**
 * Label of the student of a level row (0.11.5): L, then eleve/Eleve (wrapped or not), libelle, nom + prénom, then the
 * students listed beside (by id). Case of 20/11/2026: the web space answered rows without L nor eleve.V.L, every level
 * came without a student. When nothing is found, the member names of the row go to the access log (never values).
 */
export const studentLabelOf = (student: any, names: Map<string, string>, data?: Record<string, any>): string => {
  const wrapped = (value: any) => (value && typeof value === "object" && "V" in value ? value.V : value);
  const eleve = wrapped(student?.eleve) ?? wrapped(student?.Eleve);
  const direct = [student?.L, eleve?.L, student?.libelle, student?.Libelle, eleve?.Libelle,
    [student?.nom ?? student?.Nom, student?.prenom ?? student?.Prenom].filter(Boolean).join(" ")]
    .map((value) => String(value ?? "").trim())
    .find(Boolean);
  const label = direct ?? names.get(String(student?.N ?? "")) ?? names.get(String(eleve?.N ?? "")) ?? "";
  if (!label) {
    const context = currentContext();
    if (context && !context.shape) context.shape = `student:${memberNames(student)};eleve:${memberNames(eleve)};page:${memberNames(data)}`;
  }
  return label;
};

export const ratingsFromPage = (data: Record<string, any>, skillIds: Map<string, string>): CompetencyRating[] => {
  const result: CompetencyRating[] = [];
  const names = studentNamesOf(data);
  for (const student of listOf<any>(data?.ListeElevesCompetences)) {
    const label = studentLabelOf(student, names, data);
    for (const item of listOf<any>(student?.ListeCompetences)) {
      const level = item?.NiveauDAcquisition?.V ?? item?.NiveauDAcquisition;
      const code = level && typeof level === "object" ? Number((level as { G?: unknown }).G) : Number(level);
      result.push({
        student: label,
        skill: skillIds.get(String(item?.N ?? "")) ?? String(item?.N ?? ""),
        level: Number.isFinite(code) && code > 0 ? code : null,
        observation: item?.ObservationPubliee === true ? text(item?.Observation) : "",
      });
    }
  }
  return result;
};

/** Domain code of a pilier ("D2", "D1.1", "CT3"): its code member, else the start of its label. */
export const domainCodeOf = (pilier: any): string => {
  const code = String(pilier?.code ?? pilier?.Code ?? "").trim();
  if (code) return code;
  const match = String(pilier?.L ?? "").match(/^\s*((?:D|CT)\s?\d+(?:\.\d+)?)\b/i);
  return match ? match[1].replace(/\s+/g, "").toUpperCase() : "";
};

/** Number of a skill item ("4.1") and its label without it: numero / numeroRESI / code member, else label prefix. */
export const numberOf = (skill: any): { number: string; name: string } => {
  const name = String(skill?.L ?? "").trim();
  const member = String(skill?.numero ?? skill?.numeroRESI ?? skill?.code ?? "").trim();
  const match = name.match(/^(\d+(?:\.\d+)*)[\s.):-]+(.*)$/);
  if (member) return { number: member, name: match && match[1] === member ? match[2].trim() : name };
  return match ? { number: match[1], name: match[2].trim() } : { number: "", name };
};

/** "D2/4.1", or the part that is known. */
export const skillCode = (domainCode: string, number: string): string =>
  domainCode && number ? `${domainCode}/${number}` : domainCode || number;

/** Skill of an assessment (listeCompetences of ListeEvaluations), with its stable id. */
const skillOf = (skill: any, id: string): CompetencySkill => {
  const pilier = skill?.pilier?.V ?? skill?.pilier ?? {};
  const { number, name } = numberOf(skill);
  const domainCode = domainCodeOf(pilier);
  return {
    id,
    name,
    domain: String(pilier?.L ?? "").trim(),
    domainCode,
    number,
    code: skillCode(domainCode, number),
    cycle: String(skill?.palier?.V?.L ?? pilier?.palier?.V?.L ?? "").trim(),
  };
};

/** Delay of the publication to parents (days) of the school, null when unknown. */
export const parentsDelayOf = (session: SessionHandle): number | null => userData(session).parentsDelayDays ?? null;

/** Key of the stable id of an assessment: date (legacy timestamp), class or group, title. */
export const evaluationKey = (evaluation: Element, resourcename: string): string => {
  const date = parsePronoteDate(evaluation.dateValidation?.V ?? evaluation.date?.V);
  return `${date ? legacySeconds(date) : 0}|${resourcename}|${String(evaluation.L ?? "").trim()}`;
};

/** Class or group an assessment belongs to (member "classe" of ListeEvaluations), null when Pronote does not give it. */
export const evaluationClass = (evaluation: Element): Element | null => {
  for (const candidate of [evaluation?.classe, evaluation?.Classe, evaluation?.ressource, evaluation?.groupe]) {
    const raw = unwrap(candidate) as Element | undefined;
    if (raw && typeof raw === "object" && (hasNumber(raw.N) || String(raw.L ?? "").trim() !== "")) return raw;
  }
  return null;
};

/**
 * Whether an assessment belongs to the class or group asked: same Pronote identifier, else same label (case, accents
 * and brackets ignored). An assessment without class member cannot be told apart: it is kept, and the member names
 * of the assessment go to the access log.
 */
export const belongsToResource = (evaluation: Element, resourceRef: Element | undefined, resourcename: string): boolean => {
  const own = evaluationClass(evaluation);
  if (!own) {
    const context = currentContext();
    if (context && !context.shape) context.shape = `evaluation:${memberNames(evaluation)}`;
    return true;
  }
  if (resourceRef && hasNumber(own.N) && own.N === resourceRef.N) return true;
  const label = labelKey(String(own.L ?? ""));
  return label !== "" && label === labelKey(resourcename);
};

/** Period of an assessment as Pronote gives it (member "periode"), else the period asked. */
export const evaluationPeriod = (evaluation: Element, period: Element): Element => {
  const own = unwrap(evaluation?.periode) as Element | undefined;
  return own && typeof own === "object" && hasNumber(own.N) ? own : period;
};

export type ParsedEvaluation = { evaluation: Element; item: CompetencyItem; skillIds: Map<string, string> };

/** Assessments of a list with their stable ids, distinct for two assessments of the same date and title ("~2"). */
export const parseEvaluations = (
  evaluations: Element[],
  subject: string,
  resourcename: string,
  type: "class" | "group",
  serviceid = "",
  parentsDelay: number | null = null,
): ParsedEvaluation[] => {
  const ids = stableIds("competency", evaluations, (evaluation) => evaluationKey(evaluation, resourcename));
  return evaluations.map((evaluation, index) => ({
    evaluation,
    ...itemFromList(evaluation, subject, resourcename, type, serviceid, parentsDelay, ids[index]),
  }));
};

/** Answer of ListeEvaluations for one service: the raw answer, its assessments of the class or group, the tab used. */
export type EvaluationList = { list: Record<string, any>; evaluations: Element[]; tab: number | null };

/**
 * Assessments of a service, class or group and period. "Saisie des évaluations" (tab 56) first, as the client: Pronote
 * answers the assessments of that service only. Refused or closed: "Liste des évaluations" (tab 65), which answers
 * every assessment of the teacher ("all" keeps that answer for the other services of the same request). Whatever the
 * tab, only the assessments whose class or group is the one asked are returned. null: both refused.
 */
export const listEvaluations = async (
  session: SessionHandle,
  service: Element,
  resourceRef: Element | undefined,
  resourcename: string,
  period: Element,
  all: Map<string, Record<string, any> | null> = new Map(),
): Promise<EvaluationList | null> => {
  const data = { service: ref(service), ...(resourceRef ? { ressource: ref(resourceRef) } : {}), periode: ref(period) };
  const usable = (answer: Record<string, any> | null | undefined): answer is Record<string, any> =>
    Boolean(answer) && Object.keys(answer as object).length > 0;
  let list: Record<string, any> | null = null;
  let tab = requireFunction("competencyList").onglet;
  // The calls are sent even when the tab is not listed: Pronote's own answer decides (as in 0.9.0).
  if (!all.has("refused")) {
    try {
      list = await call(session, "competencyList", data);
    } catch (error) {
      if (!isAccessDenied(error)) throw error;
    }
    // A refusal of tab 56 holds for the whole request: the other services go straight to tab 65.
    if (!usable(list)) all.set("refused", null);
  }
  let filterPeriod = false;
  if (!usable(list)) {
    tab = requireFunction("competencyListAll").onglet;
    const key = `all|${String(period.N ?? "")}`;
    if (!all.has(key)) {
      let answer: Record<string, any> | null = null;
      try {
        answer = await call(session, "competencyListAll", data);
      } catch (error) {
        if (!isAccessDenied(error)) throw error;
      }
      all.set(key, usable(answer) ? answer : null);
    }
    list = all.get(key) ?? null;
    filterPeriod = true;
  }
  if (!usable(list)) return null;
  const evaluations = listOf<Element>(list.listeEvaluations)
    .filter((evaluation) => belongsToResource(evaluation, resourceRef, resourcename))
    .filter((evaluation) => !filterPeriod || evaluationPeriod(evaluation, period).N === period.N);
  return { list, evaluations, tab };
};

/** Levels of one assessment: PageCompetencesParEvaluation with the class and the period of the assessment itself. */
export const loadEvaluationPage = (
  session: SessionHandle,
  evaluation: Element,
  resourceRef: Element | undefined,
  period: Element,
): Promise<Record<string, any>> => {
  const own = evaluationClass(evaluation);
  const resource = own && hasNumber(own.N) ? own : resourceRef;
  return call(session, "competencyPage", {
    evaluation: ref(evaluation),
    ...(evaluation.devoir?.V?.N ? { devoir: ref(evaluation.devoir.V) } : {}),
    ...(resource ? { ressource: ref(resource) } : {}),
    periodeEvaluation: ref(evaluationPeriod(evaluation, period)),
  });
};

/** One assessment of ListeEvaluations, without its ratings. */
export const itemFromList = (
  evaluation: Element,
  subject: string,
  resourcename: string,
  type: "class" | "group",
  serviceid = "",
  parentsDelay: number | null = null,
  id: string | null = null,
): { item: CompetencyItem; skillIds: Map<string, string> } => {
  const date = parsePronoteDate(evaluation.dateValidation?.V ?? evaluation.date?.V);
  const publication = parsePronoteDate(evaluation.datePublication?.V);
  const parents = parsePronoteDate(evaluation.datePublicationParents?.V ?? evaluation.datePublicationParent?.V);
  const title = String(evaluation.L ?? "").trim();
  const skills = listOf<any>(evaluation.listeCompetences);
  const skillIds = new Map<string, string>();
  const ids = stableIds("competency", skills, (skill) => `${String(skill?.L ?? "")}|${String(skill?.pilier?.V?.L ?? "")}`);
  skills.forEach((skill, index) => skillIds.set(String(skill?.relationESI?.V?.N ?? skill?.N ?? ""), ids[index]));
  const coefficient = Number.parseFloat(String(evaluation.coefficient?.V ?? evaluation.coefficient ?? "").replace(",", "."));
  return {
    skillIds,
    item: {
      // Legacy timestamp (host zone, as until 0.8.0): the id of an assessment must not change with the time zone fix.
      id: id ?? stableId("competency", evaluationKey(evaluation, resourcename)),
      title,
      date: date ? seconds(date) : null,
      publication: publication ? seconds(publication) : null,
      publicationParents: parents
        ? seconds(parents)
        : publication && parentsDelay !== null
          ? seconds(publication) + Math.round(parentsDelay * 86400)
          : null,
      coefficient: Number.isFinite(coefficient) ? coefficient : null,
      cycleReport: evaluation.priseEnCompteDansBilan !== false,
      local: localTimes({ date, publication, publicationParents: parents }),
      subject,
      resourcename,
      type,
      serviceid,
      skills: skills.map((skill, index) => skillOf(skill, ids[index])),
      ratings: [],
    },
  };
};

/** Resource member ({N, G, L}, G 1 class, 2 group) of a service. */
export const resourceRefOf = (service: Element, type: "class" | "group"): Element | undefined => {
  const resource = resourceOf(service);
  return resource ? { ...resource, G: type === "group" ? 2 : 1 } : undefined;
};

/** Element sent to the skills functions: the skills service (tab 65) when known, else the grade one. */
export const competencyElement = (entry: MergedService): Element => entry.competency ?? entry.grade ?? entry.service;

/* non validé sur la démo : onglets 65 et 56 fermés au profil de démonstration */
export const overview = async (session: SessionHandle, periodId = "", classes: string[] = []): Promise<CompetencyOverview> => {
  ensureSkillsSpace(session);
  const picked = await pickPeriod(session, periodId);
  const parentsDelay = parentsDelayOf(session);
  const base: CompetencyOverview = {
    available: true,
    reason: "",
    ...levelMembers(session),
    period: { id: picked.periodId, name: String(picked.period.L ?? "") },
    parentsDelayDays: parentsDelay,
    services: [],
    items: [],
  };
  const all = await loadAllServices(session, picked.period);
  const serviceIds = serviceIdsOf(all);
  const services: Service[] = [];
  const lists = new Map<string, Record<string, any> | null>();
  let total = 0;
  for (const [index, entry] of all.entries()) {
    const service = competencyElement(entry);
    const resourcename = String(resourceOf(service)?.L ?? "");
    if (!matchesLabels([resourcename], classes)) continue;
    const described = describeService(session, entry, serviceIds[index], [picked.periodId]);
    services.push(described);
    const type = entry.grade
      ? userData(session).resources.find((item) => item.label === resourcename)?.genre === 2 ? "group" : "class"
      : resourceType(session, resourcename, true);
    const resourceRef = resourceRefOf(service, type);
    const listed = await listEvaluations(session, service, resourceRef, resourcename, picked.period, lists);
    if (!listed) {
      return { ...base, services, available: false, reason: "access_denied", ...deniedWhere(session, requireFunction("competencyList").onglet) };
    }
    const subject = String(service.matiere?.V?.L ?? service.L ?? "");
    for (const { evaluation, item, skillIds } of parseEvaluations(listed.evaluations, subject, resourcename, type, serviceIds[index], parentsDelay)) {
      if (total >= MAX_ITEMS) break;
      total++;
      const page = await loadEvaluationPage(session, evaluation, resourceRef, picked.period);
      item.ratings = ratingsFromPage(page, skillIds);
      base.items.push(item);
    }
  }
  if (services.length === 0 && isTabClosed(session, "competencyServicesList")) {
    // 0.11.2: without the skills tab (mobile session read without the web one, e.g. PIN asked by the web space), the
    // services of tab 65 are not listed: "no service" would read as "nothing to assess". Said as a refusal instead.
    return { ...base, services, available: false, reason: "access_denied", ...deniedWhere(session, 65) };
  }
  return { ...base, services };
};

/* ---- Referential (0.8.0): domains and items of a service, to create an assessment from a code ("D2/4.1") ---- */

/**
 * Referential item with its identifiers of the session (never returned to Moodle). "node": the element of the
 * referential itself ({N, G, L}; G 25 item, 24 significant element, 28 sub-item), that the client duplicates into the
 * assessment when a skill is added; "palier": the cycle of its domain, sent with it; "relation": the relation ESI of
 * an assessment that already has the skill (only for the skills read in assessments), else the identifier of the node.
 */
export type SessionReferentialItem = ReferentialItem & {
  relation: string;
  node: { N: string; G?: number; L: string };
  palier: Element | null;
};

const SKIPPED_MEMBERS = new Set(["pilier", "palier", "relationESI", "service", "classe", "groupe", "periode", "matiere", "pere",
  "niveauAcquiDefaut", "listeNiveauxRestrictions"]);

const isNode = (value: any): boolean => value !== null && typeof value === "object" && typeof value.N === "string"
  && typeof value.L === "string";

const childrenOf = (node: any): any[] =>
  Object.entries(node)
    .filter(([key]) => !SKIPPED_MEMBERS.has(key))
    .flatMap(([, value]) => listOf<any>(value))
    .filter(isNode);

/**
 * Items (leaves) of a referential tree, whatever its depth: cycle ("palier", label starting with "Cycle" or member
 * palier) > domain ("pilier", D1…D5) > element (intermediate) > item. A flat list of skills (listeCompetences of an
 * assessment, each with its pilier member) gives the same items. Reconstructed from the client, NOT VALIDATED.
 */
export const referentialFrom = (roots: unknown[]): SessionReferentialItem[] => {
  const found: Omit<SessionReferentialItem, "id">[] = [];
  type Context = { cycle: string; domain: string; domainCode: string; element: string; palier: Element | null };
  const element = (value: unknown): Element | null => {
    const raw = unwrap(value) as Element | undefined;
    return raw && typeof raw === "object" && typeof raw.N === "string" ? raw : null;
  };
  const visit = (node: any, context: Context) => {
    const kids = childrenOf(node);
    const label = String(node.L ?? "").trim();
    const pilier = node.pilier?.V ?? node.pilier;
    const palier = element(node.palier) ?? element(pilier?.palier) ?? context.palier;
    const cycle = String(node.palier?.V?.L ?? pilier?.palier?.V?.L ?? "").trim() || context.cycle;
    if (kids.length === 0) {
      const { number, name } = numberOf(node);
      const domain = context.domain || String(pilier?.L ?? "").trim();
      const domainCode = context.domainCode || domainCodeOf(pilier);
      found.push({
        relation: String(node.relationESI?.V?.N ?? node.N),
        node: { N: String(node.N), ...(typeof node.G === "number" ? { G: node.G } : {}), L: String(node.L ?? "") },
        palier,
        cycle,
        domain,
        domainCode,
        element: context.element,
        number,
        name,
        code: skillCode(domainCode, number),
      });
      return;
    }
    let next: Context;
    if (/^(cycle|palier)\b/i.test(label) && context.domain === "") next = { ...context, cycle: label, palier: element(node) ?? palier };
    else if (context.domain === "") next = { ...context, cycle, palier, domain: label, domainCode: domainCodeOf(node) };
    else next = { ...context, cycle, palier, element: [context.element, label].filter(Boolean).join(" > ") };
    // ListePiliers gives the elements of a domain as a FLAT list, each with its parent ("pere"): the label of the parent
    // is the "element" of its children. Parents stay listed (the client lets some of them be assessed).
    const labels = new Map(kids.map((kid) => [String(kid.N), String(kid.L ?? "").trim()]));
    for (const kid of kids) {
      const pere = element(kid.pere);
      const parentLabel = pere ? labels.get(pere.N) ?? String(pere.L ?? "").trim() : "";
      visit(kid, parentLabel ? { ...next, element: [next.element, parentLabel].filter(Boolean).join(" > ") } : next);
    }
  };
  for (const root of roots) {
    if (isNode(root)) visit(root, { cycle: "", domain: "", domainCode: "", element: "", palier: null });
  }
  // The same item read twice (tree and skills already assessed) is kept once, with its first relation.
  const key = (item: Omit<SessionReferentialItem, "id">) => `${item.cycle}|${item.domainCode || item.domain}|${item.number}|${item.name}`;
  const unique = found.filter((item, index) => found.findIndex((other) => key(other) === key(item)) === index);
  const ids = stableIds("referential", unique, key);
  return unique.map((item, index) => ({ id: ids[index], ...item }));
};

/** Referential of a service: listeReferentielsUniques of ListeEvaluations, ListePiliers, skills already assessed. */
export const loadReferential = async (
  session: SessionHandle,
  service: Element,
  resourceRef: Element | undefined,
  list: Record<string, any> | null,
): Promise<SessionReferentialItem[]> => {
  const roots: unknown[] = [...listOf(list?.listeReferentielsUniques)];
  try {
    const data = await call(session, "competencyReferential", {
      service: ref(service),
      ...(resourceRef ? { ressource: ref(resourceRef) } : {}),
    });
    roots.push(...listOf(data?.listePiliers), ...listOf(data?.listeReferentiels));
  } catch (error) {
    if (error instanceof WebSessionRequired || (!(error instanceof ServerSideError) && !(error instanceof HttpError))) throw error;
  }
  for (const evaluation of listOf<Element>(list?.listeEvaluations)) roots.push(...listOf(evaluation.listeCompetences));
  return referentialFrom(roots);
};

/**
 * Referential item designated by a stable id (rf:…), a code ("D2/4.1", "D2 4.1", "4.1" when unique) or a label
 * (case and accents ignored, with or without its number). null when unknown or ambiguous.
 */
export const findReferentialItem = <T extends ReferentialItem>(wanted: string, items: T[]): T | null => {
  const exact = items.find((item) => item.id === wanted);
  if (exact) return exact;
  const code = wanted.trim().toUpperCase().replace(/\s*[/\s-]\s*/g, "/");
  const unique = (found: T[]) => (found.length === 1 ? found[0] : null);
  // 0.13.0: any domain code, not only D1…D5 and CT ("SCIE/13.4", "COMP/9.1" of the referentials by subject).
  if (/^([A-Z][A-Z0-9]*(\.\d+)?\/)?\d+(\.\d+)*$/.test(code)) {
    const byCode = unique(items.filter((item) => item.code.toUpperCase() === code));
    if (byCode) return byCode;
    if (!code.includes("/")) return unique(items.filter((item) => item.number === code));
    return null;
  }
  const label = normalise(wanted).replace(/^\d+(\.\d+)*[\s.):-]+/, "");
  return unique(items.filter((item) => normalise(item.name) === label));
};

/** GET /competencies/referential: the referential of one service of the period. */
export const referential = async (session: SessionHandle, serviceId: string, periodId = "") => {
  ensureSkillsSpace(session);
  const picked = await pickPeriod(session, periodId);
  const all = await loadAllServices(session, picked.period);
  const entry = resolveService(serviceId, all);
  const index = all.indexOf(entry);
  const service = competencyElement(entry);
  const resourcename = String(resourceOf(service)?.L ?? "");
  const type = resourceType(session, resourcename, entry.grade === null);
  const resourceRef = resourceRefOf(service, type);
  const described = describeService(session, entry, serviceIdsOf(all)[index], [picked.periodId]);
  const listed = await listEvaluations(session, service, resourceRef, resourcename, picked.period);
  if (!listed) {
    return { available: false, reason: "access_denied", ...deniedWhere(session, requireFunction("competencyList").onglet), validated: false,
      service: described, items: [] as ReferentialItem[] };
  }
  const items = (await loadReferential(session, service, resourceRef, listed.list)).map(publicItem);
  return { available: true, reason: "", validated: false, service: described, items };
};

/** Referential item without its identifiers of the session. */
export const publicItem = ({ relation: _relation, node: _node, palier: _palier, ...item }: SessionReferentialItem): ReferentialItem => item;
