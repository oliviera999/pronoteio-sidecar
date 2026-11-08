/**
 * Writes of the messaging: SaisieMessage (tab 131), one function and one "commande" (objetrequetesaisiemessage.js,
 * docs/pronote-matrice/7-communication.md in mood_prod):
 * - "" : new discussion (exactly Pawnote's newDiscussion plus genreDiscussion 0) or reply (bouton + messagePourReponse);
 *   a sent message is IRREVERSIBLE, the "deletion" commands only touch the teacher's own copy;
 * - "brouillon" : draft, with "brouillon" absent to create one or { N, E: 2 } to modify the draft message read by
 *   ListeMessages (brouillon: true); "suppression" with listePossessionsMessages deletes a draft discussion.
 * Recipients come from ListePublics (recipients.ts); a "list" recipient is replaced by the members of the matching
 * ListeDiffusion. Attachments are files uploaded first (POST /files, function SaisieMessage) referenced by
 * { idFichier, nomFichier }, or links { nomFichier, url } (listeFichiers[{ idFichier, nomFichier, url }] in the
 * client: links not validated on a real server).
 * Nothing here forwards, reports, empties the trash or deletes a received message. Every write is refused before
 * any call when the messaging is disabled (right to disconnect: Pronote then answers {} and writes nothing), and
 * the listing is re-read to prove the write. None of these writes has been validated on a real server.
 */
import type { SessionHandle } from "pawnote";
import { HttpError } from "../errors.js";
import { listOf } from "../pronote/encoding.js";
import { hasRight, userData } from "../pronote/userdata.js";
import { normalise, type Discussion, type MessageWrite, type MessageWriteResult, type RecipientKind, type WriteAttachmentRef } from "../normalise.js";
import { callFunction } from "./functions.js";
import { findList, loadLists } from "./lists.js";
import { DISCUSSIONS_REQUEST, discussionsFromAnswer, listDiscussions, messagesRequest, type DiscussionRow } from "./messaging.js";
import { loadAllPublics, RECIPIENT_GENRES, resolveRecipients, type Public } from "./recipients.js";
import { sendWrite } from "./write.js";

export { RECIPIENT_GENRES };
export type { MessageWrite, MessageWriteResult };

const STATE_MODIFIED = 2;
const TYPE_HTML = 21;
/** Genre of a discussion (genreDiscussion): 0 ordinary discussion. */
const DISCUSSION_ORDINARY = 0;

type Target = Pick<Public, "N" | "G" | "L">;

/** listeFichiers members of a message: uploaded files by idFichier, links by url. */
export const filesOf = (attachments: WriteAttachmentRef[] | undefined): Record<string, unknown>[] =>
  (attachments ?? []).map((item) => {
    if (item.fileId) return { idFichier: item.fileId, nomFichier: item.name };
    // not validated on a real server: the client lists { idFichier, nomFichier, url }; a link has no idFichier.
    if (item.url) return { nomFichier: item.name || item.url, url: item.url };
    throw new HttpError(400, "attachment_without_file_or_url");
  });

/** SaisieMessage JSON of a new discussion (exactly Pawnote's newDiscussion, plus genreDiscussion and the files). */
export const newDiscussionRequest = (subject: string, content: unknown, recipients: Target[], files: Record<string, unknown>[] = []): Record<string, unknown> => ({
  objet: subject,
  contenu: content,
  estCreationCarnetLiaison: false,
  listeFichiers: files,
  listeDestinataires: recipients.map((item) => ({ N: item.N, G: item.G, E: STATE_MODIFIED })),
  genreDiscussion: DISCUSSION_ORDINARY,
});

/** SaisieMessage JSON of a reply in a discussion (button and message to answer come from ListeMessages). */
export const replyRequest = (content: unknown, buttonGenre: number, messageN: string, files: Record<string, unknown>[] = []): Record<string, unknown> => ({
  contenu: content,
  bouton: { N: 0, G: buttonGenre },
  messagePourReponse: { N: messageN, G: 0 },
  listeFichiers: files,
});

/** SaisieMessage JSON of a draft: "brouillon" absent to create, { N, E: 2 } to modify. */
export const draftRequest = (subject: string, content: unknown, recipients: Target[], files: Record<string, unknown>[], draftN: string | null): Record<string, unknown> => ({
  commande: "brouillon",
  ...(draftN ? { brouillon: { N: draftN, E: STATE_MODIFIED } } : {}),
  objet: subject,
  contenu: content,
  listeDestinataires: recipients.map((item) => ({ N: item.N, G: item.G, E: STATE_MODIFIED })),
  listeFichiers: files,
});

/** SaisieMessage JSON deleting the teacher's copy of a draft discussion. */
export const deleteDraftRequest = (possessions: { N: string }[]): Record<string, unknown> => ({
  commande: "suppression",
  listePossessionsMessages: possessions.map((item) => ({ N: item.N })),
});

const advancedEditor = (session: SessionHandle): boolean =>
  hasRight(userData(session).rights as Record<string, unknown>, "communication", "avecDiscussionAvancee") === true;

export const contentOf = (session: SessionHandle, text: string): unknown =>
  advancedEditor(session) ? { _T: TYPE_HTML, V: text.split(/\r?\n/).map((line) => `<p>${line}</p>`).join("") } : text;

/** Recipients of a write resolved to Pronote publics: kinds through ListePublics, "list" through ListeDiffusion. */
export const resolveTargets = async (session: SessionHandle, recipients: NonNullable<MessageWrite["recipients"]>): Promise<Target[]> => {
  const direct = recipients.filter((item) => item.kind !== "list") as { kind: RecipientKind; label: string }[];
  const publics = await loadAllPublics(session, direct.map((item) => item.kind));
  const targets: Target[] = resolveRecipients(publics, direct).map((item) => ({ N: item.N, G: item.G, L: item.L }));
  const lists = recipients.filter((item) => item.kind === "list");
  if (lists.length) {
    const rows = await loadLists(session);
    for (const wanted of lists) {
      const row = findList(rows, wanted.label);
      row.members.forEach((member, index) => {
        if (!targets.some((item) => item.N === member.N)) targets.push({ N: member.N, G: member.G, L: row.list.members[index]?.label ?? "" });
      });
    }
  }
  return targets;
};

const result = (
  before: Discussion | null,
  after: MessageWriteResult["after"],
  request: Record<string, unknown>,
  written: boolean,
  irreversible: boolean,
): MessageWriteResult => ({ before, after, request, written, dryRun: !written, irreversible, validated: false });

const requireText = (write: MessageWrite): string => {
  const text = String(write.text ?? "");
  if (text.trim() === "") throw new HttpError(400, "empty_message");
  return text;
};

const requireRow = (rows: DiscussionRow[], id: string | undefined, folder?: "drafts"): DiscussionRow => {
  const row = rows.find((item) => item.discussion.id === id);
  if (!row || (folder && row.discussion.folder !== folder)) throw new HttpError(404, folder ? "draft_not_found" : "discussion_not_found");
  return row;
};

const rereadDiscussions = async (session: SessionHandle): Promise<Discussion[]> =>
  discussionsFromAnswer(await callFunction(session, "discussionsList", DISCUSSIONS_REQUEST)).rows.map((row) => row.discussion);

export const sendMessage = async (session: SessionHandle, write: MessageWrite): Promise<MessageWriteResult> => {
  const listing = await listDiscussions(session);
  if (listing.disabled) throw new HttpError(409, "messaging_disabled");
  const files = filesOf(write.attachments);
  const attachmentNames = (write.attachments ?? []).map((item) => item.name);

  if (write.mode === "new" || write.mode === "draft") {
    const text = requireText(write);
    const content = contentOf(session, text);
    const subject = String(write.subject ?? "").trim();
    if (!subject) throw new HttpError(400, "subject_required");
    if (!write.recipients?.length) throw new HttpError(400, "recipients_required");
    const targets = await resolveTargets(session, write.recipients);
    const irreversible = write.mode === "new";
    const request = irreversible ? newDiscussionRequest(subject, content, targets, files) : draftRequest(subject, content, targets, files, null);
    const after = { subject, recipients: targets.map((item) => item.L), text, attachments: attachmentNames, discussion: null as Discussion | null, deleted: false };
    if (write.dryRun) return result(null, after, request, false, irreversible);
    await sendWrite(session, "messageSave", request);
    const reread = await rereadDiscussions(session);
    const created = reread
      .filter((item) => normalise(item.subject) === normalise(subject) && (irreversible ? item.folder !== "drafts" : item.folder === "drafts"))
      .sort((a, b) => b.lastDate - a.lastDate)[0] ?? null;
    if (!created) throw new HttpError(502, irreversible ? "message_not_saved" : "draft_not_saved");
    return result(null, { ...after, discussion: created }, request, true, irreversible);
  }

  if (write.mode === "reply") {
    const text = requireText(write);
    const row = requireRow(listing.rows, write.discussion);
    const messages = await callFunction(session, "discussionMessages", messagesRequest(row.possessions));
    const button = listOf<any>(messages?.listeBoutons).find((item) => typeof item?.G === "number");
    const target = messages?.messagePourReponse?.V ?? messages?.messagePourReponse;
    if (!button || !target?.N) throw new HttpError(409, "reply_not_possible");
    const request = replyRequest(contentOf(session, text), Number(button.G), String(target.N), files);
    const after = { subject: row.discussion.subject, recipients: row.discussion.participants, text, attachments: attachmentNames, discussion: row.discussion, deleted: false };
    if (write.dryRun) return result(row.discussion, after, request, false, true);
    await sendWrite(session, "messageSave", request);
    const reread = await rereadDiscussions(session);
    const updated = reread.find((item) => item.subject === row.discussion.subject && item.count > row.discussion.count)
      ?? reread.find((item) => item.id === row.discussion.id) ?? null;
    if (!updated) throw new HttpError(502, "message_not_saved");
    return result(row.discussion, { ...after, discussion: updated }, request, true, true);
  }

  const row = requireRow(listing.rows, write.discussion, "drafts");
  if (write.mode === "draft_delete") {
    const request = deleteDraftRequest(row.possessions);
    const after = { subject: row.discussion.subject, recipients: row.discussion.participants, text: "", attachments: [], discussion: null, deleted: true };
    if (write.dryRun) return result(row.discussion, after, request, false, false);
    await sendWrite(session, "messageSave", request);
    const reread = await rereadDiscussions(session);
    if (reread.some((item) => item.id === row.discussion.id && item.folder === "drafts")) throw new HttpError(502, "draft_not_deleted");
    return result(row.discussion, after, request, true, false);
  }

  // draft_update: the draft message (brouillon: true) and its current recipients come from ListeMessages.
  const text = requireText(write);
  const messages = await callFunction(session, "discussionMessages", messagesRequest(row.possessions));
  const draft = listOf<any>(messages?.listeMessages).find((item) => item?.brouillon === true) ?? listOf<any>(messages?.listeMessages)[0];
  if (!draft?.N) throw new HttpError(404, "draft_not_found");
  const subject = String(write.subject ?? row.discussion.subject).trim();
  if (!subject) throw new HttpError(400, "subject_required");
  const targets: Target[] = write.recipients?.length
    ? await resolveTargets(session, write.recipients)
    : listOf<any>(messages?.destinataires?.listeDestinataires).filter((item) => typeof item?.N === "string").map((item) => ({ N: String(item.N), G: Number(item.G ?? 0), L: String(item.L ?? "").trim() }));
  if (!targets.length) throw new HttpError(400, "recipients_required");
  const request = draftRequest(subject, contentOf(session, text), targets, files, String(draft.N));
  const after = { subject, recipients: targets.map((item) => item.L), text, attachments: attachmentNames, discussion: row.discussion, deleted: false };
  if (write.dryRun) return result(row.discussion, after, request, false, false);
  await sendWrite(session, "messageSave", request);
  const reread = await rereadDiscussions(session);
  const updated = reread.filter((item) => item.folder === "drafts" && normalise(item.subject) === normalise(subject)).sort((a, b) => b.lastDate - a.lastDate)[0] ?? null;
  if (!updated) throw new HttpError(502, "draft_not_saved");
  return result(row.discussion, { ...after, discussion: updated }, request, true, false);
};
