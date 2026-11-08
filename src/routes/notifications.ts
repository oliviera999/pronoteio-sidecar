import type { FastifyInstance } from "fastify";
import { requireSession } from "../session.js";
import * as teacher from "../teacher/index.js";

export default async function notificationsRoutes(app: FastifyInstance): Promise<void> {
  // Notification centre (home tab), read only: nothing is marked as read or closed.
  app.get("/notifications", async (request) => teacher.notifications(requireSession(request)));
}
