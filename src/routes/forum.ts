import type { FastifyInstance } from "fastify";
import { requireSession } from "../session.js";
import * as teacher from "../teacher/index.js";

type ForumQuery = { topic?: string };

export default async function forumRoutes(app: FastifyInstance): Promise<void> {
  // Topics of the pedagogical forum, or the posts of one topic (read only: no topic, moderation or read flag is written).
  app.get<{ Querystring: ForumQuery }>(
    "/forum",
    { schema: { querystring: { type: "object", properties: { topic: { type: "string", maxLength: 300 } } } } },
    async (request) => teacher.forum(requireSession(request), request.query.topic || undefined),
  );
}
