/**
 * Report card comments ("appréciations") of the teacher's service for a class and a period, read only.
 *
 * NOT VALIDATED ON THE DEMO SERVER: tabs 25 and 27 are closed to its teacher profile (refusal verified). Shapes come
 * from the web client code (docs/pronote-matrice/4-9-bulletins-divers.md in mood_prod): PageApprBulletin
 * { ressource, periode, service } → listeLignes[] (eleve, appA/appB/appC, cloture), appreciationClasse,
 * strInfoCloture; for the main teacher, ListeAppreciations (kinds) then PageAppreciationsGenerales
 * { classe, periode, appreciation, estUneRubrique } → listeLignes[] (eleve, appreciationGle).
 *
 * 0.12.0: every kind of general comment that is not a rubric is read (see readGeneral), the answer says why none came
 * back ("general"), and a main teacher without service in the class still gets them (service: null).
 */
import { ServerSideError } from "pawnote";
import { HttpError } from "../errors.js";
import { listOf } from "../pronote/encoding.js";
import { userData } from "../pronote/userdata.js";
import { isAccessDenied } from "./competencies.js";
import { call, loadCommentServices, loadCompetencyServices, loadServices, pickPeriod, ref, resourceOf, serviceKey } from "./grades.js";
import { kindOf, resolve, stableId, stableIds } from "./ids.js";
import { labelKey } from "../normalise.js";
import { isTabClosed } from "./functions.js";
import { shapeOf } from "./shape.js";
import { reportsPage } from "./reports.js";
import { boolOf, member } from "./tolerant.js";
const GENRE_CLASS = 1;
const GENRE_GROUP = 2;
const GENRE_PERIOD = 2;
const text = (value) => {
    const raw = value !== null && typeof value === "object" && "V" in value ? value.V : value;
    if (raw !== null && typeof raw === "object")
        return text(raw.L);
    return typeof raw === "string" ? raw : null;
};
/** Largest length of a report card comment (TailleMaxAppreciation[0], teacher's bulletin comment), null if unknown. */
export const maxLengthOf = (session) => {
    const raw = userData(session).maxCommentLength;
    const value = Array.isArray(raw) ? raw[0] : raw !== null && typeof raw === "object" ? raw.V : raw;
    const first = Array.isArray(value) ? value[0] : value;
    const parsed = Number.parseInt(String(first ?? ""), 10);
    if (!Number.isFinite(parsed))
        return null;
    return parsed > 0 ? parsed : null;
};
/** Lines of a PageApprBulletin answer ("data" member): one per student, with the teacher's comment. */
export const commentsFromPage = (data) => {
    const students = listOf(data?.listeLignes)
        .filter((line) => line?.eleve)
        .map((line) => {
        const first = line.appA ?? line.appB ?? line.appC ?? null;
        // 0.16.1: text in "L", else in "appreciation" (as the class comment carries it on the real grid).
        return { student: String(line.eleve?.V?.L ?? line.eleve?.L ?? "").trim(), comment: generalText(first) };
    });
    const closed = String(data?.strInfoCloture ?? "").trim() !== ""
        || listOf(data?.listeLignes).some((line) => line?.appA?.cloture === true || line?.appA?.V?.cloture === true);
    // 0.16.1, real grid of 23/11/2026: the class comment is { G, titre, appreciation, editable, cloture }, text in "appreciation".
    const classComment = generalText(data?.appreciationClasse);
    return { students, classComment: classComment === "" ? null : classComment, closed };
};
const LINE_LISTS = ["listeLignes", "ListeLignes", "lignes"];
const GENERAL_TEXTS = ["appreciationGle", "appreciationGenerale", "appGenerale", "appreciation"];
/**
 * General comments of the main teacher (PageAppreciationsGenerales answer): student → text. Rubric lines ("estPere")
 * are skipped. Member names without case (listeLignes, appreciationGle and their candidates).
 */
export const generalFromPage = (data) => new Map(listOf(member(data, LINE_LISTS))
    .filter((line) => line?.eleve && line?.estPere !== true)
    .map((line) => [String(line.eleve?.V?.L ?? line.eleve?.L ?? "").trim(), generalText(member(line, GENERAL_TEXTS))]));
/**
 * Text of a general comment. 0.14.1, real shape of 21/11/2026: the element of a line carries { N, G, titre, appreciation,
 * editable, cloture } and no "L" while nothing is entered; the text is read from "L", then from "appreciation".
 */
const generalText = (value) => {
    const read = text(value);
    if (read !== null)
        return read;
    const raw = value !== null && typeof value === "object" && "V" in value ? value.V : value;
    const other = raw !== null && typeof raw === "object" ? raw.appreciation : null;
    return typeof other === "string" && other !== "" ? other : null;
};
/** Whether a PageAppreciationsGenerales answer carries its list of lines (even empty). */
const hasLines = (data) => member(data, LINE_LISTS) !== undefined;
/**
 * Kinds of general comments of the school (ListeAppreciations answer): name and whether it is a rubric (a heading
 * with children, e.g. "Conseil de classe", "Vie scolaire" on the demo server), with the Pronote element.
 */
export const kindsFromAnswer = (data) => 
// 0.14.0, first real check: the member is "liste" (as the web client reads it: actionSurRequeteListeAppreciations).
listOf(member(data, ["liste", "listeAppreciations", "ListeAppreciations"]))
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
    element: item,
    name: String(item.L ?? "").trim(),
    rubric: boolOf(member(item, ["estUneRubrique", "estRubrique", "estPere", "rubrique"])) === true,
}));
/**
 * Requests tried for the kinds of general comments, in order. The web client fills ListeAppreciations from the page
 * (objetrequetelistes.js: ressource = the class, listeRessources, periode); the request without parameter answered an
 * EMPTY list on the real server (20/11/2026). "classe" is the name of the page request, tried last.
 */
export const kindRequests = (resource, period) => {
    const classe = { N: resource.id, G: resource.genre, L: resource.label };
    const periode = { N: period.N, G: period.G ?? GENRE_PERIOD, L: period.L };
    return [
        { variant: "ressource+periode", data: { ressource: classe, periode } },
        { variant: "ressource+listeRessources+periode", data: { ressource: classe, listeRessources: [classe], periode } },
        { variant: "none", data: {} },
        { variant: "classe+periode", data: { classe, periode } },
    ];
};
/**
 * Kinds of general comments of a class and period: the first request whose list is not empty. A refusal of every
 * request is access_denied; an answer without any known list is format_unknown (with its shape).
 */
export const readKinds = async (session, resource, period) => {
    // A class and period without any kind are not asked again for ten minutes: the general comments are then read from
    // the report cards by pages, and each page would send the four requests again.
    const memo = noKinds.get(session) ?? new Map();
    noKinds.set(session, memo);
    const key = `${resource.id}|${period.N}`;
    const known = memo.get(key);
    if (known && known.expires > Date.now())
        return known.read;
    const read = await askKinds(session, resource, period);
    if (read.kinds.length === 0 && read.reason !== "access_denied")
        memo.set(key, { expires: Date.now() + NO_KINDS_TTL_MS, read });
    return read;
};
const NO_KINDS_TTL_MS = 10 * 60_000;
const noKinds = new WeakMap();
/** Forgets the classes and periods known to have no kind of general comment (tests). */
export const resetKindsMemo = (session) => {
    noKinds.delete(session);
};
const askKinds = async (session, resource, period) => {
    let denied = 0;
    let unknown = null;
    const requests = kindRequests(resource, period);
    for (const request of requests) {
        let answer;
        try {
            answer = await call(session, "commentKinds", request.data);
        }
        catch (error) {
            if (!isAccessDenied(error))
                throw error;
            denied++;
            continue;
        }
        if (!answer || Object.keys(answer).length === 0) {
            denied++;
            continue;
        }
        const kinds = kindsFromAnswer(answer);
        if (kinds.length > 0)
            return { kinds, variant: request.variant, reason: "" };
        if (member(answer, ["liste", "listeAppreciations", "ListeAppreciations"]) === undefined)
            unknown = unknown ?? shapeOf(answer);
    }
    if (denied === requests.length)
        return { kinds: [], variant: "", reason: "access_denied" };
    return unknown ? { kinds: [], variant: "", reason: "format_unknown", shape: unknown } : { kinds: [], variant: "", reason: "no_kind" };
};
/** Largest number of kinds of general comments read (one Pronote call each). */
export const MAX_GENERAL_KINDS = 8;
/** Kind shown as students[].general: the global or general comment, else the first kind read. */
export const mainKind = (names) => names.find((name) => /global|g[ée]n[ée]ral/i.test(name)) ?? names[0] ?? "";
/**
 * General comments of the main teacher for a class and a period: every kind that is not a rubric is read. Until
 * 0.11.5 only the kind named "globale" (or of genre 0) was read and any failure was silent: nothing came back on a
 * school that names it otherwise (20/11/2026). "reason" now says why nothing is returned.
 */
const readGeneral = async (session, resource, period) => {
    const none = (reason, extra = {}) => ({ general: { available: false, reason, kind: "", kinds: [], ...extra }, byKind: [] });
    if (!resource.principal || resource.genre !== GENRE_CLASS)
        return none("not_principal");
    const found = await readKinds(session, resource, period);
    const kinds = found.kinds;
    const listed = kinds.map(({ name, rubric }) => ({ name, rubric }));
    if (kinds.length === 0)
        return none(found.reason, found.shape ? { shape: found.shape } : {});
    const readable = kinds.filter((kind) => !kind.rubric && kind.name !== "").slice(0, MAX_GENERAL_KINDS);
    if (readable.length === 0)
        return none("no_kind", { kinds: listed });
    const byKind = [];
    let denied = 0;
    let unknown = null;
    for (const kind of readable) {
        let page;
        try {
            page = await call(session, "generalCommentsPage", {
                classe: { N: resource.id, G: GENRE_CLASS },
                periode: { N: period.N, G: GENRE_PERIOD },
                appreciation: ref(kind.element),
                estUneRubrique: false,
            });
        }
        catch (error) {
            if (!isAccessDenied(error))
                throw error;
            denied++;
            continue;
        }
        if (!page || Object.keys(page).length === 0) {
            denied++;
            continue;
        }
        if (!hasLines(page)) {
            unknown = unknown ?? shapeOf(page);
            continue;
        }
        byKind.push({ kind: kind.name, lines: generalFromPage(page) });
    }
    if (byKind.length === 0) {
        return none(unknown ? "format_unknown" : denied > 0 ? "access_denied" : "no_kind", { kinds: listed, ...(unknown ? { shape: unknown } : {}) });
    }
    return { general: { available: true, reason: "", kind: mainKind(byKind.map((item) => item.kind)), kinds: listed, source: "kinds",
            variant: found.variant }, byKind };
};
/** Label of a kind of comment of a report card foot, when Pronote gives it no title. */
const FOOT_KINDS = { general: "Appréciation générale", council: "Conseil de classe", comment: "Commentaire",
    cpe: "CPE", other: "Autre" };
/**
 * General comments read from the report cards (0.14.0): the foot of PageBulletins carries them (ObjetListeAppreciations),
 * and that page answers on the real server while the kinds of tab 27 come back empty. One report card per student, by
 * pages, partial when the queue towards Pronote is full. "first" is why the kinds gave nothing: it stays the reason.
 */
const generalFromReports = async (session, resourceId, periodId, page, first) => {
    let read;
    try {
        read = await reportsPage(session, resourceId, periodId, page, "reportcard");
    }
    catch (error) {
        // The list of students or the report cards refused: the first cause stays the answer.
        if (!(error instanceof ServerSideError))
            throw error;
        return { general: first, byKind: [] };
    }
    if (!read.available)
        return { general: first, byKind: [] };
    const byKind = new Map();
    let main = "";
    for (const report of read.items) {
        const student = [report.lastname, report.firstname].filter(Boolean).join(" ");
        for (const comment of report.comments) {
            const kind = comment.title || FOOT_KINDS[comment.kind] || comment.kind;
            if (comment.kind === "general" && main === "")
                main = kind;
            const lines = byKind.get(kind) ?? new Map();
            if (!lines.has(student))
                lines.set(student, comment.text);
            byKind.set(kind, lines);
        }
    }
    const kinds = [...byKind.entries()].map(([kind, lines]) => ({ kind, lines }));
    return {
        general: { available: true, reason: first.reason, kind: main || mainKind(kinds.map((item) => item.kind)), kinds: first.kinds,
            ...(first.shape ? { shape: first.shape } : {}), source: "reportcards",
            page: { total: read.total, offset: read.offset, read: read.read, remaining: read.remaining, partial: read.partial,
                retry_after: read.retry_after } },
        byKind: kinds,
    };
};
/**
 * Class or group of a report card comment request (0.16.1). Moodle names the resource by its label and sends "c:" for
 * any of them (local_olutionmcp until 0.52.x): a group ("6-SC-603") was then refused with class_not_found. The id is
 * resolved in the genre of its prefix, then in the other genre (same label); an unknown label stays a 404.
 */
export const commentResource = (session, id) => {
    const kind = kindOf(id);
    if (kind !== "class" && kind !== "group")
        throw new HttpError(409, "resource_without_pronote_id");
    const resources = userData(session).resources;
    const body = id.slice(id.indexOf(":") + 1);
    const attempt = (wanted) => {
        const genre = wanted === "class" ? GENRE_CLASS : GENRE_GROUP;
        const resource = resolve(wanted, `${wanted === "class" ? "c" : "g"}:${body}`, resources.filter((item) => item.genre === genre), (item) => item.label);
        return { resource, genre: genre, kind: wanted };
    };
    try {
        return attempt(kind);
    }
    catch (error) {
        if (!(error instanceof HttpError) || error.status !== 404)
            throw error;
        try {
            return attempt(kind === "class" ? "group" : "class");
        }
        catch {
            throw error;
        }
    }
};
/**
 * Service of the teacher for the report card comments of a class or group and a period (0.16.1). Until 0.16.0 only
 * the services of the grade entry (tab 23) were looked at: the groups of a "collège" class assessed by skills only
 * (6e at Lyautey: "6-SC-603", "6-SC-601-602") have no grade service and were refused with service_not_found, read and
 * write. Order: tab 23 (stable ids unchanged), then the services of the comments page itself (tab 25, as the client
 * fills its list for that resource), then the skills services (tab 65). Matching on the resource label (case, accents
 * and brackets ignored); in the tab 25 list, already filtered on the resource by Pronote, a single top-level service
 * is taken as is. null: no service of the teacher for that resource.
 */
export const findCommentService = async (session, period, resource) => {
    const sameResource = (service) => labelKey(String(resourceOf(service)?.L ?? "")) === labelKey(resource.label);
    const grades = await loadServices(session, period);
    const index = grades.findIndex((service) => String(resourceOf(service)?.L ?? "") === resource.label);
    if (index >= 0)
        return { service: grades[index], id: stableIds("service", grades, serviceKey)[index], source: "grades" };
    const loose = grades.findIndex(sameResource);
    if (loose >= 0)
        return { service: grades[loose], id: stableIds("service", grades, serviceKey)[loose], source: "grades" };
    const own = (service) => ({ service, id: stableId("service", serviceKey(service)), source: "comments" });
    const listed = await loadCommentServices(session, period, { id: resource.id, genre: resource.genre, label: resource.label });
    const top = listed.filter((service) => service.estUnSousService !== true);
    const matching = top.filter(sameResource);
    if (matching.length >= 1)
        return own(matching[0]);
    if (top.length === 1)
        return own(top[0]);
    // 0.16.2: the tab 65 list is an enrichment elsewhere and returns [] on a mobile session. Here isTabClosed is called
    // first and unguarded: on a mobile session it throws WebSessionRequired (replay on the web session, where a
    // skills-only group is found); true means the tab is closed to the account itself.
    if (isTabClosed(session, "competencyServicesList"))
        return null;
    const skills = await loadCompetencyServices(session, period);
    const skill = skills.find(sameResource);
    return skill ? { service: skill, id: stableId("service", serviceKey(skill)), source: "competencies" } : null;
};
/* non validé sur la démo : onglets 25 et 27 fermés au profil de démonstration */
export const reportComments = async (session, resourceId, periodId, page = {}) => {
    const { resource, genre, kind } = commentResource(session, resourceId);
    const picked = await pickPeriod(session, periodId);
    const found = await findCommentService(session, picked.period, resource);
    // 0.12.0: a main teacher who teaches no service in the class still reads the general comments.
    if (!found && !resource.principal)
        throw new HttpError(404, "service_not_found");
    const service = found?.service ?? null;
    const result = {
        available: true,
        reason: "",
        class: { id: resourceId, name: resource.label },
        period: { id: picked.periodId, name: String(picked.period.L ?? "") },
        service: service && found
            ? { id: found.id, name: [service.matiere?.V?.L ?? service.L ?? "", resource.label].filter(Boolean).join(" - ") }
            : null,
        closed: false,
        maxLength: maxLengthOf(session),
        classComment: null,
        general: { available: false, reason: "not_principal", kind: "", kinds: [] },
        students: [],
    };
    let lines = [];
    let serviceDenied = service === null;
    if (service) {
        let page = null;
        try {
            page = await call(session, "commentsPage", {
                ressource: { N: resource.id, G: genre },
                periode: { N: picked.period.N, G: GENRE_PERIOD },
                service: { N: service.N },
            });
        }
        catch (error) {
            if (!isAccessDenied(error))
                throw error;
        }
        if (!page || Object.keys(page).length === 0) {
            serviceDenied = true;
        }
        else {
            const read = commentsFromPage(page);
            result.closed = read.closed;
            result.classComment = read.classComment;
            lines = read.students;
        }
    }
    let { general, byKind } = await readGeneral(session, resource, picked.period);
    // 0.14.0: no kind for a main teacher: the general comments of the report cards, saying so (never a silent fallback).
    // Only for a client that asks a page of students (local_pronoteio 0.22.0): an older client, which reads the answer as
    // the whole class, keeps the answer of 0.13.0 (this service is updated before Moodle).
    const paged = page.student !== undefined || page.offset !== undefined || page.limit !== undefined;
    if (paged && !general.available && general.reason !== "not_principal" && resource.principal && kind === "class") {
        ({ general, byKind } = await generalFromReports(session, resourceId, periodId, page, general));
    }
    result.general = general;
    if (serviceDenied && !general.available) {
        // Neither the comments of a service nor the general ones: the refusal is relayed (as before 0.12.0).
        return { ...result, available: false, reason: service ? "access_denied" : general.reason };
    }
    const names = [...new Set([...lines.map((line) => line.student), ...byKind.flatMap((item) => [...item.lines.keys()])])].filter(Boolean);
    const comments = new Map(lines.map((line) => [line.student, line.comment]));
    const main = byKind.find((item) => item.kind === general.kind);
    result.students = names.map((student) => ({
        student,
        comment: comments.get(student) ?? null,
        general: main?.lines.get(student) ?? null,
        generals: byKind
            .map((item) => ({ kind: item.kind, text: item.lines.get(student) ?? "" }))
            .filter((item) => item.text.trim() !== ""),
    }));
    return result;
};
//# sourceMappingURL=comments.js.map