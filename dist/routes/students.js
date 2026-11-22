import { HttpError } from "../errors.js";
import { requireSession } from "../session.js";
import { RESOURCE_KINDS, resourceTimetable } from "../teacher/resourceTimetable.js";
import { INCLUDE_VALUES, MAX_FILES, MAX_IDS, checkStudentFiles, studentFiles, studentFilesByIds } from "../teacher/students.js";
import { HISTORY_SOURCES, MAX_HISTORY_STUDENTS, studentHistory } from "../teacher/history.js";
import { MAX_PHOTOS, studentPhoto, studentPhotos } from "../teacher/photos.js";
import { MAX_PLAN_STUDENTS, studentPlans } from "../teacher/plans.js";
import { MAX_SHAPE_PAGE, PP_GROUPS, ppCheck } from "../teacher/ppcheck.js";
import { epochToWall } from "../time.js";
const filesQuery = {
    type: "object",
    required: ["resource"],
    properties: {
        resource: { type: "string", minLength: 1, maxLength: 200 },
        student: { type: "string", maxLength: 200 },
        include: { type: "string", maxLength: 100 },
        offset: { type: "integer", minimum: 0, maximum: 10000 },
        limit: { type: "integer", minimum: 1, maximum: MAX_FILES },
        // 0.9.0: bulk read of a list of student ids (comma separated), paced by the sidecar, partial results.
        ids: { type: "string", maxLength: MAX_IDS * 60 },
    },
};
const resourceTimetableQuery = {
    type: "object",
    required: ["kind", "name", "from", "to"],
    properties: {
        kind: { type: "string", enum: [...RESOURCE_KINDS] },
        name: { type: "string", maxLength: 200 },
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
        const { resource, student = "", include, offset, limit, ids } = request.query;
        if (ids !== undefined) {
            const list = ids.split(",").map((item) => item.trim()).filter(Boolean);
            if (list.length === 0 || list.length > MAX_IDS)
                throw new HttpError(400, "validation_failed:ids");
            return studentFilesByIds(requireSession(request), resource, parseInclude(include), list);
        }
        return studentFiles(requireSession(request), resource, parseInclude(include), student, { offset, limit });
    });
    // Health check of the student files path: one FicheEleve call, counts only.
    app.get("/students/files/check", { schema: { querystring: { type: "object", required: ["resource"], properties: { resource: { type: "string", minLength: 1, maxLength: 200 } } } } }, async (request) => checkStudentFiles(requireSession(request), request.query.resource));
    // One student at a time: Moodle checks the perimeter and the image rights before asking.
    app.get("/students/photo", {
        schema: {
            querystring: {
                type: "object",
                required: ["resource", "student"],
                properties: {
                    resource: { type: "string", minLength: 1, maxLength: 200 },
                    student: { type: "string", minLength: 3, maxLength: 200 },
                },
            },
        },
    }, async (request) => studentPhoto(requireSession(request), request.query.resource, request.query.student));
    // 0.12.0: photos of a page of students (or of one), never cached nor kept.
    app.get("/students/photos", {
        schema: {
            querystring: {
                type: "object",
                required: ["resource"],
                properties: {
                    resource: { type: "string", minLength: 1, maxLength: 200 },
                    student: { type: "string", minLength: 3, maxLength: 200 },
                    offset: { type: "integer", minimum: 0, maximum: 10000 },
                    limit: { type: "integer", minimum: 1, maximum: MAX_PHOTOS },
                },
            },
        },
    }, async (request) => {
        const { resource, student, offset, limit } = request.query;
        return studentPhotos(requireSession(request), resource, { student, offset, limit });
    });
    // 0.16.0: support plans of a page of students (DetailsPIEleve, not validated). Health data: never cached, nothing of
    // it in a log (teacher/plans.ts).
    app.get("/students/plans", {
        schema: {
            querystring: {
                type: "object",
                required: ["resource"],
                properties: {
                    resource: { type: "string", minLength: 1, maxLength: 200 },
                    student: { type: "string", minLength: 3, maxLength: 200 },
                    offset: { type: "integer", minimum: 0, maximum: 10000 },
                    limit: { type: "integer", minimum: 1, maximum: MAX_PLAN_STUDENTS },
                },
            },
        },
    }, async (request) => {
        const { resource, student, offset, limit } = request.query;
        return studentPlans(requireSession(request), resource, { student, offset, limit });
    });
    // 0.16.0: results of the previous years of a page of students (LivretScolaire, PageSuiviPluriannuel, not validated):
    // see teacher/history.ts.
    app.get("/students/history", {
        schema: {
            querystring: {
                type: "object",
                required: ["resource"],
                properties: {
                    resource: { type: "string", minLength: 1, maxLength: 200 },
                    student: { type: "string", minLength: 3, maxLength: 200 },
                    offset: { type: "integer", minimum: 0, maximum: 10000 },
                    limit: { type: "integer", minimum: 1, maximum: MAX_HISTORY_STUDENTS },
                    sources: { type: "string", maxLength: 40 },
                },
            },
        },
    }, async (request) => {
        const { resource, student, offset, limit, sources } = request.query;
        const asked = (sources ?? "").split(",").map((item) => item.trim()).filter(Boolean);
        for (const source of asked) {
            if (!HISTORY_SOURCES.includes(source))
                throw new HttpError(400, `invalid_sources:${source}`);
        }
        return studentHistory(requireSession(request), resource, { student, offset, limit }, asked);
    });
    // 0.12.0: check of the main teacher view: status and shape of each function, never a value.
    // 0.14.0: "function" asks one function (every request variant) and returns its whole shape by pages; "groups"
    // (core, life, reports, misc) asks some groups of probes only.
    // 0.14.1: a whole check stops starting probes after "budget" seconds and names the first one not run ("next"), to
    // be asked again with "from".
    app.get("/pp/check", {
        schema: {
            querystring: {
                type: "object",
                required: ["resource"],
                properties: {
                    resource: { type: "string", minLength: 1, maxLength: 200 },
                    function: { type: "string", maxLength: 60, pattern: "^[A-Za-z]*$" },
                    groups: { type: "string", maxLength: 60 },
                    shapeoffset: { type: "integer", minimum: 0, maximum: 100000 },
                    shapelimit: { type: "integer", minimum: 1, maximum: MAX_SHAPE_PAGE },
                    from: { type: "string", maxLength: 60, pattern: "^[A-Za-z]*$" },
                    budget: { type: "integer", minimum: 1, maximum: 50 },
                },
            },
        },
    }, async (request) => {
        const { resource, function: fn, groups, shapeoffset, shapelimit, from, budget } = request.query;
        const list = (groups ?? "").split(",").map((item) => item.trim()).filter(Boolean);
        for (const group of list) {
            if (!PP_GROUPS.includes(group))
                throw new HttpError(400, `invalid_groups:${group}`);
        }
        return ppCheck(requireSession(request), resource, { function: fn, groups: list, shapeOffset: shapeoffset, shapeLimit: shapelimit,
            from, ...(budget !== undefined ? { budgetMs: budget * 1000 } : {}) });
    });
    app.get("/timetable/resource", { schema: { querystring: resourceTimetableQuery } }, async (request) => {
        const { kind, name, class: className = "", from, to } = request.query;
        if (to <= from || to - from > 62 * 24 * 3600)
            throw new HttpError(400, "range_too_large");
        return resourceTimetable(requireSession(request), kind, name, epochToWall(from), epochToWall(to), className);
    });
}
//# sourceMappingURL=students.js.map