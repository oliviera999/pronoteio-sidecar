import { HttpError } from "../errors.js";
const states = new WeakMap();
export const MIN_SPACING_MS = 150;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Waits for the spacing, checks the ceiling and records the call. */
export const throttle = async (session, maxPerMinute, now = Date.now()) => {
    const state = states.get(session) ?? { last: 0, calls: [] };
    states.set(session, state);
    state.calls = state.calls.filter((time) => time > now - 60_000);
    if (maxPerMinute > 0 && state.calls.length >= maxPerMinute) {
        throw new HttpError(429, "rate_limited");
    }
    const wait = state.last + MIN_SPACING_MS - now;
    if (wait > 0)
        await sleep(wait);
    const time = Date.now();
    state.last = time;
    state.calls.push(time);
};
/** Calls made during the last minute (for tests and the health check). */
export const recentCalls = (session, now = Date.now()) => (states.get(session)?.calls ?? []).filter((time) => time > now - 60_000).length;
//# sourceMappingURL=limiter.js.map