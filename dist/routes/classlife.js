import { HttpError } from "../errors.js";
import { requireSession } from "../session.js";
import { classLife, LIFE_INCLUDES, LIFE_SOURCES, MAX_LIFE_STUDENTS } from "../teacher/classlife.js";
/** Largest range of a school life read (seconds): a school year and its margins. */
export const MAX_LIFE_RANGE = 400 * 24 * 3600;
/** Values of a comma separated parameter, each checked against the allowed ones (400 invalid_<name>:<value>). */
export const parseList = (value, allowed, name) => {
    const parts = (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
    for (const part of parts) {
        if (!allowed.includes(part))
            throw new HttpError(400, `invalid_${name}:${part}`);
    }
    return [...new Set(parts)];
};
export default async function classLifeRoutes(app) {
    // School life of a class or group for the main teacher (0.12.0, not validated): see teacher/classlife.ts.
    app.get("/classlife", {
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
    }, async (request) => {
        const { resource, from, to, include, sources, student, offset, limit } = request.query;
        if (to <= from || to - from > MAX_LIFE_RANGE)
            throw new HttpError(400, "range_too_large");
        return classLife(requireSession(request), resource, from, to, {
            include: parseList(include, LIFE_INCLUDES, "include"),
            sources: parseList(sources, LIFE_SOURCES, "sources"),
            page: { student, offset, limit },
        });
    });
}
//# sourceMappingURL=classlife.js.map