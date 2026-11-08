import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionHandle } from "pawnote";
import { resolveWriteMode } from "../src/config.js";
import { MIN_SPACING_MS, recentCalls, throttle } from "../src/pronote/limiter.js";
import { entryRefusal } from "../src/pronote/request.js";

test("calls are spaced and counted per session", async () => {
  const session = {} as SessionHandle;
  const started = Date.now();
  await throttle(session, 0);
  await throttle(session, 0);
  assert.ok(Date.now() - started >= MIN_SPACING_MS - 5);
  assert.equal(recentCalls(session), 2);
});

test("the ceiling per minute answers 429 rate_limited", async () => {
  const session = {} as SessionHandle;
  await throttle(session, 2);
  await throttle(session, 2);
  await assert.rejects(throttle(session, 2), /rate_limited/);
  // Another session has its own counter.
  await throttle({} as SessionHandle, 2);
});

test("a RapportSaisie refusal becomes an error, an ordinary answer does not", () => {
  assert.equal(entryRefusal({ listeEleves: [] }), null);
  assert.equal(entryRefusal({ RapportSaisie: { _erreurSaisie_: false, _messagesErreur_: { _T: 24, V: [] } } }), null);
  assert.equal(
    entryRefusal({ RapportSaisie: { _erreurSaisie_: true, titre_Messages_Erreur: "Saisie impossible", _messagesErreur_: { _T: 24, V: [{ L: "Période clôturée" }] } } }),
    "Saisie impossible : Période clôturée",
  );
  assert.equal(entryRefusal({ RapportSaisie: { _erreurSaisie_: true } }), "Saisie refusée par Pronote");
});

test("the write mode defaults to simulate and keeps the older setting as an alias", () => {
  assert.equal(resolveWriteMode({}), "simulate");
  assert.equal(resolveWriteMode({ PRONOTEIO_WRITE_MODE: "live" }), "live");
  assert.equal(resolveWriteMode({ PRONOTEIO_WRITE_MODE: "LIVE " }), "live");
  assert.equal(resolveWriteMode({ PRONOTEIO_WRITE_MODE: "other" }), "simulate");
  assert.equal(resolveWriteMode({ PRONOTEIO_ENABLE_GRADE_WRITE: "true" }), "live");
  assert.equal(resolveWriteMode({ PRONOTEIO_WRITE_MODE: "simulate", PRONOTEIO_ENABLE_GRADE_WRITE: "true" }), "simulate");
});
