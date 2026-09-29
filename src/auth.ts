import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { config } from "./config.js";
import { HttpError } from "./errors.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
  }
}

/** Signatures already seen during the skew window (replay protection). */
const seen = new Map<string, number>();

const purgeSeen = (now: number): void => {
  for (const [signature, expires] of seen) {
    if (expires < now) seen.delete(signature);
  }
};

/**
 * Checks the request signature produced by sidecar_connector::send():
 * HMAC-SHA256(secret, timestamp \n METHOD \n path?query \n sha256(body)).
 */
export const verifySignature = (request: FastifyRequest): void => {
  const timestamp = String(request.headers["x-pronoteio-timestamp"] ?? "");
  const signature = String(request.headers["x-pronoteio-signature"] ?? "");
  const now = Math.floor(Date.now() / 1000);

  if (!/^\d+$/.test(timestamp) || Math.abs(now - Number(timestamp)) > config.maxSkew) {
    throw new HttpError(401, "invalid_timestamp");
  }

  const bodyHash = createHash("sha256").update(request.rawBody ?? "").digest("hex");
  const expected = createHmac("sha256", config.secret)
    .update([timestamp, request.method, request.url, bodyHash].join("\n"))
    .digest("hex");

  const given = Buffer.from(signature, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    throw new HttpError(401, "invalid_signature");
  }

  purgeSeen(now);
  if (seen.has(signature)) {
    throw new HttpError(401, "replayed_request");
  }
  seen.set(signature, now + config.maxSkew);
};
