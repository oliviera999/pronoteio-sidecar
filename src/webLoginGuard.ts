/**
 * Guard of the logins to the web Espace Professeurs (0.15.0), per account, whatever the caller.
 *
 * Case of 21/11/2026 (08:24:20–08:27:03 UTC): every 3 to 4 seconds a caller asked a web-only function, got
 * 409 web_session_required and sent a web login (password); Pronote refused each of them (RateLimitedError), and each
 * request was a new login sent to Pronote. A burst of password logins may lock the teacher's account.
 *
 * Rules, keyed by the account (tokenStore.accountKey):
 * - single flight: one web login of an account in flight; the concurrent requests of the same login wait for it and get
 *   the same answer (or the same error). A request with a PIN (the teacher is typing it) is never merged with a login
 *   without PIN, nor the reverse: it runs after it;
 * - reuse: a web login without PIN of an account whose web session is alive gets it back, without any call to Pronote
 *   (only with the password that opened it: another password is checked by Pronote, see routes/session.ts);
 * - back-off: after a refusal by Pronote (rate limit, suspended address, any unexpected failure of the login), no web
 *   login without PIN is sent to Pronote before 60 s, then 2, 5 and 15 minutes: 429 web_login_backoff with retry_after
 *   and backoff_until. A login with a PIN is let through (interactive), and extends the back-off when refused too.
 *   Interactive outcomes (pin_required, bad_pin, bad_credentials…) start no back-off; a success clears it.
 * The state (delays, instants, error name: no personal data) is kept across a restart in the state file (state.ts),
 * under a SHA-256 fingerprint of the account key.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { HttpError, toHttp } from "./errors.js";
import { MAX_WEB_LOGIN_ACCOUNTS, MAX_WEB_LOGIN_RECENT, stateStore, type StateStore, type WebLoginRecord } from "./state.js";
import { serializeLogin } from "./tokenStore.js";

/** Delays after the 1st, 2nd, 3rd and every later consecutive refusal (seconds). */
export const BACKOFF_STEPS = [60, 120, 300, 900] as const;

/** Window of the "recent failures" counter (seconds). */
export const RECENT_WINDOW = 600;

/** An account without failure for this long is forgotten: the ladder starts again at its first step (milliseconds). */
export const FORGET_AFTER = 24 * 3600 * 1000;

/** State of an account as served by GET /session/info (times in epoch seconds). */
export type WebLoginStatus = {
  /** Consecutive refusals by Pronote. */
  failures: number;
  /** Failed web logins of any kind during the last 10 minutes. */
  recentFailures: number;
  backoffUntil: number | null;
  /** Seconds before a web login may be sent to Pronote, 0 without back-off. */
  retryAfter: number;
  lastFailureAt: number | null;
  /** Error name or code of the last failure ("RateLimitedError", "pin_required"), never a message. */
  lastKind: string | null;
};

/** Members added to the error answers during a back-off. */
export type BackoffHint = { retry_after: number; backoff_until: number };

/** Short tag of an account for the access log (12 hex characters of a SHA-256 of its key): never a name nor a URL. */
export const accountTag = (account: string): string => createHash("sha256").update(account).digest("hex").slice(0, 12);

/** Key of the fingerprints below: random at each start, in memory only. */
const PROCESS_KEY = randomBytes(32);

/**
 * Key of a login for the single flight: fingerprint of what makes two requests the same login (password, PIN,
 * navigator identifier). Requests with another PIN or password are not merged: they run one after the other. The
 * fingerprint is keyed by a random value of the process and kept in memory only (never written, never logged).
 */
export const flightKey = (parts: (string | undefined)[]): string =>
  createHmac("sha256", PROCESS_KEY).update(parts.map((part) => (part === undefined ? "-" : `+${part}`)).join("\n")).digest("hex");

/** Kind of a failed login for the health report: its stable error string or the name of the Error, never its message. */
export const failureKind = (error: unknown): string => {
  const [status, code] = toHttp(error);
  const raw = status < 500 || error instanceof HttpError ? code.split(":")[0] : String((error as Error)?.name ?? typeof error);
  return raw.replace(/[^\w.-]/g, "").slice(0, 60) || "unknown";
};

/**
 * Refusal by Pronote, which starts or extends the back-off: Pawnote's RateLimitedError, SuspendedIPError,
 * PageUnavailableError, BusyPageError, AccessDeniedError, AccountDisabledError, a network error, a decoding error: any
 * failure the sidecar answers with a 5xx status. The interactive outcomes are 4xx (bad_credentials, pin_required,
 * bad_pin, security_setup_required, double_auth_required, web_token_refused): the teacher acts, nothing is delayed.
 */
export const isRefusal = (error: unknown): boolean => toHttp(error)[0] >= 500;

export class WebLoginGuard {
  /** Logins in flight or waiting, by account and login key. */
  private readonly flights = new Map<string, Promise<unknown>>();

  constructor(
    /** Clock (milliseconds), replaced in the tests. */
    public now: () => number = Date.now,
    private readonly store: StateStore = stateStore,
  ) {}

  private get records(): Record<string, WebLoginRecord> {
    return this.store.state.webLogin;
  }

  /** Key of an account in the state file: a fingerprint of its key, itself a fingerprint (no name, no URL). */
  private static keyOf(account: string): string {
    return createHash("sha256").update(`pronoteio-web-login\n${account}`).digest("hex");
  }

  private record(account: string): WebLoginRecord | undefined {
    const key = WebLoginGuard.keyOf(account);
    return Object.hasOwn(this.records, key) ? this.records[key] : undefined;
  }

  private recentOf(record: WebLoginRecord, now: number): number[] {
    return record.recent.filter((at) => at > now - RECENT_WINDOW * 1000 && at <= now);
  }

  /** Forgets the accounts without failure for a day, and the oldest ones beyond the limit. */
  private purge(now: number): void {
    const records = this.records;
    for (const [key, record] of Object.entries(records)) {
      if (record.backoffUntil <= now && (record.lastFailureAt ?? 0) < now - FORGET_AFTER) delete records[key];
    }
    const keys = Object.keys(records);
    if (keys.length <= MAX_WEB_LOGIN_ACCOUNTS) return;
    keys.sort((a, b) => (records[a].lastFailureAt ?? 0) - (records[b].lastFailureAt ?? 0));
    for (const key of keys.slice(0, keys.length - MAX_WEB_LOGIN_ACCOUNTS)) delete records[key];
  }

  /** Seconds before a web login of the account may be sent to Pronote (at least 1 during a back-off), else 0. */
  retryAfter(account: string): number {
    const record = this.record(account);
    const now = this.now();
    return record && record.backoffUntil > now ? Math.max(1, Math.ceil((record.backoffUntil - now) / 1000)) : 0;
  }

  /** Members of an error answer during the back-off of an account, null without back-off. */
  hint(account: string | null | undefined): BackoffHint | null {
    if (!account) return null;
    const retry = this.retryAfter(account);
    if (retry === 0) return null;
    return { retry_after: retry, backoff_until: Math.ceil((this.record(account) as WebLoginRecord).backoffUntil / 1000) };
  }

  /** Answer of a web login refused by the guard: no call to Pronote was made. */
  backoffError(account: string): HttpError {
    const hint = this.hint(account) ?? { retry_after: 1, backoff_until: Math.ceil(this.now() / 1000) + 1 };
    return new HttpError(429, "web_login_backoff", hint, { "retry-after": String(hint.retry_after) });
  }

  /** State of an account (GET /session/info); zeros and nulls for an account never refused, or unknown (null). */
  status(account: string | null | undefined): WebLoginStatus {
    const record = account ? this.record(account) : undefined;
    const now = this.now();
    if (!record) return { failures: 0, recentFailures: 0, backoffUntil: null, retryAfter: 0, lastFailureAt: null, lastKind: null };
    const active = record.backoffUntil > now;
    return {
      failures: record.failures,
      recentFailures: this.recentOf(record, now).length,
      backoffUntil: active ? Math.ceil(record.backoffUntil / 1000) : null,
      retryAfter: active ? Math.max(1, Math.ceil((record.backoffUntil - now) / 1000)) : 0,
      lastFailureAt: record.lastFailureAt === null ? null : Math.floor(record.lastFailureAt / 1000),
      lastKind: record.lastKind,
    };
  }

  /** Aggregate of the signed health report: no account identity. */
  stats(): { accountsInBackoff: number; failuresLast10Min: number } {
    const now = this.now();
    const records = Object.values(this.records);
    return {
      accountsInBackoff: records.filter((record) => record.backoffUntil > now).length,
      failuresLast10Min: records.reduce((sum, record) => sum + this.recentOf(record, now).length, 0),
    };
  }

  /** A web login succeeded: the back-off and the consecutive refusals of the account are cleared. */
  recordSuccess(account: string): void {
    const record = this.record(account);
    if (!record) return;
    const changed = record.failures !== 0 || record.backoffUntil !== 0;
    record.failures = 0;
    record.backoffUntil = 0;
    if (changed) this.store.save();
  }

  /**
   * A web login failed: counted in the recent failures whatever its kind; a refusal by Pronote (isRefusal) starts the
   * back-off, or extends it (60 s, 2 min, 5 min, then 15 min).
   */
  recordFailure(account: string, error: unknown): void {
    const now = this.now();
    this.purge(now);
    const key = WebLoginGuard.keyOf(account);
    const record = this.record(account) ?? (this.records[key] = { failures: 0, backoffUntil: 0, lastFailureAt: null, lastKind: null, recent: [] });
    record.recent = [...this.recentOf(record, now), now].slice(-MAX_WEB_LOGIN_RECENT);
    record.lastFailureAt = now;
    record.lastKind = failureKind(error);
    if (!isRefusal(error)) return;
    record.failures++;
    const delay = BACKOFF_STEPS[Math.min(record.failures, BACKOFF_STEPS.length) - 1];
    record.backoffUntil = Math.max(record.backoffUntil, now + delay * 1000);
    // Written at once: the host restarts the process often, and a restart must not erase the back-off.
    this.store.save();
  }

  /**
   * Runs a web login of an account under the guard.
   * - key: flightKey of the request; the requests of the same key waiting or in flight share one answer;
   * - interactive: the request carries a PIN; it is never reused nor refused by the back-off;
   * - reuse: answer built from the web session of the account still alive, null when there is none;
   * - attempt: the real login (calls Pronote). Its failure is recorded, then thrown to every merged request.
   */
  run<T>(account: string, options: { key: string; interactive: boolean; reuse: () => T | null; attempt: () => Promise<T> }): Promise<T> {
    const { key, interactive, reuse, attempt } = options;
    // During a back-off the answer is immediate: it does not wait for a login in flight (one with a PIN).
    if (!interactive && this.retryAfter(account) > 0 && reuse() === null) return Promise.reject(this.backoffError(account));
    const id = `${account}|${key}`;
    const flying = this.flights.get(id);
    if (flying) return flying as Promise<T>;
    const flight = serializeLogin(`${account}|web`, async (): Promise<T> => {
      if (!interactive) {
        // Checked again inside the lock: the login that ran before this one may have opened the session, or been refused.
        const reused = reuse();
        if (reused !== null) return reused;
        if (this.retryAfter(account) > 0) throw this.backoffError(account);
      }
      try {
        const result = await attempt();
        this.recordSuccess(account);
        return result;
      } catch (error) {
        this.recordFailure(account, error);
        throw error;
      }
    });
    this.flights.set(id, flight);
    const clear = () => {
      if (this.flights.get(id) === flight) this.flights.delete(id);
    };
    flight.then(clear, clear);
    return flight;
  }

  /** Forgets everything (tests). */
  reset(): void {
    for (const key of Object.keys(this.records)) delete this.records[key];
    this.flights.clear();
    this.now = Date.now;
  }
}

/** Guard of the application. */
export const webLoginGuard = new WebLoginGuard();
