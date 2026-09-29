export const intervalQuery = {
    type: "object",
    required: ["from", "to"],
    properties: {
        from: { type: "integer", minimum: 0 },
        to: { type: "integer", minimum: 0 },
    },
};
export const resourceQuery = {
    type: "object",
    required: ["resource"],
    properties: {
        resource: { type: "string", minLength: 1 },
    },
};
export const resourceIntervalQuery = {
    type: "object",
    required: ["resource", "from", "to"],
    properties: {
        ...resourceQuery.properties,
        ...intervalQuery.properties,
    },
};
//# sourceMappingURL=schemas.js.map