import Fastify from "fastify";
import { verifySignature } from "./auth.js";
import { assertSecret, config } from "./config.js";
import { toHttp } from "./errors.js";
import absencesRoutes from "./routes/absences.js";
import assessmentsRoutes from "./routes/assessments.js";
import filesRoutes from "./routes/files.js";
import gradesRoutes from "./routes/grades.js";
import homeworkRoutes from "./routes/homework.js";
import notebookRoutes from "./routes/notebook.js";
import reportsRoutes from "./routes/reports.js";
import rosterRoutes from "./routes/roster.js";
import sessionRoutes from "./routes/session.js";
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

// Keep the raw body: the HMAC signature covers the exact bytes sent by Moodle.
app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
  request.rawBody = body as string;
  try {
    done(null, body === "" ? {} : JSON.parse(body as string));
  } catch {
    done(Object.assign(new Error("invalid_json"), { statusCode: 400 }), undefined);
  }
});

app.get("/health", async () => ({ ok: true }));

// Before schema validation, so that unsigned requests learn nothing about the API.
app.addHook("preValidation", async (request) => {
  if (request.routeOptions.url === "/health") return;
  verifySignature(request);
});

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

// Under Phusion Passenger (cPanel "Setup Node.js App") the server must listen on the socket given by
// Passenger: its documented way is listen("passenger"), which Fastify's listen() cannot express.
if ("PhusionPassenger" in globalThis) {
  await app.ready();
  app.server.listen("passenger");
} else {
  await app.listen({ host: config.host, port: config.port });
}
