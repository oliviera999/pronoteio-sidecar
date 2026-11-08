/**
 * Pronote teacher-space functions used by the sidecar.
 *
 * Names and tabs ("onglet") are specific to the PRONOTE version and are NOT documented by
 * Index Education: they are read from the teacher web client (see docs/capture.md) and
 * validated with tools/probe.ts. An empty name means "not configured": the matching route
 * answers HTTP 501 not_configured:<key>.
 *
 * Values can be overridden without rebuilding through the JSON file given in
 * PRONOTEIO_FUNCTIONS_FILE (same keys as below).
 */
import { readFileSync } from "node:fs";
import type { SessionHandle } from "pawnote";
import { HttpError } from "../errors.js";
import { answerData, callPronote } from "../pronote/request.js";
import { tabClosed } from "../pronote/userdata.js";

export type TeacherFunction = {
  /** Pronote function name sent in "id"/"nom". */
  name: string;
  /** Tab number sent in Signature.onglet, null to send no signature. */
  onglet: number | null;
};

export type FunctionKey =
  /** Periods of the grade entry ({ listePeriodes, periodeParDefaut }). */
  | "periodsList"
  /** Services of the teacher for a period ({ services }). */
  | "servicesList"
  /** Grade entry page of a service and period: students, existing assessments, service settings. */
  | "gradesPage"
  /** Students of a class or group, any class of the school. */
  | "studentsList"
  /** Creates or updates assessments and their grades. */
  | "gradesSave"
  /** Call sheet of one lesson (students and their absences), read for each lesson of the range. */
  | "absencesList"
  /** Report card ("bulletin") of one student for a period, read for each student of the class. */
  | "reportCard"
  /** Timetable of a resource for a week ({ ListeCours }), read week by week. */
  | "timetablePage"
  /** Notebook ("cahier de textes") of one lesson: contents, homework, students (a read despite its name). */
  | "lessonPage"
  /** Notebook entry settings: categories (written test, skills assessment...), templates. */
  | "lessonSettings"
  /** School-wide list of written tests of some classes (tab 154, not open to every profile). */
  | "writtenTestsList"
  /** Notebook of a class for a period, every teacher (tab 89, not open to every profile). */
  | "classNotebook"
  /** Writes a notebook entry: contents, homework, publication (SaisieCahierDeTextes, tab 28). */
  | "notebookSave"
  /** Services and rooms available to flag a written test from a lesson, before SaisieCahierDeTextes. */
  | "assessmentPlanning"
  /** Modifies one lesson of the timetable: rooms, memo, move, delete (SaisieCours, tab 16). */
  | "lessonSave"
  /** Resources of the school timetable: classes, teachers, rooms, equipment (RessourceEDT, tab 16). */
  | "timetableResources"
  /** Skills assessments of a service and period (tab 65; not validated on the demo server). */
  | "competencyList"
  /** Levels given in one skills assessment (tab 56; not validated on the demo server). */
  | "competencyPage"
  /** Report card comments grid of a service, class and period (tab 25; not validated on the demo server). */
  | "commentsPage"
  /** Kinds of general comments of the school (tab 27). */
  | "commentKinds"
  /** General comments of the main teacher for a class and period (tab 27; not validated on the demo server). */
  | "generalCommentsPage"
  /** Discussions of the messaging (tab 131). */
  | "discussionsList"
  /** Messages of a discussion (tab 131; a read when marquerCommeLu is false). */
  | "discussionMessages"
  /** Information and surveys (tab 8). */
  | "newsPage"
  /** Digital locker (tab 148). */
  | "lockerPage"
  /** Quizzes of the teacher (tab 86). */
  | "quizList"
  /** One grade or comment of a student on an assessment (SaisieNotesUnitaire, tab 23). */
  | "gradeSaveUnit"
  /** Creates, modifies or deletes a skills assessment and its levels (SaisieEvaluations, tab 65; not validated). */
  | "competencySave"
  /** Report card comment of the teacher's service (SaisieAppreciation, tab 25; not validated). */
  | "commentSave"
  /** General comment of the main teacher (SaisieAppreciation, tab 27; not validated). */
  | "generalCommentSave"
  /** Sends a message or a reply (SaisieMessage, tab 131; irreversible). */
  | "messageSave"
  /** Possible recipients of a discussion (ListePublics, tab 131). */
  | "recipientsList"
  /** Call sheet of one lesson: absences, late arrivals, done flag (SaisieAbsences, tab 113). */
  | "attendanceSave"
  /* ---- Communication (0.2.0), docs/pronoteio/communication.md section 2 ---- */
  /** Participants of a discussion (SaisiePublicMessage, tab 131: a read despite its name). */
  | "participantsList"
  /** Messaging preferences: disconnection hours and days, automatic reply (PreferenceMessagerie, tab 131). */
  | "messagingPreferences"
  /** Saves a messaging preference (SaisiePreferenceMessagerie, tab 131; declared, never called). */
  | "messagingPreferencesSave"
  /** Possible recipients of the accounts without "discussion avancée" (ListeRessourcesPourCommunication, tab 131). */
  | "recipientsFallback"
  /** Distribution lists (ListeDiffusion, tab 158). */
  | "distributionLists"
  /** Creates, modifies or deletes a distribution list of the teacher (SaisieListeDiffusion, tab 158). */
  | "distributionListSave"
  /** Results of a survey or an information (PageActualitesResultats, tab 8). */
  | "newsResults"
  /** Limits, natures and publics before creating an information (DonneesEditionInformation, tab 8). */
  | "newsEdit"
  /** Answer to a news item (saisieActualite false) or creation (saisieActualite true) (SaisieActualites, tab 8). */
  | "newsSave"
  /** Survey templates of the school (ListeSondagesDeBiblioEtablissement, tab 8). */
  | "surveyLibrary"
  /** Notification centre (CentraleNotifications, tab 7). */
  | "notifications"
  /** Parent-teacher meeting sessions (SessionRencontres, tab 90). */
  | "meetingSessions"
  /** Wishes, unavailability and rights of one meeting session (RencontresParentsProfs, tab 90). */
  | "meetingDetails"
  /** Planning of one meeting session (RencontrePlanning, tab 94, often closed). */
  | "meetingPlanning"
  /** Wishes ("desiderata") of the teacher for a meeting session (SaisieRencontreDesiderata, tab 92). */
  | "meetingWishesSave"
  /** Unavailability of the teacher for a meeting session (SaisieRencontreIndisponibilites, tab 91). */
  | "meetingUnavailabilitySave"
  /** Appointments (RDV, tab 284; read with type rdvcr_RDV only). */
  | "appointments"
  /** Pedagogical forum (ForumPedagogique, tab 275; read with fpcr_Sujets and fpcr_Posts only). */
  | "forum";

/**
 * Values read from the PRONOTE 2026.2 teacher client (tabs: 23 grade entry, 105 student list, 113 call sheet,
 * 13 report card, 16 timetable, 28 notebook entry, 154 written tests, 89 class notebook). See
 * docs/pronoteio/capture.md and docs/pronote-matrice/1-cahier-de-textes.md in mood_prod.
 */
const defaults: Record<FunctionKey, TeacherFunction> = {
  periodsList: { name: "ListePeriodes", onglet: 23 },
  servicesList: { name: "ListeServices", onglet: 23 },
  gradesPage: { name: "PageNotes", onglet: 23 },
  studentsList: { name: "ListeEleves", onglet: 105 },
  gradesSave: { name: "SaisieNotes", onglet: 23 },
  absencesList: { name: "PageSaisieAbsences", onglet: 113 },
  reportCard: { name: "PageBulletins", onglet: 13 },
  timetablePage: { name: "PageEmploiDuTemps", onglet: 16 },
  lessonPage: { name: "PageSaisieCahierDeTextes", onglet: 28 },
  lessonSettings: { name: "PageSaisieCahierDeTextes_General", onglet: 28 },
  writtenTestsList: { name: "ListeDevoirSurTable", onglet: 154 },
  classNotebook: { name: "PageCahierDeTexte", onglet: 89 },
  notebookSave: { name: "SaisieCahierDeTextes", onglet: 28 },
  assessmentPlanning: { name: "ProgrammerDevoirEvaluationCDT", onglet: 28 },
  lessonSave: { name: "SaisieCours", onglet: 16 },
  timetableResources: { name: "RessourceEDT", onglet: 16 },
  competencyList: { name: "ListeEvaluations", onglet: 65 },
  competencyPage: { name: "PageCompetencesParEvaluation", onglet: 56 },
  commentsPage: { name: "PageApprBulletin", onglet: 25 },
  commentKinds: { name: "ListeAppreciations", onglet: 27 },
  generalCommentsPage: { name: "PageAppreciationsGenerales", onglet: 27 },
  discussionsList: { name: "ListeMessagerie", onglet: 131 },
  discussionMessages: { name: "ListeMessages", onglet: 131 },
  newsPage: { name: "PageActualites", onglet: 8 },
  lockerPage: { name: "Casier", onglet: 148 },
  quizList: { name: "listeQCM", onglet: 86 },
  gradeSaveUnit: { name: "SaisieNotesUnitaire", onglet: 23 },
  competencySave: { name: "SaisieEvaluations", onglet: 65 },
  commentSave: { name: "SaisieAppreciation", onglet: 25 },
  generalCommentSave: { name: "SaisieAppreciation", onglet: 27 },
  messageSave: { name: "SaisieMessage", onglet: 131 },
  recipientsList: { name: "ListePublics", onglet: 131 },
  attendanceSave: { name: "SaisieAbsences", onglet: 113 },
  participantsList: { name: "SaisiePublicMessage", onglet: 131 },
  messagingPreferences: { name: "PreferenceMessagerie", onglet: 131 },
  messagingPreferencesSave: { name: "SaisiePreferenceMessagerie", onglet: 131 },
  recipientsFallback: { name: "ListeRessourcesPourCommunication", onglet: 131 },
  distributionLists: { name: "ListeDiffusion", onglet: 158 },
  distributionListSave: { name: "SaisieListeDiffusion", onglet: 158 },
  newsResults: { name: "PageActualitesResultats", onglet: 8 },
  newsEdit: { name: "DonneesEditionInformation", onglet: 8 },
  newsSave: { name: "SaisieActualites", onglet: 8 },
  surveyLibrary: { name: "ListeSondagesDeBiblioEtablissement", onglet: 8 },
  notifications: { name: "CentraleNotifications", onglet: 7 },
  meetingSessions: { name: "SessionRencontres", onglet: 90 },
  meetingDetails: { name: "RencontresParentsProfs", onglet: 90 },
  meetingPlanning: { name: "RencontrePlanning", onglet: 94 },
  meetingWishesSave: { name: "SaisieRencontreDesiderata", onglet: 92 },
  meetingUnavailabilitySave: { name: "SaisieRencontreIndisponibilites", onglet: 91 },
  appointments: { name: "RDV", onglet: 284 },
  forum: { name: "ForumPedagogique", onglet: 275 },
};

const load = (): Record<FunctionKey, TeacherFunction> => {
  const file = process.env.PRONOTEIO_FUNCTIONS_FILE;
  if (!file) return defaults;
  const overrides = JSON.parse(readFileSync(file, "utf8")) as Partial<Record<FunctionKey, Partial<TeacherFunction>>>;
  const merged = { ...defaults };
  for (const key of Object.keys(defaults) as FunctionKey[]) {
    merged[key] = { ...defaults[key], ...overrides[key] };
  }
  return merged;
};

export const functions = load();

/** Whether the tab of a function is closed to the account (tabs received at login and lacking it). */
export const isTabClosed = (session: SessionHandle, key: FunctionKey): boolean => tabClosed(session, functions[key].onglet);

/** Refuses a write before any call when the tab of its function is closed to the account: 409 tab_closed:<function>. */
export const assertTabOpen = (session: SessionHandle, key: FunctionKey): void => {
  if (isTabClosed(session, key)) throw new HttpError(409, `tab_closed:${functions[key].name}`);
};

/**
 * Sends a read function through callPronote and returns its "data". The data member is left out when
 * "data" is undefined (CentraleNotifications is called without data).
 */
export const callFunction = async (session: SessionHandle, key: FunctionKey, data?: Record<string, unknown>): Promise<Record<string, any>> => {
  const fn = requireFunction(key);
  const answer = await callPronote(session, { name: fn.name, data, signature: fn.onglet !== null ? { onglet: fn.onglet } : undefined });
  return answerData(session, answer);
};

/** Configured function, or HTTP 501 when the capture has not been done yet. */
export const requireFunction = (key: FunctionKey): TeacherFunction => {
  const fn = functions[key];
  if (!fn.name) throw new HttpError(501, `not_configured:${key}`);
  return fn;
};
