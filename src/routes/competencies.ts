import type { FastifyInstance } from "fastify";
import { requireSession } from "../session.js";
import * as teacher from "../teacher/index.js";
import { classesOf } from "./notebook.js";

type PeriodQuery = { period?: string; classes?: string };

export const periodClassesQuery = {
  type: "object",
  properties: { period: { type: "string", maxLength: 200, default: "" }, classes: { type: "string", maxLength: 2000 } },
} as const;

export default async function competenciesRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: PeriodQuery }>("/competencies", { schema: { querystring: periodClassesQuery } }, async (request) =>
    teacher.competencyOverview(requireSession(request), request.query.period ?? "", classesOf(request.query.classes)),
  );
}
