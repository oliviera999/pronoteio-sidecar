import type { FastifyInstance } from "fastify";
import { HttpError } from "../errors.js";
import { requireSession } from "../session.js";
import { RESOURCE_KINDS, resourceTimetable, type ResourceKind } from "../teacher/resourceTimetable.js";
import { INCLUDE_VALUES, studentFiles, type Include } from "../teacher/students.js";

type FilesQuery = { resource: string; student?: string; include?: string };
type ResourceTimetableQuery = { kind: ResourceKind; name: string; class?: string; from: number; to: number };

const filesQuery = {
  type: "object",
  required: ["resource"],
  properties: {
    resource: { type: "string", minLength: 1, maxLength: 200 },
    student: { type: "string", maxLength: 200 },
    include: { type: "string", maxLength: 100 },
  },
} as const;

const resourceTimetableQuery = {
  type: "object",
  required: ["kind", "name", "from", "to"],
  properties: {
    kind: { type: "string", enum: [...RESOURCE_KINDS] },
    name: { type: "string", minLength: 1, maxLength: 200 },
    class: { type: "string", maxLength: 100 },
    from: { type: "integer", minimum: 0 },
    to: { type: "integer", minimum: 0 },
  },
} as const;

/** Parts requested with include=imagerights,guardians,... (unknown parts refused). */
export const parseInclude = (value: string | undefined): Include[] => {
  const parts = (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  for (const part of parts) {
    if (!(INCLUDE_VALUES as readonly string[]).includes(part)) throw new HttpError(400, `invalid_include:${part}`);
  }
  return [...new Set(parts)] as Include[];
};

export default async function studentsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: FilesQuery }>("/students/files", { schema: { querystring: filesQuery } }, async (request) => {
    const { resource, student = "", include } = request.query;
    return studentFiles(requireSession(request), resource, parseInclude(include), student);
  });

  app.get<{ Querystring: ResourceTimetableQuery }>(
    "/timetable/resource",
    { schema: { querystring: resourceTimetableQuery } },
    async (request) => {
      const { kind, name, class: className = "", from, to } = request.query;
      if (to <= from || to - from > 62 * 24 * 3600) throw new HttpError(400, "range_too_large");
      return resourceTimetable(requireSession(request), kind, name, new Date(from * 1000), new Date(to * 1000), className);
    },
  );
}
