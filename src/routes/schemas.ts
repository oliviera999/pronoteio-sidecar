export type IntervalQuery = { from: number; to: number };
export type ResourceQuery = { resource: string };
export type ResourceIntervalQuery = ResourceQuery & IntervalQuery;

export const intervalQuery = {
  type: "object",
  required: ["from", "to"],
  properties: {
    from: { type: "integer", minimum: 0 },
    to: { type: "integer", minimum: 0 },
  },
} as const;

export const resourceQuery = {
  type: "object",
  required: ["resource"],
  properties: {
    resource: { type: "string", minLength: 1 },
  },
} as const;

export const resourceIntervalQuery = {
  type: "object",
  required: ["resource", "from", "to"],
  properties: {
    ...resourceQuery.properties,
    ...intervalQuery.properties,
  },
} as const;

/** Attachment of a message or an information: an uploaded file (POST /files) or a link. */
export const attachmentSchema = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string", maxLength: 255 },
    fileId: { type: "string", maxLength: 100 },
    url: { type: "string", maxLength: 2000 },
  },
} as const;

export const RECIPIENT_KIND_VALUES = ["class", "group", "teacher", "student", "parent", "staff"] as const;

/** Recipient of a message, member of a list or individual of an audience: nature and label. */
export const recipientRefSchema = (kinds: readonly string[] = RECIPIENT_KIND_VALUES) =>
  ({
    type: "object",
    required: ["kind", "label"],
    properties: {
      kind: { type: "string", enum: [...kinds] },
      label: { type: "string", minLength: 1, maxLength: 200 },
    },
  }) as const;
