import assert from "node:assert/strict";
import { test } from "node:test";
import { assertAccepted, reportMessages } from "../src/teacher/write.js";

test("a RapportSaisie refusal becomes 409 pronote_refused with the client's messages", () => {
  const report = { _erreurSaisie_: true, titre_Messages_Erreur: "Saisie impossible", _messagesErreur_: { _T: 24, V: [{ L: "Période clôturée" }] } };
  assert.equal(reportMessages(report), "Saisie impossible : Période clôturée");
  assert.throws(() => assertAccepted(report, false), /pronote_refused:Saisie impossible : Période clôturée/);
  assert.throws(() => assertAccepted({ refusSaisie: true, titre_Messages_Erreur: "Refus" }, true), /pronote_refused:Refus/);
  assert.throws(() => assertAccepted({ messageRefusDest: "M. X refuse les messages" }, false), /pronote_refused:M. X refuse/);
});

test("a confirmation request is relayed unless forced", () => {
  const report = { demandeConfirmationSaisie: { titre: "Confirmer", message: "Le cahier de textes sera supprimé" } };
  assert.throws(() => assertAccepted(report, false), /confirmation_required:Confirmer : Le cahier de textes sera supprimé/);
  assert.equal(assertAccepted(report, true), report);
  assert.equal(assertAccepted(null, false), null);
  assert.deepEqual(assertAccepted({ listeEvaluationsCreees: [] }, false), { listeEvaluationsCreees: [] });
});
