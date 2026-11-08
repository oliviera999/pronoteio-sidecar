/**
 * Writes of the messaging: SaisieMessage (tab 131), one function and one "commande" (objetrequetesaisiemessage.js,
 * docs/pronote-matrice/7-communication.md in mood_prod):
 * - "" : new discussion (exactly Pawnote's newDiscussion plus genreDiscussion 0) or reply (Pawnote's
 *   discussionSendMessage: bouton, messagePourReponse, genreDiscussion 0 and a brouillon { N: <negative id>, E: 1 });
 *   a sent message is IRREVERSIBLE, the "deletion" commands only touch the teacher's own copy;
 * - "brouillon" : draft, with "brouillon" absent to create one or { N, E: 2 } to modify the draft message read by
 *   ListeMessages (brouillon: true); "suppression" with listePossessionsMessages deletes a draft discussion.
 * Recipients come from ListePublics (recipients.ts); a "list" recipient is replaced by the members of the matching
 * ListeDiffusion. Attachments are files uploaded first (POST /files, function SaisieMessage) referenced by
 * { idFichier, nomFichier }, or links { nomFichier, url } (listeFichiers[{ idFichier, nomFichier, url }] in the
 * client: links not validated on a real server). Plain text is HTML-escaped before being wrapped in paragraphs.
 * Proof of a write: the listing is re-read and the written discussion must be NEW (its stable id was absent before)
 * for a new message or a draft, must have gained a message (count or activity date) for a reply, and must carry the
 * sent text for a draft update: Pronote answers {} to an ignored write, a pre-existing discussion never counts.
 * Nothing here forwards, reports, empties the trash or deletes a received message. Every write is refused before
 * any call when the messaging is disabled (right to disconnect) or when tab 131 is closed to the account. None of
 * these writes has been validated on a real server.
 */
import type { SessionHandle } from "pawnote";
import { HttpError } from "../errors.js";
import { listOf } from "../pronote/encoding.js";
import { hasRight, userData } from "../pronote/userdata.js";
import { normalise, plainText, type Discussion, type MessageWrite, type MessageWriteResult, type RecipientKind, type WriteAttachmentRef } from "../normalise.js";
import { assertTabOpen, callFunction } from "./functions.js";
import { findList, loadLists } from "./lists.js";
import { listDiscussions, messagesRequest, participantKind, replyButton, replyTarget, type DiscussionRow } from "./messaging.js";
import { loadAllPublics, RECIPIENT_GENRES, resolveRecipients, type Public } from "./recipients.js";
import { sendWrite } from "./write.js";

export { RECIPIENT_GENRES };
export type { MessageWrite, MessageWriteResult };

const STATE_CREATED = 1;
const STATE_MODIFIED = 2;
const TYPE_HTML = 21;
/** Genre of a discussion (genreDiscussion): 0 ordinary discussion. */
const DISCUSSION_ORDINARY = 0;

type Target = Pick<Public, "N" | "G" | "L">;

/** Temporary identifier of the draft created with a reply, as Pawnote's generator (-1, -2, …). */
let draftCounter = 0;
export const nextDraftId = (): number => --draftCounter;

const invalid = (code: string): HttpError => new HttpError(400, `invalid_request:${code}`);

/** listeFichiers members of a message: uploaded files by idFichier, links by url. */
export const filesOf = (attachments: WriteAttachmentRef[] | undefined): Record<string, unknown>[] =>
  (attachments ?? []).map((item) => {
    if (item.fileId) return { idFichier: item.fileId, nomFichier: item.name };
    // not validated on a real server: the client lists { idFichier, nomFichier, url }; a link has no idFichier.
    if (item.url) return { nomFichier: item.name || item.url, url: item.url };
    throw invalid("attachment_without_file_or_url");
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

/** SaisieMessage JSON of a reply in a discussion (Pawnote's discussionSendMessage; button and message come from ListeMessages). */
export const replyRequest = (content: unknown, buttonGenre: number, messageN: string, files: Record<string, unknown>[] = [], draftId = nextDraftId()): Record<string, unknown> => ({
  contenu: content,
  bouton: { N: 0, G: buttonGenre },
  brouillon: { N: draftId, E: STATE_CREATED },
  genreDiscussion: DISCUSSION_ORDINARY,
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

export const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Content member: escaped HTML paragraphs with the advanced editor, the plain text otherwise. */
export const contentOf = (session: SessionHandle, text: string): unknown =>
  advancedEditor(session) ? { _T: TYPE_HTML, V: text.split(/\r?\n/).map((line) => `<p>${escapeHtml(line)}</p>`).join("") } : text;

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

type Before = (Discussion & { text?: string; attachments?: string[] }) | null;

const result = (before: Before, after: MessageWriteResult["after"], request: Record<string, unknown>, written: boolean, irreversible: boolean): MessageWriteResult =>
  ({ before, after, request, written, dryRun: !written, irreversible, validated: false });

const requireText = (write: MessageWrite): string => {
  const text = String(write.text ?? "");
  if (text.trim() === "") throw invalid("empty_message");
  return text;
};

/** Text of a message content (plain string or { _T: 21, V: html }). */
const contentText = (value: unknown): string => {
  const raw = value !== null && typeof value === "object" && "V" in (value as object) ? (value as { V: unknown }).V : value;
  return typeof raw === "string" ? raw : "";
};

const draftMessage = (messages: Record<string, any>): any =>
  listOf<any>(messages?.listeMessages).find((item) => item?.brouillon === true) ?? listOf<any>(messages?.listeMessages)[0];

/**
 * State of a draft before a write: the discussion row plus the draft text, its recipients and its attachment names
 * (ListeMessages), so that Moodle can restore the draft after a deletion or a modification and report lost files.
 */
const draftBefore = (row: DiscussionRow, messages: Record<string, any>): Discussion & { text: string; attachments: string[] } => {
  const draft = draftMessage(messages);
  const recipients = listOf<any>(messages?.destinataires?.listeDestinataires)
    .filter((item) => item && typeof item === "object")
    .map((item) => ({ label: String(item?.L ?? "").trim(), kind: participantKind(item?.G) }));
  return {
    ...row.discussion,
    participantsDetail: recipients.length ? recipients : row.discussion.participantsDetail,
    text: contentText(draft?.contenu),
    attachments: listOf<any>(draft?.listeFichiers).map((file) => String(file?.L ?? file?.nomFichier ?? "").trim()).filter(Boolean),
  };
};

const requireRow = (rows: DiscussionRow[], id: string | undefined, folder?: "drafts"): DiscussionRow => {
  const row = rows.find((item) => item.discussion.id === id);
  if (!row || (folder && row.discussion.folder !== folder)) throw new HttpError(404, folder ? "draft_not_found" : "discussion_not_found");
  return row;
};

/** Comparable text of a content (HTML or plain). */
const comparable = (text: string): string => normalise(plainText(text.replace(/<\/p>/gi, "\n").replace(/<br\s*\/?>/gi, "\n"), 100000));

export const sendMessage = async (session: SessionHandle, write: MessageWrite): Promise<MessageWriteResult> => {
  assertTabOpen(session, "messageSave");
  const listing = await listDiscussions(session);
  if (listing.disabled) throw new HttpError(409, "messaging_disabled");
  const knownIds = new Set(listing.rows.map((row) => row.discussion.id));
  const files = filesOf(write.attachments);
  const attachmentNames = (write.attachments ?? []).map((item) => item.name);

  if (write.mode === "new" || write.mode === "draft") {
    const text = requireText(write);
    const content = contentOf(session, text);
    const subject = String(write.subject ?? "").trim();
    if (!subject) throw invalid("subject_required");
    if (!write.recipients?.length) throw invalid("recipients_required");
    const targets = await resolveTargets(session, write.recipients);
    const irreversible = write.mode === "new";
    const request = irreversible ? newDiscussionRequest(subject, content, targets, files) : draftRequest(subject, content, targets, files, null);
    const after = { subject, recipients: targets.map((item) => item.L), text, attachments: attachmentNames, discussion: null as Discussion | null, deleted: false };
    if (write.dryRun) return result(null, after, request, false, irreversible);
    await sendWrite(session, "messageSave", request);
    const reread = (await listDiscussions(session)).rows.map((row) => row.discussion);
    // Only a discussion absent before the write proves it: a pre-existing one with the same subject never does.
    const created = reread
      .filter((item) => !knownIds.has(item.id) && normalise(item.subject) === normalise(subject) && (irreversible ? item.folder !== "drafts" : item.folder === "drafts"))
      .sort((a, b) => b.lastDate - a.lastDate)[0] ?? null;
    if (!created) throw new HttpError(502, irreversible ? "message_not_saved" : "draft_not_saved");
    return result(null, { ...after, discussion: created }, request, true, irreversible);
  }

  if (write.mode === "reply") {
    const text = requireText(write);
    const row = requireRow(listing.rows, write.discussion);
    const messages = await callFunction(session, "discussionMessages", messagesRequest(row.possessions));
    const button = replyButton(messages);
    const target = replyTarget(messages);
    if (!button || !target) throw new HttpError(409, "reply_not_possible");
    const request = replyRequest(contentOf(session, text), button.G, target, files);
    const after = { subject: row.discussion.subject, recipients: row.discussion.participants, text, attachments: attachmentNames, discussion: row.discussion, deleted: false };
    if (write.dryRun) return result(row.discussion, after, request, false, true);
    await sendWrite(session, "messageSave", request);
    const reread = (await listDiscussions(session)).rows.map((item) => item.discussion);
    // The discussion (same id, or a new id when its activity date moved) must have gained a message.
    const before = row.discussion;
    const updated = reread.find((item) =>
      normalise(item.subject) === normalise(before.subject)
      && (item.id === before.id || !knownIds.has(item.id))
      && (item.count > before.count || item.lastDate > before.lastDate)) ?? null;
    if (!updated) throw new HttpError(502, "message_not_saved");
    return result(before, { ...after, discussion: updated }, request, true, true);
  }

  const row = requireRow(listing.rows, write.discussion, "drafts");
  if (write.mode === "draft_delete") {
    const before = draftBefore(row, await callFunction(session, "discussionMessages", messagesRequest(row.possessions)));
    const request = deleteDraftRequest(row.possessions);
    const after = { subject: row.discussion.subject, recipients: row.discussion.participants, text: "", attachments: [], discussion: null, deleted: true };
    if (write.dryRun) return result(before, after, request, false, false);
    await sendWrite(session, "messageSave", request);
    const reread = (await listDiscussions(session)).rows.map((item) => item.discussion);
    if (reread.some((item) => item.id === row.discussion.id && item.folder === "drafts")) throw new HttpError(502, "draft_not_deleted");
    return result(before, after, request, true, false);
  }

  // draft_update: the draft message (brouillon: true) and its current recipients come from ListeMessages.
  const text = requireText(write);
  const messages = await callFunction(session, "discussionMessages", messagesRequest(row.possessions));
  const draft = draftMessage(messages);
  if (!draft?.N) throw new HttpError(404, "draft_not_found");
  const subject = String(write.subject ?? row.discussion.subject).trim();
  if (!subject) throw invalid("subject_required");
  const targets: Target[] = write.recipients?.length
    ? await resolveTargets(session, write.recipients)
    : listOf<any>(messages?.destinataires?.listeDestinataires).filter((item) => typeof item?.N === "string").map((item) => ({ N: String(item.N), G: Number(item.G ?? 0), L: String(item.L ?? "").trim() }));
  if (!targets.length) throw invalid("recipients_required");
  const before = draftBefore(row, messages);
  const request = draftRequest(subject, contentOf(session, text), targets, files, String(draft.N));
  const after = { subject, recipients: targets.map((item) => item.L), text, attachments: attachmentNames, discussion: row.discussion, deleted: false };
  if (write.dryRun) return result(before, after, request, false, false);
  await sendWrite(session, "messageSave", request);
  const reread = await listDiscussions(session);
  // The draft (same id, or a new id when its activity date moved) must now carry the sent text.
  const candidates = reread.rows
    .filter((item) => item.discussion.folder === "drafts" && normalise(item.discussion.subject) === normalise(subject) && (item.discussion.id === row.discussion.id || !knownIds.has(item.discussion.id)))
    .sort((a, b) => (a.discussion.id === row.discussion.id ? -1 : 1));
  for (const candidate of candidates) {
    const content = contentText(draftMessage(await callFunction(session, "discussionMessages", messagesRequest(candidate.possessions)))?.contenu);
    if (comparable(content) === comparable(text)) return result(before, { ...after, discussion: candidate.discussion }, request, true, false);
  }
  throw new HttpError(502, "draft_not_saved");
};
