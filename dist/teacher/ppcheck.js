/**
 * Check of the main teacher view (0.12.0, GET /pp/check): each Pronote function of the lot is called once on the first
 * student of a class, and only its status and the SHAPE of its answer (member paths and types, never a value) are
 * returned. None of these functions was captured on a real server: the shapes are what is needed to finish their
 * decoders without reading any student data (docs/pronoteio/vue-pp.md in mood_prod, section 5).
 */
import { ServerSideError } from "pawnote";
import { HttpError, RateLimitedError } from "../errors.js";
import { pronoteDate } from "../pronote/encoding.js";
import { userData } from "../pronote/userdata.js";
import { wallNow } from "../time.js";
import { eventsFromNotebook, eventsFromRecap } from "./classlife.js";
import { kindsFromAnswer } from "./comments.js";
import { callFunction, functions } from "./functions.js";
import { loadPeriods, ref } from "./grades.js";
import { resultsFromAnswer } from "./reports.js";
import { resolveResource, rosterEntries } from "./roster.js";
import { fileOf, MEMO_LISTS, shapeOf } from "./students.js";
import { isAccessDenied, member } from "./tolerant.js";
/** Largest number of lines of the shape of one answer. */
export const MAX_CHECK_SHAPE = 80;
const GENRE_CLASS = 1;
const GENRE_STUDENT = 4;
const GENRE_PERIOD = 2;
export const ppCheck = async (session, resourceId) => {
    const resource = resolveResource(session, resourceId);
    const entries = await rosterEntries(session, resourceId);
    if (entries.length === 0)
        return { students: 0, checks: [] };
    const student = entries[0];
    const tabs = userData(session).tabs;
    const { periods, current } = await loadPeriods(session);
    const period = current ?? periods[0] ?? null;
    const eleve = { N: student.pronoteId, G: GENRE_STUDENT, L: student.label };
    const classe = { N: resource.id, G: GENRE_CLASS, L: resource.label };
    const now = wallNow();
    const monthAgo = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
    /** Calls one function; "recognise" returns a detail code when the answer is understood, null otherwise. */
    const run = async (key, data, recognise, skip) => {
        const fn = functions[key];
        const base = { key, function: fn.name, onglet: fn.onglet, status: "error", detail: "", shape: [] };
        if (!fn.name)
            return { check: { ...base, detail: "not_configured" }, answer: null };
        if (data === null)
            return { check: { ...base, detail: "not_applicable" }, answer: null };
        let answer;
        try {
            answer = await callFunction(session, key, data);
        }
        catch (error) {
            if (error instanceof RateLimitedError)
                return { check: { ...base, detail: "rate_limited" }, answer: null };
            // A tab missing from the mobile session (WebSessionRequired) replays the whole check on the web session.
            if (error instanceof HttpError)
                throw error;
            if (isAccessDenied(error)) {
                const closed = fn.onglet !== null && Array.isArray(tabs) && !tabs.includes(fn.onglet);
                return { check: { ...base, status: closed ? "tab_closed" : "access_denied" }, answer: null };
            }
            if (error instanceof ServerSideError)
                return { check: { ...base, detail: "pronote_error" }, answer: null };
            throw error;
        }
        if (!answer || Object.keys(answer).length === 0)
            return { check: { ...base, status: "access_denied", detail: "empty_answer" }, answer: null };
        const shape = (skip === undefined ? shapeOf(answer) : shapeOf(answer, "", 0, [], skip)).slice(0, MAX_CHECK_SHAPE);
        const detail = recognise(answer);
        return { check: { ...base, status: detail === null ? "format_unknown" : "ok", detail: detail ?? "", shape }, answer };
    };
    const isClass = resource.genre === GENRE_CLASS;
    const reportData = isClass && period ? { eleve, classe, periode: { N: period.N, G: period.G, L: period.L } } : null;
    const report = (answer) => member(answer, ["ListeServices"]) !== undefined || member(answer, ["Message"]) !== undefined ? "" : null;
    const checks = [];
    checks.push((await run("reportCard", reportData, report)).check);
    checks.push((await run("transcript", reportData, report)).check);
    checks.push((await run("classResults", isClass && period ? { classe, periode: { N: period.N, G: period.G, L: period.L },
        absences: false, competences: false, afficherSousServices: false, afficherSeulementSousServices: false, masquerSansNotes: false,
        avecCouleurMoyenne: false } : null, (answer) => (resultsFromAnswer(answer, entries) === null ? null : ""))).check);
    const kinds = await run("commentKinds", isClass ? {} : null, (answer) => (kindsFromAnswer(answer).length > 0 ? "" : null));
    checks.push(kinds.check);
    const kind = kinds.answer ? kindsFromAnswer(kinds.answer).find((item) => !item.rubric && item.name !== "") : undefined;
    if (kind && period) {
        checks.push((await run("generalCommentsPage", { classe: { N: resource.id, G: GENRE_CLASS }, periode: { N: period.N, G: GENRE_PERIOD },
            appreciation: ref(kind.element), estUneRubrique: false }, (answer) => (member(answer, ["listeLignes", "lignes"]) !== undefined ? "" : null))).check);
    }
    else {
        const fn = functions.generalCommentsPage;
        const refused = kinds.check.status === "access_denied" || kinds.check.status === "tab_closed";
        checks.push({ key: "generalCommentsPage", function: fn.name, onglet: fn.onglet, status: refused ? kinds.check.status : "error",
            detail: "no_kind", shape: [] });
    }
    checks.push((await run("studentLifeRecap", { eleve, DateDebut: pronoteDate(monthAgo), DateFin: pronoteDate(now) }, (answer) => (eventsFromRecap(answer) === null ? null : ""))).check);
    checks.push((await run("studentNotebook", { Eleve: eleve }, (answer) => (eventsFromNotebook(answer) === null ? null : ""))).check);
    // The shape of the memos is the point of this check: the names of its members are not filtered.
    checks.push((await run("studentMemos", { eleve, estValorisation: false }, (answer) => (member(answer, MEMO_LISTS) !== undefined ? "" : null), null)).check);
    checks.push((await run("studentFile", { Eleve: eleve, AvecEleve: true, AvecResponsables: true }, (answer) => {
        const read = fileOf(student, answer, []);
        return `unmapped=${read.unmapped.length};guardians=${read.unmappedGuardian.length}`;
    })).check);
    return { students: entries.length, checks };
};
//# sourceMappingURL=ppcheck.js.map