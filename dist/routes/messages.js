import { requireSession } from "../session.js";
import * as teacher from "../teacher/index.js";
export default async function messagesRoutes(app) {
    app.get("/messages", {
        schema: {
            querystring: {
                type: "object",
                properties: {
                    folder: { type: "string", enum: ["inbox", "sent", "drafts", "archive", "trash"], default: "inbox" },
                    limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
                },
            },
        },
    }, async (request) => teacher.discussions(requireSession(request), request.query.folder ?? "inbox", request.query.limit ?? 50));
    app.get("/messages/discussion", { schema: { querystring: { type: "object", required: ["id"], properties: { id: { type: "string", minLength: 1 } } } } }, async (request) => teacher.discussion(requireSession(request), request.query.id));
    app.get("/news", { schema: { querystring: { type: "object", properties: { unreadOnly: { type: "boolean", default: false } } } } }, async (request) => teacher.news(requireSession(request), request.query.unreadOnly ?? false));
}
//# sourceMappingURL=messages.js.map