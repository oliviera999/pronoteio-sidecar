/** Classes, groups and students (ListeEleves works for any class or group of the school). */
import { parseTimetable, timetableFromIntervals, type SessionHandle } from "pawnote";
import { HttpError } from "../errors.js";
import { answerData, callPronote } from "../pronote/request.js";
import { listOf } from "../pronote/encoding.js";
import { userData, type SchoolResource } from "../pronote/userdata.js";
import { splitDisplayName, type Resource, type Student } from "../normalise.js";
import { requireFunction } from "./functions.js";
import { kindOf, resolve, stableId, stableIds } from "./ids.js";

/** Fallback when the login data are missing: group names found in the school-year timetable. */
const resourcesFromTimetable = async (session: SessionHandle): Promise<Resource[]> => {
  const timetable = await timetableFromIntervals(session, session.instance.firstDate, session.instance.lastDate);
  parseTimetable(session, timetable, { withSuperposedCanceledClasses: false, withCanceledClasses: true, withPlannedClasses: true });
  const names = new Set<string>();
  for (const item of timetable.classes) {
    if (item.is === "lesson") item.groupNames.forEach((name) => names.add(name));
  }
  return [...names].sort().map((name) => ({ id: `name:${name}`, name, type: "class" }));
};

const typeOf = (item: SchoolResource) => (item.genre === 1 ? "class" : "group") as "class" | "group";

/** Every class of the school (cohorts) and the groups the teacher teaches (course mappings). */
export const resources = async (session: SessionHandle): Promise<Resource[]> => {
  const all = userData(session).resources;
  if (all.length === 0) return resourcesFromTimetable(session);
  return all
    .filter((item) => item.genre === 1 || item.taught)
    .map((item) => ({ id: stableId(typeOf(item), item.label), name: item.label, type: typeOf(item) }))
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name, "fr", { numeric: true }));
};

/** Student of a class or group in the current session: Pronote id, "NOM Prénom" and stable id. */
export type RosterEntry = { pronoteId: string; label: string; id: string };

export const rosterEntries = async (session: SessionHandle, resourceId: string): Promise<RosterEntry[]> => {
  const kind = kindOf(resourceId);
  if (kind !== "class" && kind !== "group") {
    throw new HttpError(409, "resource_without_pronote_id");
  }
  const genre = kind === "class" ? 1 : 2;
  const candidates = userData(session).resources.filter((item) => item.genre === genre);
  const resource = resolve(kind, resourceId, candidates, (item) => item.label);

  const fn = requireFunction("studentsList");
  const answer = await callPronote(session, {
    name: fn.name,
    data: { ressource: { N: resource.id, G: resource.genre, L: resource.label } },
    signature: fn.onglet !== null ? { onglet: fn.onglet } : undefined,
  });
  const students = listOf(answerData(session, answer).listeEleves);
  const ids = stableIds("student", students, (item: any) => String(item.L ?? ""));
  return students.map((item: any, index) => ({ pronoteId: String(item.N ?? ""), label: String(item.L ?? ""), id: ids[index] }));
};

export const roster = async (session: SessionHandle, resourceId: string): Promise<Student[]> => {
  // Pronote only gives "NOM Prénom" to a teacher: no e-mail nor birth date.
  return (await rosterEntries(session, resourceId)).map((entry) => {
    const split = splitDisplayName(entry.label);
    return { id: entry.id, lastname: split.lastname, firstname: split.firstname, email: null, birthdate: null };
  });
};
