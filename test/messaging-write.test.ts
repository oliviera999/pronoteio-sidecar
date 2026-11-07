import assert from "node:assert/strict";
import { test } from "node:test";
import { newDiscussionRequest, publicsOf, RECIPIENT_GENRES, replyRequest, resolveRecipients } from "../src/teacher/messagingWrite.js";

/* Recipient items as ListePublics answers them on the demo server (captures 0077-0084), anonymised; nothing
   personal is kept beyond the label. */
const students = publicsOf({
  listePublics: { _T: 24, V: [
    { L: "ELEVE Un", N: "46#x1", G: 4, P: 6, discussionInterdit: false, enseigne: true, regimeEleve: { V: {} }, listeProjetsAcc: { V: [] } },
    { L: "ELEVE Deux", N: "46#x2", G: 4, P: 7, discussionInterdit: true },
    { L: "ELEVE Trois", N: "46#x3", G: 4 },
    { L: "ELEVE Trois", N: "46#x4", G: 4 },
  ] },
});
const classes = publicsOf({ listePublics: { _T: 24, V: [{ L: "3C", N: "23#k1", G: 1 }] } });

test("publics keep only the identifier, the label and the refusal flag", () => {
  assert.deepEqual(students[0], { N: "46#x1", G: 4, L: "ELEVE Un", refuses: false });
  assert.equal(students[1].refuses, true);
  assert.equal(RECIPIENT_GENRES.parent, 5);
});

test("recipients are resolved by label; unknown, ambiguous and refusing ones are rejected", () => {
  const publics = { class: classes, teacher: [], student: students, parent: [], staff: [] };
  assert.deepEqual(resolveRecipients(publics, [{ kind: "student", label: "eleve un" }, { kind: "class", label: "3C" }]).map((item) => item.N), ["46#x1", "23#k1"]);
  assert.throws(() => resolveRecipients(publics, [{ kind: "student", label: "INCONNU" }]), /recipient_not_found:INCONNU/);
  assert.throws(() => resolveRecipients(publics, [{ kind: "student", label: "ELEVE Trois" }]), /recipient_ambiguous:ELEVE Trois/);
  assert.throws(() => resolveRecipients(publics, [{ kind: "student", label: "ELEVE Deux" }]), /recipient_refuses:ELEVE Deux/);
});

test("SaisieMessage requests follow Pawnote's newDiscussion plus genreDiscussion, and the reply shape of the client", () => {
  assert.deepEqual(newDiscussionRequest("Sortie", "Bonjour", [students[0], classes[0]]), {
    objet: "Sortie",
    contenu: "Bonjour",
    estCreationCarnetLiaison: false,
    listeFichiers: [],
    listeDestinataires: [{ N: "46#x1", G: 4, E: 2 }, { N: "23#k1", G: 1, E: 2 }],
    genreDiscussion: 0,
  });
  assert.deepEqual(replyRequest({ _T: 21, V: "<p>Merci</p>" }, 2, "85#m1"), {
    contenu: { _T: 21, V: "<p>Merci</p>" },
    bouton: { N: 0, G: 2 },
    messagePourReponse: { N: "85#m1", G: 0 },
    listeFichiers: [],
  });
});
