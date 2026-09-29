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
  | "absencesList";

/** Values read from the PRONOTE 2026.2 teacher client (tabs: 23 grade entry, 105 student list, 113 call sheet). */
const defaults: Record<FunctionKey, TeacherFunction> = {
  periodsList: { name: "ListePeriodes", onglet: 23 },
  servicesList: { name: "ListeServices", onglet: 23 },
  gradesPage: { name: "PageNotes", onglet: 23 },
  studentsList: { name: "ListeEleves", onglet: 105 },
  gradesSave: { name: "SaisieNotes", onglet: 23 },
  absencesList: { name: "PageSaisieAbsences", onglet: 113 },
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

/** Configured function, or HTTP 501 when the capture has not been done yet. */
export const requireFunction = (key: FunctionKey): TeacherFunction => {
  const fn = functions[key];
  if (!fn.name) throw new HttpError(501, `not_configured:${key}`);
  return fn;
};
