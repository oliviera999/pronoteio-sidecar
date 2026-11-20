/**
 * Data sent by Pronote only once, during the login, that Pawnote does not keep:
 * the classes and groups of the school (ParametresUtilisateur, which cannot be called again),
 * the tabs ("onglets") the account may open and the largest assessment scale (FonctionParametres).
 */
import type { Fetcher } from "@literate.ink/utilities";
import { createSessionHandle, type SessionHandle } from "pawnote";
import { listOf, parseNumberSet } from "./encoding.js";
import { compatFetcher } from "./compat.js";
import { decodePayload } from "./request.js";
import { assertReachable } from "../space.js";

/**
 * Class (genre 1) or group (genre 2) of the school. "id" is only valid in the session that sent it.
 * "principal": the account is the main teacher ("professeur principal") of the class.
 */
export type SchoolResource = { id: string; label: string; genre: 1 | 2; taught: boolean; principal: boolean };

/**
 * "tabs": every tab number of listeOnglets (groups and their tabs), null when not received.
 * "rights": raw "autorisations" object of ParametresUtilisateur (absences.*, cours.*, casierNumerique.*...), {} when
 * not received. "acquisitionLevels": raw General.ListeNiveauxDAcquisitions of FonctionParametres (skills levels of the
 * school; 0.13.0: the client reads them there, GParametres.listeNiveauxDAcquisitions, not in ParametresUtilisateur where
 * they were looked for until 0.12.0 and never found), [] when not received. "maxCommentLength":
 * General.TailleMaxAppreciation (per kind), null when not received.
 * "parentsDelayDays" (0.8.0): days between the publication to students and to parents ("publiée aux parents un jour
 * après la publication aux élèves"), from the first numeric member of General whose name speaks of parents and of a
 * delay (decalage, delai), null when not received. NOT VALIDATED: member name unknown, read defensively.
 */
export type UserData = {
  resources: SchoolResource[];
  maxScale: number | null;
  tabs: number[] | null;
  rights: Record<string, unknown>;
  acquisitionLevels: unknown[];
  maxCommentLength: unknown;
  parentsDelayDays: number | null;
  /**
   * 0.13.0: days added to the date of an assessment for its default publication (General.NbJDecalageDatePublicationParDefaut,
   * the client's getProchaineDateOuvreePourPublication), null when not received (the client then uses 1).
   */
  publicationDelayDays: number | null;
  /** 0.13.0: working days of the school (General.JoursOuvres: 1 Monday … 7 Sunday), [] when not received. */
  workingDays: number[];
  /** 0.11.4: identity of ParametresUtilisateur ("ressource": N, G, L, Etablissement), for a tolerant decoding. */
  identity: { id: string; kind: number; name: string; establishment: string } | null;
};

const EMPTY: UserData = {
  resources: [],
  maxScale: null,
  tabs: null,
  rights: {},
  acquisitionLevels: [],
  maxCommentLength: null,
  parentsDelayDays: null,
  publicationDelayDays: null,
  workingDays: [],
  identity: null,
};

/** Delay of the publication to parents (days) in a General member of FonctionParametres, null when absent. */
export const parentsDelayOf = (general: unknown): number | null => {
  if (!general || typeof general !== "object") return null;
  for (const [key, raw] of Object.entries(general as Record<string, unknown>)) {
    if (!/parent/i.test(key) || !/decal|d[ée]lai/i.test(key)) continue;
    const value = raw !== null && typeof raw === "object" && "V" in (raw as object) ? (raw as { V: unknown }).V : raw;
    const number = Number.parseFloat(String(value ?? "").replace(",", "."));
    if (Number.isFinite(number) && number >= 0 && number <= 60) return number;
  }
  return null;
};

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

const wrapped = (value: unknown): unknown =>
  value !== null && typeof value === "object" && "V" in (value as object) ? (value as { V: unknown }).V : value;

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
  const resource = content.ressource;
  if (resource && typeof resource === "object" && typeof resource.N === "string") {
    const establishment = resource.Etablissement?.V?.L ?? resource.Etablissement?.L ?? "";
    data.identity = { id: resource.N, kind: Number(resource.G ?? 0), name: String(resource.L ?? ""),
      establishment: String(establishment) };
  }
  if (content.autorisations && typeof content.autorisations === "object") data.rights = content.autorisations;
  // 0.13.0: FonctionParametres carries the levels in General (capital L); the root member is kept for older servers.
  const levels = content.General?.ListeNiveauxDAcquisitions ?? content.General?.listeNiveauxDAcquisitions
    ?? content.listeNiveauxDAcquisitions ?? content.ListeNiveauxDAcquisitions;
  if (levels && listOf(levels).length) data.acquisitionLevels = listOf(levels);
  const publicationDelay = parseNumber(wrapped(content.General?.NbJDecalageDatePublicationParDefaut));
  if (publicationDelay !== null && publicationDelay >= -30 && publicationDelay <= 60) data.publicationDelayDays = publicationDelay;
  const workingDays = parseNumberSet(content.General?.JoursOuvres).filter((day) => day >= 1 && day <= 7);
  if (workingDays.length) data.workingDays = workingDays;
  const maxScale = parseNumber(content.General?.BaremeMaxDevoirs?.V);
  if (maxScale !== null) data.maxScale = maxScale;
  if (content.General?.TailleMaxAppreciation !== undefined) data.maxCommentLength = content.General.TailleMaxAppreciation;
  const delay = parentsDelayOf(content.General);
  if (delay !== null) data.parentsDelayDays = delay;
};

/** Session handle whose fetcher records the login-only data (read back with userData()). */
export const createCapturingHandle = (base: Fetcher = compatFetcher): SessionHandle => {
  const data: UserData = { ...EMPTY, workingDays: [] };
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

const lower = (value: string) => value.toLowerCase();

/**
 * Whether a right ("autorisations" of ParametresUtilisateur) is granted, looked up case-insensitively either
 * inside its group ({ communication: { avecDiscussionAvancee: true } }) or at the root ({ avecDiscussionAvancee }).
 * null when the rights were not received or the right is not listed at all.
 */
export const hasRight = (rights: Record<string, unknown>, group: string, name: string): boolean | null => {
  if (!rights || typeof rights !== "object") return null;
  const groupKey = Object.keys(rights).find((key) => lower(key) === lower(group));
  const inGroup = groupKey ? (rights[groupKey] as Record<string, unknown> | undefined) : undefined;
  if (inGroup && typeof inGroup === "object") {
    const key = Object.keys(inGroup).find((item) => lower(item) === lower(name));
    if (key) return inGroup[key] === true;
  }
  const flat = Object.keys(rights).find((key) => lower(key) === lower(name) || lower(key) === lower(`${group}.${name}`));
  if (flat) return rights[flat] === true;
  return null;
};

/**
 * Whether the tab of a function is closed to the account: true only when the tabs were received and lack it. 0.10.0: a
 * tab missing from the MOBILE session is not a refusal while the web space has not been tried: WebSessionRequired
 * (space.ts) when the client can open a web session.
 */
export const tabClosed = (session: SessionHandle, onglet: number | null, fn = ""): boolean => {
  const tabs = userData(session).tabs;
  const closed = onglet !== null && Array.isArray(tabs) && !tabs.includes(onglet);
  if (closed) assertReachable(session, tabs, onglet, fn);
  return closed;
};

/** Replaces the login data of a session (tests, or a session handle created outside createCapturingHandle). */
export const rememberUserData = (session: SessionHandle, data: Partial<UserData>): void => {
  store.set(session, { ...EMPTY, ...data });
};
