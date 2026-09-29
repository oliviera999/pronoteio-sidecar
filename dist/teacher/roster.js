/** Classes, groups and students (ListeEleves works for any class or group of the school). */
import { parseTimetable, timetableFromIntervals } from "pawnote";
import { HttpError } from "../errors.js";
import { answerData, callPronote } from "../pronote/request.js";
import { listOf } from "../pronote/encoding.js";
import { userData } from "../pronote/userdata.js";
import { splitDisplayName } from "../normalise.js";
import { requireFunction } from "./functions.js";
import { kindOf, resolve, stableId, stableIds } from "./ids.js";
/** Fallback when the login data are missing: group names found in the school-year timetable. */
const resourcesFromTimetable = async (session) => {
    const timetable = await timetableFromIntervals(session, session.instance.firstDate, session.instance.lastDate);
    parseTimetable(session, timetable, { withSuperposedCanceledClasses: false, withCanceledClasses: true, withPlannedClasses: true });
    const names = new Set();
    for (const item of timetable.classes) {
        if (item.is === "lesson")
            item.groupNames.forEach((name) => names.add(name));
    }
    return [...names].sort().map((name) => ({ id: `name:${name}`, name, type: "class" }));
};
const typeOf = (item) => (item.genre === 1 ? "class" : "group");
/** Every class of the school (cohorts) and the groups the teacher teaches (course mappings). */
export const resources = async (session) => {
    const all = userData(session).resources;
    if (all.length === 0)
        return resourcesFromTimetable(session);
    return all
        .filter((item) => item.genre === 1 || item.taught)
        .map((item) => ({ id: stableId(typeOf(item), item.label), name: item.label, type: typeOf(item) }))
        .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name, "fr", { numeric: true }));
};
export const rosterEntries = async (session, resourceId) => {
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
    const ids = stableIds("student", students, (item) => String(item.L ?? ""));
    return students.map((item, index) => ({ pronoteId: String(item.N ?? ""), label: String(item.L ?? ""), id: ids[index] }));
};
export const roster = async (session, resourceId) => {
    // Pronote only gives "NOM Prénom" to a teacher: no e-mail nor birth date.
    return (await rosterEntries(session, resourceId)).map((entry) => {
        const split = splitDisplayName(entry.label);
        return { id: entry.id, lastname: split.lastname, firstname: split.firstname, email: null, birthdate: null };
    });
};
//# sourceMappingURL=roster.js.map