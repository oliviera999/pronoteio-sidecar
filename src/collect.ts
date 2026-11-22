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
 * (app.inject with the internal token, as jobs.ts), and merges the pages. Rules:
 * - one grouped read per account at a time: a second request answers 409 collect_running with the collectid running;
 * - every Pronote call goes through the queue of the session with the bulk priority (limiter.ts): writes and unit reads
 *   of the teacher pass first. A pause separates two internal reads;
 * - a full queue (429, or a page answered partially): the read waits retry_after, then goes on at the first student
 *   not read. Nothing read is lost, nothing is read twice (a student whose read takes several calls, cut between two
 *   of them, is read again from its first call);
 * - a function Pronote refuses, an unknown shape or an error ends ITS block (unavailable, failed, or partial when
 *   students were read before): the other blocks go on, and what was read stays readable;
 * - a session that closes during the read (web session expired, or required and absent): the block is put aside, the
 *   blocks that do not need it go on, then the read waits ("waiting", with the state of the sessions: sessionState.ts)
 *   and resumes when the session is back (a new login of the account is found by itself; the sessions sent with a
 *   GET /collect/:id are adopted too). After PRONOTEIO_COLLECT_WAIT seconds (900) the read ends "partial";
 * - results live in memory only, 30 minutes after the end, never on disk; lost at restart (404 collect_not_found: the
 *   collector starts again). DELETE forgets them at once.
 * Nothing of a block goes to a log: the internal reads are not written to the access log, and the lines of these routes
 * carry no size for the results (app.ts SILENT_ROUTES): a block may hold the support plans.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { INTERNAL_HEADER, INTERNAL_TOKEN } from "./auth.js";
import { HttpError } from "./errors.js";
import { limiterOptions } from "./pronote/limiter.js";
import { MAX_LIFE_RANGE, parseList } from "./routes/classlife.js";
import { accountSession, requireSession, sessionById, sessionEntry, webSessionEntry } from "./session.js";
import { sessionState } from "./sessionState.js";
import { announcesWeb, type Space } from "./space.js";
import { LIFE_INCLUDES, LIFE_SOURCES } from "./teacher/classlife.js";
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
const MAX_COLLECTS = 10;
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
  /** Session the block waits for. */
  needs: "web" | "main" | null;
  /** Merged answer of the route. */
  result: Record<string, any> | null;
};

type Collect = {
  id: string;
  owner: string;
  account: string | null;
  sessions: { main: string; web: string };
  mainSpace: Space;
  /** Every main session id the read was asked or polled with. */
  known: Set<string>;
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
};

const collects = new Map<string, Collect>();

const ACTIVE: CollectStatus[] = ["queued", "running", "waiting"];
const isActive = (job: Collect): boolean => ACTIVE.includes(job.status);

const purge = (now = Date.now()): void => {
  for (const [id, job] of collects) if (job.finished !== null && job.finished + collectTiming.ttlMs < now) collects.delete(id);
  // Results nobody deleted: the oldest ended reads go first.
  const ended = [...collects.values()].filter((job) => job.finished !== null).sort((a, b) => (a.finished as number) - (b.finished as number));
  for (const job of ended.slice(0, Math.max(0, ended.length - MAX_KEPT))) collects.delete(job.id);
};

/** Forgets every grouped read (tests). */
export const resetCollects = (): void => {
  for (const job of collects.values()) job.cancelled = true;
  collects.clear();
};

/** Statistics for the health check (no content). */
export const collectStats = () => {
  purge();
  const list = [...collects.values()];
  return { collects: list.length, running: list.filter(isActive).length };
};

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
    if (entry) {
      job.sessions.main = entry.id;
      job.known.add(entry.id);
    }
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

const errorOf = (answer: Answer): string => String(answer.body?.error ?? `http_${answer.status}`).slice(0, 120);

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

/** One internal read: asked again after retry_after while the queue is full, and once after an error of Pronote. */
const read = async (app: FastifyInstance, job: Collect, url: string): Promise<Answer> => {
  let errors = 0;
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

/** Next internal read of a block, null when it has nothing left to read. */
const nextUrl = (job: Collect, block: BlockState): string | null => {
  const { route, kind, period } = BLOCK_ROUTES[block.name];
  const params = { ...(job.params[block.name] ?? {}), ...(period && job.period !== "" ? { period: job.period } : {}) };
  // The overview of the grades names its classes itself.
  const base = block.name === "grades" ? params : { resource: job.resource, ...params };
  if (kind === "single") return block.started ? null : query(route, base);
  if (kind === "ids") {
    if (block.started && block.todo.length === 0) return null;
    return query(route, { ...base, ids: block.todo.slice(0, collectTiming.pageSize).join(",") });
  }
  if (block.started && (block.finished || block.offset >= block.total)) return null;
  return query(route, { ...base, offset: block.offset, limit: Math.min(collectTiming.pageSize, MAX_RESULT_ITEMS) });
};

const union = (a: unknown, b: unknown): string[] => [...new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])])].sort();

/**
 * Merges a page into the result of its block. Returns whether students were read, and the seconds to wait before the
 * next page when this one stopped on a full queue.
 */
const absorb = (job: Collect, block: BlockState, body: Record<string, any>): { advanced: boolean; retryAfter: number } => {
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
    const page = body.general?.page;
    block.result = { ...previous, ...body, students: [...students.values()] };
    if (!page || !Array.isArray(page.read)) {
      block.read = block.total;
      block.finished = true;
      return { advanced: true, retryAfter: 0 };
    }
    block.ids.push(...page.read);
    block.offset += page.read.length;
    block.read = Math.min(block.total, block.ids.length);
    if (block.offset >= Number(page.total ?? block.total)) block.finished = true;
    return { advanced: page.read.length > 0, retryAfter: page.partial ? Number(page.retry_after ?? 1) : 0 };
  }
  const items = Array.isArray(body.items) ? body.items : [];
  const done: string[] = Array.isArray(body.read) ? body.read : items.map((item: Record<string, any>) => String(item.studentid ?? item.id ?? "")).filter(Boolean);
  block.result = { ...previous, ...body, items: [...(previous.items ?? []), ...items],
    ...(previous.unreadable || body.unreadable ? { unreadable: [...(previous.unreadable ?? []), ...(body.unreadable ?? [])] } : {}),
    ...(previous.shape && !body.shape ? { shape: previous.shape } : {}) };
  block.ids.push(...done);
  const retryAfter = body.partial ? Number(body.retry_after ?? 1) : 0;
  if (kind === "ids") {
    const notFound: string[] = Array.isArray(body.notFound) ? body.notFound : [];
    block.result.unmappedKeys = union(previous.unmappedKeys, body.unmappedKeys);
    block.result.unmappedGuardianKeys = union(previous.unmappedGuardianKeys, body.unmappedGuardianKeys);
    block.result.notFound = [...(previous.notFound ?? []), ...notFound];
    const gone = new Set([...done, ...notFound]);
    block.todo = block.todo.filter((id) => !gone.has(id));
    block.read = block.total - block.todo.length;
    return { advanced: gone.size > 0, retryAfter };
  }
  block.offset += done.length;
  block.read = Math.min(block.total, block.ids.length);
  return { advanced: done.length > 0, retryAfter };
};

/** Result of a block as its route would give it for the whole class: what was read, and the students left. */
const seal = (job: Collect, block: BlockState): void => {
  const kind = BLOCK_ROUTES[block.name].kind;
  if (!block.result) return;
  if (kind === "comments") {
    const page = block.result.general?.page;
    if (page) {
      const remaining = job.students.filter((id) => !block.ids.includes(id));
      block.result.general = { ...block.result.general, page: { ...page, offset: 0, read: block.ids, remaining, partial: remaining.length > 0, retry_after: 0 } };
    }
    return;
  }
  if (kind === "single") return;
  const remaining = kind === "ids" ? block.todo : job.students.filter((id) => !block.ids.includes(id));
  Object.assign(block.result, { offset: 0, total: job.students.length, read: block.ids, remaining, partial: remaining.length > 0, retry_after: 0 },
    kind === "ids" ? { truncated: false } : {});
};

/** Ends a block that cannot go further: partial when students were read, else the status given. */
const stop = (job: Collect, block: BlockState, status: "unavailable" | "failed", reason: string, body?: Record<string, any>): void => {
  const some = block.started && block.result !== null && block.read > 0 && BLOCK_ROUTES[block.name].kind !== "single";
  block.status = some ? "partial" : status;
  block.reason = reason;
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
    const url = nextUrl(job, block);
    if (url === null) {
      block.status = "done";
      seal(job, block);
      return "final";
    }
    const answer = await read(app, job, url);
    const lost = lostSession(answer);
    if (lost) {
      block.status = "pending";
      block.needs = lost;
      return "deferred";
    }
    block.started = true;
    if (answer.status !== 200 || !answer.body || typeof answer.body !== "object") {
      // A request refused (4xx: a group where a class is needed, a service not found…) or an error of Pronote (5xx).
      stop(job, block, answer.status >= 500 ? "failed" : "unavailable", answer.status === 429 ? "rate_limited" : errorOf(answer));
      return "final";
    }
    if (answer.body.available === false) {
      stop(job, block, "unavailable", String(answer.body.reason || "unavailable"), answer.body);
      return "final";
    }
    const { advanced, retryAfter } = absorb(job, block, answer.body);
    if (!advanced && retryAfter === 0 && nextUrl(job, block) !== null) {
      // An answer that reads nobody and promises nothing: the block would never end.
      stop(job, block, "failed", "no_progress");
      return "final";
    }
    if (retryAfter > 0) await hold(job, retryAfter);
    else await sleep(collectTiming.pauseMs);
  }
};

/** Waits for the sessions the blocks put aside need. False when they did not come back in time. */
const waitForSessions = async (job: Collect, deferred: BlockState[]): Promise<boolean> => {
  job.status = "waiting";
  job.current = null;
  const until = Math.min(Date.now() + collectTiming.waitingMaxMs, job.deadline);
  while (Date.now() < until) {
    if (job.cancelled) throw new Stopped("cancelled");
    await sleep(collectTiming.pollMs);
    refreshSessions(job);
    const main = !deferred.some((block) => block.needs === "main") || sessionById(job.sessions.main) !== undefined;
    const web = !deferred.some((block) => block.needs === "web") || sessionState(job.sessions, job.account).web === "open";
    if (main && web) {
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
  const statuses = job.blocks.map((block) => block.status);
  const some = statuses.some((status) => status === "done" || status === "partial");
  const settled = statuses.every((status) => status === "done" || status === "unavailable");
  // A read that ran out of time is partial, whatever it read: the blocks say what is missing and why.
  job.status = job.expired ? "partial" : settled ? "done" : some ? "partial" : "failed";
  job.current = null;
  job.retryAt = 0;
  job.finished = Date.now();
};

const run = async (app: FastifyInstance, job: Collect): Promise<void> => {
  job.status = "running";
  try {
    const failure = await prepare(app, job);
    if (failure !== null) {
      for (const block of job.blocks) stop(job, block, failure.status, failure.reason);
    } else {
      const queue = [...job.blocks];
      const deferred: BlockState[] = [];
      for (;;) {
        check(job);
        const block = queue.shift();
        if (!block) {
          if (deferred.length === 0 || !(await waitForSessions(job, deferred))) break;
          queue.push(...deferred.splice(0));
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
  // A read that had a web session knows it is gone even when the account is unknown (sessionState.ts needs it).
  const web = state.web === "closed" && job.sessions.web !== "" ? "reopen_required" : state.web;
  return {
    collectid: job.id,
    status: job.status,
    created: Math.floor(job.created / 1000),
    finished: job.finished === null ? null : Math.floor(job.finished / 1000),
    expires: Math.floor(((job.finished ?? job.deadline) + collectTiming.ttlMs) / 1000),
    progress: {
      done: job.blocks.reduce((sum, block) => sum + (final(block) ? block.total : block.read), 0),
      total: job.blocks.reduce((sum, block) => sum + block.total, 0),
      block: job.current,
      student: current ? current.read : 0,
    },
    retry_after: Math.max(job.retryAt > now ? Math.ceil((job.retryAt - now) / 1000) : 0, job.status === "waiting" ? state.retry_after : 0),
    session: { mobile: state.mobile, web, reason: web === state.web ? state.reason : (state.reason || "web_session_expired") },
    blocks: Object.fromEntries(job.blocks.map((block) => [block.name, { status: block.status, reason: block.reason,
      validated: block.result?.validated === true, read: block.read, total: block.total, remaining: Math.max(0, block.total - block.read) }])),
  };
};

/** Read of the request: the one of its account, or one it was asked or polled with; 404 collect_not_found otherwise. */
const find = (request: FastifyRequest, id: string): Collect => {
  purge();
  const job = collects.get(id);
  const header = String(request.headers["x-pronoteio-session"] ?? "");
  const entry = sessionEntry(request);
  if (!job || !((entry?.account && entry.account === job.account) || (header !== "" && job.known.has(header)))) {
    throw new HttpError(404, "collect_not_found");
  }
  // The sessions sent with the request replace those that are gone (a new login of the teacher).
  if (entry && entry.space === job.mainSpace && !sessionById(job.sessions.main)) {
    job.sessions.main = entry.id;
    job.known.add(entry.id);
  }
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
        include: list(options.classlife?.include, LIFE_INCLUDES, "include"), sources: list(options.classlife?.sources, LIFE_SOURCES, "sources") };
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
        known: new Set([session]), webCapable: announcesWeb(request.headers as Record<string, unknown>), resource: request.body.resource,
        period: request.body.period ?? "", params, status: "queued", created: now, finished: null, deadline: now + collectTiming.maxRunMs,
        blocks: blocks.map((name) => ({ name, status: "pending", reason: "", read: 0, total: 0, started: false, finished: false, offset: 0, ids: [],
          todo: [], needs: null, result: null })),
        current: null, students: [], retryAt: 0, cancelled: false, expired: false };
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
    job.cancelled = true;
    collects.delete(job.id);
    return { collectid: job.id, cancelled: true };
  });
};
