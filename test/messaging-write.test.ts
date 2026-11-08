import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionHandle } from "pawnote";
import { draftRequest, deleteDraftRequest, filesOf, newDiscussionRequest, RECIPIENT_GENRES, replyRequest } from "../src/teacher/messagingWrite.js";
import { publicsOf, resolveRecipients } from "../src/teacher/recipients.js";

const session = { information: { url: "https://demo.example/pronote", id: "sess1" } } as unknown as SessionHandle;

/* Recipient items as ListePublics answers them on the demo server (captures 0077-0084), anonymised; nothing
   personal is kept beyond the label. */
const students = publicsOf(session, "student", {
  listePublics: { _T: 24, V: [
    { L: "ELEVE Un", N: "46#x1", G: 4, P: 6, discussionInterdit: false, enseigne: true, regimeEleve: { V: {} }, listeProjetsAcc: { V: [] } },
    { L: "ELEVE Deux", N: "46#x2", G: 4, P: 7, discussionInterdit: true },
    { L: "ELEVE Trois", N: "46#x3", G: 4 },
    { L: "ELEVE Trois", N: "46#x4", G: 4 },
  ] },
});
const classes = publicsOf(session, "class", { listePublics: { _T: 24, V: [{ L: "3C", N: "23#k1", G: 1 }] } });

test("publics keep only the identifier, the label and the refusal flag", () => {
  assert.deepEqual({ N: students[0].N, G: students[0].G, L: students[0].L, refuses: students[0].refuses }, { N: "46#x1", G: 4, L: "ELEVE Un", refuses: false });
  assert.equal(students[1].refuses, true);
  assert.equal(RECIPIENT_GENRES.parent, 5);
  assert.ok(!JSON.stringify(students.map((item) => item.recipient)).includes("46#"), "no raw Pronote id in the minimised recipient");
});

test("recipients are resolved by label; unknown, ambiguous and refusing ones are rejected", () => {
  const publics = { class: classes, student: students };
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
  assert.deepEqual(replyRequest({ _T: 21, V: "<p>Merci</p>" }, 2, "85#m1", [], -1), {
    contenu: { _T: 21, V: "<p>Merci</p>" },
    bouton: { N: 0, G: 2 },
    brouillon: { N: -1, E: 1 },
    genreDiscussion: 0,
    messagePourReponse: { N: "85#m1", G: 0 },
    listeFichiers: [],
  }, "Pawnote's discussionSendMessage: a temporary draft and genreDiscussion 0 beside the button");
  const generated = replyRequest("x", 2, "85#m1") as any;
  assert.ok(Number.isInteger(generated.brouillon.N) && generated.brouillon.N < 0, "a negative temporary id is generated");
});

test("a draft is saved with the brouillon command, created without 'brouillon' and modified with { N, E: 2 }", () => {
  const files = filesOf([{ name: "sortie.pdf", fileId: "reqUpl_1_1" }, { name: "Site", url: "https://example.org" }]);
  assert.deepEqual(files, [{ idFichier: "reqUpl_1_1", nomFichier: "sortie.pdf" }, { nomFichier: "Site", url: "https://example.org" }]);
  assert.throws(() => filesOf([{ name: "x" }]), /invalid_request:attachment_without_file_or_url/);
  assert.deepEqual(draftRequest("Sortie", "Bonjour", [students[0]], files, null), {
    commande: "brouillon",
    objet: "Sortie",
    contenu: "Bonjour",
    listeDestinataires: [{ N: "46#x1", G: 4, E: 2 }],
    listeFichiers: files,
  });
  const update = draftRequest("Sortie", "Bonjour", [students[0]], [], "85#d1");
  assert.deepEqual(update.brouillon, { N: "85#d1", E: 2 });
  assert.deepEqual(deleteDraftRequest([{ N: "108#p1" }, { N: "108#p2" }]), { commande: "suppression", listePossessionsMessages: [{ N: "108#p1" }, { N: "108#p2" }] });
  assert.deepEqual(newDiscussionRequest("S", "B", [classes[0]], files).listeFichiers, files);
});
