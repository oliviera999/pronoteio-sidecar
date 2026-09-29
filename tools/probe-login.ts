/**
 * Login shared by the discovery tools, with the account of the local .env.
 *
 * First run: PROBE_PASSWORD (+ PROBE_PIN when Pronote asks for the double authentication PIN).
 * The device is then registered as trusted and the single-use token is kept in .probe-token with its
 * device identifier, so that the next runs log in by token without password nor PIN.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
import type { Fetcher } from "@literate.ink/utilities";
import { compatFetcher, pronoteBaseUrl } from "../src/pronote/compat.js";
import { createCapturingHandle } from "../src/pronote/userdata.js";

const TOKEN_FILE = ".probe-token";
const DEVICE_NAME = "Moodle pronoteio (tests)";

type Saved = { token: string; deviceUUID: string };

const readSaved = (): Saved | null => {
  if (!existsSync(TOKEN_FILE)) return null;
  const saved = JSON.parse(readFileSync(TOKEN_FILE, "utf8")) as Partial<Saved>;
  return saved.token && saved.deviceUUID ? (saved as Saved) : null;
};

export const probeLogin = async (
  fetcher: Fetcher = compatFetcher,
  onSession: (session: SessionHandle) => void = () => {},
): Promise<SessionHandle> => {
  const url = process.env.PROBE_URL ?? "";
  const username = process.env.PROBE_USERNAME ?? "";
  if (!url || !username) throw new Error("Set PROBE_URL and PROBE_USERNAME in .env");

  const saved = readSaved();
  const deviceUUID = saved?.deviceUUID ?? process.env.PROBE_DEVICE_UUID ?? randomUUID();
  const base = { url: pronoteBaseUrl(url), username, kind: AccountKind.TEACHER, deviceUUID };

  let session = createCapturingHandle(fetcher);
  onSession(session);
  let refresh: RefreshInformation | null = null;
  if (saved) {
    try {
      refresh = await loginToken(session, { ...base, token: saved.token });
    } catch (error) {
      console.error(`Token login failed (${error instanceof Error ? error.name : error}), using the password.`);
      session = createCapturingHandle(fetcher);
      onSession(session);
    }
  }
  if (!refresh) {
    try {
      refresh = await loginCredentials(session, { ...base, password: process.env.PROBE_PASSWORD ?? "" });
    } catch (error) {
      if (!(error instanceof SecurityError)) throw error;
      const modal = error.handle;
      if (modal.shouldCustomPassword || modal.shouldCustomDoubleAuth) {
        throw new Error("Pronote asks to set up the password / double authentication in its web space first.");
      }
      const pin = process.env.PROBE_PIN ?? "";
      if (modal.shouldEnterPIN) {
        if (!pin) throw new Error("Pronote asks for the double authentication PIN: add PROBE_PIN to .env.");
        if (!(await securityCheckPIN(session, pin))) throw new Error("PIN refused by Pronote.");
        await securitySave(session, modal, { pin, deviceName: DEVICE_NAME });
      } else {
        await securitySave(session, modal, { deviceName: DEVICE_NAME });
      }
      const { authentication, identity, initialUsername } = modal.context;
      refresh = await finishLoginManually(session, authentication, identity, initialUsername);
    }
  }
  writeFileSync(TOKEN_FILE, JSON.stringify({ token: refresh.token, deviceUUID }, null, 2));
  return session;
};
