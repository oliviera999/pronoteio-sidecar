import type { FastifyInstance } from "fastify";
import { requireSession } from "../session.js";
import * as teacher from "../teacher/index.js";
import type { LockerKind } from "../teacher/resources.js";

export default async function resourcesRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { kind?: LockerKind } }>(
    "/locker",
    { schema: { querystring: { type: "object", properties: { kind: { type: "string", enum: ["received", "deposited"], default: "received" } } } } },
    async (request) => teacher.locker(requireSession(request), request.query.kind ?? "received"),
  );

  app.get("/quizzes", async (request) => teacher.quizzes(requireSession(request)));
}
