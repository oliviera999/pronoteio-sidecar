/**
 * Context of the HTTP request being served, reachable from any Pronote call it makes (AsyncLocalStorage): priority
 * in the rate limiter queue (P2), deadline of the wait, counters of the request (cache, Pronote calls), dry run.
 */
import { AsyncLocalStorage } from "node:async_hooks";
/** Priorities of the queue: writes first, then unit reads, then bulk reads (lower is served first). */
export const PRIORITY = { write: 0, read: 1, bulk: 2 };
export const requestContext = new AsyncLocalStorage();
export const currentContext = () => requestContext.getStore();
/** Bulk routes: several Pronote calls per request, served after the unit reads. */
const BULK_ROUTES = new Set(["/students/files", "/grades/overview", "/notebook", "/assessments", "/jobs", "/jobs/:id"]);
/** Priority of a request from its method and route. */
export const priorityOf = (method, route, query = {}) => {
    if (method !== "GET" && method !== "HEAD")
        return PRIORITY.write;
    if (route === "/students/files") {
        // One student (student=…) is a unit read; a page of a class or a list of ids is a bulk read.
        return typeof query.student === "string" && query.student !== "" && query.ids === undefined ? PRIORITY.read : PRIORITY.bulk;
    }
    return BULK_ROUTES.has(route) ? PRIORITY.bulk : PRIORITY.read;
};
//# sourceMappingURL=context.js.map