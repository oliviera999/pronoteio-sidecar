import { requireSession } from "../session.js";
import * as teacher from "../teacher/index.js";
export default async function forumRoutes(app) {
    // Topics of the pedagogical forum, or the posts of one topic (read only: no topic, moderation or read flag is written).
    app.get("/forum", { schema: { querystring: { type: "object", properties: { topic: { type: "string", maxLength: 300 } } } } }, async (request) => teacher.forum(requireSession(request), request.query.topic || undefined));
}
//# sourceMappingURL=forum.js.map