import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
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
 * Checks the timestamp, the nonce and the signature of a request produced by sidecar_connector::send():
 * HMAC-SHA256(secret, signedPayload(...)), and returns the signature. Does not record it (see recordSignature).
 * Errors: invalid_timestamp (clocks of Moodle and of the sidecar more than PRONOTEIO_MAX_SKEW apart, or no
 * timestamp), invalid_signature (secret different from Moodle's, or altered request).
 */
export const checkSignature = (request: FastifyRequest): string => {
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
  return signature;
};

/**
 * Records a signature for the skew window; false when it was already seen (the same request delivered again).
 * The cache lives in memory only: a restart (for example after a change of PRONOTEIO_SECRET) empties it, and a
 * signature made with another secret can never match.
 */
export const recordSignature = (signature: string, now = Math.floor(Date.now() / 1000)): boolean => {
  purgeSeen(now);
  if (seen.has(signature)) return false;
  seen.set(signature, now + config.maxSkew);
  return true;
};

/**
 * Checks the request signature and refuses a request already seen (replayed_request). The random nonce (plugin
 * 0.2.3+) makes two identical requests sent in the same second distinct, e.g. a request retried after a new login;
 * requests without nonce (older plugins) are still accepted.
 */
export const verifySignature = (request: FastifyRequest): void => {
  if (!recordSignature(checkSignature(request))) {
    throw new HttpError(401, "replayed_request");
  }
};

type Answer = { status: number; headers: Record<string, string>; payload: unknown };

/** Reads still running, by signature: a second delivery of the same read waits for the answer of the first. */
const inflight = new Map<string, Promise<Answer>>();

declare module "fastify" {
  interface FastifyRequest {
    inflightResolve?: (answer: Answer) => void;
  }
}

/**
 * Raw body parser and signature check of every route but /health, before schema validation (unsigned requests
 * learn nothing about the API).
 *
 * The web server in front of the sidecar (Apache + Passenger on cPanel) may deliver the same request twice, the
 * second time while a slow read is still running (10/11/2026: student files, one FicheEleve call per student, and
 * other calls waiting in the Pronote session queue). Refusing that second delivery sent "replayed_request" back to
 * Moodle although nothing was replayed by anyone. Now:
 * - a GET (read only) delivered again while the first delivery runs waits for it and gets the same answer:
 *   Pronote is read once and Moodle gets its data;
 * - a GET delivered again after its answer, and any POST (write, login) delivered twice, are still refused with
 *   replayed_request: a write is never executed twice.
 */
export const registerAuth = (app: FastifyInstance): void => {
  // Keep the raw body: the HMAC signature covers the exact bytes sent by Moodle.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    request.rawBody = body as string;
    try {
      done(null, body === "" ? {} : JSON.parse(body as string));
    } catch {
      done(Object.assign(new Error("invalid_json"), { statusCode: 400 }), undefined);
    }
  });

  app.addHook("preValidation", async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.routeOptions.url === "/health") return;
    const signature = checkSignature(request);
    if (recordSignature(signature)) {
      if (request.method === "GET") {
        let resolve!: (answer: Answer) => void;
        inflight.set(signature, new Promise<Answer>((done) => (resolve = done)));
        request.inflightResolve = (answer) => {
          inflight.delete(signature);
          resolve(answer);
        };
      }
      return;
    }
    const running = request.method === "GET" ? inflight.get(signature) : undefined;
    if (!running) throw new HttpError(401, "replayed_request");
    request.log.info("same read delivered again while it runs: answered with the result of the first delivery");
    const answer = await running;
    reply.code(answer.status).headers(answer.headers);
    return reply.send(answer.payload);
  });

  // Answer of a read (success or error): shared with the deliveries waiting for it.
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.inflightResolve) {
      const contentType = reply.getHeader("content-type");
      request.inflightResolve({
        status: reply.statusCode,
        headers: contentType ? { "content-type": String(contentType) } : {},
        payload,
      });
      request.inflightResolve = undefined;
    }
    return payload;
  });

  // Never leave a waiting delivery behind (aborted request, error before any answer).
  app.addHook("onResponse", async (request, reply) => {
    request.inflightResolve?.({ status: reply.statusCode >= 400 ? reply.statusCode : 502, headers: {},
      payload: JSON.stringify({ error: "pronote_error" }) });
    request.inflightResolve = undefined;
  });
};
