import { requireSession } from "../session.js";
import * as teacher from "../teacher/index.js";
import { classesOf } from "./notebook.js";
export const periodClassesQuery = {
    type: "object",
    properties: { period: { type: "string", maxLength: 200, default: "" }, classes: { type: "string", maxLength: 2000 } },
};
export default async function competenciesRoutes(app) {
    app.get("/competencies", { schema: { querystring: periodClassesQuery } }, async (request) => teacher.competencyOverview(requireSession(request), request.query.period ?? "", classesOf(request.query.classes)));
}
//# sourceMappingURL=competencies.js.map