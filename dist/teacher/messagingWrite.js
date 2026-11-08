import { HttpError } from "../errors.js";
import { listOf } from "../pronote/encoding.js";
import { hasRight, userData } from "../pronote/userdata.js";
import { normalise, plainText } from "../normalise.js";
import { assertTabOpen, callFunction } from "./functions.js";
import { findList, loadLists } from "./lists.js";
import { listDiscussions, messagesRequest, participantKind, replyButton, replyTarget } from "./messaging.js";
import { loadAllPublics, RECIPIENT_GENRES, resolveRecipients } from "./recipients.js";
import { sendWrite } from "./write.js";
export { RECIPIENT_GENRES };
const STATE_CREATED = 1;
const STATE_MODIFIED = 2;
const TYPE_HTML = 21;
/** Genre of a discussion (genreDiscussion): 0 ordinary discussion. */
const DISCUSSION_ORDINARY = 0;
/** Temporary identifier of the draft created with a reply, as Pawnote's generator (-1, -2, …). */
let draftCounter = 0;
export const nextDraftId = () => --draftCounter;
const invalid = (code) => new HttpError(400, `invalid_request:${code}`);
/** listeFichiers members of a message: uploaded files by idFichier, links by url. */
export const filesOf = (attachments) => (attachments ?? []).map((item) => {
    if (item.fileId)
        return { idFichier: item.fileId, nomFichier: item.name };
    // not validated on a real server: the client lists { idFichier, nomFichier, url }; a link has no idFichier.
    if (item.url)
        return { nomFichier: item.name || item.url, url: item.url };
    throw invalid("attachment_without_file_or_url");
});
/** SaisieMessage JSON of a new discussion (exactly Pawnote's newDiscussion, plus genreDiscussion and the files). */
export const newDiscussionRequest = (subject, content, recipients, files = []) => ({
    objet: subject,
    contenu: content,
    estCreationCarnetLiaison: false,
    listeFichiers: files,
    listeDestinataires: recipients.map((item) => ({ N: item.N, G: item.G, E: STATE_MODIFIED })),
    genreDiscussion: DISCUSSION_ORDINARY,
});
/** SaisieMessage JSON of a reply in a discussion (Pawnote's discussionSendMessage; button and message come from ListeMessages). */
export const replyRequest = (content, buttonGenre, messageN, files = [], draftId = nextDraftId()) => ({
    contenu: content,
    bouton: { N: 0, G: buttonGenre },
    brouillon: { N: draftId, E: STATE_CREATED },
    genreDiscussion: DISCUSSION_ORDINARY,
    messagePourReponse: { N: messageN, G: 0 },
    listeFichiers: files,
});
/** SaisieMessage JSON of a draft: "brouillon" absent to create, { N, E: 2 } to modify. */
export const draftRequest = (subject, content, recipients, files, draftN) => ({
    commande: "brouillon",
    ...(draftN ? { brouillon: { N: draftN, E: STATE_MODIFIED } } : {}),
    objet: subject,
    contenu: content,
    listeDestinataires: recipients.map((item) => ({ N: item.N, G: item.G, E: STATE_MODIFIED })),
    listeFichiers: files,
});
/** SaisieMessage JSON deleting the teacher's copy of a draft discussion. */
export const deleteDraftRequest = (possessions) => ({
    commande: "suppression",
    listePossessionsMessages: possessions.map((item) => ({ N: item.N })),
});
const advancedEditor = (session) => hasRight(userData(session).rights, "communication", "avecDiscussionAvancee") === true;
export const escapeHtml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Content member: escaped HTML paragraphs with the advanced editor, the plain text otherwise. */
export const contentOf = (session, text) => advancedEditor(session) ? { _T: TYPE_HTML, V: text.split(/\r?\n/).map((line) => `<p>${escapeHtml(line)}</p>`).join("") } : text;
/** Recipients of a write resolved to Pronote publics: kinds through ListePublics, "list" through ListeDiffusion. */
export const resolveTargets = async (session, recipients) => {
    const direct = recipients.filter((item) => item.kind !== "list");
    const publics = await loadAllPublics(session, direct.map((item) => item.kind));
    const targets = resolveRecipients(publics, direct).map((item) => ({ N: item.N, G: item.G, L: item.L }));
    const lists = recipients.filter((item) => item.kind === "list");
    if (lists.length) {
        const rows = await loadLists(session);
        for (const wanted of lists) {
            const row = findList(rows, wanted.label);
            row.members.forEach((member, index) => {
                if (!targets.some((item) => item.N === member.N))
                    targets.push({ N: member.N, G: member.G, L: row.list.members[index]?.label ?? "" });
            });
        }
    }
    return targets;
};
const result = (before, after, request, written, irreversible) => ({ before, after, request, written, dryRun: !written, irreversible, validated: false });
const requireText = (write) => {
    const text = String(write.text ?? "");
    if (text.trim() === "")
        throw invalid("empty_message");
    return text;
};
/** Text of a message content (plain string or { _T: 21, V: html }). */
const contentText = (value) => {
    const raw = value !== null && typeof value === "object" && "V" in value ? value.V : value;
    return typeof raw === "string" ? raw : "";
};
const draftMessage = (messages) => listOf(messages?.listeMessages).find((item) => item?.brouillon === true) ?? listOf(messages?.listeMessages)[0];
/**
 * State of a draft before a write: the discussion row plus the draft text, its recipients and its attachment names
 * (ListeMessages), so that Moodle can restore the draft after a deletion or a modification and report lost files.
 */
const draftBefore = (row, messages) => {
    const draft = draftMessage(messages);
    const recipients = listOf(messages?.destinataires?.listeDestinataires)
        .filter((item) => item && typeof item === "object")
        .map((item) => ({ label: String(item?.L ?? "").trim(), kind: participantKind(item?.G) }));
    return {
        ...row.discussion,
        participantsDetail: recipients.length ? recipients : row.discussion.participantsDetail,
        text: contentText(draft?.contenu),
        attachments: listOf(draft?.listeFichiers).map((file) => String(file?.L ?? file?.nomFichier ?? "").trim()).filter(Boolean),
    };
};
const requireRow = (rows, id, folder) => {
    const row = rows.find((item) => item.discussion.id === id);
    if (!row || (folder && row.discussion.folder !== folder))
        throw new HttpError(404, folder ? "draft_not_found" : "discussion_not_found");
    return row;
};
/** Comparable text of a content (HTML or plain). */
const comparable = (text) => normalise(plainText(text.replace(/<\/p>/gi, "\n").replace(/<br\s*\/?>/gi, "\n"), 100000));
export const sendMessage = async (session, write) => {
    assertTabOpen(session, "messageSave");
    const listing = await listDiscussions(session);
    if (listing.disabled)
        throw new HttpError(409, "messaging_disabled");
    const knownIds = new Set(listing.rows.map((row) => row.discussion.id));
    const files = filesOf(write.attachments);
    const attachmentNames = (write.attachments ?? []).map((item) => item.name);
    if (write.mode === "new" || write.mode === "draft") {
        const text = requireText(write);
        const content = contentOf(session, text);
        const subject = String(write.subject ?? "").trim();
        if (!subject)
            throw invalid("subject_required");
        if (!write.recipients?.length)
            throw invalid("recipients_required");
        const targets = await resolveTargets(session, write.recipients);
        const irreversible = write.mode === "new";
        const request = irreversible ? newDiscussionRequest(subject, content, targets, files) : draftRequest(subject, content, targets, files, null);
        const after = { subject, recipients: targets.map((item) => item.L), text, attachments: attachmentNames, discussion: null, deleted: false };
        if (write.dryRun)
            return result(null, after, request, false, irreversible);
        await sendWrite(session, "messageSave", request);
        const reread = (await listDiscussions(session)).rows.map((row) => row.discussion);
        // Only a discussion absent before the write proves it: a pre-existing one with the same subject never does.
        const created = reread
            .filter((item) => !knownIds.has(item.id) && normalise(item.subject) === normalise(subject) && (irreversible ? item.folder !== "drafts" : item.folder === "drafts"))
            .sort((a, b) => b.lastDate - a.lastDate)[0] ?? null;
        if (!created)
            throw new HttpError(502, irreversible ? "message_not_saved" : "draft_not_saved");
        return result(null, { ...after, discussion: created }, request, true, irreversible);
    }
    if (write.mode === "reply") {
        const text = requireText(write);
        const row = requireRow(listing.rows, write.discussion);
        const messages = await callFunction(session, "discussionMessages", messagesRequest(row.possessions));
        const button = replyButton(messages);
        const target = replyTarget(messages);
        if (!button || !target)
            throw new HttpError(409, "reply_not_possible");
        const request = replyRequest(contentOf(session, text), button.G, target, files);
        const after = { subject: row.discussion.subject, recipients: row.discussion.participants, text, attachments: attachmentNames, discussion: row.discussion, deleted: false };
        if (write.dryRun)
            return result(row.discussion, after, request, false, true);
        await sendWrite(session, "messageSave", request);
        const reread = (await listDiscussions(session)).rows.map((item) => item.discussion);
        // The discussion (same id, or a new id when its activity date moved) must have gained a message.
        const before = row.discussion;
        const updated = reread.find((item) => normalise(item.subject) === normalise(before.subject)
            && (item.id === before.id || !knownIds.has(item.id))
            && (item.count > before.count || item.lastDate > before.lastDate)) ?? null;
        if (!updated)
            throw new HttpError(502, "message_not_saved");
        return result(before, { ...after, discussion: updated }, request, true, true);
    }
    const row = requireRow(listing.rows, write.discussion, "drafts");
    if (write.mode === "draft_delete") {
        const before = draftBefore(row, await callFunction(session, "discussionMessages", messagesRequest(row.possessions)));
        const request = deleteDraftRequest(row.possessions);
        const after = { subject: row.discussion.subject, recipients: row.discussion.participants, text: "", attachments: [], discussion: null, deleted: true };
        if (write.dryRun)
            return result(before, after, request, false, false);
        await sendWrite(session, "messageSave", request);
        const reread = (await listDiscussions(session)).rows.map((item) => item.discussion);
        if (reread.some((item) => item.id === row.discussion.id && item.folder === "drafts"))
            throw new HttpError(502, "draft_not_deleted");
        return result(before, after, request, true, false);
    }
    // draft_update: the draft message (brouillon: true) and its current recipients come from ListeMessages.
    const text = requireText(write);
    const messages = await callFunction(session, "discussionMessages", messagesRequest(row.possessions));
    const draft = draftMessage(messages);
    if (!draft?.N)
        throw new HttpError(404, "draft_not_found");
    const subject = String(write.subject ?? row.discussion.subject).trim();
    if (!subject)
        throw invalid("subject_required");
    const targets = write.recipients?.length
        ? await resolveTargets(session, write.recipients)
        : listOf(messages?.destinataires?.listeDestinataires).filter((item) => typeof item?.N === "string").map((item) => ({ N: String(item.N), G: Number(item.G ?? 0), L: String(item.L ?? "").trim() }));
    if (!targets.length)
        throw invalid("recipients_required");
    const before = draftBefore(row, messages);
    const request = draftRequest(subject, contentOf(session, text), targets, files, String(draft.N));
    const after = { subject, recipients: targets.map((item) => item.L), text, attachments: attachmentNames, discussion: row.discussion, deleted: false };
    if (write.dryRun)
        return result(before, after, request, false, false);
    await sendWrite(session, "messageSave", request);
    const reread = await listDiscussions(session);
    // The draft (same id, or a new id when its activity date moved) must now carry the sent text.
    const candidates = reread.rows
        .filter((item) => item.discussion.folder === "drafts" && normalise(item.discussion.subject) === normalise(subject) && (item.discussion.id === row.discussion.id || !knownIds.has(item.discussion.id)))
        .sort((a, b) => (a.discussion.id === row.discussion.id ? -1 : 1));
    for (const candidate of candidates) {
        const content = contentText(draftMessage(await callFunction(session, "discussionMessages", messagesRequest(candidate.possessions)))?.contenu);
        if (comparable(content) === comparable(text))
            return result(before, { ...after, discussion: candidate.discussion }, request, true, false);
    }
    throw new HttpError(502, "draft_not_saved");
};
//# sourceMappingURL=messagingWrite.js.map