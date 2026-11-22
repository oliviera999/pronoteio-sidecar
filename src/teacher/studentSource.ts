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
import { ServerSideError, type SessionHandle } from "pawnote";
import { lostSessionReason } from "../session.js";
import { wallNow } from "../time.js";
import { seconds } from "../normalise.js";
import { callFunction, functions, type FunctionKey } from "./functions.js";
import { SENSITIVE, shapeOf } from "./shape.js";
import { deniedWhere, isAccessDenied } from "./tolerant.js";

/** What a function gave for a student, a page or a request. */
export type SourceOutcome = {
  available: boolean;
  /** "", access_denied, pronote_error, format_unknown, not_asked. */
  reason: string;
  /** Shape of the answer that was not understood (shape.ts): never a value. */
  shape?: string[];
  onglet?: number;
  space?: string;
};

const CLOSED_TTL_MS = 10 * 60_000;

type Memory = { answered: Set<FunctionKey>; closed: Map<FunctionKey, { outcome: SourceOutcome; until: number }> };
const memories = new WeakMap<SessionHandle, Memory>();

const memoryOf = (session: SessionHandle): Memory => {
  let memory = memories.get(session);
  if (!memory) {
    memory = { answered: new Set(), closed: new Map() };
    memories.set(session, memory);
  }
  return memory;
};

/** Forgets what a session learnt about its functions (tests). */
export const resetSourceMemory = (session: SessionHandle): void => {
  memories.delete(session);
};

/** A function during one request: open until Pronote refuses it or its shape is unknown. */
export type StudentSource = { key: FunctionKey; state: SourceOutcome };

/** Source of a request: closed from the start when the session saw the function refused in the last minutes. */
export const openSource = (session: SessionHandle, key: FunctionKey): StudentSource => {
  const known = memoryOf(session).closed.get(key);
  if (known && known.until > Date.now()) return { key, state: known.outcome };
  return { key, state: { available: true, reason: "" } };
};

const OPEN: SourceOutcome = { available: true, reason: "" };

/**
 * Reads one student from a source. "value" is null when nothing was read (source closed, refusal, unknown shape), with
 * the outcome that says why; "nothing" is what a student without anything gets.
 */
export const readStudentSource = async <T>(
  session: SessionHandle,
  source: StudentSource,
  data: Record<string, unknown>,
  decode: (answer: Record<string, any>) => T | null,
  nothing: T,
): Promise<{ value: T | null; outcome: SourceOutcome }> => {
  if (!source.state.available) return { value: null, outcome: source.state };
  const memory = memoryOf(session);
  const close = (outcome: SourceOutcome, remember: boolean): { value: null; outcome: SourceOutcome } => {
    source.state = outcome;
    if (remember) memory.closed.set(source.key, { outcome, until: Date.now() + CLOSED_TTL_MS });
    return { value: null, outcome };
  };
  const denied = (): SourceOutcome => ({ available: false, reason: "access_denied", ...deniedWhere(session, functions[source.key].onglet) });
  let answer: Record<string, any>;
  try {
    answer = await callFunction(session, source.key, data);
  } catch (error) {
    if (!(error instanceof ServerSideError) || lostSessionReason(error)) throw error;
    // An error of Pronote that is not a refusal may be of the moment: it closes the function for this request only.
    return isAccessDenied(error) ? close(denied(), true) : close({ available: false, reason: "pronote_error" }, false);
  }
  if (!answer || Object.keys(answer).length === 0) {
    return memory.answered.has(source.key) ? { value: nothing, outcome: OPEN } : close(denied(), true);
  }
  const value = decode(answer);
  if (value === null) {
    // Health functions included: the sensitive names are left out of the shape (shape.ts SENSITIVE).
    const outcome: SourceOutcome = { available: false, reason: "format_unknown", shape: shapeOf(answer, "", 0, [], SENSITIVE) };
    return memory.answered.has(source.key) ? { value: null, outcome } : close(outcome, true);
  }
  memory.answered.add(source.key);
  return { value, outcome: OPEN };
};

/** School year of a session in epoch seconds: the dates of the instance, else September to July around today. */
export const schoolYearRange = (session: SessionHandle): { from: number; to: number } => {
  const instance = (session.instance ?? {}) as { firstDate?: unknown; lastDate?: unknown; firstMonday?: unknown };
  const now = wallNow();
  const year = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  const valid = (value: unknown): value is Date => value instanceof Date && !Number.isNaN(value.getTime());
  const first = valid(instance.firstDate) ? instance.firstDate : valid(instance.firstMonday) ? instance.firstMonday : new Date(year, 8, 1);
  const last = valid(instance.lastDate) && instance.lastDate > first ? instance.lastDate : new Date(first.getFullYear() + 1, 6, 15);
  const start = new Date(first.getFullYear(), first.getMonth(), first.getDate());
  const end = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
  return { from: seconds(start), to: seconds(end) };
};
