import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveWriteMode } from "../src/config.js";
import { entryRefusal } from "../src/pronote/request.js";

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
