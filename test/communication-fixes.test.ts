import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { SessionHandle } from "pawnote";
import { rememberUserData } from "../src/pronote/userdata.js";
import { writeDistributionList } from "../src/teacher/lists.js";
import { mailbox } from "../src/teacher/mailboxWrite.js";
import { canReplyFrom, discussionsFromAnswer, messagingPreferences, replyButton } from "../src/teacher/messaging.js";
import { contentOf, escapeHtml, sendMessage } from "../src/teacher/messagingWrite.js";
import { audienceOf, newsResults, newsRowsOf } from "../src/teacher/news.js";
import { isSurveyClosed, newsSaveRequest, writeNews, writeNewsResponse } from "../src/teacher/newsWrite.js";
import { forum } from "../src/teacher/forum.js";
import { fakeSession } from "./fake-session.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const session = {
  information: { url: "https://demo.example/pronote", id: "sess1", aesKey: "0123456789abcdef", aesIV: "fedcba9876543210" },
} as unknown as SessionHandle;

/** The demo listing with the messaging enabled. */
const enabledListing = () => ({ ...fixture("messaging-list"), messagerieDesactivee: false });
const roots = (listing: any) => listing.listeMessagerie.V.filter((row: any) => row.estUneDiscussion && row.profondeur === 0);
const advanced = (handle: SessionHandle) => rememberUserData(handle, { rights: { communication: { avecDiscussionAvancee: true } } });

/* ---- 1. reply proof ---- */

test("a reply ignored by Pronote ({}) is not written: the discussion must have gained a message", async () => {
  let listing = enabledListing();
  const ignoring = fakeSession({ ListeMessagerie: () => listing, ListeMessages: () => fixture("messaging-messages"), SaisieMessage: () => ({}) });
  advanced(ignoring);
  const id = discussionsFromAnswer(listing).rows[0].discussion.id;
  await assert.rejects(sendMessage(ignoring, { mode: "reply", discussion: id, text: "Merci", dryRun: false }), /message_not_saved/);

  // Accepted when the count grows (same id), or when the activity date moved (new id, absent before).
  const grown = fakeSession({
    ListeMessagerie: () => listing,
    ListeMessages: () => fixture("messaging-messages"),
    SaisieMessage: () => {
      listing = enabledListing();
      roots(listing)[0].nombreMessages = 3;
      roots(listing)[0].dateActivite = { _T: 7, V: "08/11/2026" };
      return {};
    },
  });
  advanced(grown);
  const written = await sendMessage(grown, { mode: "reply", discussion: id, text: "Merci", dryRun: false });
  assert.equal(written.written, true);
  assert.equal(written.after.discussion?.count, 3);
  assert.notEqual(written.after.discussion?.id, id, "the id follows the activity date");
});

/* ---- 2. new / draft proofs ---- */

test("a new message or a draft is proved by a discussion absent before the write, never by a pre-existing one", async () => {
  const listing = enabledListing();
  roots(listing)[1].listeEtiquettes = { _T: 24, V: [{ N: "51#x42", G: 4 }] };
  const handlers = {
    ListeMessagerie: () => listing,
    ListePublics: (data: any) => fixture("publics")[String(data.genres.V).replace(/[[\]]/g, "")],
    SaisieMessage: () => ({}),
  };
  const ignoring = fakeSession(handlers);
  advanced(ignoring);
  // "Motivation" already exists in the inbox and in the drafts: an ignored write must not be proved by them.
  await assert.rejects(sendMessage(ignoring, { mode: "new", subject: "Motivation", text: "x", recipients: [{ kind: "class", label: "3A" }], dryRun: false }), /message_not_saved/);
  await assert.rejects(sendMessage(ignoring, { mode: "draft", subject: "Motivation", text: "x", recipients: [{ kind: "class", label: "3A" }], dryRun: false }), /draft_not_saved/);

  let current = listing;
  const creating = fakeSession({
    ...handlers,
    ListeMessagerie: () => current,
    SaisieMessage: () => {
      current = structuredClone(listing);
      current.listeMessagerie.V.push({ N: "0", estUneDiscussion: true, nombreMessages: 1, objet: "Motivation", profondeur: 0, dateActivite: { _T: 7, V: "08/11/2026" },
        listeEtiquettes: { _T: 24, V: [{ N: "51#x42", G: 4 }] }, listePossessionsMessages: { _T: 24, V: [{ N: "108#new" }] } });
      return {};
    },
  });
  advanced(creating);
  const created = await sendMessage(creating, { mode: "draft", subject: "Motivation", text: "x", recipients: [{ kind: "class", label: "3A" }], dryRun: false });
  assert.equal(created.written, true);
  assert.equal(created.after.discussion?.id, "m:Motivation|08/11/2026");
});

test("a draft update is proved by re-reading the draft and finding the sent text", async () => {
  const listing = enabledListing();
  roots(listing)[1].listeEtiquettes = { _T: 24, V: [{ N: "51#x42", G: 4 }] };
  const draft = discussionsFromAnswer(listing).rows.find((row) => row.discussion.folder === "drafts")!;
  let content = "ancien texte";
  const messages = () => ({
    listeMessages: { _T: 24, V: [{ N: "85#d1", brouillon: true, contenu: content, estHTML: false, emetteur: true, listeFichiers: { _T: 24, V: [{ L: "ancien.pdf", N: "67#f1", G: 1 }] } }] },
    destinataires: { listeDestinataires: { _T: 24, V: [{ L: "Mme COLLEGUE A.", N: "109#t2", G: 3 }] } },
  });
  const ignoring = fakeSession({ ListeMessagerie: () => listing, ListeMessages: messages, SaisieMessage: () => ({}) });
  const attempt = sendMessage(ignoring, { mode: "draft_update", discussion: draft.discussion.id, text: "nouveau texte", dryRun: false });
  await assert.rejects(attempt, /draft_not_saved/);
  const applying = fakeSession({ ListeMessagerie: () => listing, ListeMessages: messages, SaisieMessage: (sent) => {
    content = String(sent!.contenu);
    return {};
  } });
  const written = await sendMessage(applying, { mode: "draft_update", discussion: draft.discussion.id, text: "nouveau texte", dryRun: false });
  assert.equal(written.written, true);
  assert.deepEqual(written.before?.attachments, ["ancien.pdf"], "the draft's attachment names are in the state before");
  assert.equal(written.before?.text, "ancien texte", "text before the write");
});

/* ---- 3. escaping ---- */

test("plain text is HTML-escaped before being wrapped in paragraphs (advanced editor)", () => {
  assert.equal(escapeHtml('a & b < c > "d"'), "a &amp; b &lt; c &gt; &quot;d&quot;");
  const handle = { information: {} } as unknown as SessionHandle;
  advanced(handle);
  assert.deepEqual(contentOf(handle, 'Bonjour <M. X>,\nvoir "a & b"'), { _T: 21, V: "<p>Bonjour &lt;M. X&gt;,</p><p>voir &quot;a &amp; b&quot;</p>" });
  rememberUserData(handle, { rights: {} });
  assert.equal(contentOf(handle, "a < b"), "a < b", "plain text without the advanced editor");
});

/* ---- 5, 6, 7, 12. news ownership, proofs, text-only update, audience ---- */

const sentPage = () => fixture("news-page");
const sentRows = () => newsRowsOf(session, sentPage(), "sent");

test("an item of another author cannot be modified, deleted or published; deletion is proved by the id leaving the account's lists", async () => {
  const page = sentPage();
  page.listeModesAff[1].listeActualites.V[0].estVerrouille = false;
  page.listeModesAff[1].listeActualites.V[1].estVerrouille = false;
  const [mine, shared] = newsRowsOf(session, page, "sent").map((row) => row.item);
  assert.equal(mine.mine, true);
  assert.equal(shared.mine, false);
  rememberUserData(session, { tabs: null });
  const fake = fakeSession({ PageActualites: () => page, SaisieActualites: () => ({}) });
  advanced(fake);
  await assert.rejects(writeNews(fake, { mode: "delete", id: shared.id }, false), /pronote_refused:Information d'un autre auteur/);
  await assert.rejects(writeNews(fake, { mode: "publish", id: shared.id }, true), /pronote_refused/);
  // Ignored deletion of one's own item: the id is still listed → not saved (the title of the colleague's item is irrelevant).
  await assert.rejects(writeNews(fake, { mode: "delete", id: mine.id }, false), /news_not_saved/);
  let current = page;
  const deleting = fakeSession({ PageActualites: () => current, SaisieActualites: () => {
    current = structuredClone(page);
    current.listeModesAff[1].listeActualites.V.shift();
    return {};
  } });
  const deleted = await writeNews(deleting, { mode: "delete", id: mine.id }, false);
  assert.equal(deleted.written, true);
  assert.equal(deleted.irreversible, true, "a published item");
});

test("creation is proved by a new id of the account, not by a pre-existing item with the same title", async () => {
  const page = sentPage();
  const handlers = {
    PageActualites: () => page,
    DonneesEditionInformation: () => ({ tailleMaxTitre: 200, tailleMaxReponse: 500 }),
    ListePublics: (data: any) => fixture("publics")[String(data.genres.V).replace(/[[\]]/g, "")],
    SaisieActualites: () => ({}),
  };
  const ignoring = fakeSession(handlers);
  advanced(ignoring);
  // "SVT" exists already in the sent mode, written by the account: an ignored creation must not be proved by it.
  await assert.rejects(writeNews(ignoring, { mode: "create", kind: "information", title: "SVT", text: "<p>x</p>", start: 1_800_000_000, audience: { classes: ["3A"] } }, false), /news_not_saved/);
  let current = page;
  const creating = fakeSession({ ...handlers, PageActualites: () => current, SaisieActualites: () => {
    current = structuredClone(page);
    current.listeModesAff[2].listeActualites.V.push({ L: "SVT", N: "65#new", estInformation: true, estAuteur: true, publie: false, etatPublication: 3, dateDebut: { _T: 7, V: "15/01/2027" } });
    return {};
  } });
  advanced(creating);
  const created = await writeNews(creating, { mode: "create", kind: "information", title: "SVT", text: "<p>x</p>", start: 1_800_000_000, audience: { classes: ["3A"] } }, false);
  assert.equal(created.written, true);
  assert.equal(created.after?.scope, "drafts");
  assert.equal(created.after?.published, false);
});

test("updating the text of an information replaces its question; the public is only modified when an audience is given", () => {
  const existing = {
    N: "65#x13", L: "SVT", estInformation: true, estSondage: false, publie: false,
    listeQuestions: { _T: 24, V: [{ N: "66#q1", genreReponse: 4, texte: { _T: 21, V: "<p>ancien</p>" } }] },
    listePublicEntite: { _T: 24, V: [{ N: "23#c1", G: 1, L: "3A" }] }, avecResp1: true,
  };
  const request = newsSaveRequest({ mode: "update", text: "<p>nouveau</p>" }, existing, null, { entities: [], individuals: [] });
  const [item] = request.listeActualites as any[];
  assert.equal(item.E, 2);
  assert.equal(item.publie, false);
  assert.equal(item.listeQuestions.length, 2);
  assert.equal(item.listeQuestions[0].E, 3, "the old question is deleted");
  assert.equal(item.listeQuestions[1].E, 1);
  assert.deepEqual(item.listeQuestions[1].texte, { _T: 21, V: "<p>nouveau</p>" });
  assert.equal(item.avecModificationPublic, false, "no audience given");
  assert.deepEqual(item.listePublicEntite, { _T: 24, V: [{ N: "23#c1", G: 1, L: "3A" }] }, "existing public kept");
  assert.equal(item.avecResp1, true);
  const untouched = (newsSaveRequest({ mode: "update", title: "SVT 2" }, existing, null, { entities: [], individuals: [] }).listeActualites as any[])[0];
  assert.equal(untouched.listeQuestions.length, 1, "no text, no questions: the existing question is kept");
  const withAudience = (newsSaveRequest({ mode: "update", audience: { classes: ["3B"] } }, existing, null, { entities: [{ N: "23#c2", G: 1 }], individuals: [] }).listeActualites as any[])[0];
  assert.equal(withAudience.avecModificationPublic, true);
  assert.deepEqual(withAudience.listePublicEntite, [{ N: "23#c2", G: 1 }]);
});

test("the audience of a sent or draft item is read from its raw members (labels only), null when Pronote sends none", () => {
  assert.equal(sentRows()[0].item.audience, null, "the demo page carries no public member");
  const raw = {
    listePublicEntite: { _T: 24, V: [{ N: "23#c1", G: 1, L: "3A" }, { N: "24#g1", G: 2, L: "3A-GR1" }] },
    listePublicIndividu: { _T: 24, V: [{ N: "109#t2", G: 3, L: "Mme COLLEGUE A." }] },
    avecEleve: true, avecResp1: true, avecResp2: true, avecProfsPrincipaux: false, avecTuteurs: true,
  };
  assert.deepEqual(audienceOf(raw), {
    classes: ["3A"], groups: ["3A-GR1"], students: true, parents: "all", mainTeachers: false, tutors: true,
    individuals: [{ label: "Mme COLLEGUE A.", kind: "teacher" }],
  });
  assert.equal(audienceOf({ ...raw, avecResp2: false })?.parents, "one");
  assert.ok(!JSON.stringify(audienceOf(raw)).includes("#"));
  const page = sentPage();
  Object.assign(page.listeModesAff[1].listeActualites.V[0], raw);
  assert.deepEqual(newsRowsOf(session, page, "sent")[0].item.audience?.classes, ["3A"]);
});

/* ---- 8. tab_closed and access_denied ---- */

test("writes are refused with tab_closed:<function> before any call when their tab is closed", async () => {
  const handle = fakeSession({});
  rememberUserData(handle, { tabs: [16] });
  await assert.rejects(sendMessage(handle, { mode: "draft", subject: "x", text: "y", recipients: [{ kind: "class", label: "3A" }], dryRun: true }), /tab_closed:SaisieMessage/);
  await assert.rejects(mailbox(handle, "read", ["m:x"], true), /tab_closed:SaisieMessage/);
  await assert.rejects(writeDistributionList(handle, { action: "create", label: "x", members: [] }, true), /tab_closed:SaisieListeDiffusion/);
  await assert.rejects(writeNews(handle, { mode: "create", kind: "information", title: "x", text: "y", start: 1, audience: { classes: ["3A"] } }, true), /tab_closed:SaisieActualites/);
  await assert.rejects(writeNewsResponse(handle, "n:x", { read: true }, true), /tab_closed:SaisieActualites/);
  assert.equal(handle.calls.length, 0);
});

test("refusals in reading are never 502: preferences and results answer tab_closed, forum posts access_denied", async () => {
  const prefs = fakeSession({ ListeMessagerie: () => fixture("messaging-list") });
  await assert.rejects(messagingPreferences(prefs), /tab_closed:PreferenceMessagerie/);
  const page = sentPage();
  const results = fakeSession({ PageActualites: () => page });
  await assert.rejects(newsResults(results, sentRows()[1].item.id), /tab_closed:PageActualitesResultats/);
  const data = fixture("forum");
  const posts = fakeSession({ ForumPedagogique: (sent) => (sent?.type === "fpcr_Sujets" ? data.topics : { Erreur: { Titre: "Vos droits sont insuffisants" } }) });
  const detail = await forum(posts, "ft:Exposés sur l'énergie|05/11/2026 10:15:00");
  assert.equal(detail.available, false);
  assert.equal(detail.reason, "access_denied");
});

/* ---- 10. folders ---- */

test("several labels on a row: trash > archive > drafts > sent > inbox; unarchive of a sent discussion is proved by any folder but archive", async () => {
  const listing = enabledListing();
  roots(listing)[0].listeEtiquettes = { _T: 24, V: [{ N: "51#x43", G: 5 }, { N: "51#x41", G: 2 }] };
  roots(listing)[1].listeEtiquettes = { _T: 24, V: [{ N: "51#x41", G: 2 }, { N: "51#x47", G: 7 }, { N: "51#sent", G: 3 }] };
  const rows = discussionsFromAnswer(listing).rows;
  assert.equal(rows[0].discussion.folder, "trash");
  assert.equal(rows[1].discussion.folder, "archive");
  let current = listing;
  const handle = fakeSession({ ListeMessagerie: () => current, SaisieMessage: (sent) => {
    assert.equal(sent?.commande, "archive");
    assert.equal(sent?.archiver, false);
    current = structuredClone(listing);
    roots(current)[1].listeEtiquettes = { _T: 24, V: [{ N: "51#sent", G: 3 }] };
    return {};
  } });
  const result = await mailbox(handle, "unarchive", [rows[1].discussion.id], false);
  assert.equal(result.written, true);
  assert.equal(result.after[0].folder, "sent");
});

/* ---- 11. reply button ---- */

test("the send button is the one labelled Envoyer, else the first with a genre", () => {
  const data = { listeBoutons: { _T: 24, V: [{ G: 4, L: "Répondre à tous" }, { G: 2, L: "Envoyer" }] }, messagePourReponse: { _T: 24, V: { N: "85#m" } } };
  assert.deepEqual(replyButton(data), { G: 2, L: "Envoyer" });
  assert.equal(replyButton({ listeBoutons: [{ G: 4, L: "Autre" }] })?.G, 4);
  assert.equal(canReplyFrom(data), true);
  assert.equal(canReplyFrom({ listeBoutons: [] }), false);
});

/* ---- 13. end of day, error codes ---- */

test("a survey stays open until the end of the day of dateFin; local validation errors are invalid_request:<code>", async () => {
  const item = { ...sentRows()[0].item, locked: false, end: Math.floor(new Date(2026, 10, 30).getTime() / 1000) };
  assert.equal(isSurveyClosed(item, new Date(2026, 10, 30, 18, 0)), false);
  assert.equal(isSurveyClosed(item, new Date(2026, 11, 1, 0, 0, 1)), true);
  const handle = fakeSession({ ListeMessagerie: () => enabledListing() });
  await assert.rejects(sendMessage(handle, { mode: "new", subject: "", text: "x", recipients: [{ kind: "class", label: "3A" }], dryRun: true }), /^Error: invalid_request:subject_required$/);
  await assert.rejects(sendMessage(handle, { mode: "new", subject: "x", text: " ", dryRun: true }), /invalid_request:empty_message/);
  await assert.rejects(sendMessage(handle, { mode: "new", subject: "x", text: "y", dryRun: true }), /invalid_request:recipients_required/);
  const lists = fakeSession({ ListeDiffusion: () => fixture("distribution-lists") });
  await assert.rejects(writeDistributionList(lists, { action: "update" }, true), /invalid_request:list_id_required/);
  await assert.rejects(writeDistributionList(lists, { action: "create", label: " " }, true), /invalid_request:label_required/);
});
