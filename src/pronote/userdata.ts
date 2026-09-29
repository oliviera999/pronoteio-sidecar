/**
 * Data sent by Pronote only once, during the login, that Pawnote does not keep:
 * the classes and groups of the school (ParametresUtilisateur, which cannot be called again)
 * and the largest assessment scale (FonctionParametres).
 */
import type { Fetcher } from "@literate.ink/utilities";
import { createSessionHandle, type SessionHandle } from "pawnote";
import { listOf } from "./encoding.js";
import { compatFetcher } from "./compat.js";
import { decodePayload } from "./request.js";

/** Class (genre 1) or group (genre 2) of the school. "id" is only valid in the session that sent it. */
export type SchoolResource = { id: string; label: string; genre: 1 | 2; taught: boolean };

export type UserData = { resources: SchoolResource[]; maxScale: number | null };

const store = new WeakMap<SessionHandle, UserData>();

const parseNumber = (value: unknown): number | null => {
  const number = Number.parseFloat(String(value ?? "").replace(",", "."));
  return Number.isFinite(number) ? number : null;
};

const absorb = (data: UserData, answer: any): void => {
  const content = answer?.data ?? answer?.donnees ?? {};
  if (content.listeClasses) {
    data.resources = listOf(content.listeClasses)
      .filter((item: any) => item.G === 1 || item.G === 2)
      .map((item: any) => ({ id: String(item.N), label: String(item.L ?? ""), genre: item.G, taught: Boolean(item.enseigne) }));
  }
  const maxScale = parseNumber(content.General?.BaremeMaxDevoirs?.V);
  if (maxScale !== null) data.maxScale = maxScale;
};

/** Session handle whose fetcher records the login-only data (read back with userData()). */
export const createCapturingHandle = (base: Fetcher = compatFetcher): SessionHandle => {
  const data: UserData = { resources: [], maxScale: null };
  let handle: SessionHandle | null = null;
  const fetcher: Fetcher = async (request) => {
    const response = await base(request);
    const body = String(request.content ?? "");
    if (handle && (body.includes('"ParametresUtilisateur"') || body.includes('"FonctionParametres"'))) {
      try {
        const envelope = JSON.parse(response.content);
        absorb(data, decodePayload(handle, envelope.dataSec ?? envelope.donneesSec));
      } catch {
        // Unexpected format: the routes that need these data report it themselves.
      }
    }
    return response;
  };
  handle = createSessionHandle(fetcher);
  store.set(handle, data);
  return handle;
};

export const userData = (session: SessionHandle): UserData => store.get(session) ?? { resources: [], maxScale: null };
