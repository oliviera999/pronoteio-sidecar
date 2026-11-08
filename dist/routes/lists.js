import { config } from "../config.js";
import { HttpError } from "../errors.js";
import { requireSession } from "../session.js";
import * as teacher from "../teacher/index.js";
import { recipientRefSchema } from "./schemas.js";
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
};
export default async function listsRoutes(app) {
    app.get("/lists", async (request) => teacher.distributionLists(requireSession(request)));
    // Creates, modifies or deletes a distribution list of the account (another author's list: 409 list_not_mine).
    app.post("/lists", { schema: { body: distributionListBody } }, async (request) => {
        const { dryRun = false, ...write } = request.body;
        if (!dryRun && config.writeMode !== "live")
            throw new HttpError(403, "write_mode_simulate");
        return teacher.writeDistributionList(requireSession(request), write, dryRun);
    });
}
//# sourceMappingURL=lists.js.map