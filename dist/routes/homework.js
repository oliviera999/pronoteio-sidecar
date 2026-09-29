import { assignmentsFromIntervals } from "pawnote";
import { homeworkFromPawnote } from "../normalise.js";
import { requireSession } from "../session.js";
import { intervalQuery } from "./schemas.js";
export default async function homeworkRoutes(app) {
    app.get("/homework", { schema: { querystring: intervalQuery } }, async (request) => {
        const session = requireSession(request);
        const { from, to } = request.query;
        // TODO: validate on a teacher account; the teacher "Cahier de textes" page may differ from the
        // student "Travail à faire" page used by Pawnote, in which case move this call to src/teacher/.
        const assignments = await assignmentsFromIntervals(session, new Date(from * 1000), new Date(to * 1000));
        return { items: assignments.map(homeworkFromPawnote) };
    });
}
//# sourceMappingURL=homework.js.map