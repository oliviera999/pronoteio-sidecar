import type { FastifyInstance } from "fastify";
import * as pawnote from "pawnote";
import {
  AccountKind,
  finishLoginManually,
  loginCredentials,
  loginToken,
  presence,
  SecurityError,
  securityCheckPIN,
  securitySave,
  type RefreshInformation,
  type SessionHandle,
} from "pawnote";
import { readCache } from "../cache.js";
import { config } from "../config.js";
import { HttpError } from "../errors.js";
import type { SessionInfo } from "../normalise.js";
import { pronoteBaseUrl, webFetcher } from "../pronote/compat.js";
import { createCapturingHandle, userData } from "../pronote/userdata.js";
import { isPrimary } from "../lock.js";
import { isValidated, pronoteVersion } from "../pronote/formats.js";
import { stateStore } from "../state.js";
import {
  createSession,
  dropSession,
  requireSession,
  sessionEntry,
  sessionOfAccount,
  setPresenceSender,
  setReconnector,
  webSessionEntry,
} from "../session.js";
import { limiterOf } from "../pronote/limiter.js";
import { PRIORITY } from "../context.js";
import { accountKey, chainedTokenLogin, serializeLogin, TokenStore } from "../tokenStore.js";
import { functions } from "../teacher/functions.js";
import { stableId } from "../teacher/ids.js";

type LoginBody = {
  url: string;
  username: string;
  deviceuuid: string;
  password?: string;
  token?: string;
  pin?: string;
  devicename?: string;
  /** 0.10.0: "web" opens the web Espace Professeurs (professeur.html, "Domicile" mode) with the password. */
  space?: "mobile" | "web";
  /**
   * 0.11.1: navigator identifier (identifiantNav) given by Pronote at a previous web login. The web space recognises a
   * trusted device by it, not by deviceuuid: without it every web login came from a new browser, and the double
   * authentication asked the PIN each time.
   */
  navigator?: string;
};

/** Login of the web Espace Professeurs, added to Pawnote by tools/patch-pawnote.mjs (0.10.0); undefined when unpatched. */
type WebLogin = (
  handle: SessionHandle,
  options: { url: string; username: string; kind: AccountKind; deviceUUID: string; password: string; navigatorIdentifier?: string },
) => Promise<RefreshInformation>;
const loginWeb = (pawnote as unknown as { pronoteioLoginWeb?: WebLogin }).pronoteioLoginWeb;

/** Chain of the single-use tokens (see tokenStore.ts); null when PRONOTEIO_TOKEN_STORE=off. */
const tokenStore = config.tokenStoreFile === null ? null : new TokenStore(config.tokenStoreFile, config.secret, Date.now, config.secrets.slice(1));

/** Name shown in the teacher's Pronote "known devices" list (limited to 30 characters by Pronote). */
const DEFAULT_DEVICE_NAME = "Moodle pronoteio";

/**
 * Completes the double authentication asked by Pronote after a valid password.
 * With a PIN, the device is registered as trusted: the next token logins no longer ask for it.
 */
const completeSecurity = async (
  handle: SessionHandle,
  error: SecurityError,
  pin: string | undefined,
  devicename: string,
  onStep: (step: string) => void = () => {},
): Promise<RefreshInformation> => {
  const modal = error.handle;
  if (modal.shouldCustomPassword || modal.shouldCustomDoubleAuth) {
    // First connection: the teacher must choose a password / strategy in the Pronote web space.
    throw new HttpError(409, "security_setup_required");
  }
  if (modal.shouldEnterPIN) {
    if (pin === undefined) throw new HttpError(409, "pin_required");
    onStep("pin-check");
    if (!(await securityCheckPIN(handle, pin))) throw new HttpError(401, "bad_pin");
    onStep("pin-save");
    await securitySave(handle, modal, { pin, deviceName: devicename });
  } else if (modal.shouldEnterSource) {
    onStep("source-save");
    await securitySave(handle, modal, { deviceName: devicename });
  } else {
    throw new HttpError(409, "double_auth_required");
  }
  const { authentication, identity, initialUsername } = modal.context;
  onStep("finish");
  return finishLoginManually(handle, authentication, identity, initialUsername);
};

export const sessionInfo = (session: SessionHandle): SessionInfo => {
  const data = userData(session);
  return {
    displayname: session.user.name,
    version: session.instance.version.join("."),
    tabs: data.tabs ?? [],
    rights: data.rights,
    maxScale: data.maxScale,
    functions: Object.fromEntries(
      Object.entries(functions).map(([key, fn]) => [key, { name: fn.name, onglet: fn.onglet, configured: fn.name !== "" }]),
    ),
    writeMode: config.writeMode,
    pronoteversion: pronoteVersion(session),
    validated: isValidated(pronoteVersion(session)),
    classes: data.resources.map((item) => ({
      id: stableId(item.genre === 1 ? "class" : "group", item.label),
      name: item.label,
      type: item.genre === 1 ? ("class" as const) : ("group" as const),
      taught: item.taught,
      principal: item.principal,
    })),
  };
};

/** Pronote calls refused in a second process (P5): only the primary process talks to Pronote. */
export const assertPrimary = (): void => {
  if (!isPrimary()) throw new HttpError(503, "pronote_unavailable", { reason: "second_process" });
};

/**
 * Reconnection of a lost session with the token chain (P5): the latest token of the account, recorded at the previous
 * login, is presented to Pronote and the new one recorded. Without the token store (PRONOTEIO_TOKEN_STORE=off), no
 * reconnection: Moodle logs in again.
 */
setReconnector(async (entry) => {
  if (!tokenStore || !entry.account || !entry.login) throw new Error("no token chain");
  assertPrimary();
  const latest = tokenStore.latest(entry.account);
  if (latest === null) throw new Error("no token");
  const handle = createCapturingHandle();
  const base = { url: entry.login.url, username: entry.login.username, kind: AccountKind.TEACHER, deviceUUID: entry.login.deviceuuid };
  const refresh = await loginToken(handle, { ...base, token: latest });
  tokenStore.record(entry.account, latest, refresh.token);
  return handle;
});

/** Keep-alive of the idle sessions: Pawnote's presence request (Presence / Navigation as the official client). */
setPresenceSender(async (handle) => {
  if (!isPrimary()) return;
  await limiterOf(handle).acquire(1, PRIORITY.bulk);
  await presence(handle);
});

/** Navigator identifier (identifiantNav) Pronote gave the web session, null when absent or not a short string. */
export const navigatorOf = (handle: SessionHandle): string | null => {
  const value = (handle.instance as { navigatorIdentifier?: unknown } | undefined)?.navigatorIdentifier;
  return typeof value === "string" && /^[\x21-\x7e]{1,200}$/.test(value) ? value : null;
};

/**
 * Login of the web Espace Professeurs (0.10.0): professeur.html in "Domicile" mode, with the password only. The mobile
 * token is not accepted by this space (and a refused try would consume it): web_token_refused, without any call to
 * Pronote. A double authentication asks the PIN as for the mobile space (pin_required, bad_pin). The session is kept
 * beside the main one (one web session per account), never reconnected. The password is neither logged nor returned.
 * 0.11.1: the navigator identifier of the previous web login is sent again (see LoginBody.navigator) and the new one
 * returned.
 */
const webLogin = async (body: LoginBody) => {
  const { url, username, deviceuuid, password, pin, devicename, navigator } = body;
  if (password === undefined) throw new HttpError(401, "web_token_refused");
  if (!loginWeb) throw new HttpError(501, "not_implemented:web_space");
  assertPrimary();
  const handle = createCapturingHandle(webFetcher());
  const base = { url: pronoteBaseUrl(url), username, kind: AccountKind.TEACHER, deviceUUID: deviceuuid };
  const account = accountKey(base.url, username, deviceuuid);
  // 0.11.3: step reached by an unexpected error (login, security, session), written to the access log.
  let step = "login";
  const sessionid = await serializeLogin(`${account}|web`, async () => {
    try {
      try {
        await loginWeb(handle, { ...base, password, ...(navigator ? { navigatorIdentifier: navigator } : {}) });
      } catch (error) {
        if (!(error instanceof SecurityError)) throw error;
        step = "security";
        await completeSecurity(handle, error, pin, devicename ?? DEFAULT_DEVICE_NAME, (reached) => { step = reached; });
      }
      step = "session";
      return createSession(handle, { key: account, login: { url: base.url, username, deviceuuid } },
        { space: "web", loginMode: "credentials" });
    } catch (error) {
      if (error !== null && typeof error === "object") Object.assign(error, { loginStep: `web:${step}` });
      throw error;
    }
  });
  return {
    sessionid,
    displayname: handle.user.name,
    version: handle.instance.version.join("."),
    space: "web" as const,
    login: "credentials" as const,
    tabs: userData(handle).tabs ?? [],
    // To send back at the next web login (0.11.1): the device trusted after the PIN is this browser identifier.
    navigator: navigatorOf(handle),
  };
};

export default async function sessionRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: LoginBody }>(
    "/session/login",
    {
      schema: {
        body: {
          type: "object",
          required: ["url", "username", "deviceuuid"],
          properties: {
            url: { type: "string", pattern: "^https://" },
            username: { type: "string", minLength: 1 },
            deviceuuid: { type: "string", minLength: 8 },
            password: { type: "string", minLength: 1 },
            token: { type: "string", minLength: 1 },
            pin: { type: "string", pattern: "^[0-9]{4,8}$" },
            devicename: { type: "string", minLength: 1, maxLength: 30 },
            space: { type: "string", enum: ["mobile", "web"], default: "mobile" },
            navigator: { type: "string", pattern: "^[\\x21-\\x7e]{1,200}$" },
          },
          oneOf: [{ required: ["password"] }, { required: ["token"] }],
        },
      },
    },
    async (request) => {
      const { url, username, deviceuuid, password, token, pin, devicename, space } = request.body;
      if (space === "web") return webLogin(request.body);
      assertPrimary();
      const handle = createCapturingHandle();
      const base = { url: pronoteBaseUrl(url), username, kind: AccountKind.TEACHER, deviceUUID: deviceuuid };
      const account = accountKey(base.url, username, deviceuuid);
      const login = { url: base.url, username, deviceuuid };

      const secured = async (login: Promise<RefreshInformation>): Promise<RefreshInformation> => {
        try {
          return await login;
        } catch (error) {
          if (!(error instanceof SecurityError)) throw error;
          return completeSecurity(handle, error, pin, devicename ?? DEFAULT_DEVICE_NAME);
        }
      };
      const onRecordError = (error: unknown) => request.log.warn({ err: error }, "token store not written");

      // One login at a time per account: the token is single use.
      type Outcome = { reused: ReturnType<typeof sessionOfAccount>; refresh: RefreshInformation | null; sessionid: string | null };
      const outcome = await serializeLogin(account, async (): Promise<Outcome> => {
        // One session per account (P5): a token login of an account whose session is open gets it back, without a new
        // Pronote login (the token sent is not consumed: the valid token of the chain is returned unchanged).
        if (token !== undefined) {
          const reused = sessionOfAccount(account);
          if (reused) return { reused, refresh: null, sessionid: null };
        }
        const refresh = await doLogin();
        // Registered inside the lock: a concurrent login of the same account then reuses it.
        return { reused: null, refresh, sessionid: createSession(handle, { key: account, login },
          { space: "mobile", loginMode: password !== undefined ? "credentials" : "token" }) };
      });
      if (outcome.reused) {
        return {
          sessionid: outcome.reused.id,
          token: tokenStore ? tokenStore.resolve(account, token as string).token : token,
          displayname: outcome.reused.handle.user.name,
          version: outcome.reused.handle.instance.version.join("."),
          reused: true,
          space: "mobile" as const,
          login: outcome.reused.loginMode,
        };
      }
      const refresh = outcome.refresh as RefreshInformation;
      // Version of the Pronote server (P6), kept in the state for the health check.
      const seen = pronoteVersion(handle);
      stateStore.state.pronote = { version: seen, validated: isValidated(seen), seenAt: new Date().toISOString() };

      async function doLogin(): Promise<RefreshInformation> {
        if (password !== undefined) {
          const result = await secured(loginCredentials(handle, { ...base, password }));
          try {
            tokenStore?.record(account, null, result.token);
          } catch (error) {
            onRecordError(error);
          }
          return result;
        }
        const result = await chainedTokenLogin(tokenStore, account, token as string,
          (current) => secured(loginToken(handle, { ...base, token: current })), onRecordError);
        if (result.substituted) request.log.info("token login: previous answer lost, latest token of the chain used");
        return result;
      }

      return {
        sessionid: outcome.sessionid,
        // Single-use: Moodle must store it and send it at the next login (the sidecar keeps the chain too).
        token: refresh.token,
        displayname: handle.user.name,
        version: handle.instance.version.join("."),
        space: "mobile" as const,
        login: password !== undefined ? ("credentials" as const) : ("token" as const),
      };
    },
  );

  /**
   * Information on the open session (version, tabs, rights, functions, write mode), for the health check. 0.10.0: space
   * and login mode of the session, tabs of the web session sent in X-Pronoteio-Web-Session (webtabs).
   */
  app.get("/session/info", async (request) => {
    const info = sessionInfo(requireSession(request));
    const entry = sessionEntry(request);
    const web = webSessionEntry(request);
    return {
      ...info,
      space: entry?.space ?? "mobile",
      login: entry?.loginMode ?? "token",
      ...(web ? { webtabs: userData(web.handle).tabs ?? [] } : {}),
    };
  });

  app.post("/session/logout", async (request) => {
    readCache.dropSession(String(request.headers["x-pronoteio-session"] ?? ""));
    dropSession(request);
    return { ok: true };
  });
}
