import "./time.js";
import Fastify, { type FastifyInstance } from "fastify";
import { INTERNAL_HEADER, INTERNAL_TOKEN, registerAuth } from "./auth.js";
import { registerJobs } from "./jobs.js";
import { config } from "./config.js";
import { currentContext, PRIORITY, priorityOf, requestContext } from "./context.js";
import { lostSessionReason, reconnect, sessionEntry, sessionLostError } from "./session.js";
import { HttpError, toHttp } from "./errors.js";
import { limiterOptions } from "./pronote/limiter.js";
import { applyLocalTimes } from "./localInput.js";
import { registerCache } from "./cache.js";
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


export type AppOptions = {
  /** Fastify logger options; false in the tests. */
  logger?: boolean | Record<string, unknown>;
};

/** Builds the sidecar application (every hook and route), without listening: server.ts listens, the tests inject. */
export const buildApp = async (options: AppOptions = {}): Promise<FastifyInstance> => {
  const app = Fastify({
    bodyLimit: 512 * 1024,
    // Request bodies carry passwords and tokens: they are never logged.
    logger: options.logger ?? {
      level: config.logLevel,
      redact: ["req.headers['x-pronoteio-signature']", "req.headers['x-pronoteio-session']"],
    },
  });

  // Context of each request (priority and deadline in the Pronote queue, P2), reachable from every Pronote call.
  const queueWait = limiterOptions().maxWaitMs;
  app.addHook("onRequest", (request, _reply, done) => {
    const route = request.routeOptions.url ?? request.url.split("?")[0];
    const query = (request.query ?? {}) as Record<string, unknown>;
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

  app.get("/health", async () => ({ ok: true }));

  // Wall-clock times of the write requests ("local" members) replace their timestamps before validation (0.9.0).
  app.addHook("preValidation", async (request) => {
    if (request.body && typeof request.body === "object") applyLocalTimes(request.body);
  });

  app.setErrorHandler((error, request, reply) => {
    const [status, code] = toHttp(error);
    if (status >= 500 && status !== 501) {
      request.log.error({ err: error }, "request failed");
    }
    if (error instanceof HttpError) reply.headers(error.headers);
    reply.status(status).send({ error: code, ...(error instanceof HttpError ? error.extra : {}) });
  });

  // Lost Pronote session (expired, or closed because the account connected elsewhere): reconnect once with the token
  // chain and replay the request once (P5). A write whose write call was already sent is not replayed.
  app.addHook("onRoute", (route) => {
    const handler = route.handler as (this: unknown, ...args: unknown[]) => unknown;
    route.handler = async function (this: unknown, request: any, reply: any) {
      const entry = sessionEntry(request);
      const generation = entry?.generation ?? 0;
      try {
        return await handler.call(this, request, reply);
      } catch (error) {
        const reason = lostSessionReason(error);
        if (!reason) throw error;
        const context = currentContext();
        if (!entry || context?.writeSent || context?.replayed) throw sessionLostError(reason);
        if (!(await reconnect(entry, reason, generation))) throw sessionLostError(reason);
        if (context) context.replayed = true;
        request.log.info({ reason }, "Pronote session reconnected, request replayed");
        return await handler.call(this, request, reply);
      }
    } as typeof route.handler;
  });

  // Asynchronous jobs of the heavy reads (P4).
  registerJobs(app);

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
