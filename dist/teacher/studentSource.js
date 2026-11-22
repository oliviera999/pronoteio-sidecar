/**
 * One Pronote function read student by student, for the class follow-up (0.16.0, docs/olutionsuivi/CONTRAT_SIDECAR.md).
 *
 * The functions read here (DetailsPIEleve, LivretScolaire, PageSuiviPluriannuel) were never seen answering with their
 * values: each answer goes through a tolerant decoder, and what is not understood is described, never guessed.
 * - a refusal of Pronote (rights) closes the function: no other call, for this request and for the next pages of the
 *   same session (ten minutes), and nothing else is tried in its place;
 * - an empty answer is a refusal too, unless the function already answered in this session: then it is a student
 *   for whom Pronote has nothing;
 * - a shape the decoder does not understand answers format_unknown with the shape of the answer (names and types,
 *   never a value, sensitive names left out). It closes the function when no answer was ever understood (the decoder
 *   is wrong); once one was, it only concerns that student;
 * - a lost session, a full queue and the errors of the sidecar are thrown: the caller (app.ts, tolerant.ts readEach)
 *   handles them.
 */
import { ServerSideError } from "pawnote";
import { lostSessionReason } from "../pronote/lostSession.js";
import { wallNow } from "../time.js";
import { seconds } from "../normalise.js";
import { callFunction, functions } from "./functions.js";
import { SENSITIVE, shapeOf } from "./shape.js";
import { deniedWhere, isAccessDenied } from "./tolerant.js";
const CLOSED_TTL_MS = 10 * 60_000;
const memories = new WeakMap();
const memoryOf = (session) => {
    let memory = memories.get(session);
    if (!memory) {
        memory = { answered: new Set(), closed: new Map() };
        memories.set(session, memory);
    }
    return memory;
};
/** Forgets what a session learnt about its functions (tests). */
export const resetSourceMemory = (session) => {
    memories.delete(session);
};
/** Source of a request: closed from the start when the session saw the function refused in the last minutes. */
export const openSource = (session, key) => {
    const known = memoryOf(session).closed.get(key);
    if (known && known.until > Date.now())
        return { key, state: known.outcome };
    return { key, state: { available: true, reason: "" } };
};
const OPEN = { available: true, reason: "" };
/**
 * Reads one student from a source. "value" is null when nothing was read (source closed, refusal, unknown shape), with
 * the outcome that says why; "nothing" is what a student without anything gets.
 */
export const readStudentSource = async (session, source, data, decode, nothing) => {
    if (!source.state.available)
        return { value: null, outcome: source.state };
    const memory = memoryOf(session);
    const close = (outcome, remember) => {
        source.state = outcome;
        if (remember)
            memory.closed.set(source.key, { outcome, until: Date.now() + CLOSED_TTL_MS });
        return { value: null, outcome };
    };
    const denied = () => ({ available: false, reason: "access_denied", ...deniedWhere(session, functions[source.key].onglet) });
    let answer;
    try {
        answer = await callFunction(session, source.key, data);
    }
    catch (error) {
        if (!(error instanceof ServerSideError) || lostSessionReason(error))
            throw error;
        // An error of Pronote that is not a refusal may be of the moment: it closes the function for this request only.
        return isAccessDenied(error) ? close(denied(), true) : close({ available: false, reason: "pronote_error" }, false);
    }
    if (!answer || Object.keys(answer).length === 0) {
        return memory.answered.has(source.key) ? { value: nothing, outcome: OPEN } : close(denied(), true);
    }
    const value = decode(answer);
    if (value === null) {
        // Health functions included: the sensitive names are left out of the shape (shape.ts SENSITIVE).
        const outcome = { available: false, reason: "format_unknown", shape: shapeOf(answer, "", 0, [], SENSITIVE) };
        return memory.answered.has(source.key) ? { value: null, outcome } : close(outcome, true);
    }
    memory.answered.add(source.key);
    return { value, outcome: OPEN };
};
/** School year of a session in epoch seconds: the dates of the instance, else September to July around today. */
export const schoolYearRange = (session) => {
    const instance = (session.instance ?? {});
    const now = wallNow();
    const year = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
    const valid = (value) => value instanceof Date && !Number.isNaN(value.getTime());
    const first = valid(instance.firstDate) ? instance.firstDate : valid(instance.firstMonday) ? instance.firstMonday : new Date(year, 8, 1);
    const last = valid(instance.lastDate) && instance.lastDate > first ? instance.lastDate : new Date(first.getFullYear() + 1, 6, 15);
    const start = new Date(first.getFullYear(), first.getMonth(), first.getDate());
    const end = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
    return { from: seconds(start), to: seconds(end) };
};
//# sourceMappingURL=studentSource.js.map