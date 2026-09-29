import { requireSession } from "../session.js";
import * as teacher from "../teacher/index.js";
import { resourceIntervalQuery } from "./schemas.js";
export default async function absencesRoutes(app) {
    app.get("/absences", { schema: { querystring: resourceIntervalQuery } }, async (request) => {
        const { resource, from, to } = request.query;
        const items = await teacher.absences(requireSession(request), resource, new Date(from * 1000), new Date(to * 1000));
        return { items };
    });
}
//# sourceMappingURL=absences.js.map