import { requireSession } from "../session.js";
import * as teacher from "../teacher/index.js";
import { classesOf } from "./notebook.js";
import { intervalQuery } from "./schemas.js";
import { epochToWall } from "../time.js";
const assessmentsQuery = {
    type: "object",
    required: ["from", "to"],
    properties: { ...intervalQuery.properties, classes: { type: "string", maxLength: 2000 } },
};
export default async function assessmentsRoutes(app) {
    app.get("/assessments", { schema: { querystring: assessmentsQuery } }, async (request) => {
        const { from, to, classes } = request.query;
        return teacher.assessments(requireSession(request), epochToWall(from), epochToWall(to), classesOf(classes));
    });
}
//# sourceMappingURL=assessments.js.map