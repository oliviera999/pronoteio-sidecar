import { requireSession } from "../session.js";
import * as teacher from "../teacher/index.js";
export default async function resourcesRoutes(app) {
    app.get("/locker", { schema: { querystring: { type: "object", properties: { kind: { type: "string", enum: ["received", "deposited"], default: "received" } } } } }, async (request) => teacher.locker(requireSession(request), request.query.kind ?? "received"));
    app.get("/quizzes", async (request) => teacher.quizzes(requireSession(request)));
}
//# sourceMappingURL=resources.js.map