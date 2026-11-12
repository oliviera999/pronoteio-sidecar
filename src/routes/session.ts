import type { FastifyInstance } from "fastify";
import {
  AccountKind,
  finishLoginManually,
  loginCredentials,
  loginToken,
  SecurityError,
  securityCheckPIN,
  securitySave,
  type RefreshInformation,
  type SessionHandle,
} from "pawnote";
import { config } from "../config.js";
import { HttpError } from "../errors.js";
import type { SessionInfo } from "../normalise.js";
import { pronoteBaseUrl } from "../pronote/compat.js";
import { createCapturingHandle, userData } from "../pronote/userdata.js";
import { createSession, dropSession, requireSession } from "../session.js";
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
};

/** Chain of the single-use tokens (see tokenStore.ts); null when PRONOTEIO_TOKEN_STORE=off. */
const tokenStore = config.tokenStoreFile === null ? null : new TokenStore(config.tokenStoreFile, config.secret);

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
): Promise<RefreshInformation> => {
  const modal = error.handle;
  if (modal.shouldCustomPassword || modal.shouldCustomDoubleAuth) {
    // First connection: the teacher must choose a password / strategy in the Pronote web space.
    throw new HttpError(409, "security_setup_required");
  }
  if (modal.shouldEnterPIN) {
    if (pin === undefined) throw new HttpError(409, "pin_required");
    if (!(await securityCheckPIN(handle, pin))) throw new HttpError(401, "bad_pin");
    await securitySave(handle, modal, { pin, deviceName: devicename });
  } else if (modal.shouldEnterSource) {
    await securitySave(handle, modal, { deviceName: devicename });
  } else {
    throw new HttpError(409, "double_auth_required");
  }
  const { authentication, identity, initialUsername } = modal.context;
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
    classes: data.resources.map((item) => ({
      id: stableId(item.genre === 1 ? "class" : "group", item.label),
      name: item.label,
      type: item.genre === 1 ? ("class" as const) : ("group" as const),
      taught: item.taught,
      principal: item.principal,
    })),
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
          },
          oneOf: [{ required: ["password"] }, { required: ["token"] }],
        },
      },
    },
    async (request) => {
      const { url, username, deviceuuid, password, token, pin, devicename } = request.body;
      const handle = createCapturingHandle();
      const base = { url: pronoteBaseUrl(url), username, kind: AccountKind.TEACHER, deviceUUID: deviceuuid };
      const account = accountKey(base.url, username, deviceuuid);
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
      const refresh = await serializeLogin(account, async () => {
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
      });

      return {
        sessionid: createSession(handle),
        // Single-use: Moodle must store it and send it at the next login (the sidecar keeps the chain too).
        token: refresh.token,
        displayname: handle.user.name,
        version: handle.instance.version.join("."),
      };
    },
  );

  /** Information on the open session (version, tabs, rights, functions, write mode), for the health check. */
  app.get("/session/info", async (request) => sessionInfo(requireSession(request)));

  app.post("/session/logout", async (request) => {
    dropSession(request);
    return { ok: true };
  });
}
