/**
 * Version of the sidecar (package.json) and commit of the deployed code (health check, P8/P9). The commit is read from
 * the .git folder of the application (a clone updated by tools/cpanel-update.sh), without running git.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const appRoot = (() => {
    // dist/version.js or src/version.ts: the application folder is the parent.
    const here = new URL(".", import.meta.url).pathname;
    return join(here, "..");
})();
const readJson = (path) => {
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    }
    catch {
        return null;
    }
};
export const SIDECAR_VERSION = String(readJson(join(appRoot, "package.json"))?.version ?? "unknown");
/** Commit of the code (40 hex), null when unknown. */
export const readCommit = (root = appRoot) => {
    try {
        const git = join(root, ".git");
        if (!existsSync(git))
            return null;
        const head = readFileSync(join(git, "HEAD"), "utf8").trim();
        if (/^[0-9a-f]{40}$/.test(head))
            return head;
        const ref = head.replace(/^ref:\s*/, "");
        const loose = join(git, ref);
        if (existsSync(loose))
            return readFileSync(loose, "utf8").trim();
        const packed = readFileSync(join(git, "packed-refs"), "utf8").split("\n").find((line) => line.endsWith(` ${ref}`));
        return packed ? packed.split(" ")[0] : null;
    }
    catch {
        return null;
    }
};
export const STARTED_AT = Date.now();
export const COMMIT = readCommit();
//# sourceMappingURL=version.js.map