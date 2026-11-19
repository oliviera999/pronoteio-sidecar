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
import { createSession, dropSession, requireSession, sessionEntry, sessionOfAccount, setPresenceSender, setReconnector, webSessionEntry, } from "../session.js";
import { limiterOf } from "../pronote/limiter.js";
import { PRIORITY } from "../context.js";
import { accountKey, chainedTokenLogin, serializeLogin, TokenStore } from "../tokenStore.js";
import { functions } from "../teacher/functions.js";
import { stableId } from "../teacher/ids.js";
const loginWeb = pawnote.pronoteioLoginWeb;
/** Chain of the single-use tokens (see tokenStore.ts); null when PRONOTEIO_TOKEN_STORE=off. */
const tokenStore = config.tokenStoreFile === null ? null : new TokenStore(config.tokenStoreFile, config.secret, Date.now, config.secrets.slice(1));
/** Name shown in the teacher's Pronote "known devices" list (limited to 30 characters by Pronote). */
const DEFAULT_DEVICE_NAME = "Moodle pronoteio";
/**
 * Completes the double authentication asked by Pronote after a valid password.
 * With a PIN, the device is registered as trusted: the next token logins no longer ask for it.
 */
const completeSecurity = async (handle, error, pin, devicename) => {
    const modal = error.handle;
    if (modal.shouldCustomPassword || modal.shouldCustomDoubleAuth) {
        // First connection: the teacher must choose a password / strategy in the Pronote web space.
        throw new HttpError(409, "security_setup_required");
    }
    if (modal.shouldEnterPIN) {
        if (pin === undefined)
            throw new HttpError(409, "pin_required");
        if (!(await securityCheckPIN(handle, pin)))
            throw new HttpError(401, "bad_pin");
        await securitySave(handle, modal, { pin, deviceName: devicename });
    }
    else if (modal.shouldEnterSource) {
        await securitySave(handle, modal, { deviceName: devicename });
    }
    else {
        throw new HttpError(409, "double_auth_required");
    }
    const { authentication, identity, initialUsername } = modal.context;
    return finishLoginManually(handle, authentication, identity, initialUsername);
};
export const sessionInfo = (session) => {
    const data = userData(session);
    return {
        displayname: session.user.name,
        version: session.instance.version.join("."),
        tabs: data.tabs ?? [],
        rights: data.rights,
        maxScale: data.maxScale,
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
 * Login of the web Espace Professeurs (0.10.0): professeur.html in "Domicile" mode, with the password only. The mobile
 * token is not accepted by this space (and a refused try would consume it): web_token_refused, without any call to
 * Pronote. A double authentication asks the PIN as for the mobile space (pin_required, bad_pin). The session is kept
 * beside the main one (one web session per account), never reconnected. The password is neither logged nor returned.
 */
const webLogin = async (body) => {
    const { url, username, deviceuuid, password, pin, devicename } = body;
    if (password === undefined)
        throw new HttpError(401, "web_token_refused");
    if (!loginWeb)
        throw new HttpError(501, "not_implemented:web_space");
    assertPrimary();
    const handle = createCapturingHandle(webFetcher());
    const base = { url: pronoteBaseUrl(url), username, kind: AccountKind.TEACHER, deviceUUID: deviceuuid };
    const account = accountKey(base.url, username, deviceuuid);
    const sessionid = await serializeLogin(`${account}|web`, async () => {
        try {
            await loginWeb(handle, { ...base, password });
        }
        catch (error) {
            if (!(error instanceof SecurityError))
                throw error;
            await completeSecurity(handle, error, pin, devicename ?? DEFAULT_DEVICE_NAME);
        }
        return createSession(handle, { key: account, login: { url: base.url, username, deviceuuid } }, { space: "web", loginMode: "credentials" });
    });
    return {
        sessionid,
        displayname: handle.user.name,
        version: handle.instance.version.join("."),
        space: "web",
        login: "credentials",
        tabs: userData(handle).tabs ?? [],
    };
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
//# sourceMappingURL=session.js.map