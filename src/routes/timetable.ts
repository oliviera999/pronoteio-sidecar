import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { HttpError } from "../errors.js";
import * as teacher from "../teacher/index.js";

type LessonChangeBody = { lesson: string; rooms?: string[]; memo?: string; dryRun?: boolean; force?: boolean };

const lessonChangeBody = {
  type: "object",
  required: ["lesson"],
  properties: {
    lesson: { type: "string", minLength: 3, maxLength: 200 },
    rooms: { type: "array", maxItems: 5, items: { type: "string", minLength: 1, maxLength: 100 } },
    memo: { type: "string", maxLength: 2000 },
    dryRun: { type: "boolean", default: false },
    force: { type: "boolean", default: false },
  },
} as const;
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

  app.post<{ Body: LessonChangeBody }>("/timetable/lesson", { schema: { body: lessonChangeBody } }, async (request) => {
    const { lesson, rooms, memo, dryRun = false, force = false } = request.body;
    if (!dryRun && config.writeMode !== "live") throw new HttpError(403, "write_mode_simulate");
    return teacher.changeLesson(requireSession(request), lesson, { rooms, memo, dryRun, force });
  });
}
