import type { FastifyInstance } from "fastify";
import { requireSession } from "../session.js";
import * as teacher from "../teacher/index.js";
import { resourceQuery } from "./schemas.js";

type ReportQuery = { resource: string; period: string };

export default async function reportsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/reports/context", async (request) => teacher.reportContext(requireSession(request)));

  app.get<{ Querystring: ReportQuery }>(
    "/reports/comments",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["resource", "period"],
          properties: { ...resourceQuery.properties, period: { type: "string", minLength: 1 } },
        },
      },
    },
    async (request) => teacher.reportComments(requireSession(request), request.query.resource, request.query.period),
  );

  app.get<{ Querystring: ReportQuery }>(
    "/reports",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["resource", "period"],
          properties: { ...resourceQuery.properties, period: { type: "string", minLength: 1 } },
        },
      },
    },
    async (request) => {
      const { resource, period } = request.query;
      return { items: await teacher.reports(requireSession(request), resource, period) };
    },
  );
}
