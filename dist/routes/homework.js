import { requireSession } from "../session.js";
import * as teacher from "../teacher/index.js";
import { intervalQuery } from "./schemas.js";
/**
 * Homework of the teacher's lessons due in [from, to), in the historical shape used by the Moodle calendar sync.
 * Read through the teacher notebook (Pawnote's student page fails on a teacher account); the lessons scanned are
 * those of the range, so homework given earlier but due in the range is found only when its lesson is in range.
 */
export default async function homeworkRoutes(app) {
    app.get("/homework", { schema: { querystring: intervalQuery } }, async (request) => {
        const session = requireSession(request);
        const { from, to } = request.query;
        const result = await teacher.notebook(session, new Date(from * 1000), new Date(to * 1000), [], false);
        const items = [];
        for (const entry of result.items) {
            for (const homework of entry.homework) {
                items.push({
                    id: homework.id,
                    subject: entry.lesson.subject,
                    description: homework.description,
                    due: homework.due,
                    groups: entry.lesson.groups,
                    attachments: homework.attachments.map((file) => ({ name: file.name, url: file.url ?? "" })),
                });
            }
        }
        return { items, truncated: result.truncated };
    });
}
//# sourceMappingURL=homework.js.map