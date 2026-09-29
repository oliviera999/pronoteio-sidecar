/**
 * Grade entry through the teacher space ("Saisie des notes"), PRONOTE 2026.2.
 *
 * Read: ListePeriodes, ListeServices, then PageNotes (students, existing assessments and the
 * service settings of a service/period). Write: SaisieNotes with one assessment in
 * "listeDevoirs", encoded like the web client (objetrequetesaisienotes.js): new elements have a
 * negative N and E = 1, modified ones their N and E = 2; grades are sent as "note" on the students.
 * After a write the page is read again to report what Pronote really stored.
 */
import type { SessionHandle } from "pawnote";
import { HttpError } from "../errors.js";
import { answerData, callPronote } from "../pronote/request.js";
import { gradeValue, listOf, pronoteDate, pronoteNumber } from "../pronote/encoding.js";
import { userData } from "../pronote/userdata.js";
import type { Assessment, Grade, GradeContext, PushResult, Service } from "../normalise.js";
import { requireFunction, type FunctionKey } from "./functions.js";
import { resolve, stableId, stableIds } from "./ids.js";

const STATE_CREATED = 1;
const STATE_MODIFIED = 2;
const TYPE_NUMBER = 10;
/** Genre of a teacher resource. */
const GENRE_TEACHER = 3;

type Element = { N: string; G?: number; L?: string; [key: string]: any };

const ref = (item: Element) => ({ N: item.N, ...(item.G !== undefined ? { G: item.G } : {}), ...(item.L ? { L: item.L } : {}) });
const number = (value: number) => ({ _T: TYPE_NUMBER, V: pronoteNumber(value) });

const call = async (session: SessionHandle, key: FunctionKey, data?: Record<string, unknown>) => {
  const fn = requireFunction(key);
  const answer = await callPronote(session, {
    name: fn.name,
    data,
    signature: fn.onglet !== null ? { onglet: fn.onglet } : undefined,
  });
  return answerData(session, answer);
};

const pad = (value: number) => String(value).padStart(2, "0");
/** "dd/mm/yyyy" as Pronote displays assessment dates. */
const dayOf = (date: Date) => `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
const normaliseDay = (value: unknown) => {
  const match = String(value ?? "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return match ? `${pad(Number(match[1]))}/${pad(Number(match[2]))}/${match[3]}` : "";
};

const periodKey = (period: Element) => String(period.L ?? "");
const resourceOf = (service: Element): Element | undefined => service.classe?.V ?? service.groupe?.V;
const serviceKey = (service: Element) => `${service.matiere?.V?.L ?? service.L ?? ""}|${resourceOf(service)?.L ?? ""}`;
const studentKey = (student: Element) => String(student.L ?? "");
const assessmentKey = (assessment: Element) => `${normaliseDay(assessment.date?.V)}|${assessment.commentaire ?? ""}`;
export const assessmentIdFor = (date: Date, title: string) => stableId("assessment", `${dayOf(date)}|${title.trim()}`);

const loadPeriods = async (session: SessionHandle) => {
  const data = await call(session, "periodsList");
  const periods = listOf<Element>(data.listePeriodes);
  const byDefault = data.periodeParDefaut?.V;
  const current = periods.find((p) => p.N === byDefault?.N) ?? periods.find((p) => p.L === byDefault?.L) ?? null;
  return { periods, current };
};

const loadServices = async (session: SessionHandle, period: Element | null) => {
  const me = session.user.resources[0];
  const data = await call(session, "servicesList", {
    Professeur: { N: me.id, G: GENRE_TEACHER, L: me.name },
    ...(period ? { Periode: ref(period) } : {}),
  });
  return listOf<Element>(data.services);
};

const resourceType = (session: SessionHandle, label: string): "class" | "group" => {
  const found = userData(session).resources.find((item) => item.label === label);
  return found?.genre === 2 ? "group" : "class";
};

export const context = async (session: SessionHandle): Promise<GradeContext> => {
  const { periods, current } = await loadPeriods(session);
  const services = await loadServices(session, current);
  const periodIds = stableIds("period", periods, periodKey);
  const serviceIds = stableIds("service", services, serviceKey);

  return {
    periods: periods.map((period, index) => ({
      id: periodIds[index],
      name: String(period.L ?? ""),
      current: period === current,
    })),
    services: services.map((service, index): Service => {
      const subject = String(service.matiere?.V?.L ?? service.L ?? "");
      const resourcename = String(resourceOf(service)?.L ?? "");
      const type = resourceType(session, resourcename);
      return {
        id: serviceIds[index],
        name: [subject, resourcename].filter(Boolean).join(" - "),
        subject,
        resourceid: stableId(type, resourcename),
        resourcename,
        type,
      };
    }),
    maxScale: userData(session).maxScale,
  };
};

/** Checks the grades against the assessment, without calling Pronote. */
export const validate = (assessment: Assessment, grades: Grade[], maxScale: number | null = null): PushResult["rejected"] => {
  if (maxScale !== null && assessment.max > maxScale) throw new HttpError(400, "scale_too_large");
  const rejected: PushResult["rejected"] = [];
  const seen = new Set<string>();
  for (const grade of grades) {
    if (seen.has(grade.studentid)) rejected.push({ studentid: grade.studentid, reason: "duplicate" });
    seen.add(grade.studentid);
    if (grade.status === "" && grade.value !== null && (grade.value < 0 || grade.value > assessment.max)) {
      rejected.push({ studentid: grade.studentid, reason: "out_of_scale" });
    }
  }
  return rejected;
};

/** Service member of SaisieNotes: the service reference plus its settings for the period, as read. */
const serviceMember = (service: Element, page: Record<string, any>) => {
  const full = page.service?.V ?? {};
  const settings = listOf<Element>(full.listePeriodes)[0] ?? {};
  const member: Record<string, unknown> = { ...ref(service) };
  if (full.estUnService === false) {
    if (settings.coefficient !== undefined) member.coefficient = settings.coefficient;
  } else if (full.coefficientGeneral !== undefined) {
    member.coefficientGeneral = full.coefficientGeneral;
  }
  member.facultatif = Boolean(full.facultatif);
  for (const key of [
    "moyenneParSousMatiere",
    "moyenneBulletinSurClasse",
    "avecDevoirSupMoy",
    "avecBonusMalus",
    "ponderationNotePlusHaute",
    "ponderationNotePlusBasse",
    "arrondiEleve",
    "arrondiClasse",
  ]) {
    if (settings[key] !== undefined) member[key] = settings[key];
  }
  return member;
};

const classesMember = (period: Element, page: Record<string, any>, existing: Element | null) => {
  if (existing) {
    return listOf<Element>(existing.listeClasses).map((classe) => {
      const periods = listOf<Element>(classe.listePeriodes);
      return {
        ...ref(classe),
        service: classe.service?.V ? ref(classe.service.V) : undefined,
        ...(periods[0] ? { periodePrincipale: ref(periods[0]) } : {}),
        ...(periods[1] ? { periodeSecondaire: ref(periods[1]) } : {}),
      };
    });
  }
  return listOf<Element>(page.listeClasses).map((classe) => ({
    ...ref(classe),
    service: classe.service?.V ? ref(classe.service.V) : undefined,
    periodePrincipale: ref(period),
  }));
};

const assessmentMember = (
  period: Element,
  page: Record<string, any>,
  assessment: Assessment,
  existing: Element | null,
  notes: { N: string; note: string }[],
) => {
  const date = new Date(assessment.date * 1000);
  const publication = new Date((assessment.publication ?? assessment.date) * 1000);
  return {
    N: existing ? existing.N : -1,
    E: existing ? STATE_MODIFIED : STATE_CREATED,
    date: pronoteDate(date),
    coefficient: number(assessment.coefficient),
    verrouille: false,
    commeUnBonus: assessment.bonus,
    commeUneNote: assessment.optional && !assessment.bonus,
    commentaire: assessment.title.trim(),
    bareme: number(assessment.max),
    recalculerNotesDevoirSelonBareme: false,
    ramenerSur20: assessment.scaleTo20,
    datePublication: pronoteDate(publication),
    avecCommentaireSurNoteEleve: Boolean(existing?.avecCommentaireSurNoteEleve),
    ListeThemes: listOf<Element>(existing?.ListeThemes).map(ref),
    listeClasses: classesMember(period, page, existing),
    listeEleves: notes.map((item) => ({ N: item.N, E: STATE_MODIFIED, note: { _T: TYPE_NUMBER, V: item.note } })),
  };
};

/** Same grade? Pronote may write "12,50" for "12,5". */
const sameNote = (stored: unknown, sent: string): boolean => {
  const a = String(stored ?? "");
  if (a === sent) return true;
  if (a.startsWith("|") || sent.startsWith("|") || a === "" || sent === "") return false;
  return Number.parseFloat(a.replace(",", ".")) === Number.parseFloat(sent.replace(",", "."));
};

export const push = async (
  session: SessionHandle,
  serviceId: string,
  periodId: string,
  assessment: Assessment,
  grades: Grade[],
  dryRun: boolean,
): Promise<PushResult> => {
  const rejected = validate(assessment, grades, userData(session).maxScale);

  const { periods } = await loadPeriods(session);
  const period = resolve("period", periodId, periods, periodKey);
  const service = resolve("service", serviceId, await loadServices(session, period), serviceKey);
  const pageRequest = { service: ref(service), periode: ref(period) };
  const page = await call(session, "gradesPage", pageRequest);

  const students = listOf<Element>(page.listeEleves);
  const studentIds = stableIds("student", students, studentKey);
  const byId = new Map(studentIds.map((id, index) => [id, students[index]]));

  const invalid = new Set(rejected.map((item) => item.studentid));
  const notes: { studentid: string; N: string; note: string }[] = [];
  for (const grade of grades) {
    if (invalid.has(grade.studentid)) continue;
    const student = byId.get(grade.studentid);
    if (!student) {
      rejected.push({ studentid: grade.studentid, reason: "unknown_student" });
      continue;
    }
    notes.push({ studentid: grade.studentid, N: student.N, note: gradeValue(grade.value, grade.status) });
  }

  // The previous push (stable id) first, then an assessment with the same date and title, so that a
  // lost Moodle record does not create a duplicate.
  const assessments = listOf<Element>(page.listeDevoirs);
  const assessmentIds = stableIds("assessment", assessments, assessmentKey);
  const newId = assessmentIdFor(new Date(assessment.date * 1000), assessment.title);
  const find = (id: string | null) => (id === null ? -1 : assessmentIds.indexOf(id));
  const index = find(assessment.id) >= 0 ? find(assessment.id) : find(newId);
  const existing = index >= 0 ? assessments[index] : null;
  if (existing?.verrouille) throw new HttpError(409, "assessment_locked");

  if (dryRun || notes.length === 0) {
    return { assessmentid: existing ? assessmentIds[index] : assessment.id, written: 0, rejected, dryRun };
  }

  await call(session, "gradesSave", {
    periode: ref(period),
    service: serviceMember(service, page),
    listeDevoirs: [assessmentMember(period, page, assessment, existing, notes)],
  });

  // Read back: the assessment under its new date/title, and the grades really stored.
  const after = await call(session, "gradesPage", pageRequest);
  const saved = listOf<Element>(after.listeDevoirs);
  const savedIndex = stableIds("assessment", saved, assessmentKey).indexOf(newId);
  if (savedIndex < 0) throw new HttpError(502, "assessment_not_saved");
  const stored = new Map(listOf<Element>(saved[savedIndex].listeEleves).map((item) => [item.N, item.Note?.V]));
  const storedByLabel = new Map(listOf<Element>(saved[savedIndex].listeEleves).map((item) => [item.L, item.Note?.V]));

  let written = 0;
  for (const item of notes) {
    const label = byId.get(item.studentid)?.L;
    const value = stored.has(item.N) ? stored.get(item.N) : storedByLabel.get(label);
    if (sameNote(value, item.note)) written++;
    else rejected.push({ studentid: item.studentid, reason: "not_saved" });
  }
  return { assessmentid: newId, written, rejected, dryRun: false };
};
