import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { HttpError } from "../errors.js";
import { requireSession } from "../session.js";
import * as teacher from "../teacher/index.js";
import type { DiscussionFolder, MailboxAction, MessageWrite, RecipientKind } from "../normalise.js";
import { attachmentSchema, RECIPIENT_KIND_VALUES, recipientRefSchema } from "./schemas.js";

type ListQuery = { folder?: DiscussionFolder; limit?: number };
type DiscussionQuery = { id: string };
type RecipientsQuery = { kinds?: string; query?: string; class?: string; student?: string; limit?: number };
type MailboxBody = { action: MailboxAction; discussions: string[]; dryRun?: boolean };

/** Comma separated recipient kinds of the query (unknown words are refused). */
export const kindsOf = (value: string | undefined): RecipientKind[] => {
  const kinds = String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  for (const kind of kinds) {
    if (!(RECIPIENT_KIND_VALUES as readonly string[]).includes(kind)) throw new HttpError(400, "invalid_request");
  }
  return kinds as RecipientKind[];
};

export const messageWriteBody = {
  type: "object",
  required: ["mode"],
  properties: {
    mode: { type: "string", enum: ["new", "reply", "draft", "draft_update", "draft_delete"] },
    subject: { type: "string", maxLength: 255 },
    text: { type: "string", maxLength: 20000 },
    recipients: { type: "array", maxItems: 100, items: recipientRefSchema([...RECIPIENT_KIND_VALUES, "list"]) },
    discussion: { type: "string", maxLength: 300 },
    attachments: { type: "array", maxItems: 20, items: attachmentSchema },
    dryRun: { type: "boolean", default: false },
  },
} as const;

export default async function messagesRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: ListQuery }>(
    "/messages",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            folder: { type: "string", enum: ["inbox", "sent", "drafts", "archive", "trash"], default: "inbox" },
            limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
          },
        },
      },
    },
    async (request) => teacher.discussions(requireSession(request), request.query.folder ?? "inbox", request.query.limit ?? 50),
  );

  app.get<{ Querystring: DiscussionQuery }>(
    "/messages/discussion",
    { schema: { querystring: { type: "object", required: ["id"], properties: { id: { type: "string", minLength: 1 } } } } },
    async (request) => teacher.discussion(requireSession(request), request.query.id),
  );

  // Possible recipients, minimised (label, nature, classes, children of a parent): no Pronote id leaves.
  app.get<{ Querystring: RecipientsQuery }>(
    "/messages/recipients",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            kinds: { type: "string", maxLength: 100 },
            query: { type: "string", maxLength: 200 },
            class: { type: "string", maxLength: 100 },
            student: { type: "string", maxLength: 200 },
            limit: { type: "integer", minimum: 1, maximum: 500, default: 200 },
          },
        },
      },
    },
    async (request) => {
      const { kinds, query, class: className, student, limit } = request.query;
      return teacher.recipients(requireSession(request), kindsOf(kinds), { query, class: className, student, limit: limit ?? 200 });
    },
  );

  app.get("/messages/preferences", async (request) => teacher.messagingPreferences(requireSession(request)));

  // Sends a message, a reply or manages a draft. new and reply are irreversible. Never forwards, reports nor deletes a received message.
  app.post<{ Body: MessageWrite }>("/messages", { schema: { body: messageWriteBody } }, async (request) => {
    if (!request.body.dryRun && config.writeMode !== "live") throw new HttpError(403, "write_mode_simulate");
    return teacher.sendMessage(requireSession(request), request.body);
  });

  // Reversible actions on the teacher's own copies: read/unread, archive/unarchive, trash/restore.
  app.post<{ Body: MailboxBody }>(
    "/messages/mailbox",
    {
      schema: {
        body: {
          type: "object",
          required: ["action", "discussions"],
          properties: {
            action: { type: "string", enum: ["read", "unread", "archive", "unarchive", "trash", "restore"] },
            discussions: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1, maxLength: 300 } },
            dryRun: { type: "boolean", default: false },
          },
        },
      },
    },
    async (request) => {
      const { action, discussions, dryRun = false } = request.body;
      if (!dryRun && config.writeMode !== "live") throw new HttpError(403, "write_mode_simulate");
      return teacher.mailbox(requireSession(request), action, discussions, dryRun);
    },
  );
}
