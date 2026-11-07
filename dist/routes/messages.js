import { config } from "../config.js";
import { HttpError } from "../errors.js";
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
    // Sends a message or a reply: irreversible. Never forwards, reports nor deletes.
    app.post("/messages", {
        schema: {
            body: {
                type: "object",
                required: ["mode", "text"],
                properties: {
                    mode: { type: "string", enum: ["new", "reply"] },
                    subject: { type: "string", maxLength: 255 },
                    text: { type: "string", minLength: 1, maxLength: 20000 },
                    recipients: {
                        type: "array",
                        maxItems: 100,
                        items: {
                            type: "object",
                            required: ["kind", "label"],
                            properties: {
                                kind: { type: "string", enum: ["class", "teacher", "student", "parent", "staff"] },
                                label: { type: "string", minLength: 1, maxLength: 200 },
                            },
                        },
                    },
                    discussion: { type: "string", maxLength: 300 },
                    dryRun: { type: "boolean", default: false },
                },
            },
        },
    }, async (request) => {
        if (!request.body.dryRun && config.writeMode !== "live")
            throw new HttpError(403, "write_mode_simulate");
        return teacher.sendMessage(requireSession(request), request.body);
    });
}
//# sourceMappingURL=messages.js.map