/**
 * Whole sidecar application for the route tests (buildApp of src/app.ts): signed requests as sent by
 * local_pronoteio (sidecar_connector::send), a Pronote session answered by fake-session.ts.
 */
import { createHmac, randomBytes } from "node:crypto";

process.env.PRONOTEIO_SECRET ??= "test-secret-0123456789abcdef";

const { buildApp } = await import("../../src/app.js");
const { signedPayload } = await import("../../src/auth.js");
const { createSession } = await import("../../src/session.js");

export { buildApp, createSession };

export const secret = (): string => process.env.PRONOTEIO_SECRET as string;

export const sign = (timestamp: string, nonce: string, method: string, url: string, body = "", key = secret()) =>
  createHmac("sha256", key).update(signedPayload(timestamp, nonce, method, url, body)).digest("hex");

/** Headers of a signed request (fresh nonce), with the session when given. */
export const signedHeaders = (method: string, url: string, body = "", session?: string, options: { key?: string; timestamp?: number } = {}) => {
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString("hex");
  return {
    "x-pronoteio-timestamp": timestamp,
    "x-pronoteio-nonce": nonce,
    "x-pronoteio-signature": sign(timestamp, nonce, method, url, body, options.key),
    ...(body !== "" ? { "content-type": "application/json" } : {}),
    ...(session ? { "x-pronoteio-session": session } : {}),
  };
};

type App = Awaited<ReturnType<typeof buildApp>>;

/** Signed GET. */
export const get = (app: App, url: string, session?: string) =>
  app.inject({ method: "GET", url, headers: signedHeaders("GET", url, "", session) });

/** Signed POST with a JSON body. */
export const post = (app: App, url: string, body: unknown, session?: string) => {
  const json = JSON.stringify(body);
  return app.inject({ method: "POST", url, payload: json, headers: signedHeaders("POST", url, json, session) });
};
