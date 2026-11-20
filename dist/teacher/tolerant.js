/**
 * Tolerant readers for the answers of the main teacher view (0.12.0, docs/pronoteio/vue-pp.md in mood_prod).
 *
 * None of these Pronote functions was captured on a real server: member names are candidates read from the web client,
 * from the student space (Pawnote) and from the keys seen in production. Members are looked up without case, typed
 * values ({ _T, V }) are unwrapped, and a per-student loop answers partially when the queue towards Pronote is full.
 */
import { ServerSideError } from "pawnote";
import { HttpError, RateLimitedError } from "../errors.js";
import { listOf, parsePronoteDate } from "../pronote/encoding.js";
import { spaceOf } from "../space.js";
export const isPlain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
/** Value of a typed member ({ _T, V } → V), the value itself otherwise. */
export const unwrap = (value) => (isPlain(value) && "V" in value ? value.V : value);
/** First member present among candidate names, compared without case (undefined when none). */
export const member = (object, names, used) => {
    if (!isPlain(object))
        return undefined;
    const keys = Object.keys(object);
    for (const name of names) {
        const wanted = name.toLowerCase();
        const key = keys.find((item) => item.toLowerCase() === wanted);
        if (key !== undefined && object[key] !== undefined && object[key] !== null) {
            used?.add(key);
            return object[key];
        }
    }
    return undefined;
};
/** Text of a string, a number, a typed value or an element ({ L }), trimmed; "" otherwise. */
export const textOf = (value) => {
    if (value === null || value === undefined)
        return "";
    if (typeof value === "string" || typeof value === "number")
        return String(value).trim();
    if (isPlain(value)) {
        if ("V" in value)
            return textOf(value.V);
        if ("L" in value)
            return textOf(value.L);
    }
    return "";
};
/** Labels of a list of elements (or of strings), empty ones dropped; a single element or string gives one label. */
export const labelsOf = (value) => {
    const items = listOf(value);
    if (items.length > 0)
        return items.map((item) => textOf(item)).filter(Boolean);
    const raw = unwrap(value);
    if (Array.isArray(raw))
        return [];
    const single = textOf(value);
    return single === "" ? [] : [single];
};
/** Boolean of a member: true/false, 1/0, "oui"/"non"; null when absent or unreadable. */
export const boolOf = (value) => {
    const raw = unwrap(value);
    if (typeof raw === "boolean")
        return raw;
    if (raw === 1 || raw === "1")
        return true;
    if (raw === 0 || raw === "0")
        return false;
    if (typeof raw === "string") {
        const label = raw.trim().toLowerCase();
        if (["oui", "true", "vrai"].includes(label))
            return true;
        if (["non", "false", "faux"].includes(label))
            return false;
    }
    return null;
};
/** Number of a Pronote cell ("12,50", 3, { _T: 10, V: "12,5" }); null for an annotation ("|1") or nothing. */
export const numberOf = (value) => {
    const raw = unwrap(value);
    if (typeof raw === "number")
        return Number.isFinite(raw) ? raw : null;
    if (typeof raw !== "string")
        return null;
    const text = raw.trim().replace(/\s/g, "").replace(",", ".");
    if (text === "" || text.startsWith("|"))
        return null;
    const number = Number.parseFloat(text);
    return Number.isFinite(number) ? number : null;
};
/** Hours of a duration ("3h00", "1h30", "2,5", 2): 3, 1.5, 2.5, 2; null otherwise. */
export const hoursOf = (value) => {
    const raw = unwrap(value);
    if (typeof raw === "string") {
        const match = raw.trim().match(/^(\d+)\s*h\s*(\d{1,2})?$/i);
        if (match)
            return Math.round((Number(match[1]) + Number(match[2] ?? 0) / 60) * 100) / 100;
    }
    return numberOf(raw);
};
/** Wall Date of a Pronote date member ({ _T: 7, V: "dd/mm/yyyy[ hh:mm:ss]" } or the bare string), null otherwise. */
export const dateOf = (value) => parsePronoteDate(textOf(value));
const pad = (value) => String(value).padStart(2, "0");
/** "YYYY-MM-DD" of a wall Date, "" for null. */
export const dayString = (date) => date ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` : "";
/** Refusal of Pronote for lack of rights ("Vos droits sont insuffisants pour effectuer cette opération"). */
export const isAccessDenied = (error) => error instanceof ServerSideError && /droits|insuffisant/i.test(error.message);
/** Tab and space of a refusal, added to available: false (as the skills routes do since 0.10.0). */
export const deniedWhere = (session, onglet) => ({
    ...(onglet !== null ? { onglet } : {}),
    ...(spaceOf(session) ? { space: spaceOf(session) } : {}),
});
/**
 * Students of a page: one student (404 student_not_found when absent from the class or group), else the slice
 * [offset, offset + limit) of the roster, in ListeEleves order.
 */
export const pageOf = (entries, page, max, byDefault) => {
    const total = entries.length;
    if (page.student !== undefined && page.student !== "") {
        const index = entries.findIndex((entry) => entry.id === page.student);
        if (index < 0)
            throw new HttpError(404, "student_not_found");
        return { selected: [entries[index]], offset: index, total };
    }
    const offset = Math.max(0, Math.floor(page.offset ?? 0));
    const limit = Math.min(max, Math.max(1, Math.floor(page.limit ?? byDefault)));
    return { selected: entries.slice(offset, offset + limit), offset, total };
};
/**
 * Reads one item per student, in order. When the queue towards Pronote cannot serve the next student before the
 * deadline of the request (RateLimitedError), the students read so far are returned with the remaining ids and
 * retry_after; the error is thrown (429) only when no student could be read. Any other error is thrown.
 */
export const readEach = async (entries, read) => {
    const items = [];
    const done = [];
    let retryAfter = 0;
    for (const entry of entries) {
        try {
            items.push(await read(entry));
            done.push(entry.id);
        }
        catch (error) {
            if (error instanceof RateLimitedError && done.length > 0) {
                retryAfter = error.retryAfter;
                break;
            }
            throw error;
        }
    }
    const remaining = entries.slice(done.length).map((entry) => entry.id);
    return { items, read: done, remaining, partial: remaining.length > 0,
        retry_after: remaining.length > 0 ? Math.max(1, Math.ceil(retryAfter)) : 0 };
};
//# sourceMappingURL=tolerant.js.map