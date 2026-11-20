/** Routes whose answers are cached (GET only), with their default lifetime (seconds). */
export const CACHEABLE = {
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
    "/lists": 120,
    "/resources": 60,
};
/** Read routes changed by each write route (prefix of the write path → prefixes of the cached routes). */
const INVALIDATES = [
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
    ["/session/login", []],
    ["/admin", []],
];
/** Parameters naming the target of a write, compared with the parameters of the cached reads. */
const SCOPE_KEYS = ["resource", "class", "classes", "service", "assessment", "lesson"];
const int = (value, fallback) => {
    const parsed = Number.parseInt(value ?? "", 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};
/** Lifetimes per route from the environment. */
export const cacheTtls = (env = process.env) => {
    const base = int(env.PRONOTEIO_CACHE_TTL, 60);
    const ttls = {};
    for (const [route, ttl] of Object.entries(CACHEABLE))
        ttls[route] = base === 0 ? 0 : ttl === 60 ? base : ttl;
    for (const part of String(env.PRONOTEIO_CACHE_TTLS ?? "").split(",")) {
        const [route, raw] = part.split("=").map((item) => item.trim());
        if (route && route in CACHEABLE && /^\d+$/.test(raw ?? ""))
            ttls[route] = Number(raw);
    }
    return ttls;
};
export class ReadCache {
    ttls;
    maxBytes;
    now;
    entries = new Map();
    bytes = 0;
    hits = 0;
    misses = 0;
    invalidations = 0;
    constructor(ttls = cacheTtls(), maxBytes = int(process.env.PRONOTEIO_CACHE_MAX_MB, 20) * 1024 * 1024, now = Date.now) {
        this.ttls = ttls;
        this.maxBytes = maxBytes;
        this.now = now;
    }
    static key(session, route, params) {
        const query = Object.keys(params).sort().map((name) => `${name}=${params[name]}`).join("&");
        return `${session}\n${route}\n${query}`;
    }
    ttlOf(route) {
        return this.ttls[route] ?? 0;
    }
    get(key) {
        const entry = this.entries.get(key);
        if (!entry)
            return null;
        if (entry.expires <= this.now()) {
            this.drop(key, entry);
            return null;
        }
        // Most recently used last (eviction order).
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry;
    }
    set(key, entry) {
        const ttl = this.ttlOf(entry.route);
        if (ttl <= 0)
            return;
        const bytes = Buffer.byteLength(entry.payload);
        if (bytes > this.maxBytes / 4)
            return;
        const old = this.entries.get(key);
        if (old)
            this.drop(key, old);
        this.entries.set(key, { ...entry, bytes, expires: this.now() + ttl * 1000 });
        this.bytes += bytes;
        for (const [oldest, value] of this.entries) {
            if (this.bytes <= this.maxBytes)
                break;
            this.drop(oldest, value);
        }
    }
    drop(key, entry) {
        this.entries.delete(key);
        this.bytes -= entry.bytes;
    }
    /** Invalidates the entries of a session changed by a write (route of the write, parameters naming its target). */
    invalidate(session, writeRoute, target = {}) {
        const rule = INVALIDATES.find(([prefix]) => writeRoute === prefix || writeRoute.startsWith(`${prefix}/`));
        const families = rule ? rule[1] : null;
        const scope = new Set();
        for (const name of SCOPE_KEYS) {
            const value = target[name];
            for (const item of Array.isArray(value) ? value : [value]) {
                if (typeof item === "string" && item !== "")
                    scope.add(item);
            }
        }
        let dropped = 0;
        for (const [key, entry] of this.entries) {
            if (entry.session !== session)
                continue;
            // Unknown write route: every entry of the session (safe side).
            if (families !== null && !families.some((family) => entry.route === family || entry.route.startsWith(`${family}/`)))
                continue;
            if (scope.size > 0) {
                const named = SCOPE_KEYS.flatMap((name) => (entry.params[name] ?? "").split(",")).filter(Boolean);
                if (named.length > 0 && !named.some((value) => scope.has(value)))
                    continue;
            }
            this.drop(key, entry);
            dropped++;
        }
        this.invalidations += dropped;
        return dropped;
    }
    /** Drops every entry of a session (logout, session replaced). */
    dropSession(session) {
        for (const [key, entry] of this.entries)
            if (entry.session === session)
                this.drop(key, entry);
    }
    clear() {
        this.entries.clear();
        this.bytes = 0;
    }
    stats() {
        const now = this.now();
        for (const [key, entry] of this.entries)
            if (entry.expires <= now)
                this.drop(key, entry);
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
const sessionOf = (request) => String(request.headers["x-pronoteio-session"] ?? "");
const paramsOf = (request) => {
    const params = {};
    for (const [name, value] of Object.entries((request.query ?? {}))) {
        if (value !== undefined && value !== null)
            params[name] = String(value);
    }
    return params;
};
/** Hooks of the cache: answer from it before the handler, store and invalidate after. */
export const registerCache = (app, cache = readCache) => {
    app.addHook("preHandler", async (request, reply) => {
        const route = request.routeOptions.url ?? "";
        const session = sessionOf(request);
        if (request.method !== "GET" || session === "" || cache.ttlOf(route) <= 0)
            return;
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
            const body = (request.body ?? {});
            // A simulation (dryRun) writes nothing: the cache stays valid.
            if (body.dryRun !== true && body.dryrun !== true)
                cache.invalidate(session, route, { ...flatten(body), ...paramsOf(request) });
        }
        return payload;
    });
};
/** Target parameters of a write body, also read one level down (assessment.id, lesson…). */
const flatten = (body) => {
    const result = { ...body };
    for (const value of Object.values(body)) {
        if (value && typeof value === "object" && !Array.isArray(value)) {
            for (const [name, inner] of Object.entries(value)) {
                if (SCOPE_KEYS.includes(name) && result[name] === undefined)
                    result[name] = inner;
            }
        }
    }
    return result;
};
//# sourceMappingURL=cache.js.map