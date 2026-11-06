/**
 * Report cards ("bulletins") of a class, read in the teacher space (read only).
 *
 * PageBulletins (tab 13) answers for one student, one class and one period. The request and its
 * answer are decoded by the same client modules in the teacher and student spaces
 * (objetrequetepagebulletins.js, utilitairedeserialiserpiedbulletin.js, identical in PRONOTE 2026.2.8),
 * so the answer has the shape Pawnote decodes for students: ListeServices, ObjetListeAppreciations,
 * General and ListeAbsences. Only a teacher whose profile opens the tab can read them, usually the
 * main teacher ("professeur principal") of the class: the others get "Vos droits sont insuffisants".
 */
import { ServerSideError, type SessionHandle } from "pawnote";
import { HttpError } from "../errors.js";
import { answerData, callPronote } from "../pronote/request.js";
import { listOf } from "../pronote/encoding.js";
import { userData } from "../pronote/userdata.js";
import { splitDisplayName, type Report, type ReportComment, type ReportContext, type ReportSubject } from "../normalise.js";
import { requireFunction } from "./functions.js";
import { loadPeriods, periodKey } from "./grades.js";
import { kindOf, resolve, stableId, stableIds } from "./ids.js";
import { rosterEntries } from "./roster.js";

/** Genres of Pronote entities. */
const GENRE_CLASS = 1;
const GENRE_STUDENT = 4;

/** Annotations written instead of a value ("|n"), as in the grade entry. */
const ANNOTATIONS: Record<string, string> = {
  "1": "Abs",
  "2": "Disp",
  "3": "N.Not",
  "4": "Inap",
  "5": "N.Rdu",
  "6": "Abs0",
  "7": "N.Rdu0",
};

const valueOf = (value: unknown): unknown =>
  value !== null && typeof value === "object" && "V" in (value as object) ? (value as { V: unknown }).V : value;

/** Number of a Pronote cell ("12,50", { _T: 10, V: "12,5" }), null for an annotation or nothing. */
export const reportNumber = (value: unknown): number | null => {
  const raw = valueOf(value);
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const text = raw.trim().replace(/\s/g, "").replace(",", ".");
  if (text === "" || text.startsWith("|")) return null;
  const number = Number.parseFloat(text);
  return Number.isFinite(number) ? number : null;
};

/** Annotation of a Pronote cell ("|1" -> "Abs"), "" when the cell holds a value or nothing. */
export const reportStatus = (value: unknown): string => {
  const raw = valueOf(value);
  if (typeof raw !== "string" || !raw.startsWith("|")) return "";
  return ANNOTATIONS[raw.slice(1)] ?? raw.slice(1);
};

const text = (value: unknown): string => {
  const raw = valueOf(value);
  return typeof raw === "string" ? raw.trim() : "";
};

const commentKind = (genre: unknown): ReportComment["kind"] => {
  if (genre === 0) return "general";
  if (genre === 1 || genre === 2 || genre === 3 || genre === 8) return "council";
  if (genre === 4 || genre === 5 || genre === 6) return "comment";
  if (genre === 7) return "cpe";
  return "other";
};

const subjectOf = (service: any): ReportSubject => {
  const fromElements = listOf<any>(service.ListeElements).flatMap((item) => listOf<any>(item?.ListeProfesseurs));
  const teachers = (fromElements.length ? fromElements : listOf<any>(service.ListeProfesseurs))
    .map((item) => String(item?.L ?? "").trim())
    .filter(Boolean);
  return {
    subject: String((valueOf(service.Matiere) as any)?.L ?? service.L ?? "").trim(),
    teachers: [...new Set(teachers)],
    coefficient: reportNumber(service.Coefficient),
    average: reportNumber(service.MoyenneEleve),
    classAverage: reportNumber(service.MoyenneClasse),
    min: reportNumber(service.MoyenneInf),
    max: reportNumber(service.MoyenneSup),
    status: reportStatus(service.MoyenneEleve),
    comments: listOf<any>(service.ListeAppreciations).map((item) => String(item?.L ?? "").trim()).filter(Boolean),
  };
};

/** Report card of a PageBulletins answer ("data" member). */
export const reportFromAnswer = (
  data: any,
  student: { id: string; label: string },
  period: string,
): Report => {
  const name = splitDisplayName(student.label);
  const general = valueOf(data?.General) as any;
  const appreciations = valueOf(data?.ObjetListeAppreciations) as any;
  const footer = (valueOf(data?.ListeAbsences) ?? {}) as any;
  return {
    studentid: student.id,
    lastname: name.lastname,
    firstname: name.firstname,
    period,
    average: reportNumber(general?.MoyenneEleve),
    classAverage: reportNumber(general?.MoyenneClasse),
    subjects: listOf<any>(data?.ListeServices).map(subjectOf).filter((item) => item.subject !== ""),
    comments: listOf<any>(appreciations?.ListeAppreciations)
      .map((item) => ({ kind: commentKind(item?.G), title: String(item?.Intitule ?? "").trim(), text: String(item?.L ?? "").trim() }))
      .filter((item) => item.text !== ""),
    attendance: {
      absences: text(footer.strAbsences),
      lates: text(footer.strRetards),
      punishments: text(footer.strPunitions),
      sanctions: text(footer.strSanctions),
    },
    message: text(data?.Message),
  };
};

const reportTab = (): number | null => requireFunction("reportCard").onglet;

/** Classes (main teacher first) and periods for which report cards may be read. */
export const reportContext = async (session: SessionHandle): Promise<ReportContext> => {
  const { tabs, resources } = userData(session);
  const tab = reportTab();
  const { periods, current } = await loadPeriods(session);
  const periodIds = stableIds("period", periods, periodKey);
  return {
    allowed: tabs === null || tab === null ? null : tabs.includes(tab),
    classes: resources
      .filter((item) => item.genre === GENRE_CLASS)
      .map((item) => ({ id: stableId("class", item.label), name: item.label, principal: item.principal, taught: item.taught }))
      .sort((a, b) => Number(b.principal) - Number(a.principal) || a.name.localeCompare(b.name, "fr", { numeric: true })),
    periods: periods.map((period, index) => ({ id: periodIds[index], name: String(period.L ?? ""), current: period === current })),
  };
};

const isAccessDenied = (error: unknown): boolean =>
  error instanceof ServerSideError && /droits/i.test(error.message);

export const reports = async (session: SessionHandle, resourceId: string, periodId: string): Promise<Report[]> => {
  const fn = requireFunction("reportCard");
  const { tabs, resources } = userData(session);
  if (tabs !== null && fn.onglet !== null && !tabs.includes(fn.onglet)) throw new HttpError(403, "access_denied");
  if (kindOf(resourceId) !== "class") throw new HttpError(409, "resource_not_class");

  const classe = resolve("class", resourceId, resources.filter((item) => item.genre === GENRE_CLASS), (item) => item.label);
  const { periods } = await loadPeriods(session);
  const period = resolve("period", periodId, periods, periodKey);
  const students = await rosterEntries(session, resourceId);

  const result: Report[] = [];
  for (const student of students) {
    let answer: Record<string, any>;
    try {
      answer = await callPronote(session, {
        name: fn.name,
        data: {
          eleve: { N: student.pronoteId, G: GENRE_STUDENT, L: student.label },
          classe: { N: classe.id, G: GENRE_CLASS, L: classe.label },
          periode: { N: period.N, G: period.G, L: period.L },
        },
        signature: fn.onglet !== null ? { onglet: fn.onglet } : undefined,
      });
    } catch (error) {
      if (isAccessDenied(error)) throw new HttpError(403, "access_denied");
      throw error;
    }
    result.push(reportFromAnswer(answerData(session, answer), student, String(period.L ?? "")));
  }
  return result;
};
