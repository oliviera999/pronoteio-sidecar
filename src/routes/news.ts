import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { HttpError } from "../errors.js";
import { requireSession } from "../session.js";
import * as teacher from "../teacher/index.js";
import type { NewsResponseWrite, NewsScope, NewsWrite } from "../normalise.js";
import { attachmentSchema, recipientRefSchema } from "./schemas.js";

type NewsQuery = { scope?: NewsScope; unreadOnly?: boolean };
type ResultsQuery = { id: string; nominative?: boolean };
type ResponseBody = NewsResponseWrite & { id: string; dryRun?: boolean };
type NewsBody = NewsWrite & { dryRun?: boolean };

export const newsResponseBody = {
  type: "object",
  required: ["id"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 300 },
    read: { type: ["boolean", "null"] },
    acknowledge: { type: ["boolean", "null"] },
    answers: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        required: ["question"],
        properties: {
          question: { type: "string", pattern: "^q[0-9]+$" },
          choices: { type: "array", maxItems: 50, items: { type: "integer", minimum: 0 } },
          text: { type: "string", maxLength: 5000 },
        },
      },
    },
    remove: { type: "boolean" },
    dryRun: { type: "boolean", default: false },
  },
} as const;

export const newsWriteBody = {
  type: "object",
  required: ["mode"],
  properties: {
    mode: { type: "string", enum: ["create", "update", "delete", "publish", "unpublish"] },
    id: { type: "string", maxLength: 300 },
    kind: { type: "string", enum: ["information", "survey"] },
    title: { type: "string", maxLength: 500 },
    category: { type: "string", maxLength: 100 },
    text: { type: "string", maxLength: 50000 },
    start: { type: "integer", minimum: 0 },
    end: { type: ["integer", "null"], minimum: 0 },
    anonymous: { type: "boolean" },
    template: { type: "boolean" },
    audience: {
      type: "object",
      properties: {
        classes: { type: "array", maxItems: 100, items: { type: "string", maxLength: 100 } },
        groups: { type: "array", maxItems: 100, items: { type: "string", maxLength: 100 } },
        students: { type: "boolean" },
        parents: { type: "string", enum: ["none", "one", "all"] },
        mainTeachers: { type: "boolean" },
        tutors: { type: "boolean" },
        individuals: { type: "array", maxItems: 200, items: recipientRefSchema() },
      },
    },
    questions: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        required: ["text", "kind"],
        properties: {
          text: { type: "string", maxLength: 50000 },
          kind: { type: "string", enum: ["ack", "text", "single", "multiple", "none"] },
          choices: {
            type: "array",
            maxItems: 50,
            items: { type: "object", required: ["label"], properties: { label: { type: "string", maxLength: 500 }, free: { type: "boolean" } } },
          },
          maxLength: { type: ["integer", "null"], minimum: 0 },
        },
      },
    },
    attachments: { type: "array", maxItems: 20, items: attachmentSchema },
    dryRun: { type: "boolean", default: false },
  },
} as const;

export default async function newsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: NewsQuery }>(
    "/news",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            scope: { type: "string", enum: ["received", "sent", "drafts", "templates", "library"], default: "received" },
            unreadOnly: { type: "boolean", default: false },
          },
        },
      },
    },
    async (request) => teacher.news(requireSession(request), request.query.scope ?? "received", request.query.unreadOnly ?? false),
  );

  // Results of a survey or an information; names only when nominative is true (audited by the caller).
  app.get<{ Querystring: ResultsQuery }>(
    "/news/results",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", minLength: 1 }, nominative: { type: "boolean", default: false } },
        },
      },
    },
    async (request) => teacher.newsResults(requireSession(request), request.query.id, request.query.nominative ?? false),
  );

  // Answer, acknowledgement, read flag or removal of a received item (acknowledge and remove are irreversible).
  app.post<{ Body: ResponseBody }>("/news/response", { schema: { body: newsResponseBody } }, async (request) => {
    const { id, dryRun = false, ...response } = request.body;
    if (!dryRun && config.writeMode !== "live") throw new HttpError(403, "write_mode_simulate");
    return teacher.writeNewsResponse(requireSession(request), id, response, dryRun);
  });

  // Creates (never published), modifies, publishes, unpublishes or deletes an information or a survey.
  app.post<{ Body: NewsBody }>("/news", { schema: { body: newsWriteBody } }, async (request) => {
    const { dryRun = false, ...write } = request.body;
    if (!dryRun && config.writeMode !== "live") throw new HttpError(403, "write_mode_simulate");
    return teacher.writeNews(requireSession(request), write, dryRun);
  });
}
