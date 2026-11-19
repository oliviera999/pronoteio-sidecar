import "./time.js";
import Fastify from "fastify";
import { INTERNAL_HEADER, INTERNAL_TOKEN, PUBLIC_ROUTES, registerAuth, securityStats } from "./auth.js";
import { addressAllowed } from "./address.js";
import { registerJobs } from "./jobs.js";
import { config } from "./config.js";
import { currentContext, PRIORITY, priorityOf, requestContext } from "./context.js";
import { lostSessionReason, reconnect, sessionEntry, sessionLostError, webSessionEntry, webSessionIdOf } from "./session.js";
import { announcesWeb, WebSessionRequired } from "./space.js";
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
/** Contract declared by the client: X-Pronoteio-Contract: 2, or "contract=2" in X-Pronoteio-Client (P12). */
export const clientContract = (request) => {
    const direct = Number.parseInt(String(request.headers["x-pronoteio-contract"] ?? ""), 10);
    if (Number.isFinite(direct))
        return direct;
    const match = /contract=(\d+)/.exec(String(request.headers["x-pronoteio-client"] ?? ""));
    return match ? Number(match[1]) : 1;
};
/** A write that went through and was re-read without difference: verified true (P12). */
const verifiedResult = (request, result) => {
    if (request.method === "POST" && result && typeof result === "object" && !Array.isArray(result)) {
        const body = result;
        if (body.written === true && body.verified === undefined && "after" in body)
            return { ...body, verified: true };
    }
    return result;
};
/** Codes of a write re-read with a difference (thrown by the write modules). */
const NOT_SAVED = /^[a-z_]+_(not_saved|not_deleted|not_applied)(:|$)/;
/**
 * Write re-read with a difference: until 0.8.0 (and for a client of contract 1) a 502 "<x>_not_saved"; for a client of
 * contract 2, a 200 answer with written (a write call was sent), verified: false, the difference and the state read.
 */
const unverifiedResult = (request, error) => {
    if (request.method !== "POST" || !(error instanceof HttpError) || error.status !== 502 || !NOT_SAVED.test(error.code))
        return null;
    if (clientContract(request) < 2)
        return null;
    const context = currentContext();
    return { written: context?.writeSent === true, dryRun: false, verified: false, differences: [error.code], after: error.extra.after ?? null };
};
const routeTables = new WeakMap();
export const routesOf = (app) => routeTables.get(app) ?? [];
export const buildApp = async (options = {}) => {
    const accessLog = options.accessLog ?? defaultAccessLog;
    const app = Fastify({
        bodyLimit: 512 * 1024,
        // Client address behind the web server (X-Forwarded-For), for PRONOTEIO_ALLOWED_IPS (P11).
        trustProxy: config.trustProxy,
        // Request bodies carry passwords and tokens: they are never logged.
        logger: options.logger ?? {
            level: config.logLevel,
            redact: ["req.headers['x-pronoteio-signature']", "req.headers['x-pronoteio-session']", "req.headers['x-pronoteio-web-session']"],
            // P8: no URL (its query may name a student), no header, no body in the logs.
            serializers: {
                req: (request) => ({ method: request.method, route: request.routeOptions?.url }),
                res: (reply) => ({ status: reply.statusCode }),
            },
            ...(options.logStream ? { stream: options.logStream } : {}),
        },
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
    const table = [];
    routeTables.set(app, table);
    app.addHook("onRoute", (route) => {
        for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
            if (method === "HEAD")
                continue;
            const schema = (route.schema ?? {});
            table.push({ method, url: route.url, ...(schema.querystring ? { querystring: schema.querystring } : {}),
                ...(schema.body ? { body: schema.body } : {}), ...(schema.params ? { params: schema.params } : {}) });
        }
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
            // 0.10.0: client able to open a web session (space.ts).
            webCapable: announcesWeb(request.headers),
        }, done);
    });
    // Addresses allowed (P11): the Moodle server only, when PRONOTEIO_ALLOWED_IPS is set.
    app.addHook("onRequest", async (request) => {
        if (config.allowedIps.length === 0 || PUBLIC_ROUTES.has(request.routeOptions.url ?? ""))
            return;
        if (request.headers[INTERNAL_HEADER] === INTERNAL_TOKEN)
            return;
        if (!addressAllowed(request.ip, config.allowedIps)) {
            securityStats.addressRefused++;
            throw new HttpError(403, "address_not_allowed");
        }
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
        // P12: "dryrun" (body or query) is an alias of "dryRun"; a simulation never sends a write call (limiter.ts).
        if (request.method === "POST") {
            const body = (request.body && typeof request.body === "object" ? request.body : null);
            const query = (request.query ?? {});
            const asked = body?.dryrun ?? query.dryrun;
            if (body && asked !== undefined) {
                if (body.dryRun === undefined)
                    body.dryRun = asked === true || asked === "true" || asked === "1";
                delete body.dryrun;
            }
            const context = currentContext();
            if (context && body?.dryRun === true)
                context.dryRun = true;
        }
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
    // 0.10.0: a call needing a tab the mobile session lacks (WebSessionRequired, thrown before it is sent) replays the
    // whole request once on the web session given in X-Pronoteio-Web-Session; without it, 409 web_session_required.
    app.addHook("onRoute", (route) => {
        const handler = route.handler;
        const onWeb = async function (request, reply, error) {
            const context = currentContext();
            if (!context || context.webActive || context.writeSent)
                throw error;
            if (webSessionIdOf(request) === "")
                throw error;
            if (!webSessionEntry(request))
                throw new HttpError(401, "web_session_expired", { onglet: error.onglet, function: error.fn });
            context.webActive = true;
            request.log.info({ onglet: error.onglet }, "tab missing from the mobile session, request replayed on the web session");
            try {
                return verifiedResult(request, await handler.call(this, request, reply));
            }
            catch (replayError) {
                const unverified = unverifiedResult(request, replayError);
                if (unverified)
                    return unverified;
                // The web session has no token chain: Moodle logs in again on web_session_expired (the main session is kept).
                if (lostSessionReason(replayError))
                    throw new HttpError(401, "web_session_expired");
                throw replayError;
            }
        };
        route.handler = async function (request, reply) {
            const entry = sessionEntry(request);
            const generation = entry?.generation ?? 0;
            try {
                return verifiedResult(request, await handler.call(this, request, reply));
            }
            catch (error) {
                if (error instanceof WebSessionRequired)
                    return onWeb.call(this, request, reply, error);
                // P12: a write re-read with a difference ("*_not_saved"): a client of contract 2 gets verified: false.
                const unverified = unverifiedResult(request, error);
                if (unverified)
                    return unverified;
                const reason = lostSessionReason(error);
                if (!reason)
                    throw error;
                const context = currentContext();
                // The web session has no token chain: Moodle logs in again on web_session_expired.
                if (context?.webActive)
                    throw new HttpError(401, "web_session_expired");
                if (!entry || context?.writeSent || context?.replayed)
                    throw sessionLostError(reason);
                if (!(await reconnect(entry, reason, generation)))
                    throw sessionLostError(reason);
                if (context)
                    context.replayed = true;
                request.log.info({ reason }, "Pronote session reconnected, request replayed");
                return verifiedResult(request, await handler.call(this, request, reply));
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