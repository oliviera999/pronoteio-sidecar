import type { FastifyInstance } from "fastify";
import { parseTimetable, timetableFromIntervals } from "pawnote";
import { lessonFromPawnote, type Lesson } from "../normalise.js";
import { requireSession } from "../session.js";
import { intervalQuery, type IntervalQuery } from "./schemas.js";

// Pawnote's timetable works on a teacher account (validated with the call sheets); src/teacher/timetable.ts reads
// the same page in the teacher space with the notebook flags and may replace this route later.
export default async function timetableRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: IntervalQuery }>("/timetable", { schema: { querystring: intervalQuery } }, async (request) => {
    const session = requireSession(request);
    const { from, to } = request.query;

    const timetable = await timetableFromIntervals(session, new Date(from * 1000), new Date(to * 1000));
    parseTimetable(session, timetable, {
      withSuperposedCanceledClasses: false,
      withCanceledClasses: true,
      withPlannedClasses: true,
    });

    const items = timetable.classes.map(lessonFromPawnote).filter((lesson): lesson is Lesson => lesson !== null);
    return { items };
  });
}
