import { config } from "../config.js";
import { HttpError } from "../errors.js";
import { requireSession } from "../session.js";
import * as teacher from "../teacher/index.js";
import { classesOf } from "./notebook.js";
export const periodClassesQuery = {
    type: "object",
    properties: { period: { type: "string", maxLength: 200, default: "" }, classes: { type: "string", maxLength: 2000 } },
};
export default async function competenciesRoutes(app) {
    app.get("/competencies", { schema: { querystring: periodClassesQuery } }, async (request) => teacher.competencyOverview(requireSession(request), request.query.period ?? "", classesOf(request.query.classes)));
    // Not validated on a real server (skills tabs closed on the demo profile).
    app.post("/competencies", {
        schema: {
            body: {
                type: "object",
                required: ["service", "period"],
                properties: {
                    assessment: { type: ["string", "null"], maxLength: 300 },
                    service: { type: "string", minLength: 1 },
                    period: { type: "string", minLength: 1 },
                    title: { type: "string", maxLength: 255 },
                    date: { type: "integer", minimum: 0 },
                    publication: { type: ["integer", "null"], minimum: 0 },
                    description: { type: "string", maxLength: 10000 },
                    coefficient: { type: "number", minimum: 0, maximum: 100 },
                    skills: { type: "array", maxItems: 50, items: { type: "string", minLength: 1, maxLength: 300 } },
                    ratings: {
                        type: "array",
                        maxItems: 500,
                        items: {
                            type: "object",
                            required: ["student", "skill", "level"],
                            properties: {
                                student: { type: "string", minLength: 1, maxLength: 200 },
                                skill: { type: "string", minLength: 1, maxLength: 300 },
                                level: { type: "integer", minimum: 0, maximum: 100 },
                                observation: { type: "string", maxLength: 1000 },
                                published: { type: "boolean" },
                            },
                        },
                    },
                    delete: { type: "boolean", default: false },
                    dryRun: { type: "boolean", default: false },
                    force: { type: "boolean", default: false },
                },
            },
        },
    }, async (request) => {
        if (!request.body.dryRun && config.writeMode !== "live")
            throw new HttpError(403, "write_mode_simulate");
        return teacher.writeCompetency(requireSession(request), { ...request.body, assessment: request.body.assessment ?? null });
    });
}
//# sourceMappingURL=competencies.js.map