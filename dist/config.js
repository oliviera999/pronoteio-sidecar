import { join } from "node:path";
const int = (value, fallback) => {
    const parsed = Number.parseInt(value ?? "", 10);
    return Number.isFinite(parsed) ? parsed : fallback;
};
/**
 * Write mode of the sidecar: "simulate" (default) refuses every write to Pronote with a clear error, "live"
 * allows them. PRONOTEIO_ENABLE_GRADE_WRITE=true (older setting) is kept as an alias of "live".
 */
export const resolveWriteMode = (env) => {
    const mode = (env.PRONOTEIO_WRITE_MODE ?? "").trim().toLowerCase();
    if (mode === "live" || mode === "simulate")
        return mode;
    return env.PRONOTEIO_ENABLE_GRADE_WRITE === "true" ? "live" : "simulate";
};
const writeMode = () => resolveWriteMode(process.env);
/**
 * File of the token chain (tokenStore.ts): PRONOTEIO_TOKEN_STORE, "off" to disable it, by default var/tokens.json in
 * the application folder (kept across restarts and updates: var/ is not versioned).
 */
export const resolveTokenStoreFile = (env, cwd) => {
    const value = (env.PRONOTEIO_TOKEN_STORE ?? "").trim();
    if (value.toLowerCase() === "off")
        return null;
    return value !== "" ? value : join(cwd, "var", "tokens.json");
};
export const config = {
    secret: process.env.PRONOTEIO_SECRET ?? "",
    host: process.env.PRONOTEIO_HOST ?? "127.0.0.1",
    port: int(process.env.PRONOTEIO_PORT, 3900),
    sessionTtl: int(process.env.PRONOTEIO_SESSION_TTL, 1500) * 1000,
    /** Window of the signed requests (seconds): 60 since 0.9.0 (P11), 300 before. */
    maxSkew: int(process.env.PRONOTEIO_MAX_SKEW, 60),
    /** Secrets accepted for the signatures: the current one, then the previous ones during a rotation (P11). */
    secrets: [process.env.PRONOTEIO_SECRET ?? "", ...(process.env.PRONOTEIO_SECRET_PREVIOUS ?? "").split(",").map((item) => item.trim())]
        .filter((item) => item.length >= 16),
    /** The random nonce is required (local_pronoteio sends it since 0.2.3). */
    requireNonce: (process.env.PRONOTEIO_REQUIRE_NONCE ?? "true").toLowerCase() !== "false",
    /** Addresses allowed to call the signed routes (exact IPv4/IPv6 or IPv4 CIDR), empty: any (P11). */
    allowedIps: (process.env.PRONOTEIO_ALLOWED_IPS ?? "").split(",").map((item) => item.trim()).filter(Boolean),
    /** Trust X-Forwarded-For (the web server in front): default under Passenger only. */
    trustProxy: process.env.PRONOTEIO_TRUST_PROXY !== undefined ? process.env.PRONOTEIO_TRUST_PROXY === "true" : "PhusionPassenger" in globalThis,
    writeMode: writeMode(),
    /** Kept for callers of the previous name; true when writeMode is "live". */
    enableGradeWrite: writeMode() === "live",
    /** Pronote calls allowed per session and per minute (0: no limit); every call is also spaced by at least 150 ms. */
    maxCallsPerMinute: int(process.env.PRONOTEIO_MAX_CALLS_PER_MINUTE, 120),
    logLevel: process.env.PRONOTEIO_LOG_LEVEL ?? "info",
    tokenStoreFile: resolveTokenStoreFile(process.env, process.cwd()),
};
/** Refuses to start without a real shared secret (called by server.ts, so that importing config has no effect). */
export const assertSecret = () => {
    if (config.secret.length < 16 || config.secret === "change-me") {
        throw new Error("PRONOTEIO_SECRET must be set to a random value of at least 16 characters.");
    }
};
//# sourceMappingURL=config.js.map