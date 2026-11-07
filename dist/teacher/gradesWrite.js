import { HttpError } from "../errors.js";
import { gradeValue, listOf } from "../pronote/encoding.js";
import { normalise } from "../normalise.js";
import { assessmentKey, assessmentsFromPage, call, classesMember, loadPeriods, loadServices, periodKey, ref, serviceKey, serviceMember, statusOf, valueOf, } from "./grades.js";
import { resolve, stableIds } from "./ids.js";
import { sendWrite } from "./write.js";
const STATE_DELETED = 3;
const TYPE_NUMBER = 10;
/** Period, service and assessment of the grade entry matching the stable ids (404 when absent). */
export const locateAssessment = async (session, serviceId, periodId, assessmentId) => {
    const { periods } = await loadPeriods(session);
    const period = resolve("period", periodId, periods, periodKey);
    const services = await loadServices(session, period);
    const service = resolve("service", serviceId, services, serviceKey);
    const pageRequest = { service: ref(service), periode: ref(period) };
    const page = await call(session, "gradesPage", pageRequest);
    const assessments = listOf(page.listeDevoirs);
    const index = stableIds("assessment", assessments, assessmentKey).indexOf(assessmentId);
    if (index < 0)
        throw new HttpError(404, "assessment_not_found");
    const normalised = assessmentsFromPage(page);
    const assessment = normalised.find((item) => item.id === assessmentId) ?? normalised[index];
    return { period, service, page, pageRequest, index, existing: assessments[index], assessment };
};
/** SaisieNotes member of an existing assessment sent for deletion (its members as read, state 3, no grade). */
export const deletedAssessmentMember = (period, page, existing) => ({
    N: existing.N,
    E: STATE_DELETED,
    date: existing.date,
    coefficient: existing.coefficient,
    verrouille: existing.verrouille === true,
    commeUnBonus: existing.commeUnBonus === true,
    commeUneNote: existing.commeUneNote === true,
    commentaire: String(existing.commentaire ?? ""),
    bareme: existing.bareme,
    recalculerNotesDevoirSelonBareme: false,
    ramenerSur20: existing.ramenerSur20 === true,
    datePublication: existing.datePublication,
    avecCommentaireSurNoteEleve: existing.avecCommentaireSurNoteEleve === true,
    ListeThemes: listOf(existing.ListeThemes).map(ref),
    listeClasses: classesMember(period, page, existing),
    listeEleves: [],
});
export const removeAssessment = async (session, serviceId, periodId, assessmentId, dryRun) => {
    const located = await locateAssessment(session, serviceId, periodId, assessmentId);
    if (located.existing.verrouille === true)
        throw new HttpError(409, "assessment_locked");
    const request = {
        periode: ref(located.period),
        service: serviceMember(located.service, located.page),
        listeDevoirs: [deletedAssessmentMember(located.period, located.page, located.existing)],
    };
    if (dryRun)
        return { before: located.assessment, after: null, request, written: false, dryRun: true, irreversible: true };
    await sendWrite(session, "gradesSave", request);
    const after = await call(session, "gradesPage", located.pageRequest);
    if (stableIds("assessment", listOf(after.listeDevoirs), assessmentKey).includes(assessmentId)) {
        throw new HttpError(502, "assessment_not_deleted");
    }
    return { before: located.assessment, after: null, request, written: true, dryRun: false, irreversible: true };
};
/** SaisieNotesUnitaire JSON: one student of one assessment, grade and comment. */
export const gradeCommentRequest = (assessmentN, studentN, note, comment) => ({
    listeDevoirs: [{ N: assessmentN, listeEleves: [{ N: studentN, note: { _T: TYPE_NUMBER, V: note }, commentaire: comment }] }],
});
const cellOf = (student) => {
    const raw = String((student.Note ?? student.note)?.V ?? student.Note ?? student.note ?? "");
    return {
        student: String(student.L ?? "").trim(),
        value: valueOf(raw),
        status: statusOf(raw),
        comment: String(student.commentaire?.V ?? student.commentaire ?? ""),
    };
};
export const writeGradeComment = async (session, serviceId, periodId, assessmentId, change) => {
    const located = await locateAssessment(session, serviceId, periodId, assessmentId);
    if (located.existing.verrouille === true)
        throw new HttpError(409, "assessment_locked");
    if (change.comment !== "" && located.existing.avecCommentaireSurNoteEleve !== true) {
        throw new HttpError(409, "assessment_without_comments");
    }
    const students = listOf(located.existing.listeEleves);
    const student = students.find((item) => normalise(String(item.L ?? "")) === normalise(change.student));
    if (!student)
        throw new HttpError(404, `student_not_found:${change.student}`);
    const before = cellOf(student);
    const value = change.value === undefined ? before.value : change.value;
    const status = change.status === undefined ? before.status : change.status;
    const note = gradeValue(value, status);
    const request = gradeCommentRequest(String(located.existing.N), String(student.N), note, change.comment);
    const planned = { student: before.student, value: status === "" ? value : null, status, comment: change.comment };
    const assessment = {
        id: assessmentId,
        title: located.assessment.title,
        date: located.assessment.date,
        published: located.assessment.publication !== null && located.assessment.publication * 1000 <= Date.now(),
    };
    if (change.dryRun)
        return { assessment, before, after: planned, request, written: false, dryRun: true };
    await sendWrite(session, "gradeSaveUnit", request);
    const after = await call(session, "gradesPage", located.pageRequest);
    const saved = listOf(after.listeDevoirs).find((item) => item.N === located.existing.N)
        ?? listOf(after.listeDevoirs)[stableIds("assessment", listOf(after.listeDevoirs), assessmentKey).indexOf(assessmentId)];
    const stored = listOf(saved?.listeEleves).find((item) => item.N === student.N || normalise(String(item.L ?? "")) === normalise(change.student));
    if (!stored)
        throw new HttpError(502, "grade_not_saved");
    const cell = cellOf(stored);
    const sameValue = (cell.status || "") === status && (status !== "" || cell.value === value);
    if (!sameValue || cell.comment !== change.comment)
        throw new HttpError(502, "grade_not_saved");
    return { assessment, before, after: cell, request, written: true, dryRun: false };
};
//# sourceMappingURL=gradesWrite.js.map