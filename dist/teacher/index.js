/**
 * Teacher-space requests not covered by Pawnote (which targets student/parent accounts).
 * Function names come from functions.ts (filled after the capture, see docs/capture.md).
 */
export { absences } from "./absences.js";
export { assessments } from "./assessments.js";
export { overview as competencyOverview } from "./competencies.js";
export { reportComments } from "./comments.js";
export { context as gradeContext, overview as gradeOverview, push as pushGrades } from "./grades.js";
export { discussion, discussions, messagingPreferences } from "./messaging.js";
export { news, newsResults } from "./news.js";
export { recipients } from "./recipients.js";
export { distributionLists, writeDistributionList } from "./lists.js";
export { notifications } from "./notifications.js";
export { appointments, meetings } from "./meetings.js";
export { writeMeetingWishes } from "./meetingsWrite.js";
export { forum } from "./forum.js";
export { mailbox } from "./mailboxWrite.js";
export { writeNews, writeNewsResponse } from "./newsWrite.js";
export { locker, quizzes } from "./resources.js";
export { notebook } from "./notebook.js";
export { writeNotebook } from "./notebookWrite.js";
export { removeAssessment, writeGradeComment } from "./gradesWrite.js";
export { writeCompetency } from "./competenciesWrite.js";
export { writeComments } from "./commentsWrite.js";
export { sendMessage } from "./messagingWrite.js";
export { writeAttendance } from "./absencesWrite.js";
export { changeLesson } from "./lessonWrite.js";
export { resources, roster } from "./roster.js";
export { reportContext, reports } from "./reports.js";
export { lessons } from "./timetable.js";
//# sourceMappingURL=index.js.map