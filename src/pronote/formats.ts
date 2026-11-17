/**
 * Detection of a change of Pronote before it breaks everything (P6, 0.9.0).
 *
 * - Version: read at login (session.instance.version) and compared with the validated versions
 *   (PRONOTEIO_VALIDATED_VERSIONS, default 2026.2.8: the client the fixtures were rebuilt from). An unknown version is
 *   reported in the health check and in the X-Pronoteio-Pronote-* headers of every answer; reads stay allowed, writes
 *   are refused (409, code pronote_format_changed, reason unvalidated_version) unless
 *   PRONOTEIO_ALLOW_UNVALIDATED_WRITES=true.
 * - Format: the "data" member of the answers of the main functions is checked against its known members
 *   (FORMATS). When an answer is not empty but carries none of them (a member renamed), the call fails with
 *   502 pronote_format_changed:<function>:<member> instead of returning empty or wrong data. An empty answer stays
 *   allowed (an empty week, a class without assessment). A write reads its target page first: a changed page stops it
 *   before anything is sent.
 * The members below come from the fixtures rebuilt from the Pronote 2026.2.8 client (test/fixtures). Functions not
 * listed are not checked. PRONOTEIO_FORMAT_CHECK=off disables the check (emergency).
 */
import type { SessionHandle } from "pawnote";
import { HttpError } from "../errors.js";

/** Known members of the "data" member of each function's answer (at least one must be present in a non-empty answer). */
export const FORMATS: Record<string, string[]> = {
  PageEmploiDuTemps: ["ListeCours"],
  ListeEleves: ["listeEleves"],
  PageNotes: ["listeDevoirs", "listeEleves", "service"],
  PageSaisieCahierDeTextes: ["listeCahiersDeTexte", "listeClassesEleves", "DateCoursDeb"],
  PageSaisieCahierDeTextes_General: ["ListeCategories"],
  PageSaisieAbsences: ["ListeEleves", "ListeColonnes"],
  ListeMessagerie: ["listeMessagerie", "messagerieDesactivee"],
  ListeMessages: ["listeMessages"],
  Casier: ["listeDocumentsMonCasier", "listeDocumentsDepositaire", "categories"],
  listeQCM: ["listeQCM"],
  RessourceEDT: ["listeRessources"],
  ListeDiffusion: ["liste"],
  CentraleNotifications: ["liste"],
  PageActualitesResultats: ["listeQuestions"],
};

export const DEFAULT_VALIDATED = ["2026.2.8"];

export const validatedVersions = (env: Record<string, string | undefined> = process.env): string[] => {
  const list = String(env.PRONOTEIO_VALIDATED_VERSIONS ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  return list.length > 0 ? list : DEFAULT_VALIDATED;
};

/** Version of the Pronote server of a session ("2026.2.8"), "" when unknown. */
export const pronoteVersion = (session: SessionHandle | undefined): string => {
  const version = (session as { instance?: { version?: unknown } } | undefined)?.instance?.version;
  return Array.isArray(version) ? version.join(".") : "";
};

export const isValidated = (version: string, env: Record<string, string | undefined> = process.env): boolean =>
  version !== "" && validatedVersions(env).includes(version);

/** Refuses a write on an unvalidated Pronote version (unless allowed). */
export const assertWritable = (session: SessionHandle | undefined, env: Record<string, string | undefined> = process.env): void => {
  const version = pronoteVersion(session);
  if (version === "" || isValidated(version, env) || env.PRONOTEIO_ALLOW_UNVALIDATED_WRITES === "true") return;
  throw new HttpError(409, "pronote_format_changed", { reason: "unvalidated_version", pronoteversion: version,
    validated: validatedVersions(env) });
};

/** Checks the "data" member of an answer; throws 502 pronote_format_changed:<function>:<member> when it changed. */
export const checkFormat = (name: string, data: unknown, env: Record<string, string | undefined> = process.env): void => {
  if (env.PRONOTEIO_FORMAT_CHECK === "off") return;
  const known = FORMATS[name];
  if (!known || data === null || typeof data !== "object" || Array.isArray(data)) return;
  const keys = Object.keys(data as object);
  if (keys.length === 0 || known.some((key) => key in (data as object))) return;
  throw new HttpError(502, `pronote_format_changed:${name}:${known[0]}`, { function: name, field: known[0] });
};
