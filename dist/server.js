// First import: switches the process to UTC before any date is built (wall-clock times of Pronote, see time.ts).
import "./time.js";
import { buildApp } from "./app.js";
import { assertSecret, config } from "./config.js";
import { acquireLock, releaseLock } from "./lock.js";
import { limiterStats } from "./pronote/limiter.js";
import { stateStore } from "./state.js";
assertSecret();
// Single process (P5): a second process answers but never calls Pronote while the lock is held by a live process.
const lock = acquireLock();
if (!lock.primary)
    console.error(`pronoteio-sidecar: another process (${lock.holder}) holds ${lock.file}: running as secondary`);
// Non-personal state kept across restarts (P5): counters of the rate limiter added to those restored.
const restored = { ...stateStore.state.limiter };
stateStore.beforeSave = () => {
    const live = limiterStats();
    stateStore.state.limiter = { served: restored.served + live.served, refused: restored.refused + live.refused };
};
stateStore.start();
const stop = () => {
    stateStore.stop();
    releaseLock();
};
process.once("exit", stop);
for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => {
        stop();
        process.exit(0);
    });
}
const app = await buildApp();
// Under Phusion Passenger (cPanel "Setup Node.js App") the server must listen on the socket given by
// Passenger: its documented way is listen("passenger"), which Fastify's listen() cannot express.
if ("PhusionPassenger" in globalThis) {
    await app.ready();
    app.server.listen("passenger");
}
else {
    await app.listen({ host: config.host, port: config.port });
}
//# sourceMappingURL=server.js.map