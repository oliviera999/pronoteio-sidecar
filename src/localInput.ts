/**
 * Wall-clock times in write requests (0.9.0): any object of a request body may carry a "local" member whose keys are
 * the names of its timestamp fields and whose values are wall-clock times of the school ("2026-11-12 17:10"):
 *   { "date": 1794499800, "local": { "date": "2026-11-12 17:10" } }
 * The wall-clock time is preferred: it replaces the timestamp (converted with the school's zone, see time.ts) before
 * the schema validation, and "local" is removed. Older clients that send timestamps only are unaffected.
 */
import { HttpError } from "./errors.js";
import { parseLocal, wallToEpoch } from "./time.js";

const MAX_DEPTH = 6;

const isPlain = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Replaces the "local" members of a body by timestamps, in place; 400 validation_failed on a malformed time. */
export const applyLocalTimes = (body: unknown, path = "", depth = 0): void => {
  if (depth > MAX_DEPTH) return;
  if (Array.isArray(body)) {
    body.forEach((item, index) => applyLocalTimes(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!isPlain(body)) return;
  const local = body.local;
  if (isPlain(local)) {
    for (const [key, value] of Object.entries(local)) {
      if (value === null) continue;
      const wall = parseLocal(value);
      if (!wall) throw new HttpError(400, `validation_failed:${path ? `${path}.` : ""}local.${key}`);
      body[key] = wallToEpoch(wall);
    }
    delete body.local;
  }
  for (const [key, value] of Object.entries(body)) {
    if (isPlain(value) || Array.isArray(value)) applyLocalTimes(value, path ? `${path}.${key}` : key, depth + 1);
  }
};
