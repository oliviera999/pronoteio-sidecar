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
}
//# sourceMappingURL=reports.js.map