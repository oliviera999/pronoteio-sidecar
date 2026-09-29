import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import type { FastifyRequest } from "fastify";

process.env.PRONOTEIO_SECRET = "test-secret-0123456789abcdef";
const { signedPayload, verifySignature } = await import("../src/auth.js");
const { HttpError } = await import("../src/errors.js");

const sign = (timestamp: string, nonce: string, method: string, url: string, body = "") =>
  createHmac("sha256", process.env.PRONOTEIO_SECRET!).update(signedPayload(timestamp, nonce, method, url, body)).digest("hex");

const request = (headers: Record<string, string>, method = "GET", url = "/resources", body = "") =>
  ({ headers, method, url, rawBody: body }) as unknown as FastifyRequest;

const fails = (fn: () => void, code: string) =>
  assert.throws(fn, (error: unknown) => error instanceof HttpError && error.code === code);

const now = () => String(Math.floor(Date.now() / 1000));

test("the same request sent twice in the same second passes with distinct nonces", () => {
  const timestamp = now();
  for (const nonce of ["0123456789abcdef0123456789abcdef", "fedcba9876543210fedcba9876543210"]) {
    verifySignature(request({
      "x-pronoteio-timestamp": timestamp,
      "x-pronoteio-nonce": nonce,
      "x-pronoteio-signature": sign(timestamp, nonce, "GET", "/resources"),
    }));
  }
});

test("a replayed request is refused", () => {
  const timestamp = now();
  const nonce = "00112233445566778899aabbccddeeff";
  const headers = {
    "x-pronoteio-timestamp": timestamp,
    "x-pronoteio-nonce": nonce,
    "x-pronoteio-signature": sign(timestamp, nonce, "POST", "/session/login", "{}"),
  };
  verifySignature(request(headers, "POST", "/session/login", "{}"));
  fails(() => verifySignature(request(headers, "POST", "/session/login", "{}")), "replayed_request");
});

test("requests signed without nonce (plugin 0.2.2) are still accepted", () => {
  const timestamp = now();
  verifySignature(request({
    "x-pronoteio-timestamp": timestamp,
    "x-pronoteio-signature": sign(timestamp, "", "GET", "/absences?resource=c%3AT01"),
  }, "GET", "/absences?resource=c%3AT01"));
});

test("the nonce is covered by the signature", () => {
  const timestamp = now();
  fails(() => verifySignature(request({
    "x-pronoteio-timestamp": timestamp,
    "x-pronoteio-nonce": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "x-pronoteio-signature": sign(timestamp, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "GET", "/resources"),
  })), "invalid_signature");
  fails(() => verifySignature(request({
    "x-pronoteio-timestamp": timestamp,
    "x-pronoteio-nonce": "not-hex!",
    "x-pronoteio-signature": sign(timestamp, "not-hex!", "GET", "/resources"),
  })), "invalid_signature");
});

test("old timestamps are refused", () => {
  const timestamp = String(Math.floor(Date.now() / 1000) - 3600);
  fails(() => verifySignature(request({
    "x-pronoteio-timestamp": timestamp,
    "x-pronoteio-signature": sign(timestamp, "", "GET", "/resources"),
  })), "invalid_timestamp");
});
