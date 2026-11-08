import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { rememberUserData } from "../src/pronote/userdata.js";
import { expectedState, mailbox, mailboxRequest } from "../src/teacher/mailboxWrite.js";
import { discussionsFromAnswer } from "../src/teacher/messaging.js";
import { sendMessage } from "../src/teacher/messagingWrite.js";
import { fakeSession } from "./fake-session.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
/** The demo listing with the messaging enabled. */
const enabledListing = () => ({ ...fixture("messaging-list"), messagerieDesactivee: false });

test("mailbox requests: pourLu, archive, corbeille, restauration on the possessions; each action has an inverse state", () => {
  const possessions = [{ N: "108#x50" }, { N: "108#x51" }];
  assert.deepEqual(mailboxRequest("read", possessions), { commande: "pourLu", listePossessionsMessages: possessions, lu: true });
  assert.deepEqual(mailboxRequest("unread", possessions), { commande: "pourLu", listePossessionsMessages: possessions, lu: false });
  assert.deepEqual(mailboxRequest("archive", possessions), { commande: "archive", listePossessionsMessages: possessions, archiver: true });
  assert.deepEqual(mailboxRequest("unarchive", possessions), { commande: "archive", listePossessionsMessages: possessions, archiver: false });
  assert.deepEqual(mailboxRequest("trash", possessions), { commande: "corbeille", listePossessionsMessages: possessions });
  assert.deepEqual(mailboxRequest("restore", possessions), { commande: "restauration", listePossessionsMessages: possessions });
  const inbox = { id: "m:x", subject: "x", folder: "inbox" as const, unread: true };
  assert.equal(expectedState("read", inbox).unread, false);
  assert.equal(expectedState("unread", expectedState("read", inbox)).unread, true);
  assert.equal(expectedState("archive", inbox).folder, "archive");
  assert.equal(expectedState("unarchive", expectedState("archive", inbox)).folder, "inbox");
  assert.equal(expectedState("trash", inbox).folder, "trash");
  assert.equal(expectedState("restore", expectedState("trash", inbox)).folder, "inbox");
});

test("POST /messages/mailbox (dryRun) reads the listing, builds one request for every discussion and plans the state", async () => {
  const session = fakeSession({ ListeMessagerie: () => enabledListing() });
  const ids = discussionsFromAnswer(enabledListing()).rows.map((row) => row.discussion.id);
  const result = await mailbox(session, "read", [ids[0]], true);
  assert.equal(result.written, false);
  assert.equal(result.validated, false);
  assert.equal(result.before[0].unread, true);
  assert.equal(result.after[0].unread, false);
  assert.deepEqual(result.requests, [{ commande: "pourLu", listePossessionsMessages: [{ N: "108#x50" }, { N: "108#x51" }], lu: true }]);
  await assert.rejects(mailbox(session, "trash", ["m:absente"], true), /discussion_not_found/);
  assert.ok(session.calls.every((call) => call.name !== "SaisieMessage"));
});

test("every messaging write is refused with messaging_disabled before any SaisieMessage when the messaging is disabled", async () => {
  const session = fakeSession({ ListeMessagerie: () => fixture("messaging-list") });
  const ids = discussionsFromAnswer(fixture("messaging-list")).rows.map((row) => row.discussion.id);
  await assert.rejects(mailbox(session, "archive", [ids[0]], true), /messaging_disabled/);
  await assert.rejects(sendMessage(session, { mode: "draft", subject: "Test", text: "Bonjour", recipients: [{ kind: "teacher", label: "x" }], dryRun: true }), /messaging_disabled/);
  await assert.rejects(sendMessage(session, { mode: "new", subject: "Test", text: "Bonjour", recipients: [{ kind: "teacher", label: "x" }], dryRun: false }), /messaging_disabled/);
  assert.ok(session.calls.every((call) => call.name === "ListeMessagerie"));
});

test("a draft (dryRun) resolves its recipients, expands a distribution list and builds the brouillon command", async () => {
  const session = fakeSession({
    ListeMessagerie: () => enabledListing(),
    ListePublics: (data) => fixture("publics")[String(data!.genres.V).replace(/[[\]]/g, "")],
    ListeDiffusion: () => fixture("distribution-lists"),
  });
  rememberUserData(session, { rights: { communication: { avecDiscussionAvancee: true } } });
  const result = await sendMessage(session, {
    mode: "draft",
    subject: "Sortie musée",
    text: "Bonjour,\nvoici les informations.",
    recipients: [{ kind: "class", label: "3A" }, { kind: "list", label: "Équipe 3A" }],
    attachments: [{ name: "programme.pdf", fileId: "reqUpl_1_1" }],
    dryRun: true,
  });
  assert.equal(result.written, false);
  assert.equal(result.irreversible, false);
  assert.equal(result.validated, false);
  assert.deepEqual(result.after.recipients, ["3A", "Mme COLLEGUE A.", "Mme DIRECTION H."]);
  assert.deepEqual(result.request, {
    commande: "brouillon",
    objet: "Sortie musée",
    contenu: { _T: 21, V: "<p>Bonjour,</p><p>voici les informations.</p>" },
    listeDestinataires: [{ N: "23#c1", G: 1, E: 2 }, { N: "109#t2", G: 3, E: 2 }, { N: "106#s1", G: 34, E: 2 }],
    listeFichiers: [{ idFichier: "reqUpl_1_1", nomFichier: "programme.pdf" }],
  });
  assert.ok(!("brouillon" in result.request), "a creation sends no brouillon member");
  await assert.rejects(sendMessage(session, { mode: "draft", subject: "x", text: "y", recipients: [{ kind: "list", label: "Inconnue" }], dryRun: true }), /list_not_found/);
  await assert.rejects(sendMessage(session, { mode: "draft_update", discussion: "m:absente", text: "y", dryRun: true }), /draft_not_found/);
  await assert.rejects(sendMessage(session, { mode: "new", subject: "x", text: "y", recipients: [{ kind: "teacher", label: "M. AUTRE B." }], dryRun: true }), /recipient_refuses/);
  assert.ok(session.calls.every((call) => call.name !== "SaisieMessage"));
});

test("a draft of the drafts folder is updated with { N, E: 2 } of its message and deleted with the suppression command", async () => {
  const listing = enabledListing();
  // The second discussion of the demo becomes a draft.
  const roots = listing.listeMessagerie.V.filter((row: any) => row.estUneDiscussion && row.profondeur === 0);
  roots[1].listeEtiquettes = { _T: 24, V: [{ N: "51#x42", G: 4 }] };
  const session = fakeSession({
    ListeMessagerie: () => listing,
    ListeMessages: () => ({
      listeMessages: { _T: 24, V: [{ N: "85#d1", brouillon: true, contenu: "ancien texte", estHTML: false, emetteur: true }] },
      destinataires: { listeDestinataires: { _T: 24, V: [{ L: "Mme COLLEGUE A.", N: "109#t2", G: 3 }] } },
    }),
  });
  const draft = discussionsFromAnswer(listing).rows.find((row) => row.discussion.folder === "drafts")!;
  assert.equal(draft.discussion.draft, true);
  const updated = await sendMessage(session, { mode: "draft_update", discussion: draft.discussion.id, text: "nouveau texte", dryRun: true });
  assert.deepEqual(updated.request, {
    commande: "brouillon",
    brouillon: { N: "85#d1", E: 2 },
    objet: draft.discussion.subject,
    contenu: "nouveau texte",
    listeDestinataires: [{ N: "109#t2", G: 3, E: 2 }],
    listeFichiers: [],
  });
  assert.deepEqual(updated.after.recipients, ["Mme COLLEGUE A."]);
  const deleted = await sendMessage(session, { mode: "draft_delete", discussion: draft.discussion.id, dryRun: true });
  assert.deepEqual(deleted.request, { commande: "suppression", listePossessionsMessages: draft.possessions });
  assert.equal(deleted.after.deleted, true);
  assert.equal(deleted.irreversible, false);
  const inbox = discussionsFromAnswer(listing).rows.find((row) => row.discussion.folder === "inbox")!;
  await assert.rejects(sendMessage(session, { mode: "draft_delete", discussion: inbox.discussion.id, dryRun: true }), /draft_not_found/, "only a draft may be deleted");
});
