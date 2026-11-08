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
/** Configured function, or HTTP 501 when the capture has not been done yet. */
export const requireFunction = (key) => {
    const fn = functions[key];
    if (!fn.name)
        throw new HttpError(501, `not_configured:${key}`);
    return fn;
};
//# sourceMappingURL=functions.js.map