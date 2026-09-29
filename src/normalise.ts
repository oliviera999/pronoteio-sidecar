import type { Assignment, TimetableClassActivity, TimetableClassDetention, TimetableClassLesson } from "pawnote";
import type { GradeStatus } from "./pronote/encoding.js";

/** Shapes documented in plugin/classes/connector/connector_interface.php (timestamps in seconds). */
export type Lesson = {
  id: string;
  subject: string;
  teacher: string;
  rooms: string[];
  groups: string[];
  start: number;
  end: number;
  cancelled: boolean;
  status: string;
};

export type Homework = {
  id: string;
  subject: string;
  description: string;
  due: number;
  groups: string[];
  attachments: { name: string; url: string }[];
};

export type Resource = { id: string; name: string; type: "class" | "group" };

export type Student = {
  id: string;
  firstname: string;
  lastname: string;
  email: string | null;
  birthdate: number | null;
};

export type Absence = { id: string; studentid: string; start: number; end: number; justified: boolean; reason: string };

export type Grade = { studentid: string; value: number | null; status: GradeStatus };

/** Assessment options, all settable from Moodle. */
export type Assessment = {
  /** Existing Pronote assessment to update, null to create one. */
  id: string | null;
  title: string;
  /** Assessment date (seconds). */
  date: number;
  /** Date from which students and parents see the grade (seconds), null for immediately. */
  publication: number | null;
  /** Scale ("barème"). */
  max: number;
  coefficient: number;
  /** "Ramener sur 20". */
  scaleTo20: boolean;
  /** "Devoir facultatif": only counted if it raises the average. */
  optional: boolean;
  /** "Bonus": only points above the average count. */
  bonus: boolean;
  comment: string;
};

export type Period = { id: string; name: string; current: boolean };

export type Service = {
  id: string;
  name: string;
  subject: string;
  resourceid: string;
  resourcename: string;
  type: "class" | "group";
  /** Periods (stable ids) in which the service is graded: a group may be graded by semester only. */
  periods: string[];
};

export type GradeContext = {
  periods: Period[];
  services: Service[];
  /** Largest scale accepted by the school, null when unknown. */
  maxScale: number | null;
};

export type PushResult = {
  assessmentid: string | null;
  written: number;
  rejected: { studentid: string; reason: string }[];
  dryRun: boolean;
};

export const seconds = (date: Date): number => Math.floor(date.getTime() / 1000);

export const lessonFromPawnote = (
  item: TimetableClassLesson | TimetableClassActivity | TimetableClassDetention,
): Lesson | null => {
  if (item.is !== "lesson") return null;
  return {
    id: item.id,
    subject: item.subject?.name ?? "",
    teacher: item.teacherNames.join(", "),
    rooms: [...item.classrooms],
    groups: [...item.groupNames],
    start: seconds(item.startDate),
    end: seconds(item.endDate),
    cancelled: item.canceled,
    status: item.status ?? "",
  };
};

export const homeworkFromPawnote = (item: Assignment): Homework => ({
  id: item.id,
  subject: item.subject.name,
  description: item.description,
  due: seconds(item.deadline),
  // TODO: Pawnote does not expose the target groups of an assignment; resolve them via item.resourceID.
  groups: [],
  attachments: item.attachments.map((file) => ({ name: file.name, url: file.url })),
});

/** Splits a Pronote display name "NOM Prénom" (upper-case words form the last name). */
export const splitDisplayName = (label: string): { lastname: string; firstname: string } => {
  const words = label.trim().split(/\s+/);
  let index = 0;
  while (index < words.length - 1 && /\p{L}/u.test(words[index]) && words[index] === words[index].toLocaleUpperCase("fr")) {
    index++;
  }
  if (index === 0) index = 1;
  return { lastname: words.slice(0, index).join(" "), firstname: words.slice(index).join(" ") };
};
