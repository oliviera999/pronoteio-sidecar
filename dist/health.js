import { checkSignature, proxyStats, securityStats } from "./auth.js";
import { readCache } from "./cache.js";
import { config } from "./config.js";
import { jobStats } from "./jobs.js";
import { lockState } from "./lock.js";
import { isValidated, validatedVersions } from "./pronote/formats.js";
import { limiterOptions, limiterStats } from "./pronote/limiter.js";
import { sessionStats } from "./session.js";
import { stateStore } from "./state.js";
import { timeInfo } from "./time.js";
import { COMMIT, SIDECAR_VERSION, STARTED_AT } from "./version.js";
/** Public view: ok, version and short commit (the update script tells the new code from the old one with it). */
export const publicHealth = () => ({ ok: true, version: SIDECAR_VERSION, commit: COMMIT ? COMMIT.slice(0, 7) : "" });
export const fullHealth = (now = Date.now()) => {
    const state = stateStore.state;
    const queue = limiterStats();
    const options = limiterOptions();
    const lock = lockState();
    return {
        ok: lock.primary,
        version: SIDECAR_VERSION,
        commit: COMMIT,
        node: process.versions.node,
        startedAt: new Date(STARTED_AT).toISOString(),
        uptimeSeconds: Math.round((now - STARTED_AT) / 1000),
        starts: state.starts,
        process: { pid: process.pid, primary: lock.primary, holder: lock.holder, lockFile: lock.file ? "set" : "off", conflicts: lock.conflicts },
        time: timeInfo(now),
        writeMode: config.writeMode,
        session: { ...sessionStats(now), reconnects: state.reconnects },
        queue: {
            size: queue.queued,
            averageWaitMs: queue.averageWaitMs,
            tokens: Math.floor(queue.tokens * 10) / 10,
            lastMinute: queue.lastMinute,
            served: state.limiter.served + queue.served,
            refused: state.limiter.refused + queue.refused,
            limits: { perMinute: options.ratePerMinute, burst: options.burst, minSpacingMs: options.minSpacingMs, maxWaitSeconds: options.maxWaitMs / 1000 },
        },
        cache: readCache.stats(),
        jobs: jobStats(),
        proxy: proxyStats(now),
        pronote: {
            pronoteversion: state.pronote.version,
            validated: state.pronote.version ? isValidated(state.pronote.version) : null,
            validatedVersions: validatedVersions(),
            seenAt: state.pronote.seenAt,
        },
        security: {
            secrets: config.secrets.length,
            windowSeconds: config.maxSkew,
            nonceRequired: config.requireNonce,
            allowedIps: config.allowedIps.length,
            trustProxy: config.trustProxy,
            ...securityStats,
        },
        errors: [...state.errors].reverse(),
    };
};
const signed = (request) => request.headers["x-pronoteio-signature"] !== undefined || request.headers["x-pronoteio-timestamp"] !== undefined;
export const registerHealth = (app) => {
    app.get("/health/public", async () => publicHealth());
    app.get("/health", async (request) => {
        if (!signed(request))
            return publicHealth();
        checkSignature(request);
        return fullHealth();
    });
};
//# sourceMappingURL=health.js.map