/**
 * Single process (P5, 0.9.0). The rate limiter queue, the read cache, the jobs and the Pronote sessions live in the
 * memory of ONE Node process. If Passenger started a second one, each would open its own Pronote session (they may
 * push each other out) and count its own calls (the limits would mean nothing).
 *
 * At start the sidecar takes a lock file (PRONOTEIO_LOCK_FILE, default ~/tmp/pronoteio-sidecar.lock): process id,
 * start time and a heartbeat, no personal data. A process that finds the lock held by another live process (heartbeat
 * younger than STALE_MS) runs as "secondary": it answers (health check, errors) but sends no call to Pronote
 * (503 pronote_unavailable, reason second_process), and tries again every RETRY_MS to become the primary (the
 * previous process stops a few seconds after a Passenger restart).
 */
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, utimesSync, writeFileSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
export const STALE_MS = 60_000;
const HEARTBEAT_MS = 10_000;
const RETRY_MS = 2_000;
const state = { file: null, primary: true, holder: null, since: Date.now(), conflicts: 0 };
let heartbeat = null;
let retry = null;
/** Lock file: PRONOTEIO_LOCK_FILE, "off" to disable the check, default ~/tmp/pronoteio-sidecar.lock. */
export const resolveLockFile = (env = process.env) => {
    const value = (env.PRONOTEIO_LOCK_FILE ?? "").trim();
    if (value.toLowerCase() === "off")
        return null;
    return value !== "" ? value : join(homedir(), "tmp", "pronoteio-sidecar.lock");
};
const alive = (pid) => {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === "EPERM";
    }
};
const readHolder = (file) => {
    try {
        const pid = Number.parseInt(String(JSON.parse(readFileSync(file, "utf8"))?.pid ?? ""), 10);
        const fresh = Date.now() - statSync(file).mtimeMs < STALE_MS;
        return { pid, fresh };
    }
    catch {
        return null;
    }
};
const write = (file, exclusive) => {
    const content = JSON.stringify({ pid: process.pid, started: new Date(state.since).toISOString() });
    try {
        if (exclusive) {
            const fd = openSync(file, "wx", 0o600);
            writeSync(fd, content);
            closeSync(fd);
        }
        else {
            writeFileSync(file, content, { mode: 0o600 });
        }
        return true;
    }
    catch {
        return false;
    }
};
/** Tries to take the lock; true when this process is (now) the primary. */
export const tryAcquire = (file = state.file) => {
    if (file === null)
        return true;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    if (write(file, true))
        return true;
    const holder = readHolder(file);
    if (holder && holder.pid === process.pid)
        return write(file, false);
    if (holder && holder.fresh && alive(holder.pid)) {
        state.holder = holder.pid;
        return false;
    }
    // Stale lock (process gone, or no heartbeat for a minute): taken over.
    return write(file, false);
};
const startHeartbeat = () => {
    if (heartbeat || state.file === null)
        return;
    heartbeat = setInterval(() => {
        const now = new Date();
        try {
            utimesSync(state.file, now, now);
        }
        catch {
            write(state.file, false);
        }
    }, HEARTBEAT_MS);
    heartbeat.unref();
};
/** Takes the lock at start (server.ts); secondary mode when another live process holds it. */
export const acquireLock = (file = resolveLockFile()) => {
    state.file = file;
    state.primary = tryAcquire(file);
    if (state.primary) {
        state.holder = null;
        startHeartbeat();
    }
    else {
        state.conflicts++;
        if (!retry) {
            retry = setInterval(() => {
                if (tryAcquire()) {
                    state.primary = true;
                    state.holder = null;
                    if (retry)
                        clearInterval(retry);
                    retry = null;
                    startHeartbeat();
                }
            }, RETRY_MS);
            retry.unref();
        }
    }
    return { ...state };
};
/** Releases the lock (normal stop). */
export const releaseLock = () => {
    if (heartbeat)
        clearInterval(heartbeat);
    if (retry)
        clearInterval(retry);
    heartbeat = retry = null;
    if (state.file && state.primary && readHolder(state.file)?.pid === process.pid) {
        try {
            unlinkSync(state.file);
        }
        catch {
            // Already gone.
        }
    }
};
export const lockState = () => ({ ...state });
export const isPrimary = () => state.primary;
//# sourceMappingURL=lock.js.map