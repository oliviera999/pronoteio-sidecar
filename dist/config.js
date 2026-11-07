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
export const config = {
    secret: process.env.PRONOTEIO_SECRET ?? "",
    host: process.env.PRONOTEIO_HOST ?? "127.0.0.1",
    port: int(process.env.PRONOTEIO_PORT, 3900),
    sessionTtl: int(process.env.PRONOTEIO_SESSION_TTL, 1500) * 1000,
    maxSkew: int(process.env.PRONOTEIO_MAX_SKEW, 300),
    writeMode: writeMode(),
    /** Kept for callers of the previous name; true when writeMode is "live". */
    enableGradeWrite: writeMode() === "live",
    /** Pronote calls allowed per session and per minute (0: no limit); every call is also spaced by at least 150 ms. */
    maxCallsPerMinute: int(process.env.PRONOTEIO_MAX_CALLS_PER_MINUTE, 120),
    logLevel: process.env.PRONOTEIO_LOG_LEVEL ?? "info",
};
/** Refuses to start without a real shared secret (called by server.ts, so that importing config has no effect). */
export const assertSecret = () => {
    if (config.secret.length < 16 || config.secret === "change-me") {
        throw new Error("PRONOTEIO_SECRET must be set to a random value of at least 16 characters.");
    }
};
//# sourceMappingURL=config.js.map