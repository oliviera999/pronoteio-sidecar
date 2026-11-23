import { listOf } from "../pronote/encoding.js";
import * as pawnote from "pawnote";
import { AccountKind, finishLoginManually, loginCredentials, loginToken, presence, SecurityError, securityCheckPIN, securitySave, } from "pawnote";
import { readCache } from "../cache.js";
import { config } from "../config.js";
import { HttpError } from "../errors.js";
import { pronoteBaseUrl, webFetcher } from "../pronote/compat.js";
import { createCapturingHandle, userData } from "../pronote/userdata.js";
import { isPrimary } from "../lock.js";
import { isValidated, pronoteVersion } from "../pronote/formats.js";
import { stateStore } from "../state.js";
import { createSession, dropSession, requireSession, sessionEntry, sessionOfAccount, setPresenceSender, setReconnector, webSessionEntry, webSessionIdOf, webSessionOfAccount, } from "../session.js";
import { limiterOf } from "../pronote/limiter.js";
import { PRIORITY } from "../context.js";
import { accountKey, chainedTokenLogin, serializeLogin, TokenStore } from "../tokenStore.js";
import { flightKey, webLoginGuard } from "../webLoginGuard.js";
import { sessionState } from "../sessionState.js";
import { functions } from "../teacher/functions.js";
import { stableId } from "../teacher/ids.js";
const patchedLoginWeb = pawnote.pronoteioLoginWeb;
let loginWeb = patchedLoginWeb;
/** Replaces the web login of Pawnote (tests: a stub, never a connection to Pronote); null restores the real one. */
export const setWebLogin = (fn) => {
    loginWeb = fn ?? patchedLoginWeb;
};
/** Chain of the single-use tokens (see tokenStore.ts); null when PRONOTEIO_TOKEN_STORE=off. */
const tokenStore = config.tokenStoreFile === null ? null : new TokenStore(config.tokenStoreFile, config.secret, Date.now, config.secrets.slice(1));
/** Name shown in the teacher's Pronote "known devices" list (limited to 30 characters by Pronote). */
const DEFAULT_DEVICE_NAME = "Moodle pronoteio";
/**
 * Completes the double authentication asked by Pronote after a valid password.
 * With a PIN, the device is registered as trusted: the next token logins no longer ask for it.
 */
const completeSecurity = async (handle, error, pin, devicename, onStep = () => { }, tolerant = false) => {
    const modal = error.handle;
    if (modal.shouldCustomPassword || modal.shouldCustomDoubleAuth) {
        // First connection: the teacher must choose a password / strategy in the Pronote web space.
        throw new HttpError(409, "security_setup_required");
    }
    if (modal.shouldEnterPIN) {
        if (pin === undefined)
            throw new HttpError(409, "pin_required");
        onStep("pin-check");
        if (!(await securityCheckPIN(handle, pin)))
            throw new HttpError(401, "bad_pin");
        onStep("pin-save");
        await securitySave(handle, modal, { pin, deviceName: devicename });
    }
    else if (modal.shouldEnterSource) {
        onStep("source-save");
        await securitySave(handle, modal, { deviceName: devicename });
    }
    else {
        throw new HttpError(409, "double_auth_required");
    }
    const { authentication, identity, initialUsername } = modal.context;
    onStep("finish");
    try {
        return await finishLoginManually(handle, authentication, identity, initialUsername);
    }
    catch (error) {
        // Web space only (onStep given by webLogin): the PIN is accepted, only Pawnote's decoding of the user failed.
        if (!tolerant || !(error instanceof TypeError) || !tolerantUser(handle))
            throw error;
        onStep(`finish-tolerant:${typeErrorDetail(error)}`);
        return { token: authentication?.jetonConnexionAppliMobile, username: identity?.login ?? initialUsername,
            kind: handle.information.accountKind, url: handle.information.url,
            navigatorIdentifier: handle.instance?.navigatorIdentifier };
    }
};
export const sessionInfo = (session) => {
    const data = userData(session);
    return {
        displayname: session.user.name,
        version: session.instance.version.join("."),
        tabs: data.tabs ?? [],
        rights: data.rights,
        maxScale: data.maxScale,
        // 0.13.0: "school" when General.ListeNiveauxDAcquisitions was captured at login (see teacher/competencies.ts).
        levelsSource: listOf(data.acquisitionLevels).some((item) => Number(item?.G) >= 1 && /^\d{1,3}#/.test(String(item?.N ?? "")))
            ? "school" : "fallback",
        functions: Object.fromEntries(Object.entries(functions).map(([key, fn]) => [key, { name: fn.name, onglet: fn.onglet, configured: fn.name !== "" }])),
        writeMode: config.writeMode,
        pronoteversion: pronoteVersion(session),
        validated: isValidated(pronoteVersion(session)),
        classes: data.resources.map((item) => ({
            id: stableId(item.genre === 1 ? "class" : "group", item.label),
            name: item.label,
            type: item.genre === 1 ? "class" : "group",
            taught: item.taught,
            principal: item.principal,
        })),
    };
};
/** Pronote calls refused in a second process (P5): only the primary process talks to Pronote. */
export const assertPrimary = () => {
    if (!isPrimary())
        throw new HttpError(503, "pronote_unavailable", { reason: "second_process" });
};
/**
 * Reconnection of a lost session with the token chain (P5): the latest token of the account, recorded at the previous
 * login, is presented to Pronote and the new one recorded. Without the token store (PRONOTEIO_TOKEN_STORE=off), no
 * reconnection: Moodle logs in again.
 */
setReconnector(async (entry) => {
    if (!tokenStore || !entry.account || !entry.login)
        throw new Error("no token chain");
    assertPrimary();
    const latest = tokenStore.latest(entry.account);
    if (latest === null)
        throw new Error("no token");
    const handle = createCapturingHandle();
    const base = { url: entry.login.url, username: entry.login.username, kind: AccountKind.TEACHER, deviceUUID: entry.login.deviceuuid };
    const refresh = await loginToken(handle, { ...base, token: latest });
    tokenStore.record(entry.account, latest, refresh.token);
    return handle;
});
/** Keep-alive of the idle sessions: Pawnote's presence request (Presence / Navigation as the official client). */
setPresenceSender(async (handle) => {
    if (!isPrimary())
        return;
    await limiterOf(handle).acquire(1, PRIORITY.bulk);
    await presence(handle);
});
/**
 * 0.11.4: session user rebuilt from the identity of ParametresUtilisateur when Pawnote's decoder fails on the answer
 * of the web space (case of 20/11/2026: TypeError at the end of a web login, after the PIN was accepted). Only the
 * fields the sidecar uses (name, first resource) are filled; null when the answer was not captured.
 */
export const tolerantUser = (handle) => {
    const identity = userData(handle).identity;
    if (!identity)
        return false;
    const resource = {
        id: identity.id, kind: identity.kind, name: identity.name, establishmentName: identity.establishment,
        className: undefined, profilePicture: null, tabs: new Map(), isDirector: false, isDelegate: false, isMemberCA: false,
    };
    handle.user = {
        id: identity.id, kind: identity.kind, name: identity.name, resources: [resource],
        authorizations: { canReadDiscussions: false, canDiscuss: false, canDiscussWithStaff: false, canDiscussWithParents: false,
            canDiscussWithStudents: false, canDiscussWithTeachers: false, hasAdvancedDiscussionEditor: false,
            maxAssignmentFileUploadSize: 0, tabs: [] },
    };
    handle.userResource = resource;
    return true;
};
/** Safe detail of a TypeError of a decoder ("reading 'V'"): the property name only, never data. */
export const typeErrorDetail = (error) => {
    if (!(error instanceof TypeError))
        return null;
    const match = /\(reading '([\w$]{1,40})'\)/.exec(error.message);
    return match ? `reading:${match[1]}` : "type_error";
};
/** Navigator identifier (identifiantNav) Pronote gave the web session, null when absent or not a short string. */
export const navigatorOf = (handle) => {
    const value = handle.instance?.navigatorIdentifier;
    return typeof value === "string" && /^[\x21-\x7e]{1,200}$/.test(value) ? value : null;
};
/**
 * Fingerprint (flightKey: keyed, in memory only) of the password that opened each web session. A web session is given
 * back only to a login with the same password: another one (changed, mistyped) must be checked by Pronote, otherwise
 * Moodle would record a password never verified.
 */
const openedWith = new WeakMap();
const webLoginAnswer = (sessionid, handle) => ({
    sessionid,
    displayname: handle.user.name,
    version: handle.instance.version.join("."),
    space: "web",
    login: "credentials",
    tabs: userData(handle).tabs ?? [],
    // To send back at the next web login (0.11.1): the device trusted after the PIN is this browser identifier.
    navigator: navigatorOf(handle),
});
/**
 * Login of the web Espace Professeurs (0.10.0): professeur.html in "Domicile" mode, with the password only. The mobile
 * token is not accepted by this space (and a refused try would consume it): web_token_refused, without any call to
 * Pronote. A double authentication asks the PIN as for the mobile space (pin_required, bad_pin). The session is kept
 * beside the main one (one web session per account), never reconnected. The password is neither logged nor returned.
 * 0.11.1: the navigator identifier of the previous web login is sent again (see LoginBody.navigator) and the new one
 * returned.
 * 0.15.0: every web login goes through the guard of the account (webLoginGuard.ts), whatever the caller: one login in
 * flight (the concurrent requests share its answer), the web session still alive given back without a call to Pronote
 * ("reused": true) unless a PIN or another password is sent, and no login sent to Pronote during the back-off that
 * follows a refusal (429 web_login_backoff). Case of 21/11/2026: a burst of web logins every 3 to 4 seconds, all
 * refused by Pronote.
 */
const webLogin = async (body) => {
    const { url, username, deviceuuid, password, pin, devicename, navigator } = body;
    if (password === undefined) {
        const refused = new HttpError(401, "web_token_refused");
        try {
            // Counted in the recent failures of the account (health), without back-off: nothing was sent to Pronote.
            webLoginGuard.recordFailure(accountKey(pronoteBaseUrl(url), username, deviceuuid), refused);
        }
        catch {
            // Address that cannot be parsed: the refusal is answered as before.
        }
        throw refused;
    }
    const login = loginWeb;
    if (!login)
        throw new HttpError(501, "not_implemented:web_space");
    assertPrimary();
    const base = { url: pronoteBaseUrl(url), username, kind: AccountKind.TEACHER, deviceUUID: deviceuuid };
    const account = accountKey(base.url, username, deviceuuid);
    return webLoginGuard.run(account, {
        key: flightKey([password, pin, navigator]),
        interactive: pin !== undefined,
        reuse: () => {
            const open = webSessionOfAccount(account);
            return open && openedWith.get(open.handle) === flightKey([password])
                ? { ...webLoginAnswer(open.id, open.handle), reused: true } : null;
        },
        attempt: async () => {
            const handle = createCapturingHandle(webFetcher());
            // 0.11.3: step reached by an unexpected error (login, security, session), written to the access log.
            let step = "login";
            try {
                try {
                    await login(handle, { ...base, password, ...(navigator ? { navigatorIdentifier: navigator } : {}) });
                }
                catch (error) {
                    if (error instanceof TypeError && handle.information && tolerantUser(handle)) {
                        // 0.11.4: trusted device, no PIN asked, but the same decoding of the user failed at the end of the login.
                        step = `login-tolerant:${typeErrorDetail(error)}`;
                    }
                    else {
                        if (!(error instanceof SecurityError))
                            throw error;
                        step = "security";
                        await completeSecurity(handle, error, pin, devicename ?? DEFAULT_DEVICE_NAME, (reached) => { step = reached; }, true);
                    }
                }
                step = "session";
                const sessionid = createSession(handle, { key: account, login: { url: base.url, username, deviceuuid } }, { space: "web", loginMode: "credentials" });
                openedWith.set(handle, flightKey([password]));
                return webLoginAnswer(sessionid, handle);
            }
            catch (error) {
                const detail = typeErrorDetail(error);
                if (error !== null && typeof error === "object") {
                    Object.assign(error, { loginStep: `web:${step}${detail ? `:${detail}` : ""}` });
                }
                throw error;
            }
        },
    });
};
export default async function sessionRoutes(app) {
    app.post("/session/login", {
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
    }, async (request) => {
        const { url, username, deviceuuid, password, token, pin, devicename, space } = request.body;
        if (space === "web")
            return webLogin(request.body);
        assertPrimary();
        const handle = createCapturingHandle();
        const base = { url: pronoteBaseUrl(url), username, kind: AccountKind.TEACHER, deviceUUID: deviceuuid };
        const account = accountKey(base.url, username, deviceuuid);
        const login = { url: base.url, username, deviceuuid };
        const secured = async (login) => {
            try {
                return await login;
            }
            catch (error) {
                if (!(error instanceof SecurityError))
                    throw error;
                return completeSecurity(handle, error, pin, devicename ?? DEFAULT_DEVICE_NAME);
            }
        };
        const onRecordError = (error) => request.log.warn({ err: error }, "token store not written");
        const outcome = await serializeLogin(account, async () => {
            // One session per account (P5): a token login of an account whose session is open gets it back, without a new
            // Pronote login (the token sent is not consumed: the valid token of the chain is returned unchanged).
            if (token !== undefined) {
                const reused = sessionOfAccount(account);
                if (reused)
                    return { reused, refresh: null, sessionid: null };
            }
            const refresh = await doLogin();
            // Registered inside the lock: a concurrent login of the same account then reuses it.
            return { reused: null, refresh, sessionid: createSession(handle, { key: account, login }, { space: "mobile", loginMode: password !== undefined ? "credentials" : "token" }) };
        });
        if (outcome.reused) {
            return {
                sessionid: outcome.reused.id,
                token: tokenStore ? tokenStore.resolve(account, token).token : token,
                displayname: outcome.reused.handle.user.name,
                version: outcome.reused.handle.instance.version.join("."),
                reused: true,
                space: "mobile",
                login: outcome.reused.loginMode,
            };
        }
        const refresh = outcome.refresh;
        // Version of the Pronote server (P6), kept in the state for the health check.
        const seen = pronoteVersion(handle);
        stateStore.state.pronote = { version: seen, validated: isValidated(seen), seenAt: new Date().toISOString() };
        async function doLogin() {
            if (password !== undefined) {
                const result = await secured(loginCredentials(handle, { ...base, password }));
                try {
                    tokenStore?.record(account, null, result.token);
                }
                catch (error) {
                    onRecordError(error);
                }
                return result;
            }
            const result = await chainedTokenLogin(tokenStore, account, token, (current) => secured(loginToken(handle, { ...base, token: current })), onRecordError);
            if (result.substituted)
                request.log.info("token login: previous answer lost, latest token of the chain used");
            return result;
        }
        return {
            sessionid: outcome.sessionid,
            // Single-use: Moodle must store it and send it at the next login (the sidecar keeps the chain too).
            token: refresh.token,
            displayname: handle.user.name,
            version: handle.instance.version.join("."),
            space: "mobile",
            login: password !== undefined ? "credentials" : "token",
        };
    });
    /**
     * Information on the open session (version, tabs, rights, functions, write mode), for the health check. 0.10.0: space
     * and login mode of the session, tabs of the web session sent in X-Pronoteio-Web-Session (webtabs). 0.15.0: state of
     * the web login guard of the account (weblogin).
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
            // 0.15.0: guard of the web logins of the account (failures, back-off): the client must not log in before.
            weblogin: webLoginGuard.status(entry?.account),
            // 0.16.0: state of the two sessions of the account, as a grouped read gives it (sessionState.ts).
            state: sessionState({ main: String(request.headers["x-pronoteio-session"] ?? ""), web: webSessionIdOf(request) }, entry?.account ?? null),
        };
    });
    app.post("/session/logout", async (request) => {
        readCache.dropSession(String(request.headers["x-pronoteio-session"] ?? ""));
        dropSession(request);
        return { ok: true };
    });
}
//# sourceMappingURL=session.js.map