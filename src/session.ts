/**
 * Open Pronote sessions, in memory (tokens are not kept here: Moodle stores them, tokenStore.ts keeps the chain).
 *
 * P5 (0.9.0): one session per linked account, reused and kept alive.
 * - A token login of an account that already has an open session gets that session back (no new Pronote login: two
 *   concurrent sessions of one account may push each other out). A password login replaces it.
 * - Keep-alive: a presence request (as the official client, every PRONOTEIO_PRESENCE_INTERVAL seconds, 120) on the
 *   sessions idle for that long, while Moodle still uses them (sliding lifetime PRONOTEIO_SESSION_TTL).
 * - Session expired or closed by Pronote (the teacher connected elsewhere, when Pronote imposes it): reconnect with the
 *   token chain, once, under the login lock of the account (two requests during a reconnection make one login), then
 *   the request is replayed once (app.ts). A write is not replayed once its write call was sent.
 */
import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { ServerSideError, SessionExpiredError, type SessionHandle } from "pawnote";
import { config } from "./config.js";
import { HttpError } from "./errors.js";
import { rememberUserData, userData } from "./pronote/userdata.js";
import { stateStore } from "./state.js";
import { serializeLogin } from "./tokenStore.js";

/** Login parameters of an account (no secret), to reconnect with the token chain. */
export type LoginParams = { url: string; username: string; deviceuuid: string };

export type SessionEntry = {
  id: string;
  handle: SessionHandle;
  expires: number;
  created: number;
  lastUsed: number;
  /** Key of the account (tokenStore.accountKey), null for a session opened without it (tests). */
  account: string | null;
  login: LoginParams | null;
  /** Incremented at each reconnection (the handle was swapped). */
  generation: number;
  reconnects: number;
  lastReconnect: number | null;
  state: "open" | "reconnecting" | "lost";
};

const sessions = new Map<string, SessionEntry>();
const byAccount = new Map<string, string>();

const sessionIdOf = (request: FastifyRequest): string => String(request.headers["x-pronoteio-session"] ?? "");

/** Opens a session; with an account, it replaces the account's previous session (one session per account). */
export const createSession = (handle: SessionHandle, account?: { key: string; login: LoginParams }): string => {
  const id = randomUUID();
  const now = Date.now();
  if (account) {
    const previous = byAccount.get(account.key);
    if (previous) sessions.delete(previous);
    byAccount.set(account.key, id);
  }
  sessions.set(id, { id, handle, expires: now + config.sessionTtl, created: now, lastUsed: now, account: account?.key ?? null,
    login: account?.login ?? null, generation: 0, reconnects: 0, lastReconnect: null, state: "open" });
  return id;
};

/** Open session of an account, to be reused by its next token login; null when none is alive. */
export const sessionOfAccount = (account: string): SessionEntry | null => {
  const id = byAccount.get(account);
  const entry = id ? sessions.get(id) : undefined;
  if (!entry || entry.expires < Date.now() || entry.state === "lost") return null;
  entry.expires = Date.now() + config.sessionTtl;
  return entry;
};

/** Entry of the request's session (without touching it), undefined when unknown or expired. */
export const sessionEntry = (request: FastifyRequest): SessionEntry | undefined => {
  const entry = sessions.get(sessionIdOf(request));
  return entry && entry.expires >= Date.now() ? entry : undefined;
};

/** Session of a request (X-Pronoteio-Session header), with sliding expiry. */
export const requireSession = (request: FastifyRequest): SessionHandle => {
  const id = sessionIdOf(request);
  const entry = sessions.get(id);
  if (!entry || entry.expires < Date.now()) {
    if (entry) forget(entry);
    throw new HttpError(401, "session_expired");
  }
  entry.expires = Date.now() + config.sessionTtl;
  entry.lastUsed = Date.now();
  return entry.handle;
};

const forget = (entry: SessionEntry): void => {
  sessions.delete(entry.id);
  if (entry.account && byAccount.get(entry.account) === entry.id) byAccount.delete(entry.account);
};

export const dropSession = (request: FastifyRequest): void => {
  const entry = sessions.get(sessionIdOf(request));
  if (entry) forget(entry);
};

/* ---- Lost sessions and reconnection ---- */

/** Pronote messages of a session closed because the account connected elsewhere (candidates, not validated). */
const REPLACED = /autre (poste|appareil|navigateur)|connect[ée]+ ailleurs|nouvelle connexion|session (a été )?(fermée|interrompue|terminée)|vous avez été déconnecté/i;

/** Why a Pronote error means the session is gone: "expired", "replaced", or null for any other error. */
export const lostSessionReason = (error: unknown): "expired" | "replaced" | null => {
  if (error instanceof SessionExpiredError) return "expired";
  if (error instanceof ServerSideError && REPLACED.test(error.message)) return "replaced";
  return null;
};

/** Error answered when a lost session could not be reconnected: Moodle logs in again (session_expired). */
export const sessionLostError = (reason: "expired" | "replaced"): HttpError =>
  new HttpError(401, "session_expired", { code: reason === "replaced" ? "session_replaced" : "session_expired" });

/** Opens a new Pronote session for the account of an entry (token chain). Replaced in tests. */
export type Reconnector = (entry: SessionEntry) => Promise<SessionHandle>;

let reconnector: Reconnector | null = null;

export const setReconnector = (fn: Reconnector | null): void => {
  reconnector = fn;
};

/**
 * Reconnects the session of an entry, once for all the requests that saw the same generation: the login runs under
 * the login lock of the account, and a request arriving after another one reconnected does nothing. The handle object
 * is kept (rate limiter, user data): the new session is copied into it.
 */
export const reconnect = async (entry: SessionEntry, reason: "expired" | "replaced", seen = entry.generation): Promise<boolean> => {
  if (!reconnector || !entry.account || !entry.login) return false;
  const run = reconnector;
  return serializeLogin(entry.account, async () => {
    if (entry.generation !== seen) return entry.state === "open";
    entry.state = "reconnecting";
    try {
      const fresh = await run(entry);
      const data = userData(fresh);
      Object.assign(entry.handle, fresh);
      rememberUserData(entry.handle, data);
      entry.generation++;
      entry.reconnects++;
      entry.lastReconnect = Date.now();
      entry.state = "open";
      stateStore.recordReconnect(reason, true);
      return true;
    } catch {
      entry.state = "lost";
      stateStore.recordReconnect(reason, false);
      return false;
    }
  }).catch(() => false);
};

/* ---- Keep-alive ---- */

const PRESENCE_MS = Math.max(30, Number.parseInt(process.env.PRONOTEIO_PRESENCE_INTERVAL ?? "120", 10) || 120) * 1000;

/** Sends one presence request on a session. Replaced in tests; null disables the keep-alive. */
export type PresenceSender = (handle: SessionHandle) => Promise<void>;

let presenceSender: PresenceSender | null = null;

export const setPresenceSender = (fn: PresenceSender | null): void => {
  presenceSender = fn;
};

/** One round of keep-alive: presence on the idle sessions, reconnection of the lost ones. */
export const keepAlive = async (now = Date.now()): Promise<void> => {
  for (const entry of sessions.values()) {
    if (entry.expires < now) {
      forget(entry);
      continue;
    }
    if (!presenceSender || entry.state !== "open" || now - entry.lastUsed < PRESENCE_MS) continue;
    try {
      await presenceSender(entry.handle);
      entry.lastUsed = now;
    } catch (error) {
      const reason = lostSessionReason(error);
      if (reason) await reconnect(entry, reason);
    }
  }
};

setInterval(() => {
  void keepAlive().catch(() => undefined);
}, Math.min(PRESENCE_MS, 60_000)).unref();

/* ---- Health ---- */

export const sessionStats = (now = Date.now()) => {
  const list = [...sessions.values()].filter((entry) => entry.expires >= now);
  return {
    open: list.length,
    states: list.map((entry) => ({
      state: entry.state,
      ageSeconds: Math.round((now - entry.created) / 1000),
      idleSeconds: Math.round((now - entry.lastUsed) / 1000),
      reconnects: entry.reconnects,
      lastReconnect: entry.lastReconnect ? new Date(entry.lastReconnect).toISOString() : null,
    })),
  };
};
