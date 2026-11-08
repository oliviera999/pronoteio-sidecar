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
/** Attachment of a message or an information: an uploaded file (POST /files) or a link. */
export const attachmentSchema = {
    type: "object",
    required: ["name"],
    properties: {
        name: { type: "string", maxLength: 255 },
        fileId: { type: "string", maxLength: 100 },
        url: { type: "string", maxLength: 2000 },
    },
};
export const RECIPIENT_KIND_VALUES = ["class", "group", "teacher", "student", "parent", "staff"];
/** Recipient of a message, member of a list or individual of an audience: nature and label. */
export const recipientRefSchema = (kinds = RECIPIENT_KIND_VALUES) => ({
    type: "object",
    required: ["kind", "label"],
    properties: {
        kind: { type: "string", enum: [...kinds] },
        label: { type: "string", minLength: 1, maxLength: 200 },
    },
});
//# sourceMappingURL=schemas.js.map