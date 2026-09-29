import { requireSession } from "../session.js";
import * as teacher from "../teacher/index.js";
import { resourceQuery } from "./schemas.js";
export default async function rosterRoutes(app) {
    app.get("/resources", async (request) => {
        return { items: await teacher.resources(requireSession(request)) };
    });
    app.get("/roster", { schema: { querystring: resourceQuery } }, async (request) => {
        return { items: await teacher.roster(requireSession(request), request.query.resource) };
    });
}
//# sourceMappingURL=roster.js.map