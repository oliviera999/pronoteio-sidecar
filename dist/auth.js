import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { HttpError } from "./errors.js";
/**
 * Token of the requests made inside the process by the asynchronous jobs (app.inject, P4): random at each start,
 * never sent outside, never logged. A request carrying it skips the signature check.
 */
export const INTERNAL_TOKEN = randomBytes(32).toString("hex");
export const INTERNAL_HEADER = "x-pronoteio-internal";
/** Routes answered without signature. */
export const PUBLIC_ROUTES = new Set(["/health", "/health/public", "/errors"]);
/** Second deliveries of the same request by the web server (P4): delay after the first one, to size the proxy timeout. */
const duplicateDelays = [];
export const proxyStats = (now = Date.now()) => {
    while (duplicateDelays.length > 0 && duplicateDelays[0].at < now - 7 * 24 * 3600 * 1000)
        duplicateDelays.shift();
    const delays = duplicateDelays.map((item) => item.delay).sort((a, b) => a - b);
    return {
        /** Second deliveries during the last 7 days (answered with the answer of the first). */
        duplicates: delays.length,
        /** Of which while the first delivery was still running. */
        whileRunning: duplicateDelays.filter((item) => item.running).length,
        /** Median and shortest delay between the two deliveries (ms): about the timeout of the web server in front. */
        medianDelayMs: delays.length ? delays[Math.floor(delays.length / 2)] : null,
        minDelayMs: delays.length ? delays[0] : null,
        lastAt: duplicateDelays.length ? new Date(duplicateDelays[duplicateDelays.length - 1].at).toISOString() : null,
    };
};
const arrivals = new Map();
/** Signatures already seen during the skew window (replay protection). */
const seen = new Map();
const purgeSeen = (now) => {
    for (const [signature, expires] of seen) {
        if (expires < now)
            seen.delete(signature);
    }
};
/** Signed string: timestamp \n [nonce \n] METHOD \n path?query \n sha256(body). */
export const signedPayload = (timestamp, nonce, method, url, body) => {
    const bodyHash = createHash("sha256").update(body).digest("hex");
    return [timestamp, ...(nonce ? [nonce] : []), method, url, bodyHash].join("\n");
};
/** Uses of the previous secret during a key rotation (health check), and refusals by kind. */
export const securityStats = { previousKeyUses: 0, invalidSignature: 0, invalidTimestamp: 0, replayed: 0, addressRefused: 0 };
/**
 * Checks the nonce and the HMAC signature of a request produced by sidecar_connector::send():
 * HMAC-SHA256(secret, signedPayload(...)) with the current secret or, during a rotation, a previous one
 * (PRONOTEIO_SECRET_PREVIOUS); returns the signature. Errors: invalid_signature (secret different from Moodle's,
 * altered request, missing or malformed nonce).
 */
export const checkHmac = (request) => {
    const timestamp = String(request.headers["x-pronoteio-timestamp"] ?? "");
    const nonce = String(request.headers["x-pronoteio-nonce"] ?? "");
    const signature = String(request.headers["x-pronoteio-signature"] ?? "");
    if (!/^\d+$/.test(timestamp)) {
        securityStats.invalidTimestamp++;
        throw new HttpError(401, "invalid_timestamp");
    }
    // P11: the random nonce is required (local_pronoteio sends it since 0.2.3); PRONOTEIO_REQUIRE_NONCE=false accepts
    // older clients.
    if ((nonce === "" && config.requireNonce) || (nonce !== "" && !/^[0-9a-f]{16,64}$/.test(nonce))) {
        securityStats.invalidSignature++;
        throw new HttpError(401, "invalid_signature");
    }
    const payload = signedPayload(timestamp, nonce, request.method, request.url, request.rawBody ?? "");
    const given = Buffer.from(signature, "utf8");
    for (const [index, secret] of config.secrets.entries()) {
        const wanted = Buffer.from(createHmac("sha256", secret).update(payload).digest("hex"), "utf8");
        if (given.length === wanted.length && timingSafeEqual(given, wanted)) {
            if (index > 0)
                securityStats.previousKeyUses++;
            return signature;
        }
    }
    securityStats.invalidSignature++;
    throw new HttpError(401, "invalid_signature");
};
/** Refuses a timestamp outside the window (PRONOTEIO_MAX_SKEW seconds, 60 since 0.9.0): invalid_timestamp. */
export const checkTimestamp = (request, now = Math.floor(Date.now() / 1000)) => {
    const timestamp = Number(String(request.headers["x-pronoteio-timestamp"] ?? ""));
    if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > config.maxSkew) {
        securityStats.invalidTimestamp++;
        throw new HttpError(401, "invalid_timestamp");
    }
};
/** Signature and timestamp of a request (health check): returns the signature. */
export const checkSignature = (request) => {
    const signature = checkHmac(request);
    checkTimestamp(request);
    return signature;
};
/**
 * Records a signature for the skew window; false when it was already seen (the same request delivered again).
 * The cache lives in memory only: a restart (for example after a change of PRONOTEIO_SECRET) empties it, and a
 * signature made with another secret can never match.
 */
export const recordSignature = (signature, now = Math.floor(Date.now() / 1000)) => {
    purgeSeen(now);
    if (seen.has(signature))
        return false;
    // Kept longer than the window and than the kept answers: a late replay is refused as a replay (duplicate_write),
    // not as a clock problem.
    seen.set(signature, now + Math.max(config.maxSkew, ANSWER_TTL / 1000) + SEEN_EXTRA_SECONDS);
    return true;
};
/** Signatures are remembered this long after the window and the kept answers (seconds). */
const SEEN_EXTRA_SECONDS = 480;
/** Whether a signature was already seen (and not forgotten). */
const wasSeen = (signature, now = Math.floor(Date.now() / 1000)) => {
    const expires = seen.get(signature);
    return expires !== undefined && expires >= now;
};
/**
 * Checks the request signature and refuses a request already seen (replayed_request). The random nonce (plugin
 * 0.2.3+) makes two identical requests sent in the same second distinct, e.g. a request retried after a new login;
 * since 0.9.0 it is required (PRONOTEIO_REQUIRE_NONCE=false accepts older plugins).
 */
export const verifySignature = (request) => {
    if (!recordSignature(checkSignature(request))) {
        throw new HttpError(401, "replayed_request");
    }
};
/** Reads still running, by signature: a second delivery of the same read waits for the answer of the first. */
const inflight = new Map();
/** How long the answer of a request is kept for a late second delivery of it (milliseconds). */
export const ANSWER_TTL = 120_000;
/** Answers kept for late deliveries, at most this many (the oldest go first). */
export const MAX_KEPT_ANSWERS = 50;
/** Larger answers (student photos, files) are not kept: a late delivery of them is refused as before. */
export const MAX_KEPT_ANSWER_BYTES = 512 * 1024;
/**
 * 0.16.0: routes whose answers are health data (support plans, results of a grouped read). Their answers are never
 * kept for a late second delivery (it is refused as a replay), and their line of the access log carries neither the
 * size of the answer nor a shape (app.ts).
 */
export const HEALTH_DATA_ROUTES = new Set(["/students/plans", "/collect/:id/results"]);
/** Recent answers (in memory only), for a second delivery arriving just after the first was answered. */
const answered = new Map();
const answerSize = (payload) => typeof payload === "string" ? Buffer.byteLength(payload) : Buffer.isBuffer(payload) ? payload.length : Number.POSITIVE_INFINITY;
const keepAnswer = (signature, answer) => {
    const now = Date.now();
    if (answerSize(answer.payload) > MAX_KEPT_ANSWER_BYTES)
        return;
    for (const [key, entry] of answered) {
        if (entry.expires < now)
            answered.delete(key);
    }
    answered.set(signature, { answer, expires: now + ANSWER_TTL });
    while (answered.size > MAX_KEPT_ANSWERS)
        answered.delete(answered.keys().next().value);
};
/**
 * Raw body parser and signature check of every route but /health, before schema validation (unsigned requests
 * learn nothing about the API).
 *
 * The web server in front of the sidecar (Apache + Passenger on cPanel) may deliver the same request twice, the
 * second time while a slow request is still running, and gives Moodle the answer of the second delivery.
 * 10/11/2026: student files (a slow read); 12/11/2026: /session/login with a password, refused as a replay, so that
 * linking the account failed although nothing was replayed by anyone. Now any request (read, write or login)
 * delivered again:
 * - while the first delivery runs: waits for it and gets the same answer;
 * - within ANSWER_TTL after it was answered: gets the same answer again;
 * - later: refused with replayed_request.
 * The request is executed once in every case: a write never reaches Pronote twice.
 */
export const registerAuth = (app) => {
    // Keep the raw body: the HMAC signature covers the exact bytes sent by Moodle.
    app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
        request.rawBody = body;
        try {
            done(null, body === "" ? {} : JSON.parse(body));
        }
        catch {
            done(Object.assign(new Error("invalid_json"), { statusCode: 400 }), undefined);
        }
    });
    app.addHook("preValidation", async (request, reply) => {
        // Public routes: no data (health of the deployment, table of the error codes). /health checks its own signature.
        if (PUBLIC_ROUTES.has(request.routeOptions.url ?? ""))
            return;
        const internal = request.headers[INTERNAL_HEADER];
        if (typeof internal === "string" && internal.length === INTERNAL_TOKEN.length
            && timingSafeEqual(Buffer.from(internal), Buffer.from(INTERNAL_TOKEN))) {
            request.internal = true;
            return;
        }
        // P11 order: signature first; a second delivery of a request still running or just answered is served whatever
        // its age (the web server may deliver it again after the window); a request already seen is a replay; only then
        // the timestamp window applies.
        const signature = checkHmac(request);
        const shared = inflight.has(signature) || (answered.get(signature)?.expires ?? 0) >= Date.now();
        if (!shared && wasSeen(signature)) {
            securityStats.replayed++;
            throw new HttpError(401, "replayed_request");
        }
        if (!shared)
            checkTimestamp(request);
        if (!shared && recordSignature(signature)) {
            arrivals.set(signature, Date.now());
            let resolve;
            inflight.set(signature, new Promise((done) => (resolve = done)));
            request.inflightResolve = (answer) => {
                inflight.delete(signature);
                if (arrivals.size > MAX_KEPT_ANSWERS * 4)
                    arrivals.delete(arrivals.keys().next().value);
                if (!HEALTH_DATA_ROUTES.has(request.routeOptions.url ?? ""))
                    keepAnswer(signature, answer);
                resolve(answer);
            };
            return;
        }
        const kept = answered.get(signature);
        const running = inflight.get(signature) ?? (kept && kept.expires >= Date.now() ? Promise.resolve(kept.answer) : undefined);
        if (!running) {
            securityStats.replayed++;
            throw new HttpError(401, "replayed_request");
        }
        request.log.info({ method: request.method }, "same request delivered again: answered with the result of the first delivery");
        const first = arrivals.get(signature);
        if (first !== undefined)
            duplicateDelays.push({ at: Date.now(), delay: Date.now() - first, running: inflight.has(signature) });
        if (duplicateDelays.length > 1000)
            duplicateDelays.shift();
        const answer = await running;
        reply.code(answer.status).headers(answer.headers).header("x-pronoteio-duplicate", "shared");
        return reply.send(answer.payload);
    });
    // Answer of a request (success or error): shared with the deliveries waiting for it, kept for late ones.
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
//# sourceMappingURL=auth.js.map