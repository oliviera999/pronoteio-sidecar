/**
 * Stable identifiers.
 *
 * Pronote identifiers ("105#<43 chars>") are encrypted per session: an id read in one session is
 * refused in the next one. Moodle stores ids across sessions (course mappings, cohort links,
 * previous pushes), so the sidecar exposes ids built from labels and resolves them against the
 * current session before each call. Keys longer than MAX_KEY are hashed (Moodle columns hold 100).
 */
import { createHash } from "node:crypto";
import { HttpError } from "../errors.js";
import { normalise } from "../normalise.js";
const PREFIX = {
    class: "c",
    group: "g",
    period: "p",
    service: "s",
    student: "e",
    assessment: "d",
    absence: "a",
    lesson: "l",
    planned: "ev",
    discussion: "m",
    competency: "cp",
    news: "n",
    document: "doc",
    quiz: "q",
    recipient: "r",
    list: "dl",
    meeting: "mt",
    appointment: "rdv",
    forumTopic: "ft",
    referential: "rf",
};
const MAX_KEY = 80;
const normaliseKey = (key) => key.normalize("NFC").replace(/\s+/g, " ").trim();
export const stableId = (kind, key) => {
    const clean = normaliseKey(key);
    const body = clean.length <= MAX_KEY ? clean : `#${createHash("sha256").update(clean).digest("hex").slice(0, 32)}`;
    return `${PREFIX[kind]}:${body}`;
};
export const kindOf = (id) => {
    const prefix = id.split(":", 1)[0];
    const entry = Object.entries(PREFIX).find(([, value]) => value === prefix);
    return entry ? entry[0] : null;
};
/**
 * Stable ids of a list, in order. Items sharing the same key (e.g. two students with the same
 * name) get "~2", "~3"... in Pronote order.
 */
export const stableIds = (kind, items, key) => {
    const seen = new Map();
    return items.map((item) => {
        const id = stableId(kind, key(item));
        const count = (seen.get(id) ?? 0) + 1;
        seen.set(id, count);
        return count === 1 ? id : `${id}~${count}`;
    });
};
/** Pronote element of the current session matching a stable id, or HTTP 404 "<kind>_not_found". */
export const resolve = (kind, id, items, key) => {
    const ids = stableIds(kind, items, key);
    const index = ids.indexOf(id);
    if (index < 0)
        throw new HttpError(404, `${kind}_not_found`);
    return items[index];
};
/**
 * 0.17.1 (lot N9s): the student named in a write, among the rows of a grid. Accepted: the bare name ("NOM Prénom",
 * accents and case ignored, the first row of that name, as before 0.17.1) or the stable id ("e:NOM Prénom", and
 * "e:NOM Prénom~2" for the second homonym in Pronote order). The id is first compared exactly with the stable ids of
 * the rows (this also resolves a hashed id "e:#…"); else the prefix and the suffix are removed and the name is
 * compared as a bare name, the suffix choosing the n-th row of that name. Not found: undefined.
 */
export const matchStudent = (items, wanted, label) => {
    const comparable = normalise;
    if (!wanted.startsWith(`${PREFIX.student}:`))
        return items.find((item) => comparable(label(item)) === comparable(wanted));
    const ids = stableIds("student", items, label);
    const exact = ids.indexOf(wanted.normalize("NFC"));
    if (exact >= 0)
        return items[exact];
    let name = wanted.slice(PREFIX.student.length + 1);
    let rank = 1;
    const suffix = /~(\d{1,3})$/.exec(name);
    if (suffix) {
        rank = Number(suffix[1]);
        name = name.slice(0, suffix.index);
    }
    if (rank < 1)
        return undefined;
    return items.filter((item) => comparable(label(item)) === comparable(name))[rank - 1];
};
//# sourceMappingURL=ids.js.map