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
import { HttpError } from "../errors.js";
import { pronoteBaseUrl } from "../pronote/compat.js";
import { createCapturingHandle } from "../pronote/userdata.js";
import { createSession, dropSession } from "../session.js";

type LoginBody = {
  url: string;
  username: string;
  deviceuuid: string;
  password?: string;
  token?: string;
  pin?: string;
  devicename?: string;
};

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

      let refresh: RefreshInformation;
      try {
        refresh = password !== undefined
          ? await loginCredentials(handle, { ...base, password })
          : await loginToken(handle, { ...base, token: token as string });
      } catch (error) {
        if (!(error instanceof SecurityError)) throw error;
        refresh = await completeSecurity(handle, error, pin, devicename ?? DEFAULT_DEVICE_NAME);
      }

      return {
        sessionid: createSession(handle),
        // Single-use: Moodle must store it and send it at the next login.
        token: refresh.token,
        displayname: handle.user.name,
      };
    },
  );

  app.post("/session/logout", async (request) => {
    dropSession(request);
    return { ok: true };
  });
}
