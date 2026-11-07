/**
 * Data sent by Pronote only once, during the login, that Pawnote does not keep:
 * the classes and groups of the school (ParametresUtilisateur, which cannot be called again),
 * the tabs ("onglets") the account may open and the largest assessment scale (FonctionParametres).
 */
import type { Fetcher } from "@literate.ink/utilities";
import { createSessionHandle, type SessionHandle } from "pawnote";
import { listOf } from "./encoding.js";
import { compatFetcher } from "./compat.js";
import { decodePayload } from "./request.js";

/**
 * Class (genre 1) or group (genre 2) of the school. "id" is only valid in the session that sent it.
 * "principal": the account is the main teacher ("professeur principal") of the class.
 */
export type SchoolResource = { id: string; label: string; genre: 1 | 2; taught: boolean; principal: boolean };

/**
 * "tabs": every tab number of listeOnglets (groups and their tabs), null when not received.
 * "rights": raw "autorisations" object of ParametresUtilisateur (absences.*, cours.*, casierNumerique.*...), {} when
 * not received. "acquisitionLevels": raw listeNiveauxDAcquisitions (skills levels of the school), [] when not
 * received. "maxCommentLength": General.TailleMaxAppreciation (per kind), null when not received.
 */
export type UserData = {
  resources: SchoolResource[];
  maxScale: number | null;
  tabs: number[] | null;
  rights: Record<string, unknown>;
  acquisitionLevels: unknown[];
  maxCommentLength: unknown;
};

const EMPTY: UserData = { resources: [], maxScale: null, tabs: null, rights: {}, acquisitionLevels: [], maxCommentLength: null };

/** Tab numbers of a listeOnglets tree ([{ G, Onglet: [{ G }...] }...]). */
export const tabsOf = (value: unknown): number[] => {
  const result: number[] = [];
  const visit = (items: unknown) => {
    for (const item of listOf<any>(items)) {
      if (typeof item?.G === "number") result.push(item.G);
      visit(item?.Onglet);
    }
  };
  visit(value);
  return result;
};

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
      .map((item: any) => ({
        id: String(item.N),
        label: String(item.L ?? ""),
        genre: item.G,
        taught: Boolean(item.enseigne),
        principal: Boolean(item.estPrincipal),
      }));
  }
  if (content.listeOnglets) data.tabs = tabsOf(content.listeOnglets);
  if (content.autorisations && typeof content.autorisations === "object") data.rights = content.autorisations;
  if (content.listeNiveauxDAcquisitions) data.acquisitionLevels = listOf(content.listeNiveauxDAcquisitions);
  const maxScale = parseNumber(content.General?.BaremeMaxDevoirs?.V);
  if (maxScale !== null) data.maxScale = maxScale;
  if (content.General?.TailleMaxAppreciation !== undefined) data.maxCommentLength = content.General.TailleMaxAppreciation;
};

/** Session handle whose fetcher records the login-only data (read back with userData()). */
export const createCapturingHandle = (base: Fetcher = compatFetcher): SessionHandle => {
  const data: UserData = { ...EMPTY };
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

export const userData = (session: SessionHandle): UserData => store.get(session) ?? { ...EMPTY };

/** Replaces the login data of a session (tests, or a session handle created outside createCapturingHandle). */
export const rememberUserData = (session: SessionHandle, data: Partial<UserData>): void => {
  store.set(session, { ...EMPTY, ...data });
};
