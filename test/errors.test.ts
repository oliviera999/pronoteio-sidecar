import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp, get } from "./helpers/app.js";

const { ERROR_CODES, errorBody, stableCode } = await import("../src/errorCodes.js");
const { HttpError, RateLimitedError } = await import("../src/errors.js");
const { sessionLostError } = await import("../src/session.js");

/** One simulated case per stable code: historical error → stable code (and the members of the case). */
const cases: [number, string, string, Record<string, unknown>?][] = [
  [429, "rate_limited", "rate_limited", { retry_after: 7 }],
  [401, "session_expired", "session_expired"],
  [401, "session_expired", "session_replaced", { code: "session_replaced" }],
  [401, "bad_credentials", "login_failed"],
  [409, "pin_required", "login_failed"],
  [502, "pronote_error", "pronote_unavailable"],
  [503, "pronote_unavailable", "pronote_unavailable", { reason: "second_process" }],
  [502, "pronote_format_changed:PageEmploiDuTemps:ListeCours", "pronote_format_changed"],
  [409, "pronote_format_changed", "pronote_format_changed", { reason: "unvalidated_version" }],
  [404, "lesson_not_found", "not_found"],
  [404, "student_not_found", "not_found"],
  [409, "lesson_ambiguous:l:2026-11-12 17:10|T06|AP|r:B12 ; l:2026-11-12 17:10|T06|AP|r:B14", "ambiguous"],
  [403, "write_mode_simulate", "forbidden"],
  [409, "tab_closed:FicheEleve", "forbidden"],
  [409, "pronote_refused:Saisie impossible : MARTIN Léa", "forbidden"],
  [400, "invalid_request", "validation_failed"],
  [400, "validation_failed:local.date", "validation_failed"],
  [401, "replayed_request", "duplicate_write"],
  [409, "web_session_required", "web_session_required", { onglet: 56, function: "PageCompetencesParEvaluation" }],
  [409, "web_session_required_after_write", "web_session_required", { onglet: 56, function: "SaisieEvaluations" }],
  [401, "web_session_expired", "web_session_expired"],
  [401, "web_token_refused", "login_failed"],
  [500, "boom", "internal"],
  [501, "not_implemented:x", "internal"],
];

test("every stable code is produced by a simulated case, the historical error is kept", () => {
  const produced = new Set<string>();
  for (const [status, error, code, extra] of cases) {
    const body = errorBody(status, error, extra ?? {});
    assert.equal(body.code, code, error);
    assert.equal(body.error, error, "historical error unchanged (local_pronoteio 2026112100)");
    assert.equal(typeof body.message, "string");
    produced.add(String(body.code));
  }
  assert.deepEqual([...produced].sort(), ERROR_CODES.map((item) => item.code).sort());
  const ambiguous = errorBody(409, cases[11][1]);
  assert.deepEqual(ambiguous.candidates, ["l:2026-11-12 17:10|T06|AP|r:B12", "l:2026-11-12 17:10|T06|AP|r:B14"]);
  assert.deepEqual(errorBody(400, "validation_failed:local.date").fields, ["local.date"]);
  assert.equal(errorBody(429, "rate_limited", new RateLimitedError(3).extra).retry_after, 3);
  assert.equal(errorBody(401, "session_expired", sessionLostError("replaced").extra).code, "session_replaced");
  assert.equal(stableCode(418, "x"), "internal");
  void HttpError;
});

test("no message carries a name or a value from Pronote", () => {
  for (const [status, error, , extra] of cases) {
    const body = errorBody(status, error, extra ?? {});
    assert.doesNotMatch(String(body.message), /MARTIN|Léa|T06|ListeCours|FicheEleve/);
  }
  for (const item of ERROR_CODES) assert.doesNotMatch(item.message, /[A-Z]{3,} [A-Z][a-zé]+/);
});

test("GET /errors (public), 404, schema validation and expired session in the app", async () => {
  const app = await buildApp({ logger: false });
  const table = await app.inject({ method: "GET", url: "/errors" });
  assert.equal(table.statusCode, 200);
  assert.equal(table.json().codes.length, ERROR_CODES.length);
  assert.ok(table.json().codes.every((item: any) => item.code && item.message && item.status));

  const missing = await get(app, "/nope");
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().code, "not_found");

  const invalid = await get(app, "/roster", "s");
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error, "invalid_request");
  assert.equal(invalid.json().code, "validation_failed");
  assert.deepEqual(invalid.json().fields, ["resource"]);

  const expired = await get(app, "/roster?resource=c%3AT06", "inconnue");
  assert.equal(expired.statusCode, 401);
  assert.equal(expired.json().error, "session_expired");
  assert.equal(expired.json().code, "session_expired");
  assert.match(expired.json().message, /expiré/);
  await app.close();
});
