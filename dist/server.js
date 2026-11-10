import Fastify from "fastify";
import { registerAuth } from "./auth.js";
import { assertSecret, config } from "./config.js";
import { toHttp } from "./errors.js";
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
assertSecret();
const app = Fastify({
    bodyLimit: 512 * 1024,
    // Request bodies carry passwords and tokens: they are never logged.
    logger: {
        level: config.logLevel,
        redact: ["req.headers['x-pronoteio-signature']", "req.headers['x-pronoteio-session']"],
    },
});
// Raw body, signature check and replay protection (a read delivered twice while it runs is answered twice).
registerAuth(app);
app.get("/health", async () => ({ ok: true }));
app.setErrorHandler((error, request, reply) => {
    const [status, code] = toHttp(error);
    if (status >= 500 && status !== 501) {
        request.log.error({ err: error }, "request failed");
    }
    reply.status(status).send({ error: code });
});
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
// Under Phusion Passenger (cPanel "Setup Node.js App") the server must listen on the socket given by
// Passenger: its documented way is listen("passenger"), which Fastify's listen() cannot express.
if ("PhusionPassenger" in globalThis) {
    await app.ready();
    app.server.listen("passenger");
}
else {
    await app.listen({ host: config.host, port: config.port });
}
//# sourceMappingURL=server.js.map