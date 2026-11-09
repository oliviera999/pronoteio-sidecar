/**
 * Timetable of any resource of the school, read on demand (PageEmploiDuTemps, tab 16): a class or group, a student
 * of a class, a teacher or a room (resolved with RessourceEDT). Nothing is kept. Moodle (local_olutionmcp) checks the
 * perimeter (students of the classes taught by the account) before calling.
 *
 * NOT VALIDATED for teachers, rooms and students: the demo account only read its own timetable. A refusal of Pronote
 * is returned as available=false with the reason.
 */
import type { SessionHandle } from "pawnote";
import { HttpError } from "../errors.js";
import { listOf } from "../pronote/encoding.js";
import { userData } from "../pronote/userdata.js";
import { normalise, type Lesson } from "../normalise.js";
import { callFunction, isTabClosed } from "./functions.js";
import { rosterEntries } from "./roster.js";
import { stableId } from "./ids.js";
import { lessonFromPage, weeksOf } from "./timetable.js";

export const RESOURCE_KINDS = ["class", "group", "student", "teacher", "room"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/** TypeHttpRessource of each kind in PageEmploiDuTemps. */
const GENRES: Record<ResourceKind, number> = { class: 1, group: 2, teacher: 3, student: 4, room: 17 };

export type ResourceRef = { N: string; G: number; L: string };

export type ResourceTimetable = {
  available: boolean;
  reason: string;
  validated: boolean;
  resource: { kind: ResourceKind; label: string } | null;
  items: Lesson[];
};

/** Teachers (genre 3) or rooms (genre 17) of a RessourceEDT answer ("data" member), whatever their group. */
export const edtResources = (data: Record<string, any>, genre: number): ResourceRef[] =>
  listOf<any>(data?.listeRessources)
    .flatMap((group) => listOf<any>(group?.liste))
    .filter((item) => typeof item?.N === "string" && Number(item?.G) === genre)
    .map((item) => ({ N: String(item.N), G: genre, L: String(item.L ?? "").trim() }));

const find = (items: ResourceRef[], label: string, kind: string): ResourceRef => {
  const found = items.filter((item) => normalise(item.L) === normalise(label));
  if (found.length === 0) throw new HttpError(404, `${kind}_not_found`);
  if (found.length > 1) throw new HttpError(409, `${kind}_ambiguous`);
  return found[0];
};

/** Resource of the request, with its session-bound identifier. */
export const resolveResource = async (
  session: SessionHandle,
  kind: ResourceKind,
  label: string,
  className = "",
): Promise<ResourceRef> => {
  if (kind === "class" || kind === "group") {
    const genre = GENRES[kind];
    const items = userData(session).resources
      .filter((item) => item.genre === genre)
      .map((item) => ({ N: item.id, G: genre, L: item.label }));
    return find(items, label, kind);
  }
  if (kind === "student") {
    if (className.trim() === "") throw new HttpError(400, "class_required");
    const entries = await rosterEntries(session, stableId("class", className));
    const found = entries.filter((entry) => normalise(entry.label) === normalise(label) || entry.id === label);
    if (found.length === 0) throw new HttpError(404, "student_not_found");
    if (found.length > 1) throw new HttpError(409, "student_ambiguous");
    return { N: found[0].pronoteId, G: GENRES.student, L: found[0].label };
  }
  const data = await callFunction(session, "timetableResources", {});
  return find(edtResources(data, GENRES[kind]), label, kind);
};

/** Lessons of a resource in [from, to) (at most 9 weeks), sorted by date. */
export const resourceTimetable = async (
  session: SessionHandle,
  kind: ResourceKind,
  label: string,
  from: Date,
  to: Date,
  className = "",
): Promise<ResourceTimetable> => {
  const empty: ResourceTimetable = { available: false, reason: "", validated: false, resource: null, items: [] };
  if (isTabClosed(session, "timetablePage")) return { ...empty, reason: "tab_closed:16" };
  const weeks = weeksOf(session, from, to);
  let resource: ResourceRef;
  try {
    resource = await resolveResource(session, kind, label, className);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return { ...empty, reason: String((error as Error)?.message ?? error).slice(0, 300) };
  }
  const items: Lesson[] = [];
  for (const week of weeks) {
    let data: Record<string, any>;
    try {
      data = await callFunction(session, "timetablePage", {
        Ressource: { N: resource.N, G: resource.G, L: resource.L },
        NumeroSemaine: week,
        avecAbsencesEleve: false,
        avecConseilDeClasse: false,
        avecRetenuesEleve: false,
        estEDTPermanence: false,
        avecCoursSortiePeda: true,
      });
    } catch (error) {
      return { ...empty, resource: { kind, label: resource.L }, reason: String((error as Error)?.message ?? error).slice(0, 300) };
    }
    for (const cours of listOf<any>(data.ListeCours)) {
      const ref = lessonFromPage(session, cours, week, "");
      if (!ref) continue;
      const start = ref.lesson.start * 1000;
      if (start < from.getTime() || start >= to.getTime()) continue;
      const { id, subject, teacher, rooms, groups, start: begin, end, cancelled, status } = ref.lesson;
      items.push({ id, subject, teacher, rooms, groups, start: begin, end, cancelled, status });
    }
  }
  items.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  return { available: true, reason: "", validated: false, resource: { kind, label: resource.L }, items };
};
