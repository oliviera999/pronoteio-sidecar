import { parseTimetable, timetableFromIntervals } from "pawnote";
import { lessonFromPawnote } from "../normalise.js";
import { requireSession } from "../session.js";
import { intervalQuery } from "./schemas.js";
export default async function timetableRoutes(app) {
    app.get("/timetable", { schema: { querystring: intervalQuery } }, async (request) => {
        const session = requireSession(request);
        const { from, to } = request.query;
        const timetable = await timetableFromIntervals(session, new Date(from * 1000), new Date(to * 1000));
        parseTimetable(session, timetable, {
            withSuperposedCanceledClasses: false,
            withCanceledClasses: true,
            withPlannedClasses: true,
        });
        const items = timetable.classes.map(lessonFromPawnote).filter((lesson) => lesson !== null);
        return { items };
    });
}
//# sourceMappingURL=timetable.js.map