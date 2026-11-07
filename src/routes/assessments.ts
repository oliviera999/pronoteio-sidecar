import type { FastifyInstance } from "fastify";
import { requireSession } from "../session.js";
import * as teacher from "../teacher/index.js";
import { classesOf, type NotebookQuery } from "./notebook.js";
import { intervalQuery } from "./schemas.js";

const assessmentsQuery = {
  type: "object",
  required: ["from", "to"],
  properties: { ...intervalQuery.properties, classes: { type: "string", maxLength: 2000 } },
} as const;

export default async function assessmentsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: NotebookQuery }>("/assessments", { schema: { querystring: assessmentsQuery } }, async (request) => {
    const { from, to, classes } = request.query;
    return teacher.assessments(requireSession(request), new Date(from * 1000), new Date(to * 1000), classesOf(classes));
  });
}
