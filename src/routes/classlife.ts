import type { FastifyInstance } from "fastify";
import { HttpError } from "../errors.js";
import { requireSession } from "../session.js";
import { classLife, LIFE_INCLUDES, LIFE_SOURCES, MAX_LIFE_STUDENTS, type LifeInclude, type LifeSource } from "../teacher/classlife.js";

type ClassLifeQuery = {
  resource: string;
  from: number;
  to: number;
  include?: string;
  sources?: string;
  student?: string;
  offset?: number;
  limit?: number;
};

/** Largest range of a school life read (seconds): a school year and its margins. */
export const MAX_LIFE_RANGE = 400 * 24 * 3600;

/** Values of a comma separated parameter, each checked against the allowed ones (400 invalid_<name>:<value>). */
export const parseList = <T extends string>(value: string | undefined, allowed: readonly T[], name: string): T[] => {
  const parts = (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  for (const part of parts) {
    if (!(allowed as readonly string[]).includes(part)) throw new HttpError(400, `invalid_${name}:${part}`);
  }
  return [...new Set(parts)] as T[];
};

export default async function classLifeRoutes(app: FastifyInstance): Promise<void> {
  // School life of a class or group for the main teacher (0.12.0, not validated): see teacher/classlife.ts.
  app.get<{ Querystring: ClassLifeQuery }>(
    "/classlife",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["resource", "from", "to"],
          properties: {
            resource: { type: "string", minLength: 1, maxLength: 200 },
            from: { type: "integer", minimum: 0 },
            to: { type: "integer", minimum: 0 },
            include: { type: "string", maxLength: 200 },
            sources: { type: "string", maxLength: 100 },
            student: { type: "string", minLength: 3, maxLength: 200 },
            offset: { type: "integer", minimum: 0, maximum: 10000 },
            limit: { type: "integer", minimum: 1, maximum: MAX_LIFE_STUDENTS },
          },
        },
      },
    },
    async (request) => {
      const { resource, from, to, include, sources, student, offset, limit } = request.query;
      if (to <= from || to - from > MAX_LIFE_RANGE) throw new HttpError(400, "range_too_large");
      return classLife(requireSession(request), resource, from, to, {
        include: parseList<LifeInclude>(include, LIFE_INCLUDES, "include"),
        sources: parseList<LifeSource>(sources, LIFE_SOURCES, "sources"),
        page: { student, offset, limit },
      });
    },
  );
}
