import { config } from "../config.js";
import { HttpError } from "../errors.js";
import { requireSession } from "../session.js";
import * as teacher from "../teacher/index.js";
import { resourceIntervalQuery } from "./schemas.js";
export default async function absencesRoutes(app) {
    app.get("/absences", { schema: { querystring: resourceIntervalQuery } }, async (request) => {
        const { resource, from, to } = request.query;
        const items = await teacher.absences(requireSession(request), resource, new Date(from * 1000), new Date(to * 1000));
        return { items };
    });
    // Call sheet of one lesson: absences and late arrivals, visible to families at once. Not validated on a real server.
    app.post("/absences", {
        schema: {
            body: {
                type: "object",
                required: ["lesson", "items"],
                properties: {
                    lesson: { type: "string", minLength: 3, maxLength: 200 },
                    items: {
                        type: "array",
                        maxItems: 100,
                        items: {
                            type: "object",
                            required: ["student", "kind"],
                            properties: {
                                student: { type: "string", minLength: 1, maxLength: 200 },
                                kind: { type: "string", enum: ["absence", "late"] },
                                minutes: { type: "integer", minimum: 1, maximum: 600 },
                                delete: { type: "boolean", default: false },
                            },
                        },
                    },
                    done: { type: "boolean" },
                    dryRun: { type: "boolean", default: false },
                    force: { type: "boolean", default: false },
                },
            },
        },
    }, async (request) => {
        const { lesson, ...write } = request.body;
        if (!write.dryRun && config.writeMode !== "live")
            throw new HttpError(403, "write_mode_simulate");
        return teacher.writeAttendance(requireSession(request), lesson, write);
    });
}
//# sourceMappingURL=absences.js.map