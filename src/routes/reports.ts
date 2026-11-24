import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { HttpError } from "../errors.js";
import { requireSession } from "../session.js";
import type { CommentsWrite } from "../teacher/commentsWrite.js";
import type { PositioningWrite } from "../teacher/positioningWrite.js";
import * as teacher from "../teacher/index.js";
import { MAX_REPORTS, REPORT_SOURCES, type ReportSource } from "../teacher/reports.js";
import { resourceQuery } from "./schemas.js";

type ReportQuery = { resource: string; period: string };
type ReportPageQuery = ReportQuery & { student?: string; offset?: number; limit?: number; source?: ReportSource };

export default async function reportsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/reports/context", async (request) => teacher.reportContext(requireSession(request)));

  app.get<{ Querystring: ReportPageQuery }>(
    "/reports/comments",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["resource", "period"],
          properties: {
            ...resourceQuery.properties,
            period: { type: "string", minLength: 1 },
            // 0.14.0: page of students of the general comments read from the report cards (main teacher, no kind).
            student: { type: "string", minLength: 3, maxLength: 200 },
            offset: { type: "integer", minimum: 0, maximum: 10000 },
            limit: { type: "integer", minimum: 1, maximum: MAX_REPORTS },
          },
        },
      },
    },
    async (request) => {
      const { resource, period, student, offset, limit } = request.query;
      return teacher.reportComments(requireSession(request), resource, period, { student, offset, limit });
    },
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
            // 0.14.0: kind of general comment to write when the school has several.
            generalKind: { type: "string", maxLength: 200 },
          },
        },
      },
    },
    async (request) => {
      if (!request.body.dryRun && config.writeMode !== "live") throw new HttpError(403, "write_mode_simulate");
      return teacher.writeComments(requireSession(request), request.body);
    },
  );

  // 0.17.0 (contract N, 6.1 point 1): periods of a class or group (ListePeriodes, tab 25).
  app.get<{ Querystring: { resource: string } }>(
    "/reports/periods",
    { schema: { querystring: { type: "object", required: ["resource"], properties: { ...resourceQuery.properties } } } },
    async (request) => teacher.classPeriods(requireSession(request), request.query.resource),
  );

  // 0.17.0 (contract N, 6.1 point 3): grid of the comments tab (positioning, LSU mark, comment of each student).
  app.get<{ Querystring: { resource: string; period: string; service?: string } }>(
    "/reports/grid",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["resource", "period"],
          properties: {
            ...resourceQuery.properties,
            period: { type: "string", minLength: 1, maxLength: 200 },
            service: { type: "string", maxLength: 300, default: "" },
          },
        },
      },
    },
    async (request) => teacher.reportGrid(requireSession(request), request.query.resource, request.query.period, request.query.service ?? ""),
  );

  // 0.17.0 (contract N, 6.1 point 4): positioning and LSU mark (SaisiePositionnement, SaisieNoteLSU, tab 25).
  app.post<{ Body: PositioningWrite }>(
    "/reports/positioning",
    {
      schema: {
        body: {
          type: "object",
          required: ["resource", "period", "service", "items"],
          properties: {
            resource: { type: "string", minLength: 1, maxLength: 300 },
            period: { type: "string", minLength: 1, maxLength: 200 },
            service: { type: "string", minLength: 1, maxLength: 300 },
            items: {
              type: "array",
              minItems: 1,
              maxItems: 100,
              items: {
                type: "object",
                required: ["student", "kind", "value"],
                properties: {
                  student: { type: "string", minLength: 1, maxLength: 200 },
                  kind: { type: "string", enum: ["positioning", "lsu"] },
                  // Genre of the level (integer) or null for "positioning", "15,00" or "" for "lsu": checked by
                  // positioningWrite.ts (a union type here would let the coercion of Fastify turn null into 0).
                  value: { description: "positioning: genre du niveau (entier) ou null ; lsu: \"15,00\" (0,00 à 100,00) ou \"\"" },
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
      return teacher.writePositioning(requireSession(request), request.body);
    },
  );
}
