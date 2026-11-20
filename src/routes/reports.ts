import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { HttpError } from "../errors.js";
import { requireSession } from "../session.js";
import type { CommentsWrite } from "../teacher/commentsWrite.js";
import * as teacher from "../teacher/index.js";
import { MAX_REPORTS, REPORT_SOURCES, type ReportSource } from "../teacher/reports.js";
import { resourceQuery } from "./schemas.js";

type ReportQuery = { resource: string; period: string };
type ReportPageQuery = ReportQuery & { student?: string; offset?: number; limit?: number; source?: ReportSource };

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

  // 0.12.0: results of the class, every subject (ResultatsClasses, not validated).
  app.get<{ Querystring: ReportQuery }>(
    "/reports/results",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["resource", "period"],
          properties: { ...resourceQuery.properties, period: { type: "string", minLength: 1 } },
        },
      },
    },
    async (request) => teacher.classResults(requireSession(request), request.query.resource, request.query.period),
  );

  app.get<{ Querystring: ReportPageQuery }>(
    "/reports",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["resource", "period"],
          properties: {
            ...resourceQuery.properties,
            period: { type: "string", minLength: 1 },
            // 0.12.0: one student, or a page of the roster; "transcript" reads PageReleve (assessments of each subject).
            student: { type: "string", minLength: 3, maxLength: 200 },
            offset: { type: "integer", minimum: 0, maximum: 10000 },
            limit: { type: "integer", minimum: 1, maximum: MAX_REPORTS },
            source: { type: "string", enum: [...REPORT_SOURCES] },
          },
        },
      },
    },
    async (request) => {
      const { resource, period, student, offset, limit, source } = request.query;
      // Without page nor source: the whole class at once, as before 0.12.0 (import of the report cards by Moodle).
      if (student === undefined && offset === undefined && limit === undefined && source === undefined) {
        return { items: await teacher.reports(requireSession(request), resource, period) };
      }
      return teacher.reportsPage(requireSession(request), resource, period, { student, offset, limit }, source ?? "reportcard");
    },
  );

  // Not validated on a real server (tabs 25 and 27 closed on the demo profile).
  app.post<{ Body: CommentsWrite }>(
    "/reports/comments",
    {
      schema: {
        body: {
          type: "object",
          required: ["class", "period", "items"],
          properties: {
            class: { type: "string", minLength: 1 },
            period: { type: "string", minLength: 1 },
            items: {
              type: "array",
              minItems: 1,
              maxItems: 100,
              items: {
                type: "object",
                required: ["kind", "text"],
                properties: {
                  student: { type: "string", minLength: 1, maxLength: 200 },
                  kind: { type: "string", enum: ["subject", "general"] },
                  text: { type: "string", maxLength: 4000 },
                },
              },
            },
            dryRun: { type: "boolean", default: false },
          },
        },
      },
    },
    async (request) => {
      if (!request.body.dryRun && config.writeMode !== "live") throw new HttpError(403, "write_mode_simulate");
      return teacher.writeComments(requireSession(request), request.body);
    },
  );
}
