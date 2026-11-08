import { config } from "../config.js";
import { HttpError } from "../errors.js";
import { requireSession } from "../session.js";
import * as teacher from "../teacher/index.js";
import { intervalQuery } from "./schemas.js";
const attachmentSchema = {
    type: "object",
    required: ["name"],
    properties: {
        name: { type: "string", maxLength: 255 },
        fileId: { type: "string", maxLength: 100 },
        url: { type: "string", maxLength: 2000 },
    },
};
export const notebookWriteBody = {
    type: "object",
    required: ["lesson", "entry"],
    properties: {
        lesson: { type: "string", minLength: 3, maxLength: 200 },
        dryRun: { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        entry: {
            type: "object",
            properties: {
                published: { type: "boolean" },
                publication: { type: ["integer", "null"], minimum: 0 },
                noteForNext: { type: "string", maxLength: 4000 },
                privateComment: { type: "string", maxLength: 4000 },
                contents: {
                    type: "array",
                    maxItems: 20,
                    items: {
                        type: "object",
                        required: ["title", "description", "category"],
                        properties: {
                            id: { type: ["string", "null"], maxLength: 300 },
                            title: { type: "string", maxLength: 500 },
                            description: { type: "string", maxLength: 50000 },
                            objectives: { type: "string", maxLength: 10000 },
                            category: { anyOf: [{ type: "string", maxLength: 100 }, { type: "object", required: ["kind"], properties: { kind: { type: "integer" } } }] },
                            attachments: { type: "array", maxItems: 20, items: attachmentSchema },
                            delete: { type: "boolean" },
                            assessment: {
                                type: "object",
                                required: ["kind"],
                                properties: {
                                    kind: { type: "string", enum: ["written_test", "skills"] },
                                    createGraded: {
                                        type: "object",
                                        required: ["service", "period", "coefficient", "max"],
                                        properties: {
                                            service: { type: "string", minLength: 1 },
                                            period: { type: "string", minLength: 1 },
                                            coefficient: { type: "number", minimum: 0, maximum: 100 },
                                            max: { type: "number", exclusiveMinimum: 0, maximum: 1000 },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
                homework: {
                    type: "array",
                    maxItems: 20,
                    items: {
                        type: "object",
                        required: ["description", "due"],
                        properties: {
                            id: { type: ["string", "null"], maxLength: 300 },
                            description: { type: "string", maxLength: 50000 },
                            due: { type: "integer", minimum: 0 },
                            minutes: { type: ["integer", "null"], minimum: 0, maximum: 1440 },
                            difficulty: { type: "integer", minimum: 0, maximum: 3 },
                            returnKind: { type: "integer", minimum: 0, maximum: 4 },
                            forAll: { type: "boolean" },
                            students: { type: "array", maxItems: 60, items: { type: "string", maxLength: 200 } },
                            attachments: { type: "array", maxItems: 20, items: attachmentSchema },
                            delete: { type: "boolean" },
                        },
                    },
                },
            },
        },
    },
};
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
    app.post("/notebook", { schema: { body: notebookWriteBody } }, async (request) => {
        const { lesson, entry, dryRun = false, force = false } = request.body;
        if (!dryRun && config.writeMode !== "live")
            throw new HttpError(403, "write_mode_simulate");
        return teacher.writeNotebook(requireSession(request), lesson, entry, { dryRun, force });
    });
}
//# sourceMappingURL=notebook.js.map