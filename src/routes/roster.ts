import type { FastifyInstance } from "fastify";
import { requireSession } from "../session.js";
import * as teacher from "../teacher/index.js";
import { resourceQuery, type ResourceQuery } from "./schemas.js";

export default async function rosterRoutes(app: FastifyInstance): Promise<void> {
  app.get("/resources", async (request) => {
    return { items: await teacher.resources(requireSession(request)) };
  });

  app.get<{ Querystring: ResourceQuery }>("/roster", { schema: { querystring: resourceQuery } }, async (request) => {
    return { items: await teacher.roster(requireSession(request), request.query.resource) };
  });
}
