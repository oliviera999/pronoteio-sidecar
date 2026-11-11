import { HttpError } from "../errors.js";
import { listOf, parsePronoteDate } from "../pronote/encoding.js";
import { normalise, seconds } from "../normalise.js";
import { callFunction, isTabClosed } from "./functions.js";
import { rosterEntries } from "./roster.js";
export const INCLUDE_VALUES = ["imagerights", "guardians", "health", "photo"];
/** Largest number of files read in one request (one Pronote call per student). */
export const MAX_FILES = 40;
const text = (value) => {
    if (value === null || value === undefined)
        return "";
    if (typeof value === "string" || typeof value === "number")
        return String(value).trim();
    if (typeof value === "object") {
        const object = value;
        if ("V" in object && (typeof object.V === "string" || typeof object.V === "number"))
            return String(object.V).trim();
        if ("L" in object)
            return text(object.L);
    }
    return "";
};
const labels = (value) => listOf(value).map((item) => text(item)).filter(Boolean);
const isPlain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
/**
 * Sub-objects whose members are identity members. 10/11/2026, real account: the answer wraps the student in a typed
 * value ({ _T, V: {...} }) and puts schooling members in "Scolarite"; only "Scolarite", "V", "_T" and two lists were
 * seen at the first level, so sex and birth date stayed empty.
 */
const CONTAINERS = new Set(["eleve", "identite", "ficheeleve", "scolarite", "etatcivil", "infosperso", "informationspersonnelles"]);
/**
 * Identity members: the members of the answer object, of its typed values (V) and of its known sub-objects, flattened
 * (depth 4 at most). The containers themselves and the type codes (_T) are never members.
 */
const identityOf = (data) => {
    const merged = {};
    const visit = (source, depth) => {
        if (!isPlain(source) || depth > 4)
            return;
        for (const [key, value] of Object.entries(source)) {
            if (key === "_T")
                continue;
            if (key === "V") {
                visit(value, depth + 1);
                continue;
            }
            if (CONTAINERS.has(key.toLowerCase()) && isPlain(value)) {
                visit(value, depth + 1);
                continue;
            }
            merged[key] = value;
        }
    };
    visit(data, 0);
    return merged;
};
/** Members never described, not even by name: health, support plans, memos and attestations. */
const SENSITIVE = /(medic|allerg|sante|pai|pap|handicap|memo|attestation|projet|alimentaire|dispens)/i;
/** Largest number of lines of a shape. */
export const MAX_SHAPE = 150;
/**
 * Shape of a FicheEleve answer, to validate the mapping on a real account WITHOUT any value: one line per member path
 * with its type ("Scolarite.V.classe: object"), the type code of typed values ("_T=7"), lists described by their first
 * element ("listeGroupes.V[]: object"). Sensitive members are left out (their presence alone would say something about
 * the student).
 */
export const shapeOf = (value, path = "", depth = 0, out = []) => {
    if (out.length >= MAX_SHAPE || depth > 5)
        return out;
    const kind = Array.isArray(value) ? "list" : value === null ? "null" : typeof value;
    if (path !== "")
        out.push(`${path}: ${kind}`);
    if (Array.isArray(value)) {
        if (value.length > 0)
            shapeOf(value[0], `${path}[]`, depth + 1, out);
    }
    else if (isPlain(value)) {
        for (const [key, member] of Object.entries(value)) {
            if (out.length >= MAX_SHAPE)
                break;
            if (SENSITIVE.test(key))
                continue;
            const child = path === "" ? key : `${path}.${key}`;
            if (key === "_T" && typeof member === "number")
                out.push(`${child}=${member}`);
            else
                shapeOf(member, child, depth + 1, out);
        }
    }
    return out;
};
/** First member present among candidate names, compared without case. */
const pick = (object, names, used) => {
    const keys = Object.keys(object);
    for (const name of names) {
        const key = keys.find((item) => item.toLowerCase() === name.toLowerCase());
        if (key !== undefined && object[key] !== undefined && object[key] !== null) {
            used.add(key);
            return object[key];
        }
    }
    return undefined;
};
export const sexOf = (value) => {
    if (typeof value === "boolean")
        return value ? "M" : "F";
    const label = normalise(text(value)).replace(/\.$/, "");
    if (["f", "feminin", "fille", "femme", "2", "mme", "mlle", "madame", "mademoiselle"].includes(label))
        return "F";
    if (["m", "masculin", "garcon", "homme", "1", "monsieur"].includes(label))
        return "M";
    return "";
};
/** Sex from the members of an identity: "estFeminin"/"estFille" (true = F) first, then the other candidates. */
const sexFrom = (identity, used) => {
    const feminine = pick(identity, ["estFeminin", "estFille"], used);
    if (typeof feminine === "boolean")
        return feminine ? "F" : "M";
    return sexOf(pick(identity, ["Sexe", "estMasculin", "civilite", "genreSexe", "sexeEleve"], used));
};
/**
 * Image rights: a boolean member whose name speaks of photo or image and of authorisation, consent or broadcasting
 * (e.g. autorisePhoto, accordDiffusionPhoto, droitImage), or a labelled value ("Autorisé", "Refusé").
 */
export const imageRightsOf = (object, used) => {
    for (const [key, value] of Object.entries(object)) {
        const name = normalise(key);
        if (!/(photo|image)/.test(name) || !/(autoris|accord|diffus|droit|consent)/.test(name))
            continue;
        used.add(key);
        if (typeof value === "boolean")
            return value ? "authorized" : "refused";
        const label = normalise(text(value));
        if (/^(oui|autorise|accorde|true|1)/.test(label))
            return "authorized";
        if (/^(non|refuse|interdit|false|0)/.test(label))
            return "refused";
    }
    return "unknown";
};
export const guardianOf = (item) => {
    const used = new Set();
    const phones = ["telephonePortable", "telPortable", "portable", "telephoneFixe", "telFixe", "telephoneDomicile",
        "telephoneProfessionnel", "telPro", "telephone"]
        .map((name) => text(pick(item ?? {}, [name], used)))
        .filter(Boolean);
    const legal = pick(item ?? {}, ["estResponsableLegal", "responsableLegal", "estLegal"], used);
    const preferences = [];
    for (const [key, value] of Object.entries(item ?? {})) {
        if (value === true && /^(accepte|autorise|recoit|souhaite)/i.test(key))
            preferences.push(key);
    }
    return {
        name: text(pick(item ?? {}, ["L", "nom", "Nom"], used)),
        relation: text(pick(item ?? {}, ["lienParente", "lien", "parente", "Lien"], used)),
        legal: typeof legal === "boolean" ? legal : null,
        phones: [...new Set(phones)],
        email: text(pick(item ?? {}, ["email", "eMail", "adresseEmail", "mail", "courriel"], used)),
        address: [text(pick(item ?? {}, ["adresse1", "adresse"], used)), text(pick(item ?? {}, ["codePostal"], used)),
            text(pick(item ?? {}, ["ville"], used))].filter(Boolean).join(" "),
        preferences,
    };
};
/** Normalised file of one FicheEleve answer ("data" member), with only the requested parts. */
export const fileOf = (entry, data, include) => {
    const identity = identityOf(data);
    const used = new Set(["N", "G", "Eleve", "eleve", "Identite", "identite", "ficheEleve"]);
    const [lastnameLabel, ...firstnames] = entry.label.split(" ");
    const lastname = text(pick(identity, ["Nom", "nom"], used)) || lastnameLabel;
    const firstname = text(pick(identity, ["Prenoms", "prenoms", "Prenom", "prenom"], used)) || firstnames.join(" ");
    const birth = parsePronoteDate(text(pick(identity, ["DateNaissance", "dateDeNaissance", "dateNaiss", "naissance"], used)));
    const file = {
        id: entry.id,
        label: entry.label,
        lastname,
        firstname,
        sex: sexFrom(identity, used),
        birthdate: birth ? seconds(birth) : null,
        number: text(pick(identity, ["numeroEleve", "Numero", "numero", "numeroNational", "ine", "INE"], used)),
        email: text(pick(identity, ["email", "eMail", "adresseEmail", "mail", "courriel"], used)),
        class: text(pick(identity, ["classe", "Classe"], used)),
        groups: labels(pick(identity, ["listeGroupes", "groupes", "ListeGroupes"], used)),
        options: labels(pick(identity, ["listeOptions", "options", "ListeOptions"], used)),
        regime: text(pick(identity, ["regime", "Regime", "regimeEleve"], used)),
    };
    // Known members are always marked as used (their names are not "unmapped"); their values only leave on request.
    const imageRights = imageRightsOf(identity, used);
    const guardians = pick(identity, ["listeResponsables", "ListeResponsables", "responsables"], used);
    if (include.includes("imagerights"))
        file.imageRights = imageRights;
    if (include.includes("guardians"))
        file.guardians = listOf(guardians).map(guardianOf);
    // Health members are always marked as used: their names never leave the sidecar, their values only on request.
    const plans = pick(identity, ["listeProjetsAccompagnement", "projetsAccompagnement", "ListeProjets"], used);
    const medical = pick(identity, ["infosMedicales", "informationsMedicales", "allergies", "listeAllergies", "regimeAlimentaire"], used);
    for (const key of Object.keys(identity)) {
        if (SENSITIVE.test(key))
            used.add(key);
    }
    if (include.includes("health"))
        file.health = { plans: labels(plans), medical: [...labels(medical), text(medical)].filter(Boolean) };
    const photo = pick(identity, ["existePhoto", "avecPhoto", "photo"], used);
    if (include.includes("photo"))
        file.photo = { exists: photo === true || (typeof photo === "object" && photo !== null) };
    const unmapped = Object.keys(identity).filter((key) => !used.has(key)).sort();
    return { file, unmapped };
};
/**
 * Files of the students of a class or group (resource stable id), or of one of them (student stable id).
 * A closed tab or a refusal of Pronote is returned as available=false with the reason, never bypassed.
 */
export const studentFiles = async (session, resource, include, student = "", page = {}) => {
    const offset = Math.max(0, Math.floor(page.offset ?? 0));
    const limit = Math.min(MAX_FILES, Math.max(1, Math.floor(page.limit ?? MAX_FILES)));
    const empty = { available: false, reason: "", validated: false, items: [], unmappedKeys: [], truncated: false,
        total: 0, offset };
    if (isTabClosed(session, "studentFile"))
        return { ...empty, reason: "tab_closed:105" };
    let entries = await rosterEntries(session, resource);
    if (student !== "") {
        entries = entries.filter((entry) => entry.id === student);
        if (entries.length === 0)
            throw new HttpError(404, "student_not_found");
    }
    // One Pronote call per file read: only the requested page is read, so that a request stays short (a long request
    // may be delivered twice by the web server, see auth.ts registerAuth).
    const selected = entries.slice(offset, offset + limit);
    const truncated = page.limit === undefined && entries.length > offset + MAX_FILES;
    const items = [];
    const unmapped = new Set();
    for (const entry of selected) {
        let data;
        try {
            data = await callFunction(session, "studentFile", {
                Eleve: { N: entry.pronoteId, G: 4, L: entry.label },
                AvecEleve: true,
                AvecResponsables: include.includes("guardians"),
            });
        }
        catch (error) {
            if (error instanceof HttpError)
                throw error;
            if (items.length === 0) {
                return { ...empty, total: entries.length, reason: String(error?.message ?? error).slice(0, 300) };
            }
            throw error;
        }
        const { file, unmapped: keys } = fileOf(entry, data, include);
        keys.forEach((key) => unmapped.add(key));
        items.push(file);
    }
    return { available: true, reason: "", validated: false, items, unmappedKeys: [...unmapped].sort(), truncated,
        total: entries.length, offset };
};
/** Fields counted by the check. */
const CHECKED_FIELDS = ["lastname", "firstname", "sex", "birthdate", "number", "email", "class", "regime"];
/**
 * Minimal read of the student files path for the health check: the roster of the class, then ONE FicheEleve call
 * (first student). Only counts, field names and the shape of the answer are returned: no identity, no value.
 */
export const checkStudentFiles = async (session, resource) => {
    const none = { students: 0, read: 0, mappedKeys: 0, mapped: [], shape: [] };
    if (isTabClosed(session, "studentFile"))
        return { ...none, available: false, reason: "tab_closed:105" };
    const entries = await rosterEntries(session, resource);
    if (entries.length === 0)
        return { ...none, available: false, reason: "empty_roster" };
    const entry = entries[0];
    let data;
    try {
        data = await callFunction(session, "studentFile", { Eleve: { N: entry.pronoteId, G: 4, L: entry.label }, AvecEleve: true,
            AvecResponsables: false });
    }
    catch (error) {
        if (error instanceof HttpError)
            throw error;
        return { ...none, available: false, reason: String(error?.message ?? error).slice(0, 300), students: entries.length };
    }
    const { file } = fileOf(entry, data, []);
    const mapped = CHECKED_FIELDS.filter((key) => Boolean(file[key]));
    return { available: true, reason: "", students: entries.length, read: 1, mappedKeys: mapped.length, mapped,
        shape: shapeOf(data) };
};
//# sourceMappingURL=students.js.map