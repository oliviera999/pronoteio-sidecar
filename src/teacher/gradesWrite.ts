/**
 * Writes of the grade entry beyond push(): deletion of an assessment (SaisieNotes with E 3, as the "supprimer"
 * button of the assessment window does) and one grade with its comment (SaisieNotesUnitaire, the only call that
 * carries the per-grade comment shown to families). The demo server ignores writes: not validated on a real server.
 *
 * Deleting an assessment deletes its grades: Pronote has no undo, the state read before is the only copy.
 */
import type { SessionHandle } from "pawnote";
import { HttpError } from "../errors.js";
import { gradeValue, listOf, type GradeStatus } from "../pronote/encoding.js";
import { normalise, type OverviewAssessment } from "../normalise.js";
import {
  assessmentKey,
  assessmentsFromPage,
  call,
  classesMember,
  loadPeriods,
  loadServices,
  periodKey,
  ref,
  serviceKey,
  serviceMember,
  statusOf,
  valueOf,
  type Element,
} from "./grades.js";
import { resolve, stableIds } from "./ids.js";
import { sendWrite } from "./write.js";

const STATE_DELETED = 3;
const TYPE_NUMBER = 10;

type Located = {
  period: Element;
  service: Element;
  page: Record<string, any>;
  pageRequest: Record<string, unknown>;
  index: number;
  existing: Element;
  assessment: OverviewAssessment;
};

/** Period, service and assessment of the grade entry matching the stable ids (404 when absent). */
export const locateAssessment = async (session: SessionHandle, serviceId: string, periodId: string, assessmentId: string): Promise<Located> => {
  const { periods } = await loadPeriods(session);
  const period = resolve("period", periodId, periods, periodKey);
  const services = await loadServices(session, period);
  const service = resolve("service", serviceId, services, serviceKey);
  const pageRequest = { service: ref(service), periode: ref(period) };
  const page = await call(session, "gradesPage", pageRequest);
  const assessments = listOf<Element>(page.listeDevoirs);
  const index = stableIds("assessment", assessments, assessmentKey).indexOf(assessmentId);
  if (index < 0) throw new HttpError(404, "assessment_not_found");
  const normalised = assessmentsFromPage(page);
  const assessment = normalised.find((item) => item.id === assessmentId) ?? normalised[index];
  return { period, service, page, pageRequest, index, existing: assessments[index], assessment };
};

/** SaisieNotes member of an existing assessment sent for deletion (its members as read, state 3, no grade). */
export const deletedAssessmentMember = (period: Element, page: Record<string, any>, existing: Element): Record<string, unknown> => ({
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
  ListeThemes: listOf<Element>(existing.ListeThemes).map(ref),
  listeClasses: classesMember(period, page, existing),
  listeEleves: [],
});

export type RemoveResult = {
  before: OverviewAssessment;
  after: null;
  request: Record<string, unknown>;
  written: boolean;
  dryRun: boolean;
  /** Deleting an assessment deletes its grades: no native undo. */
  irreversible: true;
};

export const removeAssessment = async (session: SessionHandle, serviceId: string, periodId: string, assessmentId: string, dryRun: boolean): Promise<RemoveResult> => {
  const located = await locateAssessment(session, serviceId, periodId, assessmentId);
  if (located.existing.verrouille === true) throw new HttpError(409, "assessment_locked");
  const request = {
    periode: ref(located.period),
    service: serviceMember(located.service, located.page),
    listeDevoirs: [deletedAssessmentMember(located.period, located.page, located.existing)],
  };
  if (dryRun) return { before: located.assessment, after: null, request, written: false, dryRun: true, irreversible: true };
  await sendWrite(session, "gradesSave", request);
  const after = await call(session, "gradesPage", located.pageRequest);
  if (stableIds("assessment", listOf<Element>(after.listeDevoirs), assessmentKey).includes(assessmentId)) {
    throw new HttpError(502, "assessment_not_deleted");
  }
  return { before: located.assessment, after: null, request, written: true, dryRun: false, irreversible: true };
};

export type GradeCell = { student: string; value: number | null; status: GradeStatus; comment: string };

export type GradeCommentChange = {
  student: string;
  /** New value (or status); absent: the grade as read is kept. */
  value?: number | null;
  status?: GradeStatus;
  comment: string;
  dryRun: boolean;
};

export type GradeCommentResult = {
  assessment: { id: string; title: string; date: number; published: boolean };
  before: GradeCell;
  after: GradeCell;
  request: Record<string, unknown>;
  written: boolean;
  dryRun: boolean;
};

/** SaisieNotesUnitaire JSON: one student of one assessment, grade and comment. */
export const gradeCommentRequest = (assessmentN: string, studentN: string, note: string, comment: string): Record<string, unknown> => ({
  listeDevoirs: [{ N: assessmentN, listeEleves: [{ N: studentN, note: { _T: TYPE_NUMBER, V: note }, commentaire: comment }] }],
});

const cellOf = (student: Element): GradeCell => {
  const raw = String((student.Note ?? student.note)?.V ?? student.Note ?? student.note ?? "");
  return {
    student: String(student.L ?? "").trim(),
    value: valueOf(raw),
    status: statusOf(raw),
    comment: String(student.commentaire?.V ?? student.commentaire ?? ""),
  };
};

export const writeGradeComment = async (
  session: SessionHandle,
  serviceId: string,
  periodId: string,
  assessmentId: string,
  change: GradeCommentChange,
): Promise<GradeCommentResult> => {
  const located = await locateAssessment(session, serviceId, periodId, assessmentId);
  if (located.existing.verrouille === true) throw new HttpError(409, "assessment_locked");
  if (change.comment !== "" && located.existing.avecCommentaireSurNoteEleve !== true) {
    throw new HttpError(409, "assessment_without_comments");
  }
  const students = listOf<Element>(located.existing.listeEleves);
  const student = students.find((item) => normalise(String(item.L ?? "")) === normalise(change.student));
  if (!student) throw new HttpError(404, `student_not_found:${change.student}`);
  const before = cellOf(student);
  const value = change.value === undefined ? before.value : change.value;
  const status = change.status === undefined ? before.status : change.status;
  const note = gradeValue(value, status);
  const request = gradeCommentRequest(String(located.existing.N), String(student.N), note, change.comment);
  const planned: GradeCell = { student: before.student, value: status === "" ? value : null, status, comment: change.comment };
  const assessment = {
    id: assessmentId,
    title: located.assessment.title,
    date: located.assessment.date,
    published: located.assessment.publication !== null && located.assessment.publication * 1000 <= Date.now(),
  };
  if (change.dryRun) return { assessment, before, after: planned, request, written: false, dryRun: true };
  await sendWrite(session, "gradeSaveUnit", request);
  const after = await call(session, "gradesPage", located.pageRequest);
  const saved = listOf<Element>(after.listeDevoirs).find((item) => item.N === located.existing.N)
    ?? listOf<Element>(after.listeDevoirs)[stableIds("assessment", listOf<Element>(after.listeDevoirs), assessmentKey).indexOf(assessmentId)];
  const stored = listOf<Element>(saved?.listeEleves).find((item) => item.N === student.N || normalise(String(item.L ?? "")) === normalise(change.student));
  if (!stored) throw new HttpError(502, "grade_not_saved");
  const cell = cellOf(stored);
  const sameValue = (cell.status || "") === status && (status !== "" || cell.value === value);
  if (!sameValue || cell.comment !== change.comment) throw new HttpError(502, "grade_not_saved");
  return { assessment, before, after: cell, request, written: true, dryRun: false };
};
