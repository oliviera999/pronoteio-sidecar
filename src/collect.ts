/**
 * Grouped read of a class (0.16.0, docs/olutionsuivi/CONTRAT_SIDECAR.md 7.4): everything the class follow-up of Moodle
 * reads for one class, in one request answered at once.
 *
 *   POST   /collect { resource, period?, blocks: [...], options? }   → 202 { collectid, status, progress }
 *   GET    /collect/:id                                             → status, progress, state of the sessions, blocks
 *   GET    /collect/:id/results?block=…&offset=&limit=              → result of one block, in the shape of its route,
 *                                                                     with total (items of the block), offset, limit
 *   DELETE /collect/:id                                             → cancels a read, or forgets one that ended
 *
 * A block is the read of one route for the whole class (BLOCK_ROUTES): the sidecar asks its own routes, page after page
 * (app.inject with the internal token, as jobs.ts), and merges the pages. Rules (contract 7.4, 7.4 bis, 7.4 ter):
 * - one grouped read per account at a time: a second request answers 409 collect_running with the collectid running;
 *   ten reads active at most in the process (429 rate_limited beyond);
 * - every Pronote call goes through the queue of the session with the bulk priority (limiter.ts): writes and unit reads
 *   of the teacher pass first. A pause separates two internal reads;
 * - a full queue (429, or a page answered partially): the read waits retry_after, then goes on at the first student
 *   not read. Nothing read is lost, nothing is read twice (a student whose read takes several calls, cut between two
 *   of them, is read again from its first call);
 * - an error of Pronote on a student never ends the block: the student is put aside and the read goes on. A route
 *   that names him ("failed") keeps the students of the page already read; for a route that fails as a whole, the
 *   students of the page are asked one by one. The students put aside are asked once more at the end of the block,
 *   which ends "partial" when some are still not read;
 * - a function Pronote refuses, an unknown shape or a request refused ends ITS block (unavailable, or partial when
 *   students were read before): the other blocks go on, and what was read stays readable. A block read as one request
 *   that Pronote answers with an error is "failed";
 * - a session that is missing or closes during the read (web session never opened, expired, or main session lost): the
 *   block is put aside, the blocks that do not need it go on, and the read says "waiting" with the state of the
 *   sessions: session.web is "reopen_required" (never "closed") while a block waits for a web session, unless the
 *   guard of the web logins says "backoff" or "pin_required" (a login must not be sent then). The read resumes when the
 *   session is back (a new login of the account is found by itself; the web session sent with a GET /collect/:id is
 *   adopted). After PRONOTEIO_COLLECT_WAIT seconds (900), or 60 minutes of life, the read ends;
 * - end: "done" when every block is done, "failed" when none is done nor partial, "partial" otherwise;
 * - results live in memory only: a timer forgets them 30 minutes after the end, DELETE at once, and so do the logout of
 *   the account and the end of its session. A read belongs to an account (or, without account, to its session): only a
 *   live session of it reads the results. Lost at restart (404 collect_not_found: the collector starts again).
 * Nothing of a block goes to a log: the internal reads are not written to the access log, and the results are neither
 * sized in the access log nor kept for a second delivery (auth.ts HEALTH_DATA_ROUTES): a block may hold the support
 * plans.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { INTERNAL_HEADER, INTERNAL_TOKEN } from "./auth.js";
import { HttpError } from "./errors.js";
import { limiterOptions } from "./pronote/limiter.js";
import { MAX_LIFE_RANGE, parseList } from "./routes/classlife.js";
import { accountSession, onSessionForgotten, requireSession, sessionById, sessionEntry, webSessionEntry } from "./session.js";
import { sessionState } from "./sessionState.js";
import { announcesWeb, type Space } from "./space.js";
import { LIFE_INCLUDES } from "./teacher/classlife.js";
import { HISTORY_SOURCES } from "./teacher/history.js";
import { resolveResource } from "./teacher/roster.js";
import { schoolYearRange } from "./teacher/studentSource.js";
import { INCLUDE_VALUES } from "./teacher/students.js";

export const COLLECT_BLOCKS = ["files", "reportcards", "results", "comments", "classlife", "absences", "plans", "history", "grades"] as const;
export type CollectBlock = (typeof COLLECT_BLOCKS)[number];

/** Route a block reads, and how: one request, pages of students, lists of student ids, or the comments (see absorb). */
export const BLOCK_ROUTES: Record<CollectBlock, { route: string; kind: "single" | "paged" | "ids" | "comments"; period?: "required" | "optional" }> = {
  files: { route: "/students/files", kind: "ids" },
  reportcards: { route: "/reports", kind: "paged", period: "required" },
  results: { route: "/reports/results", kind: "single", period: "required" },
  comments: { route: "/reports/comments", kind: "comments", period: "required" },
  classlife: { route: "/classlife", kind: "paged" },
  absences: { route: "/classlife/absences", kind: "single" },
  plans: { route: "/students/plans", kind: "paged" },
  history: { route: "/students/history", kind: "paged" },
  grades: { route: "/grades/overview", kind: "single", period: "optional" },
};

const int = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

/** Times of the grouped reads (milliseconds). The tests shorten them. */
export const collectTiming = {
  /** Wait of one internal read in the queue towards Pronote. */
  waitMs: Math.max(limiterOptions().maxWaitMs, 120_000),
  /** Pause between two internal reads: room for the requests of the teacher. */
  pauseMs: int(process.env.PRONOTEIO_COLLECT_PAUSE_MS, 250),
  /** Duration of one second of a retry_after. */
  secondMs: 1000,
  /** While waiting for a session: delay between two looks. */
  pollMs: 5000,
  /** Longest wait for a session, then longest life of a read; beyond, it ends "partial". */
  waitingMaxMs: int(process.env.PRONOTEIO_COLLECT_WAIT, 900) * 1000,
  maxRunMs: 60 * 60_000,
  /** Life of the results after the end. */
  ttlMs: 30 * 60_000,
  /** Students per internal read. */
  pageSize: 20,
  /** Refusals of the queue in a row before a block gives up. */
  maxRetries: 40,
};

/** Largest page of GET /collect/:id/results, and grouped reads alive at once in the process. */
export const MAX_RESULT_ITEMS = 40;
export const MAX_COLLECTS = 10;
/**
 * Sources of the school life a grouped read may ask (contract 7.4 ter). Never "summary": it calls ListePunitions and
 * PageSuivisAbsenceRetard, which the profile refuses, and a grouped read never calls a refused function.
 */
export const COLLECT_LIFE_SOURCES = ["recap", "carnet", "callsheets"] as const;
/** Students put aside in one block (errors of Pronote) beyond which it gives up; times a block may be put aside for a session. */
const MAX_SKIPPED = 10;
const MAX_DEFERRALS = 20;
/** Ended reads whose results are kept, and longest wait after one refusal of the queue (seconds). */
const MAX_KEPT = 40;
const MAX_HOLD = 120;

type BlockStatus = "pending" | "running" | "done" | "partial" | "unavailable" | "failed";
type CollectStatus = "queued" | "running" | "waiting" | "done" | "partial" | "failed";

type BlockState = {
  name: CollectBlock;
  status: BlockStatus;
  reason: string;
  /** Units read and to read: students for the paged blocks, 1 for the others. */
  read: number;
  total: number;
  started: boolean;
  finished: boolean;
  /** Paged blocks: position in the roster; ids read; ids left to read (files). */
  offset: number;
  ids: string[];
  todo: string[];
  /** Students to ask one by one: those of a page that failed as a whole, or those put aside asked once more. */
  singles: string[];
  /** Size of the page being asked one by one (0: none), students of it read, and the error that failed the page. */
  window: number;
  windowRead: number;
  windowError: string;
  /** Students put aside after an error of Pronote, to be asked once more at the end; true while they are. */
  skipped: string[];
  retrying: boolean;
  /** Session the block waits for, and times it was put aside for one. */
  needs: "web" | "main" | null;
  deferrals: number;
  /** Merged answer of the route. */
  result: Record<string, any> | null;
};

type Collect = {
  id: string;
  /** Account of the read, or "session:<id>" for a session without account. */
  owner: string;
  account: string | null;
  sessions: { main: string; web: string };
  mainSpace: Space;
  webCapable: boolean;
  resource: string;
  period: string;
  /** Query parameters of each block, checked at creation. */
  params: Partial<Record<CollectBlock, Record<string, string>>>;
  status: CollectStatus;
  created: number;
  finished: number | null;
  deadline: number;
  blocks: BlockState[];
  current: CollectBlock | null;
  students: string[];
  /** Instant (ms) the read resumes after a refusal of the queue, 0 otherwise. */
  retryAt: number;
  cancelled: boolean;
  expired: boolean;
  /** Forgets the read 30 minutes after its end. */
  timer: NodeJS.Timeout | null;
};

const collects = new Map<string, Collect>();

const ACTIVE: CollectStatus[] = ["queued", "running", "waiting"];
const isActive = (job: Collect): boolean => ACTIVE.includes(job.status);

/** Forgets a read: stops it when it runs, drops its results and its timer. */
const drop = (job: Collect): void => {
  job.cancelled = true;
  if (job.timer) clearTimeout(job.timer);
  job.timer = null;
  collects.delete(job.id);
};

/** Safety net beside the timers: ended reads past their life, and the oldest ones beyond MAX_KEPT. */
const purge = (now = Date.now()): void => {
  for (const job of [...collects.values()]) if (job.finished !== null && job.finished + collectTiming.ttlMs < now) drop(job);
  const ended = [...collects.values()].filter((job) => job.finished !== null).sort((a, b) => (a.finished as number) - (b.finished as number));
  for (const job of ended.slice(0, Math.max(0, ended.length - MAX_KEPT))) drop(job);
};

/** Forgets every grouped read (tests). */
export const resetCollects = (): void => {
  for (const job of [...collects.values()]) drop(job);
};

/** Ids of the grouped reads in memory, as they are: nothing is purged by asking (tests of the timers). */
export const collectIds = (): string[] => [...collects.keys()];

/** Statistics for the health check (no content). */
export const collectStats = () => {
  purge();
  const list = [...collects.values()];
  return { collects: list.length, running: list.filter(isActive).length };
};

// Contract 7.4 ter: the logout of an account forgets its grouped reads; so does the end of the session a read belongs
// to. A session Pronote closed ("lost") forgets nothing: the read waits for the account to log in again.
onSessionForgotten((entry, reason) => {
  if (reason === "lost") return;
  for (const job of [...collects.values()]) {
    const own = job.sessions.main === entry.id || job.owner === `session:${entry.id}`;
    if (own || (reason === "logout" && entry.account !== null && entry.account === job.account)) drop(job);
  }
});

class Stopped extends Error {}

const sleep = (ms: number) => new Promise<void>((resolve) => {
  if (ms <= 0) resolve();
  else setTimeout(resolve, ms).unref();
});

type Answer = { status: number; body: any };

/** Sessions of the read: a new login of the account replaces a session that is gone. */
const refreshSessions = (job: Collect): void => {
  if (!job.account) return;
  if (!sessionById(job.sessions.main)) {
    const entry = accountSession(job.account, job.mainSpace);
    if (entry) job.sessions.main = entry.id;
  }
  if (sessionById(job.sessions.web)?.space !== "web") {
    const entry = accountSession(job.account, "web");
    if (entry) job.sessions.web = entry.id;
  }
};

const inject = async (app: FastifyInstance, job: Collect, url: string): Promise<Answer> => {
  refreshSessions(job);
  const response = await app.inject({
    method: "GET",
    url,
    headers: {
      [INTERNAL_HEADER]: INTERNAL_TOKEN,
      "x-pronoteio-collect": "1",
      "x-pronoteio-session": job.sessions.main,
      // The web session when there is one; else the client is announced as able to open one, so that a call that needs
      // the web space stops before being sent (space.ts) instead of being refused by the mobile session.
      ...(job.sessions.web !== "" ? { "x-pronoteio-web-session": job.sessions.web } : job.webCapable ? { "x-pronoteio-web": "1" } : {}),
    },
  });
  let body: unknown = null;
  try {
    body = JSON.parse(response.body);
  } catch {
    // Not JSON: no body.
  }
  return { status: response.statusCode, body };
};

/**
 * Reason of a block: a code, never a sentence. A route may answer the message of Pronote as its reason (student
 * files): it could name a student, so it is reduced to access_denied (a refusal for lack of rights) or pronote_error.
 */
const codeOf = (reason: unknown): string => {
  const text = String(reason ?? "");
  if (/^[A-Za-z][A-Za-z0-9_:.-]{0,80}$/.test(text)) return text;
  return /droits|insuffisant/i.test(text) ? "access_denied" : "pronote_error";
};

const errorOf = (answer: Answer): string => codeOf(answer.body?.error ?? `http_${answer.status}`);

/** Session an answer says is missing: the web one, the main one, or none. */
const lostSession = (answer: Answer): "web" | "main" | null => {
  const error = errorOf(answer);
  if (answer.status === 401 && error === "web_session_expired") return "web";
  if (answer.status === 409 && error.split(":")[0] === "web_session_required") return "web";
  if (answer.status === 401 && error === "session_expired") return "main";
  return null;
};

const check = (job: Collect): void => {
  if (job.cancelled) throw new Stopped("cancelled");
  if (Date.now() > job.deadline) {
    job.expired = true;
    throw new Stopped("expired");
  }
};

/** Waits "seconds" of a retry_after, shown by GET /collect/:id. */
const hold = async (job: Collect, seconds: number): Promise<void> => {
  const ms = Math.min(MAX_HOLD, Math.max(1, seconds)) * collectTiming.secondMs;
  job.retryAt = Date.now() + ms;
  await sleep(ms);
  job.retryAt = 0;
};

/**
 * One internal read: asked again after retry_after while the queue is full, and once after an error of Pronote (not
 * when a student is asked alone: he is asked once more at the end of his block).
 */
const read = async (app: FastifyInstance, job: Collect, url: string, retryErrors = true): Promise<Answer> => {
  let errors = retryErrors ? 0 : 1;
  for (let round = 0; ; round++) {
    check(job);
    const answer = await inject(app, job, url);
    if (answer.status === 429 && round < collectTiming.maxRetries) {
      await hold(job, Number(answer.body?.retry_after ?? 1) || 1);
      continue;
    }
    if (answer.status >= 500 && errors === 0) {
      errors++;
      await hold(job, 2);
      continue;
    }
    return answer;
  }
};

const query = (route: string, params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) if (value !== undefined && value !== "") search.set(name, String(value));
  const text = search.toString();
  return text === "" ? route : `${route}?${text}`;
};

/** Parameters of the route of a block, without those of a page. */
const baseParams = (job: Collect, block: BlockState): Record<string, string> => {
  const { period } = BLOCK_ROUTES[block.name];
  const params = { ...(job.params[block.name] ?? {}), ...(period && job.period !== "" ? { period: job.period } : {}) };
  // The overview of the grades names its classes itself.
  return block.name === "grades" ? params : { resource: job.resource, ...params };
};

/** Next internal read of a block read by pages, null when it has no page left to read. */
const nextUrl = (job: Collect, block: BlockState): string | null => {
  const { route, kind } = BLOCK_ROUTES[block.name];
  const base = baseParams(job, block);
  if (kind === "single") return block.started ? null : query(route, base);
  if (kind === "ids") {
    if (block.started && block.todo.length === 0) return null;
    return query(route, { ...base, ids: block.todo.slice(0, collectTiming.pageSize).join(",") });
  }
  if (block.started && (block.finished || block.offset >= block.total)) return null;
  return query(route, { ...base, offset: block.offset, limit: Math.min(collectTiming.pageSize, MAX_RESULT_ITEMS) });
};

/** Students of the page a block is about to ask. */
const windowOf = (job: Collect, block: BlockState): string[] => (BLOCK_ROUTES[block.name].kind === "ids"
  ? block.todo.slice(0, collectTiming.pageSize)
  : job.students.slice(block.offset, block.offset + Math.min(collectTiming.pageSize, MAX_RESULT_ITEMS)));

/** Read of one student of a block (a page that failed as a whole, or a student put aside). */
const singleUrl = (job: Collect, block: BlockState, id: string): string => {
  const { route, kind } = BLOCK_ROUTES[block.name];
  return query(route, { ...baseParams(job, block), ...(kind === "ids" ? { ids: id } : { student: id }) });
};

type Step = { url: string; student: string | null };

/**
 * Next internal read of a block: the students to ask one by one first, then the next page, then (once) the students
 * put aside; null when nothing is left.
 */
const nextStep = (job: Collect, block: BlockState): Step | null => {
  if (block.singles.length > 0) return { url: singleUrl(job, block, block.singles[0]), student: block.singles[0] };
  const url = nextUrl(job, block);
  if (url !== null) return { url, student: null };
  if (block.skipped.length > 0 && !block.retrying) {
    block.retrying = true;
    block.singles = block.skipped.splice(0);
    return { url: singleUrl(job, block, block.singles[0]), student: block.singles[0] };
  }
  return null;
};

const union = (a: unknown, b: unknown): string[] => [...new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])])].sort();

/** Students a block has read, in the order of the class (pages and students asked alone do not come in order). */
const inClassOrder = (job: Collect, ids: string[]): string[] => {
  const position = new Map(job.students.map((id, index) => [id, index]));
  return [...new Set(ids)].sort((a, b) => (position.get(a) ?? Number.MAX_SAFE_INTEGER) - (position.get(b) ?? Number.MAX_SAFE_INTEGER));
};

/**
 * Merges an answer into the result of its block. "page": the answer is the next page of the block (its position moves
 * on); otherwise it is one student asked alone. Returns whether students were read, and the seconds to wait before the
 * next page when this one stopped on a full queue.
 */
const absorb = (job: Collect, block: BlockState, body: Record<string, any>, page = true): { advanced: boolean; retryAfter: number } => {
  const kind = BLOCK_ROUTES[block.name].kind;
  const previous = block.result ?? {};
  if (kind === "single") {
    block.result = body;
    block.read = block.total;
    block.finished = true;
    return { advanced: true, retryAfter: 0 };
  }
  if (kind === "comments") {
    // The comments of the service and of the kinds come whole; the general comments read from the report cards come by
    // pages of students ("general.page"): the lines of a student are merged over the pages.
    const students = new Map<string, Record<string, any>>((previous.students ?? []).map((line: Record<string, any>) => [String(line.student), line]));
    for (const line of Array.isArray(body.students) ? body.students : []) {
      const known = students.get(String(line.student));
      if (!known) {
        students.set(String(line.student), line);
        continue;
      }
      const kinds = new Set((known.generals ?? []).map((item: { kind: string }) => item.kind));
      students.set(String(line.student), { ...known, comment: known.comment ?? line.comment, general: known.general ?? line.general,
        generals: [...(known.generals ?? []), ...(line.generals ?? []).filter((item: { kind: string }) => !kinds.has(item.kind))] });
    }
    const pageInfo = body.general?.page;
    block.result = { ...previous, ...body, students: [...students.values()] };
    if (!pageInfo || !Array.isArray(pageInfo.read)) {
      block.read = block.total;
      block.finished = true;
      return { advanced: true, retryAfter: 0 };
    }
    block.ids.push(...pageInfo.read);
    if (page) block.offset += pageInfo.read.length;
    block.read = Math.min(block.total, new Set(block.ids).size);
    if (page && block.offset >= Number(pageInfo.total ?? block.total)) block.finished = true;
    return { advanced: pageInfo.read.length > 0, retryAfter: pageInfo.partial ? Number(pageInfo.retry_after ?? 1) : 0 };
  }
  const items = Array.isArray(body.items) ? body.items : [];
  const done: string[] = Array.isArray(body.read) ? body.read : items.map((item: Record<string, any>) => String(item.studentid ?? item.id ?? "")).filter(Boolean);
  // Students the route answered an error of Pronote for (contract 7.4 ter): put aside, the page goes on after them.
  const failed: string[] = Array.isArray(body.failed) ? body.failed.map(String) : [];
  // The members of the block (class, sources…) are those of its pages; a student asked alone changes none of them.
  const { failed: _failed, ...members } = page || block.result === null ? body : {};
  void _failed;
  block.result = { ...previous, ...members, items: [...(previous.items ?? []), ...items],
    ...(previous.unreadable || body.unreadable ? { unreadable: [...(previous.unreadable ?? []), ...(body.unreadable ?? [])] } : {}),
    ...(previous.shape ? { shape: previous.shape } : body.shape ? { shape: body.shape } : {}) };
  block.ids.push(...done);
  const retryAfter = body.partial && failed.length === 0 ? Number(body.retry_after ?? 1) : 0;
  if (kind === "ids") {
    const notFound: string[] = Array.isArray(body.notFound) ? body.notFound : [];
    block.result.unmappedKeys = union(previous.unmappedKeys, body.unmappedKeys);
    block.result.unmappedGuardianKeys = union(previous.unmappedGuardianKeys, body.unmappedGuardianKeys);
    block.result.notFound = [...(previous.notFound ?? []), ...notFound];
    const gone = new Set([...done, ...notFound]);
    block.todo = block.todo.filter((id) => !gone.has(id));
    // Read: the students whose file came, and those the class no longer has (nothing is left to read for them).
    block.read = Math.min(block.total, new Set(block.ids).size + block.result.notFound.length);
    return { advanced: gone.size > 0, retryAfter };
  }
  if (page) {
    block.skipped.push(...failed);
    // The students asked are a prefix of the page: those read and those in error.
    block.offset += done.length + failed.length;
  }
  block.read = Math.min(block.total, new Set(block.ids).size);
  return { advanced: done.length + failed.length > 0, retryAfter };
};

/** Result of a block as its route would give it for the whole class: what was read, and the students left. */
const seal = (job: Collect, block: BlockState): void => {
  const kind = BLOCK_ROUTES[block.name].kind;
  if (!block.result) return;
  if (kind === "comments") {
    const page = block.result.general?.page;
    if (page) {
      const read = inClassOrder(job, block.ids);
      const remaining = job.students.filter((id) => !read.includes(id));
      block.result.general = { ...block.result.general, page: { ...page, offset: 0, read, remaining, partial: remaining.length > 0, retry_after: 0 } };
    }
    return;
  }
  if (kind === "single") return;
  const read = inClassOrder(job, block.ids);
  const missing = new Set<string>(block.result.notFound ?? []);
  const remaining = job.students.filter((id) => !read.includes(id) && !missing.has(id));
  // Items in the order of the class, whatever the order they were read in.
  const position = new Map(job.students.map((id, index) => [id, index]));
  const rank = (item: Record<string, any>) => position.get(String(item.studentid ?? item.id ?? "")) ?? Number.MAX_SAFE_INTEGER;
  if (Array.isArray(block.result.items)) block.result.items = [...block.result.items].sort((a, b) => rank(a) - rank(b));
  Object.assign(block.result, { offset: 0, total: job.students.length, read, remaining, partial: remaining.length > 0, retry_after: 0 },
    kind === "ids" ? { truncated: false } : {});
};

/** Ends a block that cannot go further: partial when students were read, else the status given. */
const stop = (job: Collect, block: BlockState, status: "unavailable" | "failed", reason: string, body?: Record<string, any>): void => {
  const some = block.started && block.result !== null && block.read > 0 && BLOCK_ROUTES[block.name].kind !== "single";
  block.status = some ? "partial" : status;
  block.reason = reason;
  block.singles = [];
  if (some) {
    // What was read stays, with the students left; the reason and the shape of the answer that stopped the block are added.
    Object.assign(block.result as Record<string, any>, { reason }, body?.shape ? { shape: body.shape } : {});
    seal(job, block);
  } else if (body && typeof body === "object" && body.available === false) {
    // The refusal as the route gives it (reason, tab, shape).
    block.result = body;
  } else {
    block.result = { available: false, reason, validated: false };
  }
};

/** Ends a block that asked everything: done, or partial when students put aside could not be read at all. */
const complete = (job: Collect, block: BlockState): void => {
  block.result = block.result ?? { available: false, reason: "", validated: false };
  seal(job, block);
  const kind = BLOCK_ROUTES[block.name].kind;
  const left = kind === "single" || kind === "comments" ? 0 : (block.result.remaining ?? []).length;
  if (left > 0) {
    block.status = "partial";
    block.reason = "pronote_error";
    Object.assign(block.result as Record<string, any>, { reason: "pronote_error" });
    return;
  }
  block.status = "done";
  // Contract 7.4 ter: no student with a plan that could be read. The client cannot tell "no plan" from "detail not
  // readable": it keeps to the student file.
  if (block.name === "plans" && Array.isArray(block.result?.items) && block.result.items.every((item: { plans?: unknown[] }) => (item.plans ?? []).length === 0)) {
    block.reason = "all_empty";
    Object.assign(block.result as Record<string, any>, { reason: "all_empty" });
  }
};

/** Reads a block until it ends ("final") or needs a session that is gone ("deferred": it goes on later, where it stopped). */
const runBlock = async (app: FastifyInstance, job: Collect, block: BlockState): Promise<"final" | "deferred"> => {
  const definition = BLOCK_ROUTES[block.name];
  if (definition.period === "required" && job.period === "") {
    stop(job, block, "unavailable", "period_required");
    return "final";
  }
  block.status = "running";
  block.needs = null;
  job.current = block.name;
  for (;;) {
    const step = nextStep(job, block);
    if (step === null) {
      complete(job, block);
      return "final";
    }
    const answer = await read(app, job, step.url, step.student === null);
    const lost = lostSession(answer);
    if (lost) {
      if (++block.deferrals > MAX_DEFERRALS) {
        // A session said to be back that never serves the block: it stops asking.
        stop(job, block, "unavailable", lost === "web" ? "web_session_required" : "session_expired");
        return "final";
      }
      block.status = "pending";
      block.needs = lost;
      return "deferred";
    }
    block.started = true;
    let body = answer.status === 200 && answer.body && typeof answer.body === "object" ? answer.body as Record<string, any> : null;
    // A route that answers an error of Pronote as "unavailable" (student files): handled as the error it is.
    const errored = answer.status >= 500 || (body?.available === false && codeOf(body.reason) === "pronote_error");
    if (body?.available === false && !errored) {
      // A refusal, an unknown shape: nothing more will come from this route.
      stop(job, block, "unavailable", codeOf(body.reason || "unavailable"), { ...body, reason: codeOf(body.reason || "unavailable") });
      return "final";
    }
    if (errored) body = null;
    if (step.student !== null) {
      // One student asked alone: read, or put aside (asked once more at the end; left to read after that).
      const student = step.student;
      block.singles.shift();
      const wasRead = body !== null && (Array.isArray(body.read) ? body.read.includes(student)
        : Array.isArray(body.general?.page?.read) ? body.general.page.read.includes(student) : Array.isArray(body.items) && body.items.length > 0);
      if (definition.kind === "ids") block.todo = block.todo.filter((id) => id !== student);
      if (wasRead) {
        absorb(job, block, body as Record<string, any>, false);
        block.windowRead++;
      } else if (!block.retrying) {
        block.skipped.push(student);
      }
      if (block.singles.length === 0 && block.window > 0) {
        // End of a page asked one by one.
        if (definition.kind !== "ids") block.offset += block.window;
        const none = block.windowRead === 0 && block.read === 0;
        block.window = 0;
        if (none || block.skipped.length > MAX_SKIPPED) {
          // Nobody could be read (the function fails for everyone), or too many students in error to go on.
          block.skipped = [];
          stop(job, block, "failed", block.windowError || "pronote_error");
          return "final";
        }
      }
      await sleep(collectTiming.pauseMs);
      continue;
    }
    if (body === null) {
      const students = definition.kind === "paged" || definition.kind === "ids" ? windowOf(job, block) : [];
      if (errored && students.length > 0) {
        // An error of Pronote failed the whole page: its students are asked one by one, so that one student in error
        // does not cost the others (contract 7.4 ter).
        block.singles = students;
        block.window = students.length;
        block.windowRead = 0;
        block.windowError = answer.status >= 500 ? errorOf(answer) : "pronote_error";
        continue;
      }
      // A request refused (4xx: a group where a class is needed, a service not found…), or an error of Pronote on a
      // block read as one request.
      stop(job, block, errored ? "failed" : "unavailable", answer.status === 429 ? "rate_limited" : answer.status === 200 ? "pronote_error" : errorOf(answer));
      return "final";
    }
    const { advanced, retryAfter } = absorb(job, block, body);
    if (block.skipped.length > MAX_SKIPPED) {
      block.skipped = [];
      stop(job, block, "failed", "pronote_error");
      return "final";
    }
    if (!advanced && retryAfter === 0 && nextUrl(job, block) !== null) {
      // An answer that reads nobody and promises nothing: the block would never end.
      stop(job, block, "failed", "no_progress");
      return "final";
    }
    if (retryAfter > 0) await hold(job, retryAfter);
    else await sleep(collectTiming.pauseMs);
  }
};

/** Whether the session a block waits for is there. */
const sessionBack = (job: Collect, need: "web" | "main" | null): boolean => {
  if (need === null) return true;
  refreshSessions(job);
  return need === "main" ? sessionById(job.sessions.main) !== undefined : sessionState(job.sessions, job.account).web === "open";
};

/** Waits until a block put aside can go on. False when no session came back in time. */
const waitForSessions = async (job: Collect, deferred: BlockState[]): Promise<boolean> => {
  job.status = "waiting";
  job.current = null;
  const until = Math.min(Date.now() + collectTiming.waitingMaxMs, job.deadline);
  while (Date.now() < until) {
    if (job.cancelled) throw new Stopped("cancelled");
    await sleep(collectTiming.pollMs);
    if (deferred.some((block) => sessionBack(job, block.needs))) {
      job.status = "running";
      return true;
    }
  }
  job.expired = true;
  return false;
};

/**
 * Roster of the class (ids of the students, in order) and period of the blocks that need one. Returns why nothing can
 * be read, null when the blocks may start.
 */
const prepare = async (app: FastifyInstance, job: Collect): Promise<{ status: "unavailable" | "failed"; reason: string } | null> => {
  for (;;) {
    const roster = await read(app, job, query("/roster", { resource: job.resource }));
    const lost = lostSession(roster);
    if (lost) {
      const block = job.blocks[0];
      block.needs = lost;
      if (!(await waitForSessions(job, [block]))) return { status: "unavailable", reason: lost === "web" ? "web_session_required" : "session_expired" };
      block.needs = null;
      continue;
    }
    if (roster.status !== 200 || !Array.isArray(roster.body?.items)) {
      return { status: roster.status >= 500 ? "failed" : "unavailable", reason: `roster:${errorOf(roster)}` };
    }
    job.students = roster.body.items.map((item: { id?: unknown }) => String(item.id ?? "")).filter(Boolean);
    break;
  }
  for (const block of job.blocks) {
    const kind = BLOCK_ROUTES[block.name].kind;
    block.total = kind === "single" ? 1 : job.students.length;
    if (kind === "ids") block.todo = [...job.students];
  }
  if (job.period === "" && job.blocks.some((block) => BLOCK_ROUTES[block.name].period === "required")) {
    // No period asked: the current one. Without it, the blocks that need a period say so (period_required).
    const context = await read(app, job, "/reports/context");
    const current = context.status === 200 && Array.isArray(context.body?.periods) ? context.body.periods.find((period: { current?: boolean }) => period.current) : null;
    if (current?.id) job.period = String(current.id);
  }
  return null;
};

const finish = (job: Collect): void => {
  for (const block of job.blocks) {
    if (block.status !== "pending" && block.status !== "running") continue;
    // Not read, or cut: the session it needed did not come back, or the time of the read is spent.
    stop(job, block, "unavailable", block.needs === "web" ? "web_session_required" : block.needs === "main" ? "session_expired" : "expired");
  }
  for (const block of job.blocks) block.needs = null;
  // Contract 7.4 ter: done when every block is done, failed when none is done nor partial, partial otherwise. A client
  // relies on the state of each block.
  const statuses = job.blocks.map((block) => block.status);
  job.status = statuses.every((status) => status === "done") ? "done"
    : statuses.some((status) => status === "done" || status === "partial") ? "partial" : "failed";
  job.current = null;
  job.retryAt = 0;
  job.finished = Date.now();
  // The results are forgotten 30 minutes after the end, whether a request comes or not; the timer never holds the process.
  job.timer = setTimeout(() => drop(job), collectTiming.ttlMs);
  job.timer.unref();
};

const run = async (app: FastifyInstance, job: Collect): Promise<void> => {
  job.status = "running";
  try {
    const failure = await prepare(app, job);
    if (failure !== null) {
      for (const block of job.blocks) stop(job, block, failure.status, failure.reason);
    } else {
      const queue = [...job.blocks];
      let deferred: BlockState[] = [];
      for (;;) {
        check(job);
        // The blocks put aside go on as soon as their session is back, without waiting for the others to end.
        const back = deferred.filter((block) => sessionBack(job, block.needs));
        if (back.length > 0) {
          deferred = deferred.filter((block) => !back.includes(block));
          queue.push(...back);
        }
        const block = queue.shift();
        if (!block) {
          if (deferred.length === 0 || !(await waitForSessions(job, deferred))) break;
          continue;
        }
        if ((await runBlock(app, job, block)) === "deferred") deferred.push(block);
      }
    }
  } catch (error) {
    if (job.cancelled) return;
    if (!(error instanceof Stopped)) {
      for (const block of job.blocks) {
        if (block.status === "pending" || block.status === "running") stop(job, block, "failed", "internal");
      }
    }
  }
  if (!job.cancelled) finish(job);
};

const view = (job: Collect) => {
  const now = Date.now();
  const state = sessionState(job.sessions, job.account);
  const current = job.blocks.find((block) => block.name === job.current);
  const final = (block: BlockState) => block.status !== "pending" && block.status !== "running";
  // Sessions the blocks put aside still wait for (contract 7.4 ter): the read says "waiting" as soon as one is missing,
  // even while the other blocks go on, so that the client reopens it at once.
  const active = isActive(job);
  const needsWeb = active && job.blocks.some((block) => block.needs === "web") && state.web !== "open";
  const needsMain = active && job.blocks.some((block) => block.needs === "main") && state.mobile !== "open";
  // "closed" is never said while a block waits for a web session: the client would open nothing. "backoff" and
  // "pin_required" stay: they say a login must not be sent now, or needs the teacher.
  const web = needsWeb && (state.web === "closed" || state.web === "reopen_required") ? "reopen_required" : state.web;
  const reason = needsMain ? (state.reason || "session_expired") : needsWeb && web === "reopen_required" ? "web_session_required" : state.reason;
  return {
    collectid: job.id,
    status: active && (needsWeb || needsMain) ? "waiting" : job.status,
    created: Math.floor(job.created / 1000),
    finished: job.finished === null ? null : Math.floor(job.finished / 1000),
    expires: Math.floor(((job.finished ?? job.deadline) + collectTiming.ttlMs) / 1000),
    // Students of the class (0 until its roster is read). The blocks count their own units of work.
    students: job.students.length,
    progress: {
      done: job.blocks.reduce((sum, block) => sum + (final(block) ? block.total : block.read), 0),
      total: job.blocks.reduce((sum, block) => sum + block.total, 0),
      block: job.current,
      student: current ? current.read : 0,
    },
    retry_after: Math.max(job.retryAt > now ? Math.ceil((job.retryAt - now) / 1000) : 0, needsWeb ? state.retry_after : 0),
    session: { mobile: state.mobile, web, reason },
    blocks: Object.fromEntries(job.blocks.map((block) => [block.name, { status: block.status, reason: block.reason,
      validated: block.result?.validated === true, read: block.read, total: block.total, remaining: Math.max(0, block.total - block.read) }])),
  };
};

/**
 * Read of the request: one of the account of its session (or, without account, of that session itself). The session
 * must be alive (401 session_expired otherwise): an old session id opens nothing. 404 collect_not_found for a read
 * that is unknown, ended long ago, or of someone else.
 */
const find = (request: FastifyRequest, id: string): Collect => {
  requireSession(request);
  purge();
  const job = collects.get(id);
  const entry = sessionEntry(request);
  const owner = entry ? (entry.account ?? `session:${entry.id}`) : "";
  if (!job || owner === "" || job.owner !== owner) throw new HttpError(404, "collect_not_found");
  // The sessions sent with the request replace those that are gone (a new login of the teacher).
  if (entry && entry.space === job.mainSpace && !sessionById(job.sessions.main) && sessionById(entry.id)) job.sessions.main = entry.id;
  const web = webSessionEntry(request);
  if (web && (!job.account || web.account === job.account) && sessionById(job.sessions.web)?.space !== "web") job.sessions.web = web.id;
  return job;
};

type CollectBody = { resource: string; period?: string; blocks: CollectBlock[]; options?: Record<string, Record<string, unknown>> };

const text = (value: unknown): string | undefined =>
  Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean).join(",") : typeof value === "string" ? value : undefined;

const range = (options: Record<string, unknown> | undefined): { from?: string; to?: string } => {
  const from = options?.from;
  const to = options?.to;
  if (from === undefined && to === undefined) return {};
  if (typeof from !== "number" || typeof to !== "number" || to <= from || to - from > MAX_LIFE_RANGE) throw new HttpError(400, "range_too_large");
  return { from: String(from), to: String(to) };
};

/** Query parameters of the blocks asked, from the options of the request (400 on a value the route would refuse). */
const paramsOf = (request: FastifyRequest, body: CollectBody): Collect["params"] => {
  const options = body.options ?? {};
  const params: Collect["params"] = {};
  const list = (value: unknown, allowed: readonly string[], name: string): string => parseList(text(value), allowed, name).join(",");
  for (const block of body.blocks) {
    if (block === "files") params.files = { include: list(options.files?.include, INCLUDE_VALUES, "include") };
    if (block === "reportcards") params.reportcards = { source: "reportcard" };
    if (block === "classlife") {
      const asked = range(options.classlife);
      const year = schoolYearRange(requireSession(request));
      params.classlife = { from: asked.from ?? String(year.from), to: asked.to ?? String(year.to),
        include: list(options.classlife?.include, LIFE_INCLUDES, "include"),
        // Never "summary" (400 invalid_sources:summary): see COLLECT_LIFE_SOURCES.
        sources: list(options.classlife?.sources, COLLECT_LIFE_SOURCES, "sources") };
    }
    if (block === "absences") params.absences = { ...range(options.absences) };
    if (block === "history") params.history = { sources: list(options.history?.sources, HISTORY_SOURCES, "sources") };
    if (block === "grades") {
      // The classes named, else the class asked (its label).
      params.grades = { classes: text(options.grades?.classes) || body.resource.slice(body.resource.indexOf(":") + 1) };
    }
  }
  return params;
};

/** A list of values: comma separated, or an array. */
const listOption = { anyOf: [{ type: "string", maxLength: 2000 }, { type: "array", maxItems: 50, items: { type: "string", maxLength: 200 } }] };
const rangeOptions = { from: { type: "integer", minimum: 0 }, to: { type: "integer", minimum: 0 } };

export const registerCollect = (app: FastifyInstance): void => {
  app.post<{ Body: CollectBody }>(
    "/collect",
    {
      schema: {
        body: {
          type: "object",
          required: ["resource", "blocks"],
          properties: {
            resource: { type: "string", minLength: 1, maxLength: 200 },
            period: { type: "string", maxLength: 200 },
            blocks: { type: "array", minItems: 1, maxItems: COLLECT_BLOCKS.length, items: { type: "string", enum: [...COLLECT_BLOCKS] } },
            options: {
              type: "object",
              properties: {
                files: { type: "object", properties: { include: listOption } },
                classlife: { type: "object", properties: { include: listOption, sources: listOption, ...rangeOptions } },
                absences: { type: "object", properties: { ...rangeOptions } },
                history: { type: "object", properties: { sources: listOption } },
                grades: { type: "object", properties: { classes: listOption } },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const handle = requireSession(request);
      const entry = sessionEntry(request);
      const session = String(request.headers["x-pronoteio-session"] ?? "");
      if (!entry) throw new HttpError(401, "session_expired");
      // A class or group unknown to the session is refused at once (no Pronote call).
      resolveResource(handle, request.body.resource);
      const owner = entry.account ?? `session:${session}`;
      purge();
      const running = [...collects.values()].find((job) => job.owner === owner && isActive(job));
      if (running) throw new HttpError(409, "collect_running", { collectid: running.id });
      if ([...collects.values()].filter(isActive).length >= MAX_COLLECTS) {
        throw new HttpError(429, "rate_limited", { retry_after: 60 }, { "retry-after": "60" });
      }
      const blocks = [...new Set(request.body.blocks)];
      const params = paramsOf(request, { ...request.body, blocks });
      const web = webSessionEntry(request);
      const now = Date.now();
      const job: Collect = { id: randomUUID(), owner, account: entry.account, sessions: { main: session, web: web?.id ?? "" }, mainSpace: entry.space,
        webCapable: announcesWeb(request.headers as Record<string, unknown>), resource: request.body.resource,
        period: request.body.period ?? "", params, status: "queued", created: now, finished: null, deadline: now + collectTiming.maxRunMs,
        blocks: blocks.map((name) => ({ name, status: "pending", reason: "", read: 0, total: 0, started: false, finished: false, offset: 0, ids: [],
          todo: [], singles: [], window: 0, windowRead: 0, windowError: "", skipped: [], retrying: false, needs: null, deferrals: 0, result: null })),
        current: null, students: [], retryAt: 0, cancelled: false, expired: false, timer: null };
      collects.set(job.id, job);
      void run(app, job);
      const { collectid, status, progress } = view(job);
      return reply.code(202).send({ collectid, status, progress });
    },
  );

  app.get<{ Params: { id: string } }>("/collect/:id", async (request) => view(find(request, request.params.id)));

  app.get<{ Params: { id: string }; Querystring: { block: CollectBlock; offset?: number; limit?: number } }>(
    "/collect/:id/results",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["block"],
          properties: {
            block: { type: "string", enum: [...COLLECT_BLOCKS] },
            offset: { type: "integer", minimum: 0, maximum: 10000 },
            limit: { type: "integer", minimum: 1, maximum: MAX_RESULT_ITEMS },
          },
        },
      },
    },
    async (request) => {
      const job = find(request, request.params.id);
      const block = job.blocks.find((item) => item.name === request.query.block);
      if (!block) throw new HttpError(404, "collect_block_not_found");
      // Readable once the block ended, while the others still run.
      if (block.status === "pending" || block.status === "running") throw new HttpError(409, "collect_block_not_ready", { collectid: job.id });
      const result = block.result ?? { available: false, reason: block.reason, validated: false };
      const offset = request.query.offset ?? 0;
      const limit = request.query.limit ?? MAX_RESULT_ITEMS;
      // Contract 7.4 bis: always "total" (items of the block), "offset" and "limit"; a block that could not be read is
      // the refusal of its route with no item. A block whose route has no "items" (results of the class, comments,
      // overview of the grades) comes whole, with total 0.
      const ended = block.status === "unavailable" || block.status === "failed";
      const items: unknown[] | null = Array.isArray(result.items) ? result.items : ended ? [] : null;
      if (items === null) return { ...result, total: 0, offset, limit };
      return { ...result, items: items.slice(offset, offset + limit), total: items.length, offset, limit };
    },
  );

  app.delete<{ Params: { id: string } }>("/collect/:id", async (request) => {
    const job = find(request, request.params.id);
    drop(job);
    return { collectid: job.id, cancelled: true };
  });
};
