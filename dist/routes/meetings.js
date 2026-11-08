import { config } from "../config.js";
import { HttpError } from "../errors.js";
import { requireSession } from "../session.js";
import * as teacher from "../teacher/index.js";
export const meetingWishesBody = {
    type: "object",
    required: ["session"],
    properties: {
        session: { type: "string", minLength: 1, maxLength: 300 },
        wishes: {
            type: "array",
            maxItems: 200,
            items: {
                type: "object",
                required: ["id"],
                properties: {
                    id: { type: "string", pattern: "^w[0-9]+$" },
                    duration: { type: ["integer", "null"], minimum: 0, maximum: 1440 },
                    wish: { type: ["integer", "null"], minimum: 0 },
                },
            },
        },
        unavailability: { type: ["array", "null"], maxItems: 500, items: { type: "integer", minimum: 0 } },
        dryRun: { type: "boolean", default: false },
    },
};
export default async function meetingsRoutes(app) {
    app.get("/meetings", async (request) => teacher.meetings(requireSession(request)));
    // Appointments (RDV), read only: no request, proposal or cancellation is ever sent.
    app.get("/meetings/appointments", async (request) => teacher.appointments(requireSession(request)));
    // Wishes and unavailability of the teacher for a session, during the entry period only.
    app.post("/meetings/wishes", { schema: { body: meetingWishesBody } }, async (request) => {
        const { session, dryRun = false, ...write } = request.body;
        if (!dryRun && config.writeMode !== "live")
            throw new HttpError(403, "write_mode_simulate");
        return teacher.writeMeetingWishes(requireSession(request), session, write, dryRun);
    });
}
//# sourceMappingURL=meetings.js.map