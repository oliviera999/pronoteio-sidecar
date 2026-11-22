/**
 * Short cache of the read answers, in memory only (P3, 0.9.0).
 *
 * The plugin often reads the same thing several times in a row (student files of a class read three times, roster
 * then files, timetable of the same week): each read costs Pronote calls and tokens of the rate limiter.
 * - key: Pronote session + route + sorted query parameters;
 * - lifetime: PRONOTEIO_CACHE_TTL seconds (60), per route with PRONOTEIO_CACHE_TTLS ("/students/files=30,/roster=120"),
 *   0 disables the cache (globally or for a route);
 * - a successful write invalidates the entries of the same session whose routes it may change, restricted to the
 *   same class, service, assessment or lesson when the write names one;
 * - the answer carries X-Cache: hit or miss; the health check gives the hit rate and the size.
 * RGPD: the answers may hold data of minors (rosters, files, grades). They stay in the memory of the process only,
 * never on disk, at most PRONOTEIO_CACHE_MAX_MB (20 MB, oldest entries dropped first), for a minute by default, and are
 * all lost when the process stops. Nothing of them is logged.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";

/** Routes whose answers are cached (GET only), with their default lifetime (seconds). */
export const CACHEABLE: Record<string, number> = {
  "/timetable": 60,
  "/timetable/resource": 60,
  "/homework": 60,
  "/roster": 120,
  "/students/files": 60,
  "/grades": 60,
  "/grades/context": 60,
  "/grades/overview": 60,
  "/notebook": 60,
  "/assessments": 60,
  "/absences": 30,
  "/competencies": 60,
  "/competencies/referential": 300,
  "/reports/context": 120,
  "/reports": 60,
  // 0.12.0: main teacher view. The photos (/students/photos) are never cached.
  "/reports/results": 60,
  "/classlife": 120,
  // 0.16.0: class follow-up. The support plans (/students/plans) are health data: never cached.
  "/classlife/absences": 120,
  "/students/history": 120,
  "/lists": 120,
  "/resources": 60,
};

/** Read routes changed by each write route (prefix of the write path → prefixes of the cached routes). */
const INVALIDATES: [string, string[]][] = [
  ["/grades", ["/grades", "/assessments"]],
  ["/competencies", ["/competencies"]],
  ["/notebook", ["/notebook", "/homework", "/timetable", "/assessments"]],
  ["/timetable", ["/timetable", "/notebook", "/homework"]],
  ["/absences", ["/absences", "/notebook", "/timetable", "/classlife"]],
  ["/reports", ["/reports"]],
  ["/lists", ["/lists"]],
  ["/messages", []],
  ["/news", []],
  ["/meetings", []],
  ["/files", []],
  ["/forum", []],
  // Not Pronote writes: nothing to invalidate.
  ["/jobs", []],
  ["/collect", []],
  ["/session/login", []],
  ["/admin", []],
];

/** Parameters naming the target of a write, compared with the parameters of the cached reads. */
const SCOPE_KEYS = ["resource", "class", "classes", "service", "assessment", "lesson"];

type Entry = {
  session: string;
  route: string;
  params: Record<string, string>;
  payload: string;
  contentType: string;
  bytes: number;
  expires: number;
};

const int = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

/** Lifetimes per route from the environment. */
export const cacheTtls = (env: Record<string, string | undefined> = process.env): Record<string, number> => {
  const base = int(env.PRONOTEIO_CACHE_TTL, 60);
  const ttls: Record<string, number> = {};
  for (const [route, ttl] of Object.entries(CACHEABLE)) ttls[route] = base === 0 ? 0 : ttl === 60 ? base : ttl;
  for (const part of String(env.PRONOTEIO_CACHE_TTLS ?? "").split(",")) {
    const [route, raw] = part.split("=").map((item) => item.trim());
    if (route && route in CACHEABLE && /^\d+$/.test(raw ?? "")) ttls[route] = Number(raw);
  }
  return ttls;
};

export class ReadCache {
  private entries = new Map<string, Entry>();
  private bytes = 0;
  hits = 0;
  misses = 0;
  invalidations = 0;

  constructor(
    private readonly ttls: Record<string, number> = cacheTtls(),
    private readonly maxBytes = int(process.env.PRONOTEIO_CACHE_MAX_MB, 20) * 1024 * 1024,
    private readonly now: () => number = Date.now,
  ) {}

  static key(session: string, route: string, params: Record<string, string>): string {
    const query = Object.keys(params).sort().map((name) => `${name}=${params[name]}`).join("&");
    return `${session}\n${route}\n${query}`;
  }

  ttlOf(route: string): number {
    return this.ttls[route] ?? 0;
  }

  get(key: string): Entry | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expires <= this.now()) {
      this.drop(key, entry);
      return null;
    }
    // Most recently used last (eviction order).
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  set(key: string, entry: Omit<Entry, "bytes" | "expires">): void {
    const ttl = this.ttlOf(entry.route);
    if (ttl <= 0) return;
    const bytes = Buffer.byteLength(entry.payload);
    if (bytes > this.maxBytes / 4) return;
    const old = this.entries.get(key);
    if (old) this.drop(key, old);
    this.entries.set(key, { ...entry, bytes, expires: this.now() + ttl * 1000 });
    this.bytes += bytes;
    for (const [oldest, value] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      this.drop(oldest, value);
    }
  }

  private drop(key: string, entry: Entry): void {
    this.entries.delete(key);
    this.bytes -= entry.bytes;
  }

  /** Invalidates the entries of a session changed by a write (route of the write, parameters naming its target). */
  invalidate(session: string, writeRoute: string, target: Record<string, unknown> = {}): number {
    const rule = INVALIDATES.find(([prefix]) => writeRoute === prefix || writeRoute.startsWith(`${prefix}/`));
    const families = rule ? rule[1] : null;
    const scope = new Set<string>();
    for (const name of SCOPE_KEYS) {
      const value = target[name];
      for (const item of Array.isArray(value) ? value : [value]) {
        if (typeof item === "string" && item !== "") scope.add(item);
      }
    }
    let dropped = 0;
    for (const [key, entry] of this.entries) {
      if (entry.session !== session) continue;
      // Unknown write route: every entry of the session (safe side).
      if (families !== null && !families.some((family) => entry.route === family || entry.route.startsWith(`${family}/`))) continue;
      if (scope.size > 0) {
        const named = SCOPE_KEYS.flatMap((name) => (entry.params[name] ?? "").split(",")).filter(Boolean);
        if (named.length > 0 && !named.some((value) => scope.has(value))) continue;
      }
      this.drop(key, entry);
      dropped++;
    }
    this.invalidations += dropped;
    return dropped;
  }

  /** Drops every entry of a session (logout, session replaced). */
  dropSession(session: string): void {
    for (const [key, entry] of this.entries) if (entry.session === session) this.drop(key, entry);
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  stats() {
    const now = this.now();
    for (const [key, entry] of this.entries) if (entry.expires <= now) this.drop(key, entry);
    const total = this.hits + this.misses;
    return {
      entries: this.entries.size,
      bytes: this.bytes,
      hits: this.hits,
      misses: this.misses,
      hitRate: total ? Math.round((this.hits / total) * 1000) / 1000 : 0,
      invalidations: this.invalidations,
      maxBytes: this.maxBytes,
    };
  }
}

export const readCache = new ReadCache();

declare module "fastify" {
  interface FastifyRequest {
    cacheKey?: string;
  }
}

const sessionOf = (request: FastifyRequest): string => String(request.headers["x-pronoteio-session"] ?? "");

const paramsOf = (request: FastifyRequest): Record<string, string> => {
  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries((request.query ?? {}) as Record<string, unknown>)) {
    if (value !== undefined && value !== null) params[name] = String(value);
  }
  return params;
};

/** Hooks of the cache: answer from it before the handler, store and invalidate after. */
export const registerCache = (app: FastifyInstance, cache: ReadCache = readCache): void => {
  app.addHook("preHandler", async (request, reply) => {
    const route = request.routeOptions.url ?? "";
    const session = sessionOf(request);
    if (request.method !== "GET" || session === "" || cache.ttlOf(route) <= 0) return;
    const key = ReadCache.key(session, route, paramsOf(request));
    const entry = cache.get(key);
    if (entry) {
      cache.hits++;
      reply.header("x-cache", "hit").header("content-type", entry.contentType);
      return reply.send(entry.payload);
    }
    cache.misses++;
    request.cacheKey = key;
    reply.header("x-cache", "miss");
  });

  app.addHook("onSend", async (request, reply, payload) => {
    const route = request.routeOptions.url ?? "";
    const session = sessionOf(request);
    // 0.12.0: a partial answer (students left to read, "partial": true) is never cached: the next request goes further.
    if (request.cacheKey && reply.statusCode === 200 && typeof payload === "string" && !payload.includes('"partial":true')) {
      cache.set(request.cacheKey, {
        session,
        route,
        params: paramsOf(request),
        payload,
        contentType: String(reply.getHeader("content-type") ?? "application/json; charset=utf-8"),
      });
    }
    if (request.method === "POST" && session !== "" && reply.statusCode < 400) {
      const body = (request.body ?? {}) as Record<string, unknown>;
      // A simulation (dryRun) writes nothing: the cache stays valid.
      if (body.dryRun !== true && body.dryrun !== true) cache.invalidate(session, route, { ...flatten(body), ...paramsOf(request) });
    }
    return payload;
  });
};

/** Target parameters of a write body, also read one level down (assessment.id, lesson…). */
const flatten = (body: Record<string, unknown>): Record<string, unknown> => {
  const result: Record<string, unknown> = { ...body };
  for (const value of Object.values(body)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [name, inner] of Object.entries(value as Record<string, unknown>)) {
        if (SCOPE_KEYS.includes(name) && result[name] === undefined) result[name] = inner;
      }
    }
  }
  return result;
};
