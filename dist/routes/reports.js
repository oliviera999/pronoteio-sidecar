import { config } from "../config.js";
import { HttpError } from "../errors.js";
import { requireSession } from "../session.js";
import * as teacher from "../teacher/index.js";
import { resourceQuery } from "./schemas.js";
export default async function reportsRoutes(app) {
    app.get("/reports/context", async (request) => teacher.reportContext(requireSession(request)));
    app.get("/reports/comments", {
        schema: {
            querystring: {
                type: "object",
                required: ["resource", "period"],
                properties: { ...resourceQuery.properties, period: { type: "string", minLength: 1 } },
            },
        },
    }, async (request) => teacher.reportComments(requireSession(request), request.query.resource, request.query.period));
    app.get("/reports", {
        schema: {
            querystring: {
                type: "object",
                required: ["resource", "period"],
                properties: { ...resourceQuery.properties, period: { type: "string", minLength: 1 } },
            },
        },
    }, async (request) => {
        const { resource, period } = request.query;
        return { items: await teacher.reports(requireSession(request), resource, period) };
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