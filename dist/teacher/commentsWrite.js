import { HttpError } from "../errors.js";
import { listOf } from "../pronote/encoding.js";
import { userData } from "../pronote/userdata.js";
import { normalise } from "../normalise.js";
import { isAccessDenied, } from "./competencies.js";
import { maxLengthOf } from "./comments.js";
import { call, loadServices, pickPeriod, ref, resourceOf } from "./grades.js";
import { kindOf, resolve } from "./ids.js";
import { sendWrite } from "./write.js";
const GENRE_CLASS = 1;
const GENRE_GROUP = 2;
const GENRE_PERIOD = 2;
const GENRE_STUDENT = 4;
const STATE_MODIFIED = 2;
/** TypeGenreAppreciation: 0 teacher's bulletin comment, 1 general bulletin comment. */
const KIND_SUBJECT = 0;
const KIND_GENERAL = 1;
const text = (value) => {
    const raw = value !== null && typeof value === "object" && "V" in value ? value.V : value;
    if (raw !== null && typeof raw === "object")
        return text(raw.L);
    return typeof raw === "string" ? raw : null;
};
/** Cells of a PageApprBulletin answer with their identifiers (subject comments, then the class comment). */
export const subjectCells = (page) => {
    const cells = [];
    for (const line of listOf(page?.listeLignes)) {
        const student = line?.eleve?.V ?? line?.eleve;
        const app = line?.appA?.V ?? line?.appA;
        if (!student || !app)
            continue;
        cells.push({
            student: { N: String(student.N), L: String(student.L ?? "").trim() },
            appreciation: { N: String(app.N ?? "0"), G: Number(app.G ?? 1), L: String(app.L ?? "") },
        });
    }
    const classApp = page?.appreciationClasse?.V ?? page?.appreciationClasse;
    const classCell = classApp && typeof classApp === "object"
        ? { student: null, appreciation: { N: String(classApp.N ?? "0"), G: Number(classApp.G ?? 1), L: String(classApp.L ?? "") } }
        : null;
    const closed = String(page?.strInfoCloture ?? "").trim() !== ""
        || listOf(page?.listeLignes).some((line) => line?.appA?.cloture === true || line?.appA?.V?.cloture === true);
    return { cells, classCell, closed };
};
/** Cells of a PageAppreciationsGenerales answer (general comment of each student). */
export const generalCells = (page) => {
    const cells = [];
    let closed = false;
    for (const line of listOf(page?.listeLignes)) {
        if (line?.estPere === true)
            continue;
        const student = line?.eleve?.V ?? line?.eleve;
        const app = line?.appreciationGle?.V ?? line?.appreciationGle;
        if (!student || !app)
            continue;
        if (app.cloture === true)
            closed = true;
        cells.push({
            student: { N: String(student.N), L: String(student.L ?? "").trim() },
            appreciation: { N: String(app.N ?? "0"), G: Number(app.G ?? 0), L: String(app.L ?? "") },
        });
    }
    return { cells, closed };
};
/** SaisieAppreciation JSON for one cell. */
export const commentRequest = (classe, period, service, cell, textValue, kind) => ({
    classe: { N: classe.N, G: classe.G },
    periode: { N: period.N, G: GENRE_PERIOD },
    ...(cell.student ? { eleve: { N: cell.student.N, G: GENRE_STUDENT } } : {}),
    ...(service && kind === "subject" ? { service: { N: service.N } } : {}),
    appreciation: { N: cell.appreciation.N, G: cell.appreciation.G, L: textValue, E: STATE_MODIFIED },
    typeGenreAppreciation: kind === "general" || !cell.student ? KIND_GENERAL : KIND_SUBJECT,
});
/* non validé sur la démo : onglets 25 et 27 fermés au profil de démonstration */
export const writeComments = async (session, write) => {
    const kind = kindOf(write.class);
    if (kind !== "class" && kind !== "group")
        throw new HttpError(409, "resource_without_pronote_id");
    const genre = kind === "class" ? GENRE_CLASS : GENRE_GROUP;
    const resource = resolve(kind, write.class, userData(session).resources.filter((item) => item.genre === genre), (item) => item.label);
    const picked = await pickPeriod(session, write.period);
    const maxLength = maxLengthOf(session);
    for (const item of write.items) {
        if (maxLength !== null && item.text.length > maxLength)
            throw new HttpError(409, `comment_too_long:${maxLength}`);
        if (item.kind === "general" && !item.student)
            throw new HttpError(400, "general_comment_without_student");
    }
    const services = await loadServices(session, picked.period);
    const service = services.find((item) => String(resourceOf(item)?.L ?? "") === resource.label) ?? null;
    const needsSubject = write.items.some((item) => item.kind === "subject");
    const needsGeneral = write.items.some((item) => item.kind === "general");
    if (needsSubject && !service)
        throw new HttpError(404, "service_not_found");
    if (needsGeneral && !resource.principal)
        throw new HttpError(403, "not_main_teacher");
    const classe = { N: resource.id, G: genre };
    let subject = null;
    let general = null;
    let rubric = null;
    try {
        if (needsSubject) {
            subject = subjectCells(await call(session, "commentsPage", { ressource: classe, periode: { N: picked.period.N, G: GENRE_PERIOD }, service: { N: service.N } }));
        }
        if (needsGeneral) {
            const kinds = listOf((await call(session, "commentKinds", {})).listeAppreciations);
            rubric = kinds.find((item) => /globale/i.test(String(item.L ?? ""))) ?? kinds.find((item) => item.G === 0) ?? null;
            if (!rubric)
                throw new HttpError(404, "general_rubric_not_found");
            general = generalCells(await call(session, "generalCommentsPage", {
                classe: { N: resource.id, G: GENRE_CLASS },
                periode: { N: picked.period.N, G: GENRE_PERIOD },
                appreciation: ref(rubric),
                estUneRubrique: false,
            }));
        }
    }
    catch (error) {
        if (isAccessDenied(error))
            throw new HttpError(403, "access_denied");
        throw error;
    }
    if (subject?.closed || general?.closed)
        throw new HttpError(409, "comments_closed");
    const before = [];
    const after = [];
    const requests = [];
    const targets = [];
    for (const item of write.items) {
        const source = item.kind === "general" ? general : subject;
        const cell = item.student
            ? source.cells.find((candidate) => candidate.student && normalise(candidate.student.L) === normalise(item.student))
            : source.classCell ?? undefined;
        if (!cell)
            throw new HttpError(404, item.student ? `student_not_found:${item.student}` : "class_comment_not_found");
        before.push({ student: cell.student?.L ?? null, kind: item.kind, text: cell.appreciation.L });
        after.push({ student: cell.student?.L ?? null, kind: item.kind, text: item.text });
        requests.push(commentRequest(classe, picked.period, service, cell, item.text, item.kind));
        targets.push({ cell, item, key: item.kind === "general" ? "generalCommentSave" : "commentSave" });
    }
    const base = { class: { id: write.class, name: resource.label }, period: { id: picked.periodId, name: String(picked.period.L ?? "") }, maxLength, before, after, requests, validated: false };
    if (write.dryRun)
        return { ...base, written: false, dryRun: true };
    for (const [index, target] of targets.entries()) {
        await sendWrite(session, target.key, requests[index]);
    }
    // Read again: every cell must now carry the requested text.
    const checked = [];
    if (needsSubject) {
        const reread = subjectCells(await call(session, "commentsPage", { ressource: classe, periode: { N: picked.period.N, G: GENRE_PERIOD }, service: { N: service.N } }));
        for (const [index, target] of targets.entries()) {
            if (target.item.kind !== "subject")
                continue;
            const cell = target.cell.student
                ? reread.cells.find((candidate) => candidate.student && normalise(candidate.student.L) === normalise(target.cell.student.L))
                : reread.classCell;
            if (!cell || cell.appreciation.L.trim() !== target.item.text.trim())
                throw new HttpError(502, `comment_not_saved:${target.cell.student?.L ?? "classe"}`);
            checked[index] = { student: cell.student?.L ?? null, kind: "subject", text: cell.appreciation.L };
        }
    }
    if (needsGeneral && rubric) {
        const reread = generalCells(await call(session, "generalCommentsPage", {
            classe: { N: resource.id, G: GENRE_CLASS },
            periode: { N: picked.period.N, G: GENRE_PERIOD },
            appreciation: ref(rubric),
            estUneRubrique: false,
        }));
        for (const [index, target] of targets.entries()) {
            if (target.item.kind !== "general")
                continue;
            const cell = reread.cells.find((candidate) => candidate.student && normalise(candidate.student.L) === normalise(target.cell.student.L));
            if (!cell || cell.appreciation.L.trim() !== target.item.text.trim())
                throw new HttpError(502, `comment_not_saved:${target.cell.student?.L ?? ""}`);
            checked[index] = { student: cell.student?.L ?? null, kind: "general", text: cell.appreciation.L };
        }
    }
    return { ...base, after: checked.map((cell, index) => cell ?? after[index]), written: true, dryRun: false };
};
//# sourceMappingURL=commentsWrite.js.map