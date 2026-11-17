/**
 * Skills assessments ("évaluations par compétences") of the teacher's services, read only.
 *
 * NOT VALIDATED ON THE DEMO SERVER: its teacher profile does not open the skills tabs (65, 56) and Pronote refuses
 * the functions whatever the tab sent. Request and answer shapes come from the web client code (see
 * docs/pronote-matrice/2-3-notes-competences.md in mood_prod): ListeEvaluations { service, ressource, periode } →
 * listeEvaluations[], then PageCompetencesParEvaluation { evaluation, devoir, ressource, periodeEvaluation } →
 * ListeElevesCompetences[]. A refusal ("droits insuffisants") or an empty answer gives available: false.
 *
 * 0.8.0: the services come from both tabs (grade entry, tab 23, and skills, tab 65: ListeServices with the signature
 * of tab 65), so that a "collège" group assessed by skills only is read; each assessment gives its coefficient, its
 * "bilan de cycle" flag, its publication to parents and the domain code and number of its skills ("D2", "4.1"); the
 * referential of a service (ListePiliers and listeReferentielsUniques) is read on demand. Still NOT VALIDATED.
 */
import { ServerSideError } from "pawnote";
import { listOf, parsePronoteDate } from "../pronote/encoding.js";
import { userData } from "../pronote/userdata.js";
import { HttpError } from "../errors.js";
import { matchesLabels, normalise, seconds, } from "../normalise.js";
import { localTimes } from "../normalise.js";
import { legacySeconds } from "../time.js";
import { call, describeService, loadAllServices, pickPeriod, ref, resolveService, resourceOf, resourceType, serviceIdsOf, } from "./grades.js";
import { stableId, stableIds } from "./ids.js";
/** Largest number of assessments whose levels are read in one call. */
export const MAX_ITEMS = 30;
/** EGenreNiveauDAcquisition of the client, used when the school's list was not received at login. */
export const DEFAULT_LEVELS = [
    { code: 1, name: "Expert" },
    { code: 2, name: "Acquis" },
    { code: 3, name: "Presque acquis" },
    { code: 4, name: "En cours d'acquisition" },
    { code: 5, name: "Début d'acquisition" },
    { code: 6, name: "Non acquis" },
    { code: 7, name: "Absent" },
    { code: 8, name: "Non évalué" },
    { code: 9, name: "Dispensé" },
    { code: 10, name: "Non rendu" },
];
export const isAccessDenied = (error) => error instanceof ServerSideError && /droits|insuffisant/i.test(error.message);
/** Levels of the school (listeNiveauxDAcquisitions captured at login), else the client enumeration. */
export const levelsOf = (session) => {
    const raw = listOf(userData(session).acquisitionLevels)
        .filter((item) => item && typeof item === "object" && typeof item.G === "number")
        .map((item) => ({ code: Number(item.G), name: String(item.L ?? "").trim() }));
    return raw.length ? raw : DEFAULT_LEVELS;
};
const text = (value) => {
    const raw = value !== null && typeof value === "object" && "V" in value ? value.V : value;
    return typeof raw === "string" ? raw.trim() : "";
};
/** Levels given in one assessment (PageCompetencesParEvaluation answer, "data" member). */
export const ratingsFromPage = (data, skillIds) => {
    const result = [];
    for (const student of listOf(data?.ListeElevesCompetences)) {
        const label = String(student?.L ?? student?.eleve?.V?.L ?? "").trim();
        for (const item of listOf(student?.ListeCompetences)) {
            const level = item?.NiveauDAcquisition?.V ?? item?.NiveauDAcquisition;
            const code = level && typeof level === "object" ? Number(level.G) : Number(level);
            result.push({
                student: label,
                skill: skillIds.get(String(item?.N ?? "")) ?? String(item?.N ?? ""),
                level: Number.isFinite(code) && code > 0 ? code : null,
                observation: item?.ObservationPubliee === true ? text(item?.Observation) : "",
            });
        }
    }
    return result;
};
/** Domain code of a pilier ("D2", "D1.1", "CT3"): its code member, else the start of its label. */
export const domainCodeOf = (pilier) => {
    const code = String(pilier?.code ?? pilier?.Code ?? "").trim();
    if (code)
        return code;
    const match = String(pilier?.L ?? "").match(/^\s*((?:D|CT)\s?\d+(?:\.\d+)?)\b/i);
    return match ? match[1].replace(/\s+/g, "").toUpperCase() : "";
};
/** Number of a skill item ("4.1") and its label without it: numero / numeroRESI / code member, else label prefix. */
export const numberOf = (skill) => {
    const name = String(skill?.L ?? "").trim();
    const member = String(skill?.numero ?? skill?.numeroRESI ?? skill?.code ?? "").trim();
    const match = name.match(/^(\d+(?:\.\d+)*)[\s.):-]+(.*)$/);
    if (member)
        return { number: member, name: match && match[1] === member ? match[2].trim() : name };
    return match ? { number: match[1], name: match[2].trim() } : { number: "", name };
};
/** "D2/4.1", or the part that is known. */
export const skillCode = (domainCode, number) => domainCode && number ? `${domainCode}/${number}` : domainCode || number;
/** Skill of an assessment (listeCompetences of ListeEvaluations), with its stable id. */
const skillOf = (skill, id) => {
    const pilier = skill?.pilier?.V ?? skill?.pilier ?? {};
    const { number, name } = numberOf(skill);
    const domainCode = domainCodeOf(pilier);
    return {
        id,
        name,
        domain: String(pilier?.L ?? "").trim(),
        domainCode,
        number,
        code: skillCode(domainCode, number),
        cycle: String(skill?.palier?.V?.L ?? pilier?.palier?.V?.L ?? "").trim(),
    };
};
/** Delay of the publication to parents (days) of the school, null when unknown. */
export const parentsDelayOf = (session) => userData(session).parentsDelayDays ?? null;
/** One assessment of ListeEvaluations, without its ratings. */
export const itemFromList = (evaluation, subject, resourcename, type, serviceid = "", parentsDelay = null) => {
    const date = parsePronoteDate(evaluation.dateValidation?.V ?? evaluation.date?.V);
    const publication = parsePronoteDate(evaluation.datePublication?.V);
    const parents = parsePronoteDate(evaluation.datePublicationParents?.V ?? evaluation.datePublicationParent?.V);
    const title = String(evaluation.L ?? "").trim();
    const skills = listOf(evaluation.listeCompetences);
    const skillIds = new Map();
    const ids = stableIds("competency", skills, (skill) => `${String(skill?.L ?? "")}|${String(skill?.pilier?.V?.L ?? "")}`);
    skills.forEach((skill, index) => skillIds.set(String(skill?.relationESI?.V?.N ?? skill?.N ?? ""), ids[index]));
    const coefficient = Number.parseFloat(String(evaluation.coefficient?.V ?? evaluation.coefficient ?? "").replace(",", "."));
    return {
        skillIds,
        item: {
            // Legacy timestamp (host zone, as until 0.8.0): the id of an assessment must not change with the time zone fix.
            id: stableId("competency", `${date ? legacySeconds(date) : 0}|${resourcename}|${title}`),
            title,
            date: date ? seconds(date) : null,
            publication: publication ? seconds(publication) : null,
            publicationParents: parents
                ? seconds(parents)
                : publication && parentsDelay !== null
                    ? seconds(publication) + Math.round(parentsDelay * 86400)
                    : null,
            coefficient: Number.isFinite(coefficient) ? coefficient : null,
            cycleReport: evaluation.priseEnCompteDansBilan !== false,
            local: localTimes({ date, publication, publicationParents: parents }),
            subject,
            resourcename,
            type,
            serviceid,
            skills: skills.map((skill, index) => skillOf(skill, ids[index])),
            ratings: [],
        },
    };
};
/** Resource member ({N, G, L}, G 1 class, 2 group) of a service. */
export const resourceRefOf = (service, type) => {
    const resource = resourceOf(service);
    return resource ? { ...resource, G: type === "group" ? 2 : 1 } : undefined;
};
/** Element sent to the skills functions: the skills service (tab 65) when known, else the grade one. */
export const competencyElement = (entry) => entry.competency ?? entry.grade ?? entry.service;
/* non validé sur la démo : onglets 65 et 56 fermés au profil de démonstration */
export const overview = async (session, periodId = "", classes = []) => {
    const picked = await pickPeriod(session, periodId);
    const parentsDelay = parentsDelayOf(session);
    const base = {
        available: true,
        reason: "",
        levels: levelsOf(session),
        period: { id: picked.periodId, name: String(picked.period.L ?? "") },
        parentsDelayDays: parentsDelay,
        services: [],
        items: [],
    };
    const all = await loadAllServices(session, picked.period);
    const serviceIds = serviceIdsOf(all);
    const services = [];
    let total = 0;
    for (const [index, entry] of all.entries()) {
        const service = competencyElement(entry);
        const resourcename = String(resourceOf(service)?.L ?? "");
        if (!matchesLabels([resourcename], classes))
            continue;
        const described = describeService(session, entry, serviceIds[index], [picked.periodId]);
        services.push(described);
        const type = entry.grade
            ? userData(session).resources.find((item) => item.label === resourcename)?.genre === 2 ? "group" : "class"
            : resourceType(session, resourcename, true);
        const resourceRef = resourceRefOf(service, type);
        let list;
        try {
            list = await call(session, "competencyList", {
                service: ref(service),
                ...(resourceRef ? { ressource: ref(resourceRef) } : {}),
                periode: ref(picked.period),
            });
        }
        catch (error) {
            if (isAccessDenied(error))
                return { ...base, services, available: false, reason: "access_denied" };
            throw error;
        }
        if (!list || Object.keys(list).length === 0)
            return { ...base, services, available: false, reason: "access_denied" };
        const subject = String(service.matiere?.V?.L ?? service.L ?? "");
        for (const evaluation of listOf(list.listeEvaluations)) {
            if (total >= MAX_ITEMS)
                break;
            total++;
            const { item, skillIds } = itemFromList(evaluation, subject, resourcename, type, serviceIds[index], parentsDelay);
            const page = await call(session, "competencyPage", {
                evaluation: ref(evaluation),
                ...(evaluation.devoir?.V?.N ? { devoir: ref(evaluation.devoir.V) } : {}),
                ...(resourceRef ? { ressource: ref(resourceRef) } : {}),
                periodeEvaluation: ref(picked.period),
            });
            item.ratings = ratingsFromPage(page, skillIds);
            base.items.push(item);
        }
    }
    return { ...base, services };
};
const SKIPPED_MEMBERS = new Set(["pilier", "palier", "relationESI", "service", "classe", "groupe", "periode", "matiere"]);
const isNode = (value) => value !== null && typeof value === "object" && typeof value.N === "string"
    && typeof value.L === "string";
const childrenOf = (node) => Object.entries(node)
    .filter(([key]) => !SKIPPED_MEMBERS.has(key))
    .flatMap(([, value]) => listOf(value))
    .filter(isNode);
/**
 * Items (leaves) of a referential tree, whatever its depth: cycle ("palier", label starting with "Cycle" or member
 * palier) > domain ("pilier", D1…D5) > element (intermediate) > item. A flat list of skills (listeCompetences of an
 * assessment, each with its pilier member) gives the same items. Reconstructed from the client, NOT VALIDATED.
 */
export const referentialFrom = (roots) => {
    const found = [];
    const visit = (node, context) => {
        const kids = childrenOf(node);
        const label = String(node.L ?? "").trim();
        const pilier = node.pilier?.V ?? node.pilier;
        const cycle = String(node.palier?.V?.L ?? pilier?.palier?.V?.L ?? "").trim() || context.cycle;
        if (kids.length === 0) {
            const { number, name } = numberOf(node);
            const domain = context.domain || String(pilier?.L ?? "").trim();
            const domainCode = context.domainCode || domainCodeOf(pilier);
            found.push({
                relation: String(node.relationESI?.V?.N ?? node.N),
                cycle,
                domain,
                domainCode,
                element: context.element,
                number,
                name,
                code: skillCode(domainCode, number),
            });
            return;
        }
        let next;
        if (/^(cycle|palier)\b/i.test(label) && context.domain === "")
            next = { ...context, cycle: label };
        else if (context.domain === "")
            next = { ...context, cycle, domain: label, domainCode: domainCodeOf(node) };
        else
            next = { ...context, cycle, element: [context.element, label].filter(Boolean).join(" > ") };
        for (const kid of kids)
            visit(kid, next);
    };
    for (const root of roots) {
        if (isNode(root))
            visit(root, { cycle: "", domain: "", domainCode: "", element: "" });
    }
    // The same item read twice (tree and skills already assessed) is kept once, with its first relation.
    const key = (item) => `${item.cycle}|${item.domainCode || item.domain}|${item.number}|${item.name}`;
    const unique = found.filter((item, index) => found.findIndex((other) => key(other) === key(item)) === index);
    const ids = stableIds("referential", unique, key);
    return unique.map((item, index) => ({ id: ids[index], ...item }));
};
/** Referential of a service: listeReferentielsUniques of ListeEvaluations, ListePiliers, skills already assessed. */
export const loadReferential = async (session, service, resourceRef, list) => {
    const roots = [...listOf(list?.listeReferentielsUniques)];
    try {
        const data = await call(session, "competencyReferential", {
            service: ref(service),
            ...(resourceRef ? { ressource: ref(resourceRef) } : {}),
        });
        roots.push(...listOf(data?.listePiliers), ...listOf(data?.listeReferentiels));
    }
    catch (error) {
        if (!(error instanceof ServerSideError) && !(error instanceof HttpError))
            throw error;
    }
    for (const evaluation of listOf(list?.listeEvaluations))
        roots.push(...listOf(evaluation.listeCompetences));
    return referentialFrom(roots);
};
/**
 * Referential item designated by a stable id (rf:…), a code ("D2/4.1", "D2 4.1", "4.1" when unique) or a label
 * (case and accents ignored, with or without its number). null when unknown or ambiguous.
 */
export const findReferentialItem = (wanted, items) => {
    const exact = items.find((item) => item.id === wanted);
    if (exact)
        return exact;
    const code = wanted.trim().toUpperCase().replace(/\s*[/\s-]\s*/g, "/");
    const unique = (found) => (found.length === 1 ? found[0] : null);
    if (/^((D|CT)\d+(\.\d+)?\/)?\d+(\.\d+)*$/.test(code)) {
        const byCode = unique(items.filter((item) => item.code.toUpperCase() === code));
        if (byCode)
            return byCode;
        if (!code.includes("/"))
            return unique(items.filter((item) => item.number === code));
        return null;
    }
    const label = normalise(wanted).replace(/^\d+(\.\d+)*[\s.):-]+/, "");
    return unique(items.filter((item) => normalise(item.name) === label));
};
/** GET /competencies/referential: the referential of one service of the period. */
export const referential = async (session, serviceId, periodId = "") => {
    const picked = await pickPeriod(session, periodId);
    const all = await loadAllServices(session, picked.period);
    const entry = resolveService(serviceId, all);
    const index = all.indexOf(entry);
    const service = competencyElement(entry);
    const resourcename = String(resourceOf(service)?.L ?? "");
    const type = resourceType(session, resourcename, entry.grade === null);
    const resourceRef = resourceRefOf(service, type);
    const described = describeService(session, entry, serviceIdsOf(all)[index], [picked.periodId]);
    let list;
    try {
        list = await call(session, "competencyList", {
            service: ref(service),
            ...(resourceRef ? { ressource: ref(resourceRef) } : {}),
            periode: ref(picked.period),
        });
    }
    catch (error) {
        if (isAccessDenied(error)) {
            return { available: false, reason: "access_denied", validated: false, service: described, items: [] };
        }
        throw error;
    }
    const items = (await loadReferential(session, service, resourceRef, list)).map(({ relation: _relation, ...item }) => item);
    return { available: true, reason: "", validated: false, service: described, items };
};
//# sourceMappingURL=competencies.js.map