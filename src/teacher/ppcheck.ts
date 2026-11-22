/**
 * Check of the main teacher view (GET /pp/check): each Pronote function of the view is called once on the first student
 * of a class, and only its status and the SHAPE of its answer (member paths and types, never a value) are returned.
 *
 * 0.14.0, after the first real check of 20/11/2026 (docs/olutionmcp/PROMPT_0.51.0.md in mood_prod): the check is the one
 * place where what Pronote really answers is read without any student data, so it now covers
 * - the functions of 0.12.0 ("core"), with every request variant tried for the kinds of general comments and the memos;
 * - the functions of the web session never used yet: school life ("life"), report cards and follow-up ("reports"),
 *   photo board and others ("misc"). Their requests are those of the web client (PRONOTE 2026.2, demo server); a refusal
 *   or an error of one probe never stops the next;
 * - the photo of the first student, reduced to: did a picture come, its type and its size (never the picture);
 * - the members of the student file that hold guardians and schooling people, described on their own.
 * Every probe is a READ: no function whose name starts with Saisie or Programmer (checked by callFunctionAt and by a
 * test). "function" asks ONE function (every variant) and returns its whole shape, by pages; "groups" asks some groups
 * only, so that a caller can stay inside the deadline of a request.
 */
import { ServerSideError, translateToWeekNumber, type SessionHandle } from "pawnote";
import { currentContext, isWriteFunction } from "../context.js";
import { HttpError, RateLimitedError } from "../errors.js";
import { pronoteDate } from "../pronote/encoding.js";
import { limiterOptions } from "../pronote/limiter.js";
import { userData } from "../pronote/userdata.js";
import { wallNow } from "../time.js";
import { absencesFromRecap } from "./absencesRecap.js";
import { decodeRecap, eventsFromNotebook, eventsFromSummary } from "./classlife.js";
import { kindRequests, kindsFromAnswer } from "./comments.js";
import { callFunctionAt, functions, FUNCTION_KEYS, type FunctionKey } from "./functions.js";
import { loadPeriods, loadServices, ref, resourceOf } from "./grades.js";
import { yearsFromAnswer } from "./history.js";
import { photoProbe, type Downloader } from "./photos.js";
import { plansFromAnswer } from "./plans.js";
import { resultsFromAnswer } from "./reports.js";
import { resolveResource, rosterEntries, type RosterEntry } from "./roster.js";
import { MAX_SHAPE, MAX_SHAPE_FULL, SENSITIVE, shapeOf } from "./shape.js";
import { fileOf, MEMO_LISTS, MEMO_TABS } from "./students.js";
import { isAccessDenied, isPlain, member, unwrap } from "./tolerant.js";

export type PpCheckStatus = "ok" | "access_denied" | "tab_closed" | "format_unknown" | "error";

export const PP_GROUPS = ["core", "life", "reports", "misc"] as const;
export type PpGroup = (typeof PP_GROUPS)[number];

/** Keys of the check that are not a Pronote function of functions.ts. */
export const PP_EXTRA_KEYS = ["studentFileMembers", "studentPhoto"] as const;
export type PpKey = FunctionKey | (typeof PP_EXTRA_KEYS)[number];

export type PpCheck = {
  key: PpKey;
  function: string;
  onglet: number | null;
  /** Request variant tried ("" when the function has one request). */
  variant: string;
  group: PpGroup;
  status: PpCheckStatus;
  /** Code of the outcome ("", "rate_limited", "pronote_error", "no_kind", "unmapped=3"…), never a value of Pronote. */
  detail: string;
  shape: string[];
};

export type PpCheckResult = {
  students: number;
  groups: PpGroup[];
  checks: PpCheck[];
  /** With "function": lines of its shape (longest variant), first line returned and whether more remain. */
  shapeTotal?: number;
  shapeOffset?: number;
  shapeMore?: boolean;
  /** 0.14.1: key of the first probe NOT run because the time of the check was spent: ask again with from=<key>. */
  next?: PpKey;
};

export type PpCheckOptions = {
  /** One function (key of functions.ts, or studentFileMembers / studentPhoto): every variant, whole shape. */
  function?: string;
  groups?: PpGroup[];
  shapeOffset?: number;
  shapeLimit?: number;
  downloader?: Downloader;
  /** 0.14.1: key of the probe to resume from (the "next" of the previous answer); the probes before it are not run. */
  from?: string;
  /** 0.14.1: time (ms) after which no further probe is started (a whole check; "function" is never cut). */
  budgetMs?: number;
  /** Clock of the budget (tests). */
  now?: () => number;
};

/** Lines of the shape of an answer that is understood, of one that is not, and of a page of one function. */
export const MAX_CHECK_SHAPE = 80;
export const MAX_UNKNOWN_SHAPE = MAX_SHAPE;
export const MAX_SHAPE_PAGE = 300;

/**
 * 0.14.1, after the first check in production (21/11/2026): the 45 probes of a whole check do not fit in one request.
 * Each Pronote call of the web session takes seconds, and the queue refuses every call asked after the deadline of the
 * request (20 s after it arrived): 28 probes out of 43 came back "rate_limited" although no call was in excess. Now
 * each probe has its own wait in the queue, and the check stops STARTING probes once its time is spent: the answer
 * names the first probe not run ("next"), to be asked again with "from".
 */
export const PP_BUDGET_MS = 25_000;
export const PP_BUDGET_MIN_MS = 1_000;
export const PP_BUDGET_MAX_MS = 50_000;

const GENRE_CLASS = 1;
const GENRE_STUDENT = 4;
const GENRE_PERIOD = 2;
const TYPE_LIST = 24;
const TYPE_DOMAIN = 8;

const list = (items: unknown[]) => ({ _T: TYPE_LIST, V: items });

type Probe = {
  key: FunctionKey;
  group: PpGroup;
  variant?: string;
  /** Tab sent instead of the configured one. */
  onglet?: number | null;
  /** Data sent; null: the probe does not apply (a group instead of a class, no period…). */
  data: Record<string, unknown> | null;
  /** Detail code when the answer is understood, null otherwise (no decoder, or a shape that is not the one read). */
  recognise?: (answer: Record<string, any>) => string | null;
  /** Names never described (default: the sensitive ones); null to describe every name (memos: they are the subject). */
  skip?: RegExp | null;
};

/** Members of the student file that hold people: guardians, pedagogical team, main teachers. */
const FILE_PEOPLE = ["Responsables", "listeResponsables", "listeRessources", "listeEquipePeda", "listePP"];

/** Sub-objects of a FicheEleve answer named in FILE_PEOPLE, kept under their own name (typed values unwrapped). */
const peopleOf = (answer: unknown, depth = 0, out: Record<string, unknown> = {}): Record<string, unknown> => {
  const value = unwrap(answer);
  if (!isPlain(value) || depth > 4) return out;
  for (const [key, child] of Object.entries(value)) {
    if (FILE_PEOPLE.includes(key)) out[key] = child;
    else if (isPlain(unwrap(child))) peopleOf(child, depth + 1, out);
  }
  return out;
};

export const ppCheck = async (session: SessionHandle, resourceId: string, options: PpCheckOptions = {}): Promise<PpCheckResult> => {
  const only = options.function ?? "";
  if (only !== "" && !(FUNCTION_KEYS as string[]).includes(only) && !(PP_EXTRA_KEYS as readonly string[]).includes(only)) {
    throw new HttpError(400, "invalid_function", { candidates: [...FUNCTION_KEYS, ...PP_EXTRA_KEYS] });
  }
  const groups = only !== "" ? [...PP_GROUPS] : options.groups?.length ? [...new Set(options.groups)] : [...PP_GROUPS];
  const resource = resolveResource(session, resourceId);
  const entries = await rosterEntries(session, resourceId);
  if (entries.length === 0) return { students: 0, groups, checks: [] };
  const first: RosterEntry = entries[0];
  const tabs = userData(session).tabs;
  const { periods, current } = await loadPeriods(session);
  const period = current ?? periods[0] ?? null;
  const isClass = resource.genre === GENRE_CLASS;
  const eleve = { N: first.pronoteId, G: GENRE_STUDENT, L: first.label };
  const classe = { N: resource.id, G: GENRE_CLASS, L: resource.label };
  const periode = period ? { N: period.N, G: period.G, L: period.L } : null;
  const now = wallNow();
  const monthAgo = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
  const dates = { dateDebut: pronoteDate(monthAgo), dateFin: pronoteDate(now) };
  const firstMonday = session.instance?.firstMonday;
  const week = firstMonday instanceof Date ? Math.max(1, translateToWeekNumber(now, firstMonday)) : 1;
  const domaine = { _T: TYPE_DOMAIN, V: `[1..${week}]` };
  const me = session.user?.resources?.[0];
  const max = only !== "" ? MAX_SHAPE_FULL : MAX_UNKNOWN_SHAPE;
  const clock = options.now ?? Date.now;
  const started = clock();
  const budget = Math.min(PP_BUDGET_MAX_MS, Math.max(PP_BUDGET_MIN_MS, options.budgetMs ?? PP_BUDGET_MS));
  // Probe to resume from: every key met before it is skipped. An unknown key resumes nothing (whole check).
  let from = options.from && ((FUNCTION_KEYS as string[]).includes(options.from) || (PP_EXTRA_KEYS as readonly string[]).includes(options.from))
    ? options.from : "";
  let next: PpKey | "" = "";
  // One decision per key, taken when it is first met: the variants of a function are never cut in two.
  const decided = new Map<PpKey, boolean>();
  const wanted = (key: PpKey, group: PpGroup): boolean => {
    if (only !== "") return key === only;
    if (!groups.includes(group)) return false;
    const known = decided.get(key);
    if (known !== undefined) return known;
    let run = true;
    if (from !== "") {
      if (key === from) from = "";
      else run = false;
    }
    if (run && next !== "") run = false;
    if (run && clock() - started > budget) {
      next = key;
      run = false;
    }
    decided.set(key, run);
    return run;
  };
  /** A check is a sequence of independent probes: each has its own wait in the queue of the Pronote calls. */
  const ownWait = () => {
    const context = currentContext();
    if (context) context.deadline = Math.max(context.deadline, Date.now() + limiterOptions().maxWaitMs);
  };

  /** Calls one probe; never throws for a refusal or an error of Pronote. */
  const run = async (probe: Probe): Promise<{ check: PpCheck; answer: Record<string, any> | null }> => {
    const fn = functions[probe.key];
    const onglet = probe.onglet === undefined ? fn.onglet : probe.onglet;
    const base: PpCheck = { key: probe.key, function: fn.name, onglet, variant: probe.variant ?? "", group: probe.group, status: "error",
      detail: "", shape: [] };
    if (!fn.name) return { check: { ...base, detail: "not_configured" }, answer: null };
    if (isWriteFunction(fn.name)) return { check: { ...base, detail: "write_function" }, answer: null };
    if (probe.data === null) return { check: { ...base, detail: "not_applicable" }, answer: null };
    let answer: Record<string, any>;
    try {
      ownWait();
      answer = await callFunctionAt(session, probe.key, onglet, probe.data);
    } catch (error) {
      if (error instanceof RateLimitedError) return { check: { ...base, detail: "rate_limited" }, answer: null };
      // A tab missing from the mobile session (WebSessionRequired) replays the whole check on the web session.
      if (error instanceof HttpError) throw error;
      if (isAccessDenied(error)) {
        const closed = onglet !== null && Array.isArray(tabs) && !tabs.includes(onglet);
        return { check: { ...base, status: closed ? "tab_closed" : "access_denied" }, answer: null };
      }
      if (error instanceof ServerSideError) return { check: { ...base, detail: "pronote_error" }, answer: null };
      throw error;
    }
    if (!answer || Object.keys(answer).length === 0) return { check: { ...base, status: "access_denied", detail: "empty_answer" }, answer: null };
    const detail = probe.recognise ? probe.recognise(answer) : null;
    const shape = shapeOf(answer, "", 0, [], probe.skip === undefined ? SENSITIVE : probe.skip, max);
    return { check: { ...base, status: detail === null ? "format_unknown" : "ok", detail: detail ?? "",
      shape: only !== "" || detail === null ? shape : shape.slice(0, MAX_CHECK_SHAPE) }, answer };
  };

  const checks: PpCheck[] = [];
  const push = async (key: FunctionKey, group: PpGroup, probe: Omit<Probe, "key" | "group">) => {
    if (!wanted(key, group)) return null;
    const result = await run({ key, group, ...probe });
    checks.push(result.check);
    return result;
  };

  /* ---- core: the functions the view reads ---- */
  const reportData = isClass && periode ? { eleve, classe, periode } : null;
  const report = (answer: Record<string, any>) =>
    member(answer, ["ListeServices"]) !== undefined || member(answer, ["Message"]) !== undefined ? "" : null;
  await push("reportCard", "core", { data: reportData, recognise: report });
  await push("transcript", "core", { data: reportData, recognise: report });
  await push("classResults", "core", { data: isClass && periode ? { classe, periode, absences: false, competences: false,
    afficherSousServices: false, afficherSeulementSousServices: false, masquerSansNotes: false, avecCouleurMoyenne: false } : null,
  recognise: (answer) => {
    const read = resultsFromAnswer(answer, entries);
    return read === null ? null : read.columnsUnnamed ? "columns_unnamed" : "";
  } });

  // Kinds of general comments: every request variant is a line; the first that lists kinds feeds the page read.
  let kind: ReturnType<typeof kindsFromAnswer>[number] | undefined;
  let kindsStatus: PpCheckStatus | null = null;
  if (wanted("commentKinds", "core") || wanted("generalCommentsPage", "core")) {
    for (const request of isClass && period ? kindRequests(resource, period) : [{ variant: "none", data: null as Record<string, unknown> | null }]) {
      const result = await run({ key: "commentKinds", group: "core", variant: request.variant, data: isClass ? request.data : null,
        recognise: (answer) => (kindsFromAnswer(answer).length > 0 ? "" : member(answer, ["liste", "listeAppreciations"]) !== undefined ? "empty_list" : null) });
      if (wanted("commentKinds", "core")) checks.push(result.check);
      kindsStatus = kindsStatus === "ok" ? "ok" : result.check.status;
      kind = kind ?? (result.answer ? kindsFromAnswer(result.answer).find((item) => !item.rubric && item.name !== "") : undefined);
    }
  }
  if (wanted("generalCommentsPage", "core")) {
    if (kind && period) {
      await push("generalCommentsPage", "core", { data: { classe: { N: resource.id, G: GENRE_CLASS }, periode: { N: period.N, G: GENRE_PERIOD },
        appreciation: ref(kind.element), estUneRubrique: false },
      recognise: (answer) => (member(answer, ["listeLignes", "lignes"]) !== undefined ? "" : null) });
    } else {
      const fn = functions.generalCommentsPage;
      const refused = kindsStatus === "access_denied" || kindsStatus === "tab_closed";
      checks.push({ key: "generalCommentsPage", function: fn.name, onglet: fn.onglet, variant: "", group: "core",
        status: refused && kindsStatus ? kindsStatus : "error", detail: "no_kind", shape: [] });
    }
  }
  // The request that answered on 20/11/2026 (with dates), then the one of the web client (the student alone).
  const recap = (answer: Record<string, any>) => {
    const read = decodeRecap(answer);
    return read === null ? null : [read.official ? "official" : "", read.detail ? "dated" : ""].filter(Boolean).join("+");
  };
  await push("studentLifeRecap", "core", { variant: "eleve+dates", data: { eleve, DateDebut: pronoteDate(monthAgo), DateFin: pronoteDate(now) },
    recognise: recap });
  await push("studentLifeRecap", "core", { variant: "eleve", data: { eleve }, recognise: recap });
  await push("studentNotebook", "core", { data: { Eleve: eleve }, recognise: (answer) => (eventsFromNotebook(answer) === null ? null : "") });
  // The shape of the memos is the point of this check: the names of its members are not filtered.
  for (const onglet of [...new Set([functions.studentMemos.onglet, ...MEMO_TABS])]) {
    for (const name of ["eleve", "Eleve"]) {
      await push("studentMemos", "core", { variant: `${name}@${onglet}`, onglet, data: { [name]: eleve, estValorisation: false },
        recognise: (answer) => (member(answer, MEMO_LISTS) !== undefined ? "" : null), skip: null });
    }
  }
  if (wanted("studentFile", "core") || wanted("studentFileMembers", "core")) {
    const file = await run({ key: "studentFile", group: "core", data: { Eleve: eleve, AvecEleve: true, AvecResponsables: true },
      recognise: (answer) => {
        const read = fileOf(first, answer, []);
        return `unmapped=${read.unmapped.length};guardians=${read.unmappedGuardian.length}`;
      } });
    if (wanted("studentFile", "core")) checks.push(file.check);
    if (wanted("studentFileMembers", "core")) {
      // Guardians and schooling people of the same answer, on their own: names and types only, sensitive names left out.
      const people = file.answer ? peopleOf(file.answer) : {};
      checks.push({ ...file.check, key: "studentFileMembers", variant: "", detail: file.answer ? `members=${Object.keys(people).sort().join(",")}` : file.check.detail,
        shape: file.answer ? shapeOf(people, "", 0, [], SENSITIVE, max) : [] });
    }
  }
  if (wanted("studentPhoto", "core")) {
    const base: PpCheck = { key: "studentPhoto", function: "FichiersExternes", onglet: null, variant: "", group: "core", status: "error",
      detail: "", shape: [] };
    try {
      ownWait();
      const photo = await photoProbe(session, resourceId, first, options.downloader);
      // Whether a picture came, why not, its type and its size: never the picture.
      checks.push({ ...base, status: photo.available ? "ok" : photo.reason === "download_refused" ? "access_denied" : "error",
        detail: photo.available ? `available=true;mime=${photo.mime};size=${photo.size}` : `available=false;reason=${photo.reason.replace(/[^a-z_]/g, "").slice(0, 40)}` });
    } catch (error) {
      if (error instanceof HttpError && !(error instanceof RateLimitedError)) throw error;
      checks.push({ ...base, detail: error instanceof RateLimitedError ? "rate_limited" : "download_error" });
    }
  }

  /* ---- life: school life functions of the web session ---- */
  const dated = (genre: number) => (answer: Record<string, any>) => (eventsFromSummary(answer, genre) === null ? null : "");
  await push("lifeAbsenceDetail", "life", { variant: "eleve+dates", data: { eleve, ...dates, genreAbsence: 13 }, recognise: dated(13) });
  await push("lifeAbsenceDetail", "life", { variant: "eleve+dates+professeur",
    data: me ? { eleve, professeur: { N: me.id, G: 3, L: me.name }, ...dates, genreAbsence: 13 } : null, recognise: dated(13) });
  await push("lifePunishments", "life", { data: { eleve }, recognise: dated(41) });
  await push("lifeFollowUp", "life", { data: { eleve, ...dates }, recognise: dated(13) });
  await push("lifeGrid", "life", { data: { genreSaisie: null, eleve, domaine, genreAbsence: 13 } });
  const classes = isClass ? list([classe]) : null;
  // 0.16.0: the decoders of the class follow-up say whether they understand the answer (never a count for the plans).
  await push("lifeAbsencesRecap", "life", { data: classes ? { classes, regimes: list([]), bourses: list([]), criteres: {}, domaine } : null,
    recognise: (answer) => {
      const read = absencesFromRecap(answer, entries, 0, Number.MAX_SAFE_INTEGER);
      return read === null ? null : read.dated ? "dated" : read.items.length > 0 ? "totals_only" : "no_line";
    } });
  await push("lifeCallSheetRecap", "life", { data: classes ? { classes, regimes: list([]), rubriquesObservation: list([]), domaine,
    uniquementDontJeSuisAuteur: false } : null });
  await push("lifePunishmentsRecap", "life", { data: classes ? { classes, regimes: list([]), criteres: {}, domaine } : null });
  await push("lifeIncidents", "life", { data: classes ? { classes } : null });
  await push("regimesList", "life", { data: {} });

  /* ---- reports: report cards and follow-up ---- */
  let service: { N: string } | null = null;
  if (isClass && period && (wanted("commentsPage", "reports") || wanted("transcriptCommentsPage", "reports"))) {
    try {
      ownWait();
      const found = (await loadServices(session, period)).find((item) => String(resourceOf(item)?.L ?? "") === resource.label);
      service = found ? { N: found.N } : null;
    } catch (error) {
      if (error instanceof HttpError) throw error;
    }
  }
  const grid = service && period ? { ressource: { N: resource.id, G: GENRE_CLASS }, periode: { N: period.N, G: GENRE_PERIOD }, service } : null;
  const lines = (answer: Record<string, any>) => (member(answer, ["listeLignes"]) !== undefined ? "" : null);
  await push("commentsPage", "reports", { data: grid, recognise: lines });
  await push("transcriptCommentsPage", "reports", { data: grid, recognise: lines });
  await push("studentComments", "reports", { data: isClass && periode ? { eleve, classe, listePeriodes: list([{ periode }]),
    listeCategories: list([]), avecCategories: false } : null });
  await push("pastReportStudents", "reports", { data: isClass ? { classe } : null });
  await push("pastReports", "reports", { data: { avecNotes: true, avecCompetences: false, listeElevesBIA: list([eleve]) } });
  await push("schoolingRecap", "reports", { data: classes && periode ? { classes, periode } : null });
  const years = (answer: Record<string, any>) => (yearsFromAnswer(answer) === null ? null : "");
  await push("schoolRecord", "reports", { data: isClass ? { Classe: classe, AvecDonneesClasse: true, Eleve: eleve } : null, recognise: years });
  await push("studentFolders", "reports", { variant: "eleve", data: { eleve } });
  await push("studentFolders", "reports", { variant: "Eleve", data: { Eleve: eleve } });
  await push("multiYear", "reports", { data: { eleve: { N: first.pronoteId } }, recognise: years });
  await push("teacherOpinions", "reports", { data: isClass && periode ? { classe, periode } : null });

  /* ---- misc ---- */
  await push("classPhotos", "misc", { data: isClass ? { classe, ...(periode ? { periode } : {}) } : null,
    recognise: (answer) => (member(answer, ["ListeRessources", "listeRessources"]) !== undefined ? "" : null) });
  await push("supportPlanDetails", "misc", { data: { eleve }, recognise: (answer) => (plansFromAnswer(answer) === null ? null : "") });

  if (only === "") return { students: entries.length, groups, checks, ...(next !== "" ? { next } : {}) };
  // One function: its whole shape by pages of MAX_SHAPE_PAGE lines (the same lines of every variant are paged alike).
  const offset = Math.max(0, Math.floor(options.shapeOffset ?? 0));
  const limit = Math.min(MAX_SHAPE_PAGE, Math.max(1, Math.floor(options.shapeLimit ?? MAX_SHAPE_PAGE)));
  const total = Math.max(0, ...checks.map((check) => check.shape.length));
  return { students: entries.length, groups, checks: checks.map((check) => ({ ...check, shape: check.shape.slice(offset, offset + limit) })),
    shapeTotal: total, shapeOffset: offset, shapeMore: total > offset + limit };
};
