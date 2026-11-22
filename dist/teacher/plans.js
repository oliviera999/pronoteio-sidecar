import { listOf } from "../pronote/encoding.js";
import { labelKey } from "../normalise.js";
import { resolveResource, rosterEntries } from "./roster.js";
import { openSource, readStudentSource } from "./studentSource.js";
import { planType } from "./students.js";
import { boolOf, dateOf, dayString, isPlain, labelsOf, member, pageOf, readEach, textOf, unwrap } from "./tolerant.js";
/** Largest page of students (one Pronote call per student). */
export const MAX_PLAN_STUDENTS = 40;
const PLAN_LISTS = ["listeProjets", "listeProjetsAccompagnement", "projetsAccompagnement", "listeProjetsIndividuels", "listeProjetsIndividualises",
    "listeProjetsEleve", "projetsIndividuels", "projets", "listePAP", "listePAI", "listePI", "listeDetailsPI", "listeDetails"];
/** One plan given alone. */
const PLAN_SINGLE = ["projet", "projetAccompagnement", "projetIndividuel", "projetIndividualise", "detailProjet"];
const TYPE = ["typeProjet", "type", "projet", "nature", "genreProjet", "typePI"];
const TITLE = ["intitule", "libelle", "titre", "motif", "nom"];
const START = ["dateDebut", "debut", "dateDebutValidite", "date"];
const END = ["dateFin", "fin", "dateFinValidite"];
const COMMENT = ["commentaire", "description", "detail", "precisions"];
const ACCOMMODATIONS = ["listeAmenagements", "amenagements", "listeMesures", "mesures", "listeAdaptations"];
const EXAMS = ["avecAmenagementsExamen", "amenagementExamen", "pourExamens", "avecAmenagementExamens", "estAmenagementExamen"];
/** Accommodations of a plan: labels of a flat list, or of the groups of a list of groups ("Pédagogiques": [...]). */
const accommodationsOf = (value) => {
    const out = [];
    for (const item of listOf(value)) {
        const raw = unwrap(item);
        const nested = isPlain(raw) ? listOf(member(raw, ACCOMMODATIONS)) : [];
        if (nested.length > 0)
            out.push(...accommodationsOf(nested));
        else if (textOf(item) !== "")
            out.push(textOf(item));
    }
    return out.length > 0 || Array.isArray(unwrap(value)) ? [...new Set(out)] : labelsOf(value);
};
/** One plan from an element of a list of plans, null when it names nothing. */
export const planFrom = (value) => {
    const item = unwrap(value);
    if (!isPlain(item))
        return null;
    const kind = textOf(member(item, TYPE));
    const label = textOf(item.L) || kind;
    const title = textOf(member(item, TITLE));
    if (label === "" && title === "")
        return null;
    const accommodations = accommodationsOf(member(item, ACCOMMODATIONS));
    const known = [label, kind, title].map(planType).find((type) => type !== "other");
    return {
        type: known ?? "other",
        label: label || title,
        title: title === label ? "" : title,
        start: dayString(dateOf(member(item, START))),
        end: dayString(dateOf(member(item, END))),
        comment: textOf(member(item, COMMENT)),
        accommodations,
        examAccommodations: /exam/.test(labelKey(`${label} ${kind}`)) || boolOf(member(item, EXAMS)) === true
            || accommodations.some((line) => /examen/.test(labelKey(line))),
    };
};
/** Members that make an element of an unnamed list look like a plan. */
const PLAN_MARKS = [...TYPE.filter((name) => name !== "type" && name !== "nature"), ...ACCOMMODATIONS, ...EXAMS, "dateDebut", "dateFin"];
/**
 * Plans of a DetailsPIEleve answer ("data" member), null when the shape is not understood. A known list that is empty
 * is a student without plan.
 */
export const plansFromAnswer = (data) => {
    if (!isPlain(data))
        return null;
    let list = member(data, PLAN_LISTS);
    if (list === undefined || !Array.isArray(unwrap(list))) {
        const single = unwrap(member(data, PLAN_SINGLE));
        if (isPlain(single)) {
            const plan = planFrom(single);
            if (plan !== null)
                return [plan];
        }
        // No known name: the only list of the answer whose elements carry a member of a plan.
        const candidates = Object.values(data).filter((value) => {
            const elements = listOf(value).map(unwrap).filter(isPlain);
            return elements.length > 0 && elements.some((element) => member(element, PLAN_MARKS) !== undefined);
        });
        if (candidates.length !== 1)
            return null;
        list = candidates[0];
    }
    const elements = listOf(list);
    const plans = elements.map(planFrom).filter((plan) => plan !== null);
    // Elements, but none that names a plan: another shape.
    return elements.length > 0 && plans.length === 0 ? null : plans;
};
/**
 * Support plans of a page of students of a class or group. A refusal of Pronote, or a shape that is not understood
 * while no answer ever was, answers available: false (access_denied, format_unknown with the shape) and no other call;
 * when the queue towards Pronote is full, the students read so far come back with "remaining" and "retry_after".
 */
export const studentPlans = async (session, resourceId, page = {}) => {
    const resource = resolveResource(session, resourceId);
    const { selected, offset, total } = pageOf(await rosterEntries(session, resourceId), page, MAX_PLAN_STUDENTS, 10);
    const base = { validated: false, class: { id: resourceId, name: resource.label }, total, offset };
    const source = openSource(session, "supportPlanDetails");
    let closed = null;
    const unreadable = [];
    let shape;
    const read = await readEach(selected, async (entry) => {
        if (closed)
            return null;
        const one = await readStudentSource(session, source, { eleve: { N: entry.pronoteId, G: 4, L: entry.label } }, plansFromAnswer, []);
        if (one.value !== null)
            return { studentid: entry.id, label: entry.label, plans: one.value };
        if (source.state.available) {
            // The function answers for the others: this student alone is not understood. Named, never given "no plan".
            unreadable.push(entry.id);
            shape = shape ?? one.outcome.shape;
        }
        else {
            closed = one.outcome;
        }
        return null;
    });
    const failed = closed;
    if (failed) {
        // The students read before are not returned with a refusal: the answer says one thing.
        return { ...base, ...failed, items: [], read: [], remaining: [], partial: false, retry_after: 0 };
    }
    return { ...base, available: true, reason: "", ...read, items: read.items.filter((item) => item !== null),
        ...(unreadable.length > 0 ? { unreadable, shape } : {}) };
};
//# sourceMappingURL=plans.js.map