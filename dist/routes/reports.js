import { config } from "../config.js";
import { HttpError } from "../errors.js";
import { requireSession } from "../session.js";
import * as teacher from "../teacher/index.js";
import { MAX_REPORTS, REPORT_SOURCES } from "../teacher/reports.js";
import { resourceQuery } from "./schemas.js";
export default async function reportsRoutes(app) {
    app.get("/reports/context", async (request) => teacher.reportContext(requireSession(request)));
    app.get("/reports/comments", {
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
    }, async (request) => {
        const { resource, period, student, offset, limit } = request.query;
        return teacher.reportComments(requireSession(request), resource, period, { student, offset, limit });
    });
    // 0.12.0: results of the class, every subject (ResultatsClasses, not validated).
    app.get("/reports/results", {
        schema: {
            querystring: {
                type: "object",
                required: ["resource", "period"],
                properties: { ...resourceQuery.properties, period: { type: "string", minLength: 1 } },
            },
        },
    }, async (request) => teacher.classResults(requireSession(request), request.query.resource, request.query.period));
    app.get("/reports", {
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
    }, async (request) => {
        const { resource, period, student, offset, limit, source } = request.query;
        // Without page nor source: the whole class at once, as before 0.12.0 (import of the report cards by Moodle).
        if (student === undefined && offset === undefined && limit === undefined && source === undefined) {
            return { items: await teacher.reports(requireSession(request), resource, period) };
        }
        return teacher.reportsPage(requireSession(request), resource, period, { student, offset, limit }, source ?? "reportcard");
    });
    // Not validated on a real server (tabs 25 and 27 closed on the demo profile).
    app.post("/reports/comments", {
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
    }, async (request) => {
        if (!request.body.dryRun && config.writeMode !== "live")
            throw new HttpError(403, "write_mode_simulate");
        return teacher.writeComments(requireSession(request), request.body);
    });
}
//# sourceMappingURL=reports.js.map