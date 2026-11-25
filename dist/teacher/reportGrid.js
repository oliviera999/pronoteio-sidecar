/**
 * 0.17.0 (chantier olutionsuivi 0.3.0, lot NS): periods of a class or group, and the grid of the comments tab
 * (tab 25, "Saisie des appréciations") with the positioning ("Pos.") and LSU mark ("N. LSU") columns of a "collège"
 * class. Shapes from the capture of the real server of 24/11/2026 (docs/pronoteio/capture-saisies-2026-11-24.md):
 * - ListePeriodes (tab 25, { ressource, listeRessources }) → listePeriodes: trimesters ("105#…", G 2, GenreNotation 1),
 *   bac blancs and CCF (G 4, GenreNotation 0); periodeParDefaut without G; cloture / strInfoCloture;
 * - PageApprBulletin ({ ressource, periode, service }) → listeLignes: eleve, classe (the student's own class, also for a
 *   group), appA/appB/appC, typePositionnementClasse, niveauAcquEditable, noteLSUEditable, noteLSU { _T: 10, V },
 *   listeNiveaux (N "93#…", G 1 Très bonne maîtrise, 2 satisfaisante, 4 fragile, 6 insuffisante, 7 Absent, 8 Non
 *   évalué, 9 Dispensé, 10 Non rendu), nbEvals.
 * The member that carries the positioning of a line is not in the capture: it is read from niveauAcqu (the member of
 * the RapportSaisie of SaisiePositionnement), then positionnement. Read only here; writes in positioningWrite.ts.
 */
import { ServerSideError } from "pawnote";
import { HttpError } from "../errors.js";
import { listOf } from "../pronote/encoding.js";
import { commentResource, findCommentService } from "./comments.js";
import { isAccessDenied } from "./competencies.js";
import { call, loadCommentServices, loadCompetencyServices, loadServices, periodDates, periodKey, pickPeriod, resourceOf, serviceKey, } from "./grades.js";
import { resolve, stableId, stableIds } from "./ids.js";
import { member } from "./tolerant.js";
const GENRE_PERIOD = 2;
const GENRE_CLASS = 1;
const unwrap = (value) => value !== null && typeof value === "object" && "V" in value ? value.V : value;
const numberOrNull = (value) => {
    const raw = unwrap(value);
    if (raw === null || raw === undefined || raw === "")
        return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
};
/**
 * Kind of a Pronote period (contract N, section 2): "Trimestre n" → trimester, "Semestre n" → semester, a period of
 * genre 4 or GenreNotation 0 (bac blanc, CCF) → exam, else other.
 */
export const periodKind = (period) => {
    const name = String(period.L ?? "");
    if (/trimestre/i.test(name))
        return "trimester";
    if (/semestre/i.test(name))
        return "semester";
    const notation = numberOrNull(period.GenreNotation);
    if (Number(period.G) === 4 || notation === 0 || /blanc|ccf|examen/i.test(name))
        return "exam";
    return "other";
};
/**
 * Short stable code of a period (contract N, section 2): T1…T3, S1, S2, BB1, BB2, CCF (by the name), else X<rank>
 * for an exam and P<rank> for another period. "rank" is the rank of the period among those of its kind (1-based).
 */
export const periodCode = (period, kind, rank) => {
    const name = String(period.L ?? "");
    const digit = name.match(/(\d+)/)?.[1];
    if (kind === "trimester" && digit)
        return `T${Number(digit)}`;
    if (kind === "semester" && digit)
        return `S${Number(digit)}`;
    if (kind === "exam") {
        if (/\bccf\b/i.test(name))
            return "CCF";
        if (/(bac|brevet)\s*blanc/i.test(name))
            return `BB${digit ? Number(digit) : 1}`;
        return `X${rank}`;
    }
    if (kind === "trimester")
        return `T${rank}`;
    if (kind === "semester")
        return `S${rank}`;
    return `P${rank}`;
};
const closedOf = (item) => item?.cloture === true || unwrap(item?.cloture) === true || String(item?.strInfoCloture ?? "").trim() !== "";
/** Periods of a ListePeriodes answer, with their kinds, codes, ranks and dates (contract N, 6.1 point 1). */
export const periodsFromAnswer = (session, data) => {
    const elements = listOf(data?.listePeriodes ?? data?.ListePeriodes).filter((item) => item && typeof item === "object");
    const byDefault = unwrap(data?.periodeParDefaut);
    const currentElement = elements.find((item) => byDefault?.N !== undefined && item.N === byDefault.N)
        ?? elements.find((item) => byDefault?.L && item.L === byDefault.L) ?? null;
    const ids = stableIds("period", elements, periodKey);
    const ranks = new Map();
    const used = new Set();
    const periods = elements.map((element, index) => {
        const kind = periodKind(element);
        const rank = (ranks.get(kind) ?? 0) + 1;
        ranks.set(kind, rank);
        let code = periodCode(element, kind, rank);
        // Two periods of the same code (two "BAC BLANC" without number): the second one takes its rank.
        if (used.has(code))
            code = `${kind === "exam" ? "X" : "P"}${rank}`;
        used.add(code);
        const dates = periodDates(session, element);
        const name = String(element.L ?? "");
        const digit = name.match(/(\d+)/)?.[1];
        return {
            id: ids[index],
            name,
            genre: numberOrNull(element.G),
            notation: numberOrNull(element.GenreNotation),
            kind,
            code,
            rank: (kind === "trimester" || kind === "semester") && digit ? Number(digit) : rank,
            start: dates.start ?? null,
            end: dates.end ?? null,
            current: element === currentElement,
            closed: closedOf(element),
        };
    });
    const current = currentElement ? ids[elements.indexOf(currentElement)] : null;
    return { periods, elements, current };
};
const resourceElement = (resource, genre) => ({ N: resource.id, G: genre, L: resource.label });
/** ListePeriodes of tab 25 for a class or group, as the comments page asks it ({ ressource, listeRessources }). */
const askClassPeriods = async (session, resource, genre) => {
    const element = resourceElement(resource, genre);
    return call(session, "classPeriodsList", { ressource: element, listeRessources: [element] });
};
/** GET /reports/periods: periods of a class or group (contract N, 6.1 point 1). A refusal is 403 access_denied. */
export const classPeriods = async (session, resourceId) => {
    const { resource, genre } = commentResource(session, resourceId);
    let data;
    try {
        data = await askClassPeriods(session, resource, genre);
    }
    catch (error) {
        if (isAccessDenied(error))
            throw new HttpError(403, "access_denied");
        throw error;
    }
    if (!data || Object.keys(data).length === 0)
        throw new HttpError(403, "access_denied");
    const read = periodsFromAnswer(session, data);
    return { resource: { id: resourceId, name: resource.label, genre }, current: read.current, periods: read.periods };
};
/**
 * Period of a class or group for the grid and the positioning: looked for in the periods of the class (tab 25: bac
 * blancs and CCF are there), by stable id or by code ("T1"), then in the periods of the grade entry (pickPeriod, tab
 * 23) when the class periods are refused or lack it.
 */
export const pickClassPeriod = async (session, resource, genre, periodId) => {
    try {
        const data = await askClassPeriods(session, resource, genre);
        const read = periodsFromAnswer(session, data);
        const index = read.periods.findIndex((item) => item.id === periodId || item.code === periodId);
        if (index >= 0)
            return { period: read.elements[index], periodId: read.periods[index].id, closed: read.periods[index].closed };
        try {
            const element = resolve("period", periodId, read.elements, periodKey);
            const found = read.elements.indexOf(element);
            return { period: element, periodId: read.periods[found].id, closed: read.periods[found].closed };
        }
        catch (error) {
            if (!(error instanceof HttpError) || error.status !== 404)
                throw error;
        }
    }
    catch (error) {
        if (!(error instanceof ServerSideError) && !(error instanceof HttpError && error.status === 404))
            throw error;
    }
    const picked = await pickPeriod(session, periodId);
    return { period: picked.period, periodId: picked.periodId, closed: false };
};
/**
 * Service of the teacher named by its stable id for a class or group: the grade services (tab 23, same ids as
 * /grades/context), then the services of the comments page (tab 25, sub-services included), then the skills services
 * (tab 65). Without id: the service found for the comments (findCommentService). None: 404 service_not_found.
 */
export const findGridService = async (session, period, resource, serviceId) => {
    if (serviceId === "") {
        const found = await findCommentService(session, period, resource);
        if (!found)
            throw new HttpError(404, "service_not_found");
        return { service: found.service, id: found.id };
    }
    const grades = await loadServices(session, period);
    const gradeIds = stableIds("service", grades, serviceKey);
    const index = gradeIds.indexOf(serviceId);
    if (index >= 0)
        return { service: grades[index], id: serviceId };
    const listed = await loadCommentServices(session, period, { id: resource.id, genre: resource.genre, label: resource.label });
    const own = listed.find((service) => stableId("service", serviceKey(service)) === serviceId);
    if (own)
        return { service: own, id: serviceId };
    const skills = await loadCompetencyServices(session, period);
    const skill = skills.find((service) => stableId("service", serviceKey(service)) === serviceId);
    if (skill)
        return { service: skill, id: serviceId };
    throw new HttpError(404, "service_not_found");
};
export const serviceName = (service, resource) => [service.matiere?.V?.L ?? service.L ?? "", String(resourceOf(service)?.L ?? resource.label)].filter(Boolean).join(" - ");
/** Genres of the acquisition levels (1 to 6); 7 Absent, 8 Non évalué, 9 Dispensé, 10 Non rendu are special. */
const LEVEL_GENRES = new Set([1, 2, 3, 4, 5, 6]);
const refOf = (value) => {
    const raw = unwrap(value);
    if (raw === null || typeof raw !== "object")
        return null;
    if (raw.N === undefined || raw.N === null || raw.N === "")
        return null;
    return { N: String(raw.N), ...(raw.G !== undefined ? { G: Number(raw.G) } : {}), ...(typeof raw.L === "string" ? { L: raw.L.trim() } : {}) };
};
/** Positioning of a line: niveauAcqu, else positionnement; "Aucun" (N 0, G 0) and an empty element are null. */
const positioningOf = (line) => {
    const raw = unwrap(member(line, ["niveauAcqu", "positionnement", "niveauAcquisition"]));
    if (raw === null || raw === undefined || typeof raw !== "object")
        return null;
    const genre = Number(raw.G ?? 0);
    if (!Number.isFinite(genre) || genre <= 0)
        return null;
    return { N: String(raw.N ?? ""), G: genre, ...(typeof raw.L === "string" ? { L: raw.L } : {}) };
};
/** LSU mark of a line: noteLSU { _T: 10, V: "15" }, "" and absent are null. */
const lsuOf = (line) => {
    const raw = unwrap(line?.noteLSU);
    if (raw === null || raw === undefined)
        return null;
    const value = String(typeof raw === "object" ? (raw.V ?? "") : raw).trim();
    return value === "" ? null : value;
};
const appOf = (value) => {
    const raw = unwrap(value);
    return raw !== null && typeof raw === "object" ? raw : null;
};
/** The teacher's comment of a line (first of appA, appB, appC not marked read-only), with whether it is editable. */
const commentOf = (line) => {
    const candidates = [line?.appA, line?.appB, line?.appC].map(appOf).filter((item) => item !== null);
    const app = candidates.find((item) => item.editable !== false && item.estEditable !== false) ?? candidates[0] ?? null;
    if (!app)
        return null;
    const text = typeof app.L === "string" ? app.L : typeof app.appreciation === "string" ? app.appreciation : "";
    return { text, editable: app.editable !== false && app.estEditable !== false };
};
/** Grid of a PageApprBulletin answer: positioning, LSU mark, number of assessments and comment of each student. */
export const gridFromPage = (page) => {
    const lines = listOf(page?.listeLignes).filter((line) => line && typeof line === "object");
    const withMember = (name) => (page && name in page ? page : lines.find((line) => name in line));
    const typeSource = withMember("typePositionnementClasse");
    const positioningType = typeSource ? numberOrNull(typeSource.typePositionnementClasse) : null;
    const levelsSource = withMember("listeNiveaux");
    const levels = listOf(levelsSource?.listeNiveaux)
        .filter((item) => item && typeof item === "object" && item.G !== undefined)
        .map((item) => {
        const genre = Number(item.G);
        return { id: String(item.N ?? genre), genre, name: String(item.L ?? ""), status: LEVEL_GENRES.has(genre) ? "level" : "special",
            element: { N: String(item.N ?? ""), G: genre, ...(typeof item.L === "string" ? { L: item.L } : {}) } };
    });
    const closed = closedOf(page) || lines.some((line) => appOf(line.appA)?.cloture === true);
    const rows = lines
        .filter((line) => line.eleve)
        .map((line) => {
        const student = refOf(line.eleve) ?? { N: "", L: "" };
        const hasPositioning = "niveauAcquEditable" in line || "typePositionnementClasse" in line || "niveauAcqu" in line || "positionnement" in line;
        const hasLsu = "noteLSUEditable" in line || "noteLSU" in line;
        return {
            student: { ...student, L: String(student.L ?? "").trim() },
            classe: refOf(line.classe),
            service: refOf(line.service),
            positioning: positioningOf(line),
            lsu: lsuOf(line),
            positioningEditable: unwrap(line.niveauAcquEditable) === true,
            lsuEditable: unwrap(line.noteLSUEditable) === true,
            hasPositioning,
            hasLsu,
            nbEvals: numberOrNull(line.nbEvals),
            comment: commentOf(line),
            closed: appOf(line.appA)?.cloture === true,
        };
    });
    const anyColumn = positioningType !== null || levels.length > 0 || rows.some((row) => row.hasPositioning || row.hasLsu);
    return { closed, positioningType: anyColumn ? positioningType : null, levels, rows };
};
export const gridTarget = async (session, resourceId, periodId, serviceId) => {
    const { resource, genre } = commentResource(session, resourceId);
    const picked = await pickClassPeriod(session, resource, genre, periodId);
    const service = await findGridService(session, picked.period, resource, serviceId);
    return { resourceId, resource, genre, period: picked.period, periodId: picked.periodId, periodClosed: picked.closed, service };
};
/** PageApprBulletin of the target; null when Pronote refuses it (or answers nothing). */
export const readGridPage = async (session, target) => {
    try {
        const page = await call(session, "commentsPage", {
            ressource: { N: target.resource.id, G: target.genre },
            periode: { N: target.period.N, G: target.period.G ?? GENRE_PERIOD },
            service: { N: target.service.service.N },
        });
        return page && Object.keys(page).length > 0 ? page : null;
    }
    catch (error) {
        if (isAccessDenied(error))
            return null;
        throw error;
    }
};
/** Class of a row as the routes show it: the student's own class (stable id), else the requested resource. */
export const rowClass = (row, target) => row.classe?.L ? { id: stableId("class", row.classe.L), name: row.classe.L } : { id: target.resourceId, name: target.resource.label };
/** GET /reports/grid (contract N, 6.1 point 3). */
export const reportGrid = async (session, resourceId, periodId, serviceId = "") => {
    const target = await gridTarget(session, resourceId, periodId, serviceId);
    const base = {
        available: true,
        reason: "",
        class: { id: resourceId, name: target.resource.label },
        period: { id: target.periodId, name: String(target.period.L ?? "") },
        service: { id: target.service.id, name: serviceName(target.service.service, target.resource) },
        closed: target.periodClosed,
        positioningType: null,
        levels: [],
        rows: [],
    };
    const page = await readGridPage(session, target);
    if (!page)
        return { ...base, available: false, reason: "access_denied" };
    const grid = gridFromPage(page);
    return {
        ...base,
        closed: base.closed || grid.closed,
        positioningType: grid.positioningType,
        levels: grid.levels.map(({ id, genre, name, status }) => ({ id, genre, name, status })),
        rows: grid.rows.map((row) => ({
            student: String(row.student.L ?? ""),
            classe: rowClass(row, target),
            positioning: row.positioning && row.positioning.G !== undefined
                ? { id: row.positioning.N, genre: row.positioning.G, name: row.positioning.L
                        ?? grid.levels.find((level) => level.genre === row.positioning.G)?.name ?? "" }
                : null,
            lsu: row.lsu,
            positioningEditable: row.positioningEditable,
            lsuEditable: row.lsuEditable,
            nbEvals: row.nbEvals,
            comment: row.comment,
        })),
    };
};
export { GENRE_CLASS };
//# sourceMappingURL=reportGrid.js.map