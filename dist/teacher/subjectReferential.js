/**
 * Skills referential of a subject for a cycle, as Compétences > Référentiels > Référentiels par matière (tab 200) shows
 * it, without any service (0.10.0). NOT VALIDATED: tab 200 is closed to the demo profile and missing from the mobile
 * session of a real teacher (case of 18/11/2026); it is read in the web Espace Professeurs (space.ts).
 *
 * Calls reconstructed from the web client (docs/pronote-matrice/2-3-notes-competences.md in mood_prod):
 * - ListePaliers (cycles) and ListeTousPiliersDeCompetence (piliers: subjects of the referentials), generic list
 *   requests without data;
 * - CompetencesGrilles { palier, pilier, genreReferentiel, masquerElementsOfficiels, afficherSeulementEvaluables }: the
 *   grid of the subject, a list of competence elements whose "pere" designates the significant element of an item.
 * The answer members are read defensively (several candidate names); an answer whose shape is not recognised gives
 * available: false, reason "format_unknown" and its shape (member paths and types, no value) to complete the reading.
 *
 * Stable ids by rank, in Pronote's order: two items may differ only by an apostrophe, an item may have no label.
 */
import { ServerSideError } from "pawnote";
import { HttpError } from "../errors.js";
import { listOf } from "../pronote/encoding.js";
import { normalise } from "../normalise.js";
import { spaceOf } from "../space.js";
import { domainCodeOf, isAccessDenied } from "./competencies.js";
import { functions, isTabClosed } from "./functions.js";
import { call, ref } from "./grades.js";
import { shapeOf } from "./shape.js";
/** Largest number of subjects whose grid is read for a listing (one call each). */
export const MAX_SUBJECTS = 40;
/** genreReferentiel of CompetencesGrilles for "par matière" (client enumeration, NOT VALIDATED). */
const SUBJECT_GENRE = Number.parseInt(process.env.PRONOTEIO_REFERENTIAL_GENRE ?? "1", 10) || 1;
const label = (value) => String(value?.L ?? "").trim();
const typed = (value) => (value && typeof value === "object" && "V" in value ? value.V : value);
/** Nodes of a grid answer: the first candidate list found, flattened (nested children keep their parent). */
const nodesOf = (data) => {
    const roots = listOf(data.listeElementsCompetences ?? data.listeCompetences ?? data.elementsCompetence
        ?? data.listeElements ?? data.listeGrilles);
    const out = [];
    const visit = (node, parent) => {
        if (!node || typeof node !== "object")
            return;
        out.push({ node, parent });
        for (const kid of listOf(node.listeCompetences ?? node.listeItems ?? node.listeElements))
            visit(kid, String(node.N ?? ""));
    };
    for (const root of roots)
        visit(root, null);
    return out;
};
const parentOf = (node, nested) => {
    const pere = typed(node.pere);
    const id = pere && typeof pere === "object" ? pere.N : pere;
    return id !== undefined && id !== null && id !== "" ? String(id) : nested;
};
const domainsOf = (node) => listOf(typed(node.listeDomaines ?? node.domaines ?? node.listePiliers ?? node.listeDomainesSocle))
    .filter((item) => item && typeof item === "object")
    .map((item) => {
    const name = label(item);
    const code = domainCodeOf(item);
    return { code, name: code && name.toUpperCase().startsWith(code) ? name.slice(code.length).replace(/^[\s.:-]+/, "") : name };
});
const levelsOf = (node) => listOf(typed(node.listeRestrictionsNiveaux ?? node.listeNiveaux ?? node.niveaux))
    .map((item) => (typeof item === "string" ? item : label(item)))
    .filter(Boolean);
/** Significant elements and their items, in the order of the answer; null when the shape is not recognised. */
export const gridFrom = (data, cycle, subject) => {
    const nodes = nodesOf(data);
    if (nodes.length === 0)
        return null;
    const ids = new Set(nodes.map(({ node }) => String(node.N ?? "")));
    const elements = [];
    const byId = new Map();
    for (const { node, parent: nested } of nodes) {
        const parent = parentOf(node, nested);
        if (parent !== null && ids.has(parent) && byId.has(parent)) {
            const element = byId.get(parent);
            element.items.push({
                id: `ri:${cycle}|${subject}|${elements.indexOf(element) + 1}|${element.items.length + 1}`,
                name: label(node),
                evaluable: node.evaluable !== false,
                levels: levelsOf(node),
            });
            continue;
        }
        const element = {
            id: `rs:${cycle}|${subject}|${elements.length + 1}`,
            name: label(node),
            domains: domainsOf(node),
            reportElement: String(typed(node.libelleBulletin) ?? label(typed(node.elementSignifiant)) ?? "").trim(),
            items: [],
        };
        elements.push(element);
        byId.set(String(node.N ?? `#${elements.length}`), element);
    }
    return elements;
};
const pickByLabel = (list, wanted) => {
    const key = normalise(wanted);
    return list.find((item) => normalise(label(item)) === key);
};
const classesOf = (data) => listOf(typed(data.listeClasses)).map((item) => label(item)).filter(Boolean);
/** GET /competencies/referential/subjects: subjects of each cycle, or the referential of one subject. */
export const subjectReferential = async (session, cycle = "", subject = "") => {
    const base = { available: true, reason: "", validated: false, cycle, subject, subjects: [], elements: [] };
    const denied = () => ({
        ...base,
        available: false,
        reason: "access_denied",
        ...(functions.competencySubjectReferential.onglet !== null ? { onglet: functions.competencySubjectReferential.onglet } : {}),
        ...(spaceOf(session) ? { space: spaceOf(session) } : {}),
    });
    // On a mobile session lacking tab 200: WebSessionRequired, the request is replayed on the web session (space.ts).
    if (isTabClosed(session, "competencySubjectReferential"))
        return denied();
    let cycles;
    let piliers;
    try {
        cycles = listOf((await call(session, "competencyCycles")).listePaliers);
        piliers = listOf((await call(session, "competencySubjects")).listePiliers);
    }
    catch (error) {
        if (isAccessDenied(error))
            return denied();
        throw error;
    }
    const grid = async (palier, pilier) => call(session, "competencySubjectReferential", {
        palier: ref(palier),
        pilier: ref(pilier),
        genreReferentiel: SUBJECT_GENRE,
        masquerElementsOfficiels: false,
        afficherSeulementEvaluables: false,
    });
    /** Subjects of a cycle: the piliers attached to it (palier member), every pilier when none carries one. */
    const subjectsOf = (palier) => {
        const attached = piliers.filter((item) => typed(item.palier)?.N !== undefined);
        return attached.length === 0 ? piliers : attached.filter((item) => String(typed(item.palier).N) === String(palier.N));
    };
    if (cycle !== "" && subject !== "") {
        const palier = pickByLabel(cycles, cycle);
        if (!palier)
            throw new HttpError(404, "cycle_not_found");
        const pilier = pickByLabel(subjectsOf(palier), subject);
        if (!pilier)
            throw new HttpError(404, "subject_not_found");
        let data;
        try {
            data = await grid(palier, pilier);
        }
        catch (error) {
            if (isAccessDenied(error))
                return denied();
            throw error;
        }
        const elements = gridFrom(data, label(palier), label(pilier));
        if (elements === null)
            return { ...base, available: false, reason: "format_unknown", shape: shapeOf(data) };
        return { ...base, cycle: label(palier), subject: label(pilier), elements };
    }
    const wanted = cycle === "" ? cycles : cycles.filter((item) => normalise(label(item)) === normalise(cycle));
    if (cycle !== "" && wanted.length === 0)
        throw new HttpError(404, "cycle_not_found");
    const subjects = [];
    for (const palier of wanted) {
        for (const pilier of subjectsOf(palier)) {
            if (subjects.length >= MAX_SUBJECTS)
                break;
            let data = {};
            try {
                data = await grid(palier, pilier);
            }
            catch (error) {
                if (!(error instanceof ServerSideError))
                    throw error;
            }
            const elements = gridFrom(data, label(palier), label(pilier)) ?? [];
            subjects.push({
                cycle: label(palier),
                name: label(pilier),
                elements: elements.length,
                items: elements.reduce((sum, element) => sum + element.items.length, 0),
                classes: classesOf(data),
            });
        }
    }
    return { ...base, subjects };
};
//# sourceMappingURL=subjectReferential.js.map