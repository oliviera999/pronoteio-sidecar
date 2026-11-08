import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { HttpError } from "../errors.js";
import { requireSession } from "../session.js";
import * as teacher from "../teacher/index.js";
import type { DistributionListWrite } from "../normalise.js";
import { recipientRefSchema } from "./schemas.js";

type ListBody = DistributionListWrite & { dryRun?: boolean };

export const distributionListBody = {
  type: "object",
  required: ["action"],
  properties: {
    action: { type: "string", enum: ["create", "update", "delete"] },
    id: { type: "string", maxLength: 300 },
    label: { type: "string", maxLength: 200 },
    public: { type: "boolean" },
    members: { type: "array", maxItems: 500, items: recipientRefSchema() },
    dryRun: { type: "boolean", default: false },
  },
} as const;

export default async function listsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/lists", async (request) => teacher.distributionLists(requireSession(request)));

  // Creates, modifies or deletes a distribution list of the account (another author's list: 409 list_not_mine).
  app.post<{ Body: ListBody }>("/lists", { schema: { body: distributionListBody } }, async (request) => {
    const { dryRun = false, ...write } = request.body;
    if (!dryRun && config.writeMode !== "live") throw new HttpError(403, "write_mode_simulate");
    return teacher.writeDistributionList(requireSession(request), write, dryRun);
  });
}
