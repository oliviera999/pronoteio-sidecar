/**
 * Structured access log (P8, 0.9.0): one JSON line per request, WITHOUT personal data, with rotation.
 *
 * Logged: time, method, route PATTERN (never the URL: its query may name a student, "student=e:NOM Prénom"), status,
 * stable error code, duration, answer size, cache (hit/miss), Pronote calls, priority. Never: query, body, headers,
 * session id, Pronote messages.
 * File: PRONOTEIO_LOG_FILE (default ~/logs/pronoteio-sidecar.log, "off" to disable), rotated beyond
 * PRONOTEIO_LOG_MAX_MB (5) into .1 … .N (PRONOTEIO_LOG_FILES, 5 files kept).
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
export const resolveLogFile = (env = process.env) => {
    const value = (env.PRONOTEIO_LOG_FILE ?? "").trim();
    if (value.toLowerCase() === "off")
        return null;
    return value !== "" ? value : join(homedir(), "logs", "pronoteio-sidecar.log");
};
const int = (value, fallback) => {
    const parsed = Number.parseInt(value ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
export class AccessLog {
    file;
    maxBytes;
    keep;
    size = -1;
    failed = false;
    constructor(file = resolveLogFile(), maxBytes = int(process.env.PRONOTEIO_LOG_MAX_MB, 5) * 1024 * 1024, keep = int(process.env.PRONOTEIO_LOG_FILES, 5)) {
        this.file = file;
        this.maxBytes = maxBytes;
        this.keep = keep;
    }
    rotate() {
        const file = this.file;
        for (let index = this.keep - 1; index >= 1; index--) {
            const from = `${file}.${index}`;
            if (existsSync(from)) {
                if (index === this.keep - 1)
                    unlinkSync(from);
                else
                    renameSync(from, `${file}.${index + 1}`);
            }
        }
        if (this.keep > 1)
            renameSync(file, `${file}.1`);
        else
            unlinkSync(file);
        this.size = 0;
    }
    write(entry, at = new Date()) {
        if (this.file === null || this.failed)
            return;
        const line = `${JSON.stringify({ t: at.toISOString(), ...entry })}\n`;
        try {
            if (this.size < 0) {
                mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
                this.size = existsSync(this.file) ? statSync(this.file).size : 0;
            }
            if (this.size + line.length > this.maxBytes && this.size > 0)
                this.rotate();
            appendFileSync(this.file, line, { mode: 0o600 });
            this.size += Buffer.byteLength(line);
        }
        catch {
            // A log that cannot be written never stops the sidecar (disabled until restart).
            this.failed = true;
        }
    }
}
export const accessLog = new AccessLog();
//# sourceMappingURL=logs.js.map