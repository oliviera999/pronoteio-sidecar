import { HttpError } from "../errors.js";
import { listOf } from "../pronote/encoding.js";
import { userData } from "../pronote/userdata.js";
import { isAccessDenied } from "./competencies.js";
import { call, loadServices, pickPeriod, ref, resourceOf, serviceKey } from "./grades.js";
import { kindOf, resolve, stableIds } from "./ids.js";
import { shapeOf } from "./students.js";
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
        return { student: String(line.eleve?.V?.L ?? line.eleve?.L ?? "").trim(), comment: text(first) };
    });
    const closed = String(data?.strInfoCloture ?? "").trim() !== ""
        || listOf(data?.listeLignes).some((line) => line?.appA?.cloture === true || line?.appA?.V?.cloture === true);
    return { students, classComment: text(data?.appreciationClasse), closed };
};
const LINE_LISTS = ["listeLignes", "ListeLignes", "lignes"];
const GENERAL_TEXTS = ["appreciationGle", "appreciationGenerale", "appGenerale", "appreciation"];
/**
 * General comments of the main teacher (PageAppreciationsGenerales answer): student → text. Rubric lines ("estPere")
 * are skipped. Member names without case (listeLignes, appreciationGle and their candidates).
 */
export const generalFromPage = (data) => new Map(listOf(member(data, LINE_LISTS))
    .filter((line) => line?.eleve && line?.estPere !== true)
    .map((line) => [String(line.eleve?.V?.L ?? line.eleve?.L ?? "").trim(), text(member(line, GENERAL_TEXTS))]));
/** Whether a PageAppreciationsGenerales answer carries its list of lines (even empty). */
const hasLines = (data) => member(data, LINE_LISTS) !== undefined;
/**
 * Kinds of general comments of the school (ListeAppreciations answer): name and whether it is a rubric (a heading
 * with children, e.g. "Conseil de classe", "Vie scolaire" on the demo server), with the Pronote element.
 */
export const kindsFromAnswer = (data) => listOf(member(data, ["listeAppreciations", "ListeAppreciations"]))
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
    element: item,
    name: String(item.L ?? "").trim(),
    rubric: boolOf(member(item, ["estUneRubrique", "estRubrique", "estPere", "rubrique"])) === true,
}));
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
    let answer;
    try {
        answer = await call(session, "commentKinds", {});
    }
    catch (error) {
        if (isAccessDenied(error))
            return none("access_denied");
        throw error;
    }
    const kinds = kindsFromAnswer(answer);
    const listed = kinds.map(({ name, rubric }) => ({ name, rubric }));
    if (kinds.length === 0) {
        const empty = !answer || Object.keys(answer).length === 0;
        return none(empty ? "access_denied" : "format_unknown", empty ? {} : { shape: shapeOf(answer) });
    }
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
    return { general: { available: true, reason: "", kind: mainKind(byKind.map((item) => item.kind)), kinds: listed }, byKind };
};
/* non validé sur la démo : onglets 25 et 27 fermés au profil de démonstration */
export const reportComments = async (session, resourceId, periodId) => {
    const kind = kindOf(resourceId);
    if (kind !== "class" && kind !== "group")
        throw new HttpError(409, "resource_without_pronote_id");
    const genre = kind === "class" ? GENRE_CLASS : GENRE_GROUP;
    const resource = resolve(kind, resourceId, userData(session).resources.filter((item) => item.genre === genre), (item) => item.label);
    const picked = await pickPeriod(session, periodId);
    const services = await loadServices(session, picked.period);
    const index = services.findIndex((service) => String(resourceOf(service)?.L ?? "") === resource.label);
    // 0.12.0: a main teacher who teaches no service in the class still reads the general comments.
    if (index < 0 && !resource.principal)
        throw new HttpError(404, "service_not_found");
    const service = index >= 0 ? services[index] : null;
    const result = {
        available: true,
        reason: "",
        class: { id: resourceId, name: resource.label },
        period: { id: picked.periodId, name: String(picked.period.L ?? "") },
        service: service
            ? { id: stableIds("service", services, serviceKey)[index], name: [service.matiere?.V?.L ?? service.L ?? "", resource.label].filter(Boolean).join(" - ") }
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
    const { general, byKind } = await readGeneral(session, resource, picked.period);
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