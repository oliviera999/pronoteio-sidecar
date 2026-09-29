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
