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
 *
 * Web Espace Professeurs (0.10.0): an account may also hold a session of the web space (login with the password,
 * "space": "web"), sent by Moodle in X-Pronoteio-Web-Session beside the main one. It is kept separately (one web
 * session per account), never reconnected (no token chain for the web space: web_session_expired, Moodle logs in again),
 * and used for the whole request once a call needed a tab the mobile session lacks (space.ts, app.ts).
 * 0.15.0: a web login without PIN of an account whose web session is alive gets it back (webLoginGuard.ts); a web
 * session Pronote reports as lost is forgotten at once.
 */
import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { SessionHandle } from "pawnote";
import { lostSessionReason } from "./pronote/lostSession.js";
import { config } from "./config.js";
import { HttpError } from "./errors.js";
import { rememberUserData, userData } from "./pronote/userdata.js";
import { stateStore } from "./state.js";
import { serializeLogin } from "./tokenStore.js";
import { currentContext } from "./context.js";
import { setSpace, type Space } from "./space.js";

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
  /** 0.10.0: space of the session (mobile: Pawnote login; web: Espace Professeurs, professeur.html). */
  space: Space;
  /** 0.10.0: how the session was opened (token, credentials). */
  loginMode: "token" | "credentials";
};

const sessions = new Map<string, SessionEntry>();
const byAccount = new Map<string, string>();
/** 0.16.0: instant (ms) of the last web session opened for an account, kept after that session is gone (sessionState.ts). */
const webOpened = new Map<string, number>();
const MAX_WEB_OPENED = 500;

/** Web session sent by Moodle beside the main one (0.10.0), "" when none. */
export const webSessionIdOf = (request: FastifyRequest): string => String(request.headers["x-pronoteio-web-session"] ?? "");

/** Session of the request: the web one while the request runs on it (replay after WebSessionRequired), else the main one. */
const sessionIdOf = (request: FastifyRequest): string =>
  currentContext()?.webActive ? webSessionIdOf(request) : String(request.headers["x-pronoteio-session"] ?? "");

/** Key of the web session of an account in byAccount (the main session keeps the account key). */
const webKey = (account: string): string => `${account}|web`;

/**
 * Opens a session; with an account, it replaces the account's previous session of the same space (one session per
 * account and space).
 */
export const createSession = (
  handle: SessionHandle,
  account?: { key: string; login: LoginParams },
  options: { space?: Space; loginMode?: "token" | "credentials" } = {},
): string => {
  const id = randomUUID();
  const now = Date.now();
  const space = options.space ?? "mobile";
  if (account) {
    const key = space === "web" ? webKey(account.key) : account.key;
    const previous = byAccount.get(key);
    if (previous) sessions.delete(previous);
    byAccount.set(key, id);
  }
  if (options.space) setSpace(handle, options.space);
  if (account && space === "web") {
    webOpened.delete(account.key);
    webOpened.set(account.key, now);
    for (const key of webOpened.keys()) {
      if (webOpened.size <= MAX_WEB_OPENED) break;
      webOpened.delete(key);
    }
  }
  sessions.set(id, { id, handle, expires: now + config.sessionTtl, created: now, lastUsed: now, account: account?.key ?? null,
    login: account?.login ?? null, generation: 0, reconnects: 0, lastReconnect: null, state: "open", space,
    loginMode: options.loginMode ?? "token" });
  return id;
};

/** Entry of the web session sent with a request (X-Pronoteio-Web-Session), undefined when absent, unknown or expired. */
export const webSessionEntry = (request: FastifyRequest): SessionEntry | undefined => {
  const entry = sessions.get(webSessionIdOf(request));
  return entry && entry.space === "web" && entry.expires >= Date.now() ? entry : undefined;
};

/** Open session of an account, to be reused by its next token login; null when none is alive. */
export const sessionOfAccount = (account: string): SessionEntry | null => {
  const id = byAccount.get(account);
  const entry = id ? sessions.get(id) : undefined;
  if (!entry || entry.expires < Date.now() || entry.state === "lost") return null;
  entry.expires = Date.now() + config.sessionTtl;
  return entry;
};

/**
 * 0.15.0: web session of an account still alive in the sidecar, to be given back by its next web login without PIN
 * (webLoginGuard.ts); null when none. A web session Pronote reported as lost was forgotten (forgetSession).
 */
export const webSessionOfAccount = (account: string): SessionEntry | null => {
  const entry = sessionOfAccount(webKey(account));
  return entry && entry.space === "web" ? entry : null;
};

/** 0.16.0: live session by its id, without touching its lifetime (state of the sessions, grouped reads). */
export const sessionById = (id: string): SessionEntry | undefined => {
  const entry = id === "" ? undefined : sessions.get(id);
  return entry && entry.expires >= Date.now() && entry.state !== "lost" ? entry : undefined;
};

/** 0.16.0: live session of an account in a space, without touching its lifetime. */
export const accountSession = (account: string, space: Space): SessionEntry | undefined => {
  const entry = sessionById(byAccount.get(space === "web" ? webKey(account) : account) ?? "");
  return entry && entry.space === space ? entry : undefined;
};

/** 0.16.0: instant (ms) the last web session of an account was opened, null when none ever was since the start. */
export const webOpenedAt = (account: string): number | null => webOpened.get(account) ?? null;

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
    throw new HttpError(401, currentContext()?.webActive ? "web_session_expired" : "session_expired");
  }
  entry.expires = Date.now() + config.sessionTtl;
  entry.lastUsed = Date.now();
  return entry.handle;
};

/** Why a session is forgotten: its lifetime ended, the client logged out, or Pronote closed it (web session). */
export type ForgetReason = "expired" | "logout" | "lost";

const forgotten: ((entry: SessionEntry, reason: ForgetReason) => void)[] = [];

/** 0.16.0: tells a module (grouped reads) when a session is forgotten. */
export const onSessionForgotten = (listener: (entry: SessionEntry, reason: ForgetReason) => void): void => {
  forgotten.push(listener);
};

const forget = (entry: SessionEntry, reason: ForgetReason = "expired"): void => {
  sessions.delete(entry.id);
  const key = entry.account && (entry.space === "web" ? webKey(entry.account) : entry.account);
  if (key && byAccount.get(key) === entry.id) byAccount.delete(key);
  for (const listener of forgotten) listener(entry, reason);
};

/**
 * 0.15.0: forgets a session Pronote reported as lost and that cannot be reconnected (web session: no token chain), so
 * that the next web login of the account is a real one instead of getting the dead session back.
 */
export const forgetSession = (entry: SessionEntry | undefined): void => {
  if (entry) forget(entry, "lost");
};

export const dropSession = (request: FastifyRequest): void => {
  const entry = sessions.get(sessionIdOf(request));
  if (entry) forget(entry, "logout");
};

/* ---- Lost sessions and reconnection ---- */

// 0.16.0: moved to pronote/lostSession.ts (no dependency on the configuration), still exported from here.
export { lostSessionReason };

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
  // A web session has no token chain: it is never reconnected (Moodle logs in again on web_session_expired).
  if (!reconnector || !entry.account || !entry.login || entry.space === "web") return false;
  const run = reconnector;
  return serializeLogin(entry.account, async () => {
    if (entry.generation !== seen) return entry.state === "open";
    entry.state = "reconnecting";
    try {
      const fresh = await run(entry);
      setSpace(entry.handle, entry.space);
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
      // 0.15.0: a web session found gone is forgotten (never reconnected); the next web login is a real one.
      if (reason && entry.space === "web") forget(entry, "lost");
      else if (reason) await reconnect(entry, reason);
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
      space: entry.space,
      ageSeconds: Math.round((now - entry.created) / 1000),
      idleSeconds: Math.round((now - entry.lastUsed) / 1000),
      reconnects: entry.reconnects,
      lastReconnect: entry.lastReconnect ? new Date(entry.lastReconnect).toISOString() : null,
    })),
  };
};
