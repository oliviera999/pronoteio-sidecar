import { requireSession } from "../session.js";
import * as teacher from "../teacher/index.js";
import { intervalQuery } from "./schemas.js";
/** Comma separated class or group labels of the query. */
export const classesOf = (value) => String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
export const notebookQuery = {
    type: "object",
    required: ["from", "to"],
    properties: {
        ...intervalQuery.properties,
        classes: { type: "string", maxLength: 2000 },
        includeEmpty: { type: "boolean", default: false },
    },
};
export default async function notebookRoutes(app) {
    app.get("/notebook", { schema: { querystring: notebookQuery } }, async (request) => {
        const { from, to, classes, includeEmpty = false } = request.query;
        return teacher.notebook(requireSession(request), new Date(from * 1000), new Date(to * 1000), classesOf(classes), includeEmpty);
    });
}
//# sourceMappingURL=notebook.js.map