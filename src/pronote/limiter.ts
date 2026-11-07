/**
 * Rate limiting of the calls sent to Pronote, per session: a minimum spacing between two calls and a ceiling
 * per sliding minute (HTTP 429 rate_limited beyond). Pronote servers block accounts that call too fast.
 */
import type { SessionHandle } from "pawnote";
import { HttpError } from "../errors.js";

type State = { last: number; calls: number[] };

const states = new WeakMap<object, State>();

export const MIN_SPACING_MS = 150;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Waits for the spacing, checks the ceiling and records the call. */
export const throttle = async (session: SessionHandle, maxPerMinute: number, now = Date.now()): Promise<void> => {
  const state = states.get(session) ?? { last: 0, calls: [] };
  states.set(session, state);
  state.calls = state.calls.filter((time) => time > now - 60_000);
  if (maxPerMinute > 0 && state.calls.length >= maxPerMinute) {
    throw new HttpError(429, "rate_limited");
  }
  const wait = state.last + MIN_SPACING_MS - now;
  if (wait > 0) await sleep(wait);
  const time = Date.now();
  state.last = time;
  state.calls.push(time);
};

/** Calls made during the last minute (for tests and the health check). */
export const recentCalls = (session: SessionHandle, now = Date.now()): number =>
  (states.get(session)?.calls ?? []).filter((time) => time > now - 60_000).length;
