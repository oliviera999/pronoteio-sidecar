/**
 * Non-personal state of the sidecar, kept across a restart (P5, 0.9.0): counters of the rate limiter, last errors
 * (code, route, time: never a name, an id or a message from Pronote), reconnections and the Pronote version seen.
 * Written to a small JSON file (PRONOTEIO_STATE_FILE, default var/state.json, "off" to keep it in memory) every
 * 30 seconds and at stop. The cache, the sessions and every student data stay in memory only.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
/** Accounts kept in the web login guard, and recent failures kept per account. */
export const MAX_WEB_LOGIN_ACCOUNTS = 100;
export const MAX_WEB_LOGIN_RECENT = 50;
export const MAX_ERRORS = 20;
const empty = () => ({
    savedAt: null,
    limiter: { served: 0, refused: 0 },
    errors: [],
    reconnects: { total: 0, expired: 0, replaced: 0, failed: 0, lastAt: null },
    pronote: { version: null, validated: null, seenAt: null },
    starts: 0,
    webLogin: {},
});
export const resolveStateFile = (env = process.env, cwd = process.cwd()) => {
    const value = (env.PRONOTEIO_STATE_FILE ?? "").trim();
    if (value.toLowerCase() === "off")
        return null;
    return value !== "" ? value : join(cwd, "var", "state.json");
};
/** Only known members, with their types: a damaged or altered file cannot inject anything. */
const sanitize = (raw) => {
    const state = empty();
    const num = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);
    const str = (value, max = 80) => (typeof value === "string" ? value.slice(0, max) : null);
    state.savedAt = str(raw?.savedAt);
    state.limiter = { served: num(raw?.limiter?.served), refused: num(raw?.limiter?.refused) };
    state.errors = (Array.isArray(raw?.errors) ? raw.errors : []).slice(-MAX_ERRORS).map((item) => ({
        code: str(item?.code, 40) ?? "internal",
        error: str(item?.error, 60) ?? "",
        route: str(item?.route, 60) ?? "",
        status: num(item?.status),
        at: str(item?.at, 30) ?? "",
    }));
    const r = raw?.reconnects ?? {};
    state.reconnects = { total: num(r.total), expired: num(r.expired), replaced: num(r.replaced), failed: num(r.failed), lastAt: str(r.lastAt) };
    state.pronote = { version: str(raw?.pronote?.version, 20), validated: typeof raw?.pronote?.validated === "boolean" ? raw.pronote.validated : null,
        seenAt: str(raw?.pronote?.seenAt) };
    state.starts = num(raw?.starts);
    const logins = raw?.webLogin && typeof raw.webLogin === "object" && !Array.isArray(raw.webLogin) ? raw.webLogin : {};
    for (const [key, item] of Object.entries(logins).slice(0, MAX_WEB_LOGIN_ACCOUNTS)) {
        if (!/^[0-9a-f]{64}$/.test(key))
            continue;
        const kind = str(item?.lastKind, 60);
        state.webLogin[key] = {
            failures: Math.min(1000, Math.floor(num(item?.failures))),
            backoffUntil: num(item?.backoffUntil),
            lastFailureAt: num(item?.lastFailureAt) > 0 ? num(item?.lastFailureAt) : null,
            lastKind: kind !== null && /^[\w.-]{1,60}$/.test(kind) ? kind : null,
            recent: (Array.isArray(item?.recent) ? item.recent : []).map(num).filter((at) => at > 0).slice(-MAX_WEB_LOGIN_RECENT),
        };
    }
    return state;
};
export class StateStore {
    file;
    state;
    timer = null;
    constructor(file = resolveStateFile()) {
        this.file = file;
        this.state = this.load();
    }
    load() {
        if (this.file === null || !existsSync(this.file))
            return empty();
        try {
            return sanitize(JSON.parse(readFileSync(this.file, "utf8")));
        }
        catch {
            return empty();
        }
    }
    /** Called before each save (server.ts: totals of the rate limiter). */
    beforeSave = null;
    save() {
        this.beforeSave?.();
        if (this.file === null)
            return;
        try {
            this.state.savedAt = new Date().toISOString();
            mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
            const temporary = `${this.file}.${process.pid}.tmp`;
            writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 });
            renameSync(temporary, this.file);
        }
        catch {
            // The state is a convenience: a write failure never stops the sidecar.
        }
    }
    /** Saves every 30 s and at stop (server.ts). */
    start() {
        this.state.starts++;
        if (this.timer)
            return;
        this.timer = setInterval(() => this.save(), 30_000);
        this.timer.unref();
    }
    stop() {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = null;
        this.save();
    }
    recordError(entry, at = new Date()) {
        this.state.errors.push({ ...entry, at: at.toISOString() });
        if (this.state.errors.length > MAX_ERRORS)
            this.state.errors.splice(0, this.state.errors.length - MAX_ERRORS);
    }
    recordReconnect(reason, ok) {
        const r = this.state.reconnects;
        if (ok) {
            r.total++;
            r[reason]++;
        }
        else {
            r.failed++;
        }
        r.lastAt = new Date().toISOString();
    }
}
export const stateStore = new StateStore();
//# sourceMappingURL=state.js.map