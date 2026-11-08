/**
 * Read-only integration test against the public demonstration server of Index Éducation.
 *
 *   npx tsx --env-file=.env tools/integration-demo.ts
 *
 * .env: PROBE_URL (must be demo.index-education.net), PROBE_USERNAME, PROBE_PASSWORD. One login, a dozen reads
 * paced by the limiter, no write. Exit code 1 on the first unexpected shape. Never run it in a loop: the
 * demonstration server throttles repeated logins. Output is a summary only (no student name).
 */
import { sessionInfo } from "../src/routes/session.js";
import * as teacher from "../src/teacher/index.js";
import { probeLogin } from "./probe-login.js";

if (!/demo\.index-education\.net/.test(process.env.PROBE_URL ?? "")) {
  console.error("integration-demo only runs against the demonstration server (PROBE_URL).");
  process.exit(2);
}

const failures: string[] = [];
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(label);
};

const session = await probeLogin();
const info = sessionInfo(session);
check("session/info", /^\d{4}\.\d+\.\d+$/.test(info.version) && info.classes.length > 0,
  `PRONOTE ${info.version}, ${info.tabs.length} onglets, ${info.classes.length} classes, écriture ${info.writeMode}`);

// Two weeks from the first taught lesson week: the demonstration year is fixed, "now" may fall outside it.
const taught = info.classes.filter((c) => c.taught).map((c) => c.name);
const from = new Date(session.instance.firstDate.getTime() + 8 * 7 * 86400_000);
const to = new Date(from.getTime() + 14 * 86400_000);

const lessons = await teacher.lessons(session, from, to);
check("lessons (PageEmploiDuTemps)", lessons.length > 0, `${lessons.length} cours`);

const notebook = await teacher.notebook(session, from, to, taught.slice(0, 2), false);
check("notebook (PageSaisieCahierDeTextes)", notebook.items.every((n) => typeof n.lesson.id === "string" && Array.isArray(n.contents)),
  `${notebook.items.length} entrées sur ${notebook.lessons} cours`);

const assessments = await teacher.assessments(session, from, to, taught.slice(0, 2));
check("assessments", "notebook" in assessments.sources && "grades" in assessments.sources && "dslist" in assessments.sources,
  `${assessments.items.length} évaluation(s), dslist ${assessments.sources.dslist.available ? "ouvert" : "fermé"}`);

const grades = await teacher.gradeOverview(session, "", taught.slice(0, 1));
check("grades/overview (PageNotes)", grades.periods.length > 0 && Array.isArray(grades.services), `${grades.services.length} service(s)`);

const competencies = await teacher.competencyOverview(session, "", taught.slice(0, 1));
check("competencies (refus relayé ou lecture)", typeof competencies.available === "boolean",
  competencies.available ? `${competencies.items.length} évaluation(s)` : `indisponible : ${competencies.reason}`);

const messages = await teacher.discussions(session, "inbox", 10);
check("messages (ListeMessagerie)", typeof messages.available === "boolean" && Array.isArray(messages.items),
  `${messages.items.length} discussion(s), messagerie ${messages.disabled ? "désactivée" : "active"}`);

const news = await teacher.news(session, "received", false);
check("news (PageActualites)", Array.isArray(news.items), `${news.items.length} information(s)`);

// Communication lot (0.2.0), reads only: no SaisieMessage, SaisieActualites nor SaisieListeDiffusion is sent.
const sent = await teacher.news(session, "sent", false);
check("news scope sent (PageActualites mode 1)", sent.items.every((n) => typeof n.published === "boolean" && Array.isArray(n.questions)),
  `${sent.items.length} information(s) diffusée(s)`);

const recipients = await teacher.recipients(session, ["teacher"], { limit: 50 });
check("recipients (ListePublics genre 3)", typeof recipients.available === "boolean" && recipients.items.every((r) => r.kind === "teacher" && !r.id.includes("#")),
  recipients.available ? `${recipients.total} professeur(s), messagerie ${recipients.disabled ? "désactivée" : "active"}` : `indisponible : ${recipients.reason}`);

const prefs = await teacher.messagingPreferences(session);
check("preferences (PreferenceMessagerie)", typeof prefs.disabled === "boolean" && Array.isArray(prefs.workingDays),
  `${prefs.hourBefore ?? "?"}h-${prefs.hourAfter ?? "?"}h, ${prefs.nonWorkingDays.filter((d) => d.active).length} jour(s) non ouvré(s), réouverture ${prefs.reopensAt ?? "n/a"}`);

const lists = await teacher.distributionLists(session);
check("lists (ListeDiffusion)", typeof lists.available === "boolean", lists.available ? `${lists.items.length} liste(s)` : `indisponible : ${lists.reason}`);

const notifications = await teacher.notifications(session);
check("notifications (CentraleNotifications)", typeof notifications.available === "boolean",
  notifications.available ? `${notifications.items.length} notification(s)` : `indisponible : ${notifications.reason}`);

const meetings = await teacher.meetings(session);
check("meetings (SessionRencontres, refus relayé ou lecture)", typeof meetings.available === "boolean",
  meetings.available ? `${meetings.sessions.length} session(s), planning ${meetings.sessions.some((m) => m.planningVisible) ? "visible" : "fermé"}` : `indisponible : ${meetings.reason}`);

const forum = await teacher.forum(session);
check("forum (ForumPedagogique, refus relayé ou lecture)", typeof forum.available === "boolean",
  forum.available && "topics" in forum ? `${forum.topics.length} sujet(s)` : `indisponible : ${forum.reason}`);

const locker = await teacher.locker(session, "received");
check("locker (Casier)", typeof locker.available === "boolean", `${locker.items.length} document(s)`);

const quizzes = await teacher.quizzes(session);
check("quizzes (listeQCM)", typeof quizzes.available === "boolean", `${quizzes.items.length} QCM`);

const resources = await teacher.resources(session);
const firstClass = resources.find((r) => r.type === "class" && taught.includes(r.name));
if (firstClass) {
  const absences = await teacher.absences(session, firstClass.id, from, to);
  check("absences (PageSaisieAbsences)", absences.every((a) => a.kind === "absence" || a.kind === "late"),
    `${absences.length} absence(s) ou retard(s) sur ${firstClass.name}`);
}

console.log(failures.length ? `\n${failures.length} échec(s) : ${failures.join(", ")}` : "\nTout est lu correctement.");
process.exit(failures.length ? 1 : 0);
