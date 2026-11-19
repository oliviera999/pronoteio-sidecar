/**
 * Context of the HTTP request being served, reachable from any Pronote call it makes (AsyncLocalStorage): priority
 * in the rate limiter queue (P2), deadline of the wait, counters of the request (cache, Pronote calls), dry run.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** Priorities of the queue: writes first, then unit reads, then bulk reads (lower is served first). */
export const PRIORITY = { write: 0, read: 1, bulk: 2 } as const;
export type Priority = (typeof PRIORITY)[keyof typeof PRIORITY];

export type RequestContext = {
  priority: Priority;
  /** Instant (ms) beyond which a call still waiting in the queue is refused with rate_limited. */
  deadline: number;
  /** Pronote calls made for this request. */
  calls: number;
  /** Route (pattern) of the request, for the logs and the cache. */
  route: string;
  /** A write call was sent to Pronote (the request is then never replayed after a reconnection, P5). */
  writeSent?: boolean;
  /** The request was already replayed once after a reconnection. */
  replayed?: boolean;
  /** Simulation (dryRun): no write call may be sent (P12). */
  dryRun?: boolean;
  /** 0.10.0: the client can open a web session (X-Pronoteio-Web: 1 or X-Pronoteio-Web-Session), see space.ts. */
  webCapable?: boolean;
  /** 0.10.0: the request runs on the web session (replayed after a WebSessionRequired). */
  webActive?: boolean;
};

/** Pronote functions that write (SaisiePublicMessage only reads the recipients of a message). */
export const isWriteFunction = (name: string): boolean => /^(Saisie|Programmer)/.test(name) && name !== "SaisiePublicMessage";

export const requestContext = new AsyncLocalStorage<RequestContext>();

export const currentContext = (): RequestContext | undefined => requestContext.getStore();

/** Bulk routes: several Pronote calls per request, served after the unit reads. */
const BULK_ROUTES = new Set(["/students/files", "/grades/overview", "/notebook", "/assessments", "/jobs", "/jobs/:id",
  "/competencies/referential/subjects"]);

/** Priority of a request from its method and route. */
export const priorityOf = (method: string, route: string, query: Record<string, unknown> = {}): Priority => {
  if (method !== "GET" && method !== "HEAD") return PRIORITY.write;
  if (route === "/students/files") {
    // One student (student=…) is a unit read; a page of a class or a list of ids is a bulk read.
    return typeof query.student === "string" && query.student !== "" && query.ids === undefined ? PRIORITY.read : PRIORITY.bulk;
  }
  return BULK_ROUTES.has(route) ? PRIORITY.bulk : PRIORITY.read;
};
