import { HttpError } from "../errors.js";
/** Known members of the "data" member of each function's answer (at least one must be present in a non-empty answer). */
export const FORMATS = {
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
export const validatedVersions = (env = process.env) => {
    const list = String(env.PRONOTEIO_VALIDATED_VERSIONS ?? "").split(",").map((item) => item.trim()).filter(Boolean);
    return list.length > 0 ? list : DEFAULT_VALIDATED;
};
/** Version of the Pronote server of a session ("2026.2.8"), "" when unknown. */
export const pronoteVersion = (session) => {
    const version = session?.instance?.version;
    return Array.isArray(version) ? version.join(".") : "";
};
export const isValidated = (version, env = process.env) => version !== "" && validatedVersions(env).includes(version);
/** Refuses a write on an unvalidated Pronote version (unless allowed). */
export const assertWritable = (session, env = process.env) => {
    const version = pronoteVersion(session);
    if (version === "" || isValidated(version, env) || env.PRONOTEIO_ALLOW_UNVALIDATED_WRITES === "true")
        return;
    throw new HttpError(409, "pronote_format_changed", { reason: "unvalidated_version", pronoteversion: version,
        validated: validatedVersions(env) });
};
/** Checks the "data" member of an answer; throws 502 pronote_format_changed:<function>:<member> when it changed. */
export const checkFormat = (name, data, env = process.env) => {
    if (env.PRONOTEIO_FORMAT_CHECK === "off")
        return;
    const known = FORMATS[name];
    if (!known || data === null || typeof data !== "object" || Array.isArray(data))
        return;
    const keys = Object.keys(data);
    if (keys.length === 0 || known.some((key) => key in data))
        return;
    throw new HttpError(502, `pronote_format_changed:${name}:${known[0]}`, { function: name, field: known[0] });
};
//# sourceMappingURL=formats.js.map