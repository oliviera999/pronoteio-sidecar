/**
 * Update on demand (P9, 0.9.0): POST /admin/update (signed) runs tools/cpanel-update.sh at once, the same script as
 * the cron, and answers the old version, the new one and the result of the health check. GET /admin/update gives the
 * result of the last run (var/update-result.json). tool_olutiondeploy makes a button of it.
 *
 * The script is started detached: it restarts the sidecar itself (Passenger), so the process answering may be
 * replaced before the end. The answer waits for the result up to "timeout" seconds (default 100); beyond, or when the
 * process was replaced, the client reads GET /admin/update. One update at a time (flock in the script, and here).
 * PRONOTEIO_ADMIN_UPDATE=off disables the route; PRONOTEIO_PUBLIC_URL is the public URL given to the script.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { HttpError, RateLimitedError } from "./errors.js";
import { COMMIT, SIDECAR_VERSION } from "./version.js";
const appRoot = join(new URL(".", import.meta.url).pathname, "..");
let runner = () => {
    const script = join(appRoot, "tools", "cpanel-update.sh");
    const child = spawn("/bin/bash", [script, process.env.PRONOTEIO_PUBLIC_URL ?? ""], {
        cwd: appRoot,
        detached: true,
        stdio: "ignore",
        env: { ...process.env, PRONOTEIO_UPDATE_RESULT_WHEN_UP_TO_DATE: "1" },
    });
    child.unref();
};
/** Replaces the script runner (tests). */
export const setUpdateRunner = (fn) => {
    runner = fn;
};
let running = null;
const resultFile = () => process.env.PRONOTEIO_UPDATE_RESULT ?? join(appRoot, "var", "update-result.json");
export const readResult = (file = resultFile()) => {
    try {
        return JSON.parse(readFileSync(file, "utf8"));
    }
    catch {
        return null;
    }
};
const mtime = (file) => (existsSync(file) ? statSync(file).mtimeMs : 0);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Runs the update script and waits for a NEW result file (or the timeout). */
export const runUpdate = (timeoutMs) => {
    if (running)
        throw new RateLimitedError(30);
    const file = resultFile();
    const before = mtime(file);
    running = (async () => {
        runner(file);
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            await sleep(500);
            if (mtime(file) > before)
                return readResult(file);
        }
        return null;
    })().finally(() => {
        running = null;
    });
    return running;
};
export const registerAdmin = (app) => {
    app.post("/admin/update", { schema: { body: { type: "object", properties: { timeout: { type: "integer", minimum: 0, maximum: 300 } } } } }, async (request, reply) => {
        if ((process.env.PRONOTEIO_ADMIN_UPDATE ?? "on").toLowerCase() === "off")
            throw new HttpError(403, "forbidden", { reason: "admin_update_off" });
        const timeout = (request.body?.timeout ?? 100) * 1000;
        const before = { commit: COMMIT, version: SIDECAR_VERSION };
        const result = await runUpdate(timeout);
        if (!result)
            return reply.code(202).send({ running: true, old: before, result: null });
        return { running: false, ...result };
    });
    app.get("/admin/update", async () => ({ running: running !== null, last: readResult(), current: { commit: COMMIT, version: SIDECAR_VERSION } }));
};
//# sourceMappingURL=admin.js.map