import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { HttpError } from "../errors.js";
import type { Assessment, Grade } from "../normalise.js";
import { GRADE_STATUS } from "../pronote/encoding.js";
import { requireSession } from "../session.js";
import * as teacher from "../teacher/index.js";
import { periodClassesQuery } from "./competencies.js";
import { classesOf } from "./notebook.js";

type PushBody = { service: string; period: string; assessment: Assessment & { delete?: boolean }; grades: Grade[]; dryRun?: boolean };

type CommentBody = {
  service: string;
  period: string;
  assessment: string;
  student: string;
  value?: number | null;
  status?: Grade["status"];
  comment: string;
  dryRun?: boolean;
};

export default async function gradesRoutes(app: FastifyInstance): Promise<void> {
  app.get("/grades/context", async (request) => teacher.gradeContext(requireSession(request)));

  app.get<{ Querystring: { period?: string; classes?: string } }>(
    "/grades/overview",
    { schema: { querystring: periodClassesQuery } },
    async (request) => teacher.gradeOverview(requireSession(request), request.query.period ?? "", classesOf(request.query.classes)),
  );

  app.post<{ Body: PushBody }>(
    "/grades",
    {
      schema: {
        body: {
          type: "object",
          required: ["service", "period", "assessment", "grades"],
          properties: {
            service: { type: "string", minLength: 1 },
            period: { type: "string", minLength: 1 },
            dryRun: { type: "boolean" },
            assessment: {
              type: "object",
              required: ["title", "date", "max", "coefficient"],
              properties: {
                id: { type: ["string", "null"] },
                title: { type: "string", minLength: 1, maxLength: 255 },
                date: { type: "integer", minimum: 0 },
                publication: { type: ["integer", "null"], minimum: 0 },
                max: { type: "number", exclusiveMinimum: 0, maximum: 1000 },
                coefficient: { type: "number", minimum: 0, maximum: 100 },
                scaleTo20: { type: "boolean", default: false },
                optional: { type: "boolean", default: false },
                bonus: { type: "boolean", default: false },
                comment: { type: "string", maxLength: 1000, default: "" },
                /** Deletes the existing assessment (id required) with its grades: no undo. */
                delete: { type: "boolean", default: false },
              },
            },
            grades: {
              type: "array",
              maxItems: 500,
              items: {
                type: "object",
                required: ["studentid"],
                properties: {
                  studentid: { type: "string", minLength: 1 },
                  value: { type: ["number", "null"], default: null },
                  status: { type: "string", enum: ["", ...Object.keys(GRADE_STATUS)], default: "" },
                },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const { service, period, assessment, grades, dryRun = false } = request.body;
      if (!dryRun && config.writeMode !== "live") {
        throw new HttpError(403, "write_mode_simulate");
      }
      if (assessment.delete) {
        if (!assessment.id) throw new HttpError(400, "delete_without_id");
        return teacher.removeAssessment(requireSession(request), service, period, assessment.id, dryRun);
      }
      return teacher.pushGrades(
        requireSession(request),
        service,
        period,
        { ...assessment, id: assessment.id ?? null, publication: assessment.publication ?? null },
        grades,
        dryRun,
      );
    },
  );

  app.post<{ Body: CommentBody }>(
    "/grades/comment",
    {
      schema: {
        body: {
          type: "object",
          required: ["service", "period", "assessment", "student", "comment"],
          properties: {
            service: { type: "string", minLength: 1 },
            period: { type: "string", minLength: 1 },
            assessment: { type: "string", minLength: 1 },
            student: { type: "string", minLength: 1, maxLength: 200 },
            value: { type: ["number", "null"] },
            status: { type: "string", enum: ["", ...Object.keys(GRADE_STATUS)] },
            comment: { type: "string", maxLength: 1000 },
            dryRun: { type: "boolean", default: false },
          },
        },
      },
    },
    async (request) => {
      const { service, period, assessment, student, value, status, comment, dryRun = false } = request.body;
      if (!dryRun && config.writeMode !== "live") throw new HttpError(403, "write_mode_simulate");
      return teacher.writeGradeComment(requireSession(request), service, period, assessment, { student, value, status, comment, dryRun });
    },
  );
}
