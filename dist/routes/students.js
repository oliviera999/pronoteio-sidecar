import { HttpError } from "../errors.js";
import { requireSession } from "../session.js";
import { RESOURCE_KINDS, resourceTimetable } from "../teacher/resourceTimetable.js";
import { INCLUDE_VALUES, studentFiles } from "../teacher/students.js";
const filesQuery = {
    type: "object",
    required: ["resource"],
    properties: {
        resource: { type: "string", minLength: 1, maxLength: 200 },
        student: { type: "string", maxLength: 200 },
        include: { type: "string", maxLength: 100 },
    },
};
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
};
/** Parts requested with include=imagerights,guardians,... (unknown parts refused). */
export const parseInclude = (value) => {
    const parts = (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
    for (const part of parts) {
        if (!INCLUDE_VALUES.includes(part))
            throw new HttpError(400, `invalid_include:${part}`);
    }
    return [...new Set(parts)];
};
export default async function studentsRoutes(app) {
    app.get("/students/files", { schema: { querystring: filesQuery } }, async (request) => {
        const { resource, student = "", include } = request.query;
        return studentFiles(requireSession(request), resource, parseInclude(include), student);
    });
    app.get("/timetable/resource", { schema: { querystring: resourceTimetableQuery } }, async (request) => {
        const { kind, name, class: className = "", from, to } = request.query;
        if (to <= from || to - from > 62 * 24 * 3600)
            throw new HttpError(400, "range_too_large");
        return resourceTimetable(requireSession(request), kind, name, new Date(from * 1000), new Date(to * 1000), className);
    });
}
//# sourceMappingURL=students.js.map