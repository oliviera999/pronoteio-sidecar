import { config } from "../config.js";
import { HttpError } from "../errors.js";
import { MAX_UPLOAD_BYTES, uploadFile } from "../pronote/upload.js";
import { requireSession } from "../session.js";
/** Uploads a file to Pronote for the next Saisie* call of the same session (returns its IDFichier). */
export default async function filesRoutes(app) {
    app.post("/files", {
        // Base64 of a 20 MiB file plus the JSON envelope.
        bodyLimit: Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 64 * 1024,
        schema: {
            body: {
                type: "object",
                required: ["name", "content", "function"],
                properties: {
                    name: { type: "string", minLength: 1, maxLength: 255 },
                    content: { type: "string", minLength: 1 },
                    function: { type: "string", minLength: 1, maxLength: 100 },
                },
            },
        },
    }, async (request) => {
        if (config.writeMode !== "live")
            throw new HttpError(403, "write_mode_simulate");
        const bytes = Buffer.from(request.body.content, "base64");
        if (bytes.length === 0)
            throw new HttpError(400, "empty_file");
        return uploadFile(requireSession(request), { name: request.body.name, bytes, functionName: request.body.function });
    });
}
//# sourceMappingURL=files.js.map