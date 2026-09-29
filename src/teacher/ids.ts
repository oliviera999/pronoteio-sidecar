/**
 * Stable identifiers.
 *
 * Pronote identifiers ("105#<43 chars>") are encrypted per session: an id read in one session is
 * refused in the next one. Moodle stores ids across sessions (course mappings, cohort links,
 * previous pushes), so the sidecar exposes ids built from labels and resolves them against the
 * current session before each call. Keys longer than MAX_KEY are hashed (Moodle columns hold 100).
 */
import { createHash } from "node:crypto";
import { HttpError } from "../errors.js";

export type IdKind = "class" | "group" | "period" | "service" | "student" | "assessment" | "absence";

const PREFIX: Record<IdKind, string> = {
  class: "c",
  group: "g",
  period: "p",
  service: "s",
  student: "e",
  assessment: "d",
  absence: "a",
};

const MAX_KEY = 80;

const normaliseKey = (key: string): string => key.normalize("NFC").replace(/\s+/g, " ").trim();

export const stableId = (kind: IdKind, key: string): string => {
  const clean = normaliseKey(key);
  const body = clean.length <= MAX_KEY ? clean : `#${createHash("sha256").update(clean).digest("hex").slice(0, 32)}`;
  return `${PREFIX[kind]}:${body}`;
};

export const kindOf = (id: string): IdKind | null => {
  const prefix = id.split(":", 1)[0];
  const entry = Object.entries(PREFIX).find(([, value]) => value === prefix);
  return entry ? (entry[0] as IdKind) : null;
};

/**
 * Stable ids of a list, in order. Items sharing the same key (e.g. two students with the same
 * name) get "~2", "~3"... in Pronote order.
 */
export const stableIds = <T>(kind: IdKind, items: T[], key: (item: T) => string): string[] => {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const id = stableId(kind, key(item));
    const count = (seen.get(id) ?? 0) + 1;
    seen.set(id, count);
    return count === 1 ? id : `${id}~${count}`;
  });
};

/** Pronote element of the current session matching a stable id, or HTTP 404 "<kind>_not_found". */
export const resolve = <T>(kind: IdKind, id: string, items: T[], key: (item: T) => string): T => {
  const ids = stableIds(kind, items, key);
  const index = ids.indexOf(id);
  if (index < 0) throw new HttpError(404, `${kind}_not_found`);
  return items[index];
};
