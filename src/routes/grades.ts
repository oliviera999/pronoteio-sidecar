import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { HttpError } from "../errors.js";
import type { Assessment, Grade } from "../normalise.js";
import { GRADE_STATUS } from "../pronote/encoding.js";
import { requireSession } from "../session.js";
import * as teacher from "../teacher/index.js";

type PushBody = { service: string; period: string; assessment: Assessment; grades: Grade[]; dryRun?: boolean };

export default async function gradesRoutes(app: FastifyInstance): Promise<void> {
  app.get("/grades/context", async (request) => teacher.gradeContext(requireSession(request)));

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
      if (!dryRun && !config.enableGradeWrite) {
        throw new HttpError(403, "grade_write_disabled");
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
}
