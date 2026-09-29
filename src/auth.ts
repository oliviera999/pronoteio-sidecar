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

/** Signed string: timestamp \n [nonce \n] METHOD \n path?query \n sha256(body). */
export const signedPayload = (timestamp: string, nonce: string, method: string, url: string, body: string): string => {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return [timestamp, ...(nonce ? [nonce] : []), method, url, bodyHash].join("\n");
};

/**
 * Checks the request signature produced by sidecar_connector::send():
 * HMAC-SHA256(secret, signedPayload(...)). The random nonce (plugin 0.2.3+) makes two identical
 * requests sent in the same second distinct, e.g. a request retried after a new login; requests
 * without nonce (older plugins) are still accepted.
 */
export const verifySignature = (request: FastifyRequest): void => {
  const timestamp = String(request.headers["x-pronoteio-timestamp"] ?? "");
  const nonce = String(request.headers["x-pronoteio-nonce"] ?? "");
  const signature = String(request.headers["x-pronoteio-signature"] ?? "");
  const now = Math.floor(Date.now() / 1000);

  if (!/^\d+$/.test(timestamp) || Math.abs(now - Number(timestamp)) > config.maxSkew) {
    throw new HttpError(401, "invalid_timestamp");
  }
  if (nonce !== "" && !/^[0-9a-f]{16,64}$/.test(nonce)) {
    throw new HttpError(401, "invalid_signature");
  }

  const expected = createHmac("sha256", config.secret)
    .update(signedPayload(timestamp, nonce, request.method, request.url, request.rawBody ?? ""))
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
