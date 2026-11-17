import "./time.js";
import Fastify from "fastify";
import { INTERNAL_HEADER, INTERNAL_TOKEN, registerAuth } from "./auth.js";
import { registerJobs } from "./jobs.js";
import { config } from "./config.js";
import { currentContext, PRIORITY, priorityOf, requestContext } from "./context.js";
import { lostSessionReason, reconnect, sessionEntry, sessionLostError } from "./session.js";
import { HttpError, toHttp } from "./errors.js";
import { ERROR_CODES, errorBody } from "./errorCodes.js";
import { stateStore } from "./state.js";
import { SIDECAR_VERSION } from "./version.js";
import { limiterOptions } from "./pronote/limiter.js";
import { applyLocalTimes } from "./localInput.js";
import { registerCache } from "./cache.js";
import { registerHealth } from "./health.js";
import { registerAdmin } from "./admin.js";
import { accessLog as defaultAccessLog } from "./logs.js";
import { assertWritable, isValidated, pronoteVersion } from "./pronote/formats.js";
import absencesRoutes from "./routes/absences.js";
import assessmentsRoutes from "./routes/assessments.js";
import filesRoutes from "./routes/files.js";
import forumRoutes from "./routes/forum.js";
import listsRoutes from "./routes/lists.js";
import meetingsRoutes from "./routes/meetings.js";
import newsRoutes from "./routes/news.js";
import notificationsRoutes from "./routes/notifications.js";
import competenciesRoutes from "./routes/competencies.js";
import gradesRoutes from "./routes/grades.js";
import homeworkRoutes from "./routes/homework.js";
import messagesRoutes from "./routes/messages.js";
import notebookRoutes from "./routes/notebook.js";
import reportsRoutes from "./routes/reports.js";
import resourcesRoutes from "./routes/resources.js";
import rosterRoutes from "./routes/roster.js";
import sessionRoutes from "./routes/session.js";
import studentsRoutes from "./routes/students.js";
import timetableRoutes from "./routes/timetable.js";
/** Builds the sidecar application (every hook and route), without listening: server.ts listens, the tests inject. */
export const buildApp = async (options = {}) => {
    const accessLog = options.accessLog ?? defaultAccessLog;
    const app = Fastify({
        bodyLimit: 512 * 1024,
        // Request bodies carry passwords and tokens: they are never logged.
        logger: options.logger ?? {
            level: config.logLevel,
            redact: ["req.headers['x-pronoteio-signature']", "req.headers['x-pronoteio-session']"],
            // P8: no URL (its query may name a student), no header, no body in the logs.
            serializers: {
                req: (request) => ({ method: request.method, route: request.routeOptions?.url }),
                res: (reply) => ({ status: reply.statusCode }),
            },
            ...(options.logStream ? { stream: options.logStream } : {}),
        },
        // The access log (logs.ts) replaces Fastify's request lines, which carry the URL.
        disableRequestLogging: true,
    });
    // Structured access log without personal data (P8): route pattern, status, code, duration, size.
    app.addHook("onSend", async (request, reply, payload) => {
        if (reply.statusCode >= 400 && typeof payload === "string") {
            try {
                request.errorCode = String(JSON.parse(payload)?.code ?? "");
            }
            catch {
                // Not JSON.
            }
        }
        request.answerBytes = typeof payload === "string" ? Buffer.byteLength(payload) : Buffer.isBuffer(payload) ? payload.length : 0;
        return payload;
    });
    app.addHook("onResponse", async (request, reply) => {
        if (request.internal)
            return;
        const context = currentContext();
        accessLog.write({
            method: request.method,
            route: request.routeOptions.url ?? "(unknown)",
            status: reply.statusCode,
            ...(request.errorCode ? { code: request.errorCode } : {}),
            ms: Math.round(reply.elapsedTime),
            bytes: request.answerBytes ?? 0,
            ...(reply.getHeader("x-cache") ? { cache: String(reply.getHeader("x-cache")) } : {}),
            ...(context ? { calls: context.calls, priority: context.priority } : {}),
            ...(reply.getHeader("x-pronoteio-duplicate") ? { duplicate: true } : {}),
        });
    });
    // Context of each request (priority and deadline in the Pronote queue, P2), reachable from every Pronote call.
    const queueWait = limiterOptions().maxWaitMs;
    app.addHook("onRequest", (request, _reply, done) => {
        const route = request.routeOptions.url ?? request.url.split("?")[0];
        const query = (request.query ?? {});
        // Reads of an asynchronous job (P4): bulk priority, longer wait (nobody waits for the HTTP answer).
        const job = request.headers[INTERNAL_HEADER] === INTERNAL_TOKEN;
        requestContext.run({
            priority: job ? PRIORITY.bulk : priorityOf(request.method, route, query),
            deadline: Date.now() + (job ? Math.max(queueWait, 120_000) : queueWait),
            calls: 0,
            route,
        }, done);
    });
    // Raw body, signature check and replay protection (a read delivered twice while it runs is answered twice).
    registerAuth(app);
    // Short in-memory cache of the reads (P3), after the signature check.
    registerCache(app);
    // Health (P8): /health/public unsigned, /health signed (full report).
    registerHealth(app);
    // Wall-clock times of the write requests ("local" members) replace their timestamps before validation (0.9.0).
    app.addHook("preValidation", async (request) => {
        if (request.body && typeof request.body === "object")
            applyLocalTimes(request.body);
    });
    // Error answers (P7): historical "error", stable "code", French "message"; recorded without personal data (P8).
    app.setErrorHandler((error, request, reply) => {
        const [status, legacy] = toHttp(error);
        const body = errorBody(status, legacy, error instanceof HttpError ? error.extra : {}, request.method, error);
        const route = request.routeOptions.url ?? "";
        // Only the code, the route and the kind of error: never the message of Pronote (it may name a student).
        const summary = { code: body.code, error: legacy.split(":")[0], route, status };
        stateStore.recordError(summary);
        if (status >= 500 && status !== 501) {
            request.log.error({ ...summary, kind: error?.name ?? typeof error }, "request failed");
        }
        if (error instanceof HttpError)
            reply.headers(error.headers);
        reply.status(status).send(body);
    });
    app.setNotFoundHandler((request, reply) => {
        reply.status(404).send(errorBody(404, "not_found", {}, request.method));
    });
    // Table of the stable error codes (P7), read by local_pronoteio; public: it holds no data.
    app.get("/errors", async () => ({ version: SIDECAR_VERSION, codes: ERROR_CODES }));
    // Lost Pronote session (expired, or closed because the account connected elsewhere): reconnect once with the token
    // chain and replay the request once (P5). A write whose write call was already sent is not replayed.
    app.addHook("onRoute", (route) => {
        const handler = route.handler;
        route.handler = async function (request, reply) {
            const entry = sessionEntry(request);
            const generation = entry?.generation ?? 0;
            try {
                return await handler.call(this, request, reply);
            }
            catch (error) {
                const reason = lostSessionReason(error);
                if (!reason)
                    throw error;
                const context = currentContext();
                if (!entry || context?.writeSent || context?.replayed)
                    throw sessionLostError(reason);
                if (!(await reconnect(entry, reason, generation)))
                    throw sessionLostError(reason);
                if (context)
                    context.replayed = true;
                request.log.info({ reason }, "Pronote session reconnected, request replayed");
                return await handler.call(this, request, reply);
            }
        };
    });
    // Pronote version (P6): in the headers of every answer of a session; writes refused on an unvalidated version.
    const NOT_WRITES = new Set(["/session/login", "/session/logout", "/jobs", "/admin/update"]);
    app.addHook("preHandler", async (request) => {
        if (request.method !== "POST" || NOT_WRITES.has(request.routeOptions.url ?? ""))
            return;
        const body = (request.body ?? {});
        if (body.dryRun === true || body.dryrun === true)
            return;
        assertWritable(sessionEntry(request)?.handle);
    });
    app.addHook("onSend", async (request, reply, payload) => {
        const version = pronoteVersion(sessionEntry(request)?.handle);
        if (version !== "") {
            reply.header("x-pronoteio-pronote-version", version);
            reply.header("x-pronoteio-pronote-validated", isValidated(version) ? "true" : "false");
        }
        return payload;
    });
    // Asynchronous jobs of the heavy reads (P4).
    registerJobs(app);
    // Update on demand (P9).
    registerAdmin(app);
    await app.register(sessionRoutes);
    await app.register(timetableRoutes);
    await app.register(homeworkRoutes);
    await app.register(rosterRoutes);
    await app.register(absencesRoutes);
    await app.register(gradesRoutes);
    await app.register(reportsRoutes);
    await app.register(notebookRoutes);
    await app.register(assessmentsRoutes);
    await app.register(filesRoutes);
    await app.register(competenciesRoutes);
    await app.register(messagesRoutes);
    await app.register(resourcesRoutes);
    await app.register(newsRoutes);
    await app.register(listsRoutes);
    await app.register(notificationsRoutes);
    await app.register(meetingsRoutes);
    await app.register(forumRoutes);
    await app.register(studentsRoutes);
    return app;
};
//# sourceMappingURL=app.js.map