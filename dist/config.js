const int = (value, fallback) => {
    const parsed = Number.parseInt(value ?? "", 10);
    return Number.isFinite(parsed) ? parsed : fallback;
};
export const config = {
    secret: process.env.PRONOTEIO_SECRET ?? "",
    host: process.env.PRONOTEIO_HOST ?? "127.0.0.1",
    port: int(process.env.PRONOTEIO_PORT, 3900),
    sessionTtl: int(process.env.PRONOTEIO_SESSION_TTL, 1500) * 1000,
    maxSkew: int(process.env.PRONOTEIO_MAX_SKEW, 300),
    enableGradeWrite: process.env.PRONOTEIO_ENABLE_GRADE_WRITE === "true",
    logLevel: process.env.PRONOTEIO_LOG_LEVEL ?? "info",
};
if (config.secret.length < 16 || config.secret === "change-me") {
    throw new Error("PRONOTEIO_SECRET must be set to a random value of at least 16 characters.");
}
//# sourceMappingURL=config.js.map