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
import { HttpError } from "../errors.js";
import { answerData, callPronote } from "../pronote/request.js";
import { tabClosed } from "../pronote/userdata.js";
/**
 * Values read from the PRONOTE 2026.2 teacher client (tabs: 23 grade entry, 105 student list, 113 call sheet,
 * 13 report card, 16 timetable, 28 notebook entry, 154 written tests, 89 class notebook). See
 * docs/pronoteio/capture.md and docs/pronote-matrice/1-cahier-de-textes.md in mood_prod.
 */
const defaults = {
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
    studentFile: { name: "FicheEleve", onglet: 105 },
};
const load = () => {
    const file = process.env.PRONOTEIO_FUNCTIONS_FILE;
    if (!file)
        return defaults;
    const overrides = JSON.parse(readFileSync(file, "utf8"));
    const merged = { ...defaults };
    for (const key of Object.keys(defaults)) {
        merged[key] = { ...defaults[key], ...overrides[key] };
    }
    return merged;
};
export const functions = load();
/** Whether the tab of a function is closed to the account (tabs received at login and lacking it). */
export const isTabClosed = (session, key) => tabClosed(session, functions[key].onglet);
/** Refuses a write before any call when the tab of its function is closed to the account: 409 tab_closed:<function>. */
export const assertTabOpen = (session, key) => {
    if (isTabClosed(session, key))
        throw new HttpError(409, `tab_closed:${functions[key].name}`);
};
/**
 * Sends a read function through callPronote and returns its "data". The data member is left out when
 * "data" is undefined (CentraleNotifications is called without data).
 */
export const callFunction = async (session, key, data) => {
    const fn = requireFunction(key);
    const answer = await callPronote(session, { name: fn.name, data, signature: fn.onglet !== null ? { onglet: fn.onglet } : undefined });
    return answerData(session, answer);
};
/** Configured function, or HTTP 501 when the capture has not been done yet. */
export const requireFunction = (key) => {
    const fn = functions[key];
    if (!fn.name)
        throw new HttpError(501, `not_configured:${key}`);
    return fn;
};
//# sourceMappingURL=functions.js.map