import { currentContext, isWriteFunction, PRIORITY } from "../context.js";
import { HttpError, RateLimitedError } from "../errors.js";
import { isPrimary } from "../lock.js";
export class Limiter {
    options;
    now;
    tokens;
    refilled;
    lastCall = 0;
    seq = 0;
    queue = [];
    timer = null;
    served = 0;
    refused = 0;
    waits = [];
    calls = [];
    constructor(options, now = Date.now) {
        this.options = options;
        this.now = now;
        this.tokens = options.burst;
        this.refilled = now();
    }
    get perMs() {
        return this.options.ratePerMinute / 60_000;
    }
    refill(now) {
        if (this.options.ratePerMinute <= 0) {
            this.tokens = this.options.burst;
        }
        else {
            this.tokens = Math.min(this.options.burst, this.tokens + (now - this.refilled) * this.perMs);
        }
        this.refilled = now;
    }
    /** Time (ms from now) when "cost" more tokens are available after serving "ahead" tokens, spacing included. */
    estimate(ahead, cost, count, now) {
        const spacing = Math.max(0, this.lastCall + this.options.minSpacingMs - now) + count * this.options.minSpacingMs;
        if (this.options.ratePerMinute <= 0)
            return spacing;
        const missing = ahead + cost - this.tokens;
        return Math.max(spacing, missing > 0 ? missing / this.perMs : 0);
    }
    ordered() {
        return this.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    }
    /** Seconds after which a new request of this priority would be served within the maximum wait (at least 1). */
    retryAfter(priority = PRIORITY.read, now = this.now()) {
        this.refill(now);
        const ahead = this.queue.filter((item) => item.priority <= priority);
        const tokens = ahead.reduce((sum, item) => sum + item.cost, 0);
        const drain = this.estimate(tokens, 1, ahead.length, now);
        return Math.max(1, Math.ceil((drain - this.options.maxWaitMs) / 1000));
    }
    /** Waits for a token (or refuses with RateLimitedError); resolves when the call may be sent. */
    acquire(cost = 1, priority = PRIORITY.read, deadline) {
        const now = this.now();
        const until = deadline ?? now + this.options.maxWaitMs;
        this.refill(now);
        const ahead = this.queue.filter((item) => item.priority <= priority);
        const expected = this.estimate(ahead.reduce((sum, item) => sum + item.cost, 0), cost, ahead.length, now);
        if (now + expected > until) {
            this.refused++;
            return Promise.reject(new RateLimitedError(this.retryAfter(priority, now)));
        }
        return new Promise((resolve, reject) => {
            const waiter = { cost, priority, seq: this.seq++, deadline: until, enqueued: now, resolve, reject };
            // Still waiting at its deadline (calls of a higher priority went first): refused with the remaining delay.
            waiter.timer = setTimeout(() => {
                const index = this.queue.indexOf(waiter);
                if (index < 0)
                    return;
                this.queue.splice(index, 1);
                this.refused++;
                reject(new RateLimitedError(this.retryAfter(priority)));
                this.pump();
            }, Math.max(0, until - now) + 1);
            this.queue.push(waiter);
            this.pump();
        });
    }
    pump() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        while (this.queue.length > 0) {
            const now = this.now();
            this.refill(now);
            const head = this.ordered()[0];
            const wait = this.estimate(0, head.cost, 0, now);
            if (wait > 0) {
                this.timer = setTimeout(() => this.pump(), Math.ceil(wait));
                return;
            }
            this.queue.shift();
            if (head.timer)
                clearTimeout(head.timer);
            if (this.options.ratePerMinute > 0)
                this.tokens -= head.cost;
            this.lastCall = now;
            this.served++;
            this.calls.push(now);
            this.waits.push({ at: now, wait: now - head.enqueued });
            head.resolve();
        }
    }
    stats() {
        const now = this.now();
        this.refill(now);
        this.waits = this.waits.filter((item) => item.at > now - 300_000);
        this.calls = this.calls.filter((time) => time > now - 60_000);
        const total = this.waits.reduce((sum, item) => sum + item.wait, 0);
        return {
            queued: this.queue.length,
            tokens: Math.floor(this.tokens * 10) / 10,
            served: this.served,
            refused: this.refused,
            averageWaitMs: this.waits.length ? Math.round(total / this.waits.length) : 0,
            lastMinute: this.calls.length,
        };
    }
}
const int = (value, fallback) => {
    const parsed = Number.parseInt(value ?? "", 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};
/** Options read from the environment (defaults: 120 per minute, burst 30, 150 ms, 20 s). */
export const limiterOptions = (env = process.env) => ({
    ratePerMinute: int(env.PRONOTEIO_MAX_CALLS_PER_MINUTE, 120),
    burst: Math.max(1, int(env.PRONOTEIO_RATE_BURST, 30)),
    minSpacingMs: int(env.PRONOTEIO_MIN_SPACING_MS, 150),
    maxWaitMs: int(env.PRONOTEIO_QUEUE_MAX_WAIT, 20) * 1000,
});
/**
 * Cost of the Pronote functions heavier than a list (tokens; 1 for the others). PRONOTEIO_CALL_COSTS overrides or
 * adds: "FicheEleve=3,PageNotes=2".
 */
const DEFAULT_COSTS = { FicheEleve: 2, PageBulletins: 2, PageNotes: 2, PageCahierDeTexte: 2 };
export const parseCosts = (value) => {
    const costs = { ...DEFAULT_COSTS };
    for (const part of String(value ?? "").split(",")) {
        const [name, raw] = part.split("=").map((item) => item.trim());
        const cost = Number.parseFloat(raw ?? "");
        if (name && Number.isFinite(cost) && cost > 0)
            costs[name] = cost;
    }
    return costs;
};
const costs = parseCosts(process.env.PRONOTEIO_CALL_COSTS);
/** Cost of a Pronote function call (tokens). */
export const callCost = (name) => costs[name] ?? 1;
const limiters = new WeakMap();
const live = new Set();
/** Limiter of a Pronote session (created on first use). */
export const limiterOf = (session, options = limiterOptions()) => {
    let limiter = limiters.get(session);
    if (!limiter) {
        limiter = new Limiter(options);
        limiters.set(session, limiter);
        live.add(new WeakRef(limiter));
    }
    return limiter;
};
/** Waits for the turn of a call of the current request (priority and deadline of its context). */
export const throttle = async (session, name = "") => {
    // Only the primary process talks to Pronote (P5, lock.ts).
    if (!isPrimary())
        throw new HttpError(503, "pronote_unavailable", { reason: "second_process" });
    const context = currentContext();
    await limiterOf(session).acquire(callCost(name), context?.priority ?? PRIORITY.read, context?.deadline);
    if (context) {
        context.calls++;
        if (isWriteFunction(name))
            context.writeSent = true;
    }
};
/** Calls made during the last minute (tests and health check). */
export const recentCalls = (session) => limiters.get(session)?.stats().lastMinute ?? 0;
/** Sum of the statistics of the live limiters (health check). */
export const limiterStats = () => {
    const total = { queued: 0, tokens: 0, served: 0, refused: 0, averageWaitMs: 0, lastMinute: 0, sessions: 0 };
    let weighted = 0;
    for (const ref of live) {
        const limiter = ref.deref();
        if (!limiter) {
            live.delete(ref);
            continue;
        }
        const stats = limiter.stats();
        total.sessions++;
        total.queued += stats.queued;
        total.tokens += stats.tokens;
        total.served += stats.served;
        total.refused += stats.refused;
        total.lastMinute += stats.lastMinute;
        weighted += stats.averageWaitMs * stats.served;
    }
    total.averageWaitMs = total.served ? Math.round(weighted / total.served) : 0;
    return total;
};
//# sourceMappingURL=limiter.js.map