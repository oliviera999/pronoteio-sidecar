import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { SessionHandle } from "pawnote";
import { config } from "./config.js";
import { HttpError } from "./errors.js";

type Entry = { handle: SessionHandle; expires: number };

/** In-memory cache of open Pronote sessions. Tokens are never kept here: Moodle stores them. */
const sessions = new Map<string, Entry>();

export const createSession = (handle: SessionHandle): string => {
  const id = randomUUID();
  sessions.set(id, { handle, expires: Date.now() + config.sessionTtl });
  return id;
};

/** Session of a request (X-Pronoteio-Session header), with sliding expiry. */
export const requireSession = (request: FastifyRequest): SessionHandle => {
  const id = String(request.headers["x-pronoteio-session"] ?? "");
  const entry = sessions.get(id);
  if (!entry || entry.expires < Date.now()) {
    sessions.delete(id);
    throw new HttpError(401, "session_expired");
  }
  entry.expires = Date.now() + config.sessionTtl;
  return entry.handle;
};

export const dropSession = (request: FastifyRequest): void => {
  sessions.delete(String(request.headers["x-pronoteio-session"] ?? ""));
};

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of sessions) {
    if (entry.expires < now) sessions.delete(id);
  }
}, 60_000).unref();
