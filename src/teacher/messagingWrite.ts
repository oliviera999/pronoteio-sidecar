/**
 * Sends a message: SaisieMessage (tab 131) with an empty command, as the client and Pawnote (newDiscussion,
 * discussionSendMessage) do; recipients come from ListePublics (teacher space, "discussion avancée"), see
 * docs/pronote-matrice/7-communication.md in mood_prod. A sent message is IRREVERSIBLE: the "deletion" commands only
 * touch the teacher's own copy. Nothing here forwards, reports or deletes. Refused before any call when the
 * messaging is disabled (right to disconnect) or a recipient refuses messages.
 */
import type { SessionHandle } from "pawnote";
import { HttpError } from "../errors.js";
import { listOf } from "../pronote/encoding.js";
import { userData } from "../pronote/userdata.js";
import { normalise, type Discussion } from "../normalise.js";
import { requireFunction, type FunctionKey } from "./functions.js";
import { answerData, callPronote } from "../pronote/request.js";
import { discussionsFromAnswer } from "./messaging.js";
import { sendWrite } from "./write.js";

const STATE_MODIFIED = 2;
const TYPE_HTML = 21;
/** Genre of a discussion (genreDiscussion): 0 ordinary discussion. */
const DISCUSSION_ORDINARY = 0;

export type RecipientKind = "class" | "teacher" | "student" | "parent" | "staff";

/** TypeHttpRessource of each recipient kind in ListePublics. */
export const RECIPIENT_GENRES: Record<RecipientKind, number> = { class: 1, teacher: 3, student: 4, parent: 5, staff: 34 };

export type RecipientRef = { kind: RecipientKind; label: string };

export type MessageWrite = {
  mode: "new" | "reply";
  subject?: string;
  /** Plain text (converted to HTML when the account has the advanced editor). */
  text: string;
  recipients?: RecipientRef[];
  /** Stable discussion id (m:…) for a reply. */
  discussion?: string;
  dryRun: boolean;
};

export type MessageWriteResult = {
  before: Discussion | null;
  after: { subject: string; recipients: string[]; text: string; discussion: Discussion | null };
  request: Record<string, unknown>;
  written: boolean;
  dryRun: boolean;
  irreversible: true;
};

type Public = { N: string; G: number; L: string; refuses: boolean };

const call = async (session: SessionHandle, key: FunctionKey, data: Record<string, unknown>) => {
  const fn = requireFunction(key);
  const answer = await callPronote(session, { name: fn.name, data, signature: fn.onglet !== null ? { onglet: fn.onglet } : undefined });
  return answerData(session, answer);
};

/** Recipients of one genre of a ListePublics answer, without any personal detail (only N, G, L and the refusal flag). */
export const publicsOf = (data: Record<string, any>): Public[] =>
  listOf<any>(data?.listePublics)
    .filter((item) => typeof item?.N === "string")
    .map((item) => ({ N: String(item.N), G: Number(item.G ?? 0), L: String(item.L ?? "").trim(), refuses: item?.discussionInterdit === true || item?.refusMess === true }));

/** Resolves recipient labels against the publics of their kind; 404 when unknown, 409 when one refuses messages. */
export const resolveRecipients = (publics: Record<RecipientKind, Public[]>, recipients: RecipientRef[]): Public[] =>
  recipients.map((recipient) => {
    const candidates = publics[recipient.kind] ?? [];
    const matches = candidates.filter((item) => normalise(item.L) === normalise(recipient.label));
    if (matches.length === 0) throw new HttpError(404, `recipient_not_found:${recipient.label}`);
    if (matches.length > 1) throw new HttpError(409, `recipient_ambiguous:${recipient.label}`);
    if (matches[0].refuses) throw new HttpError(409, `recipient_refuses:${recipient.label}`);
    return matches[0];
  });

/** SaisieMessage JSON of a new discussion (exactly Pawnote's newDiscussion, plus genreDiscussion). */
export const newDiscussionRequest = (subject: string, content: unknown, recipients: Public[]): Record<string, unknown> => ({
  objet: subject,
  contenu: content,
  estCreationCarnetLiaison: false,
  listeFichiers: [],
  listeDestinataires: recipients.map((item) => ({ N: item.N, G: item.G, E: STATE_MODIFIED })),
  genreDiscussion: DISCUSSION_ORDINARY,
});

/** SaisieMessage JSON of a reply in a discussion (button and message to answer come from ListeMessages). */
export const replyRequest = (content: unknown, buttonGenre: number, messageN: string): Record<string, unknown> => ({
  contenu: content,
  bouton: { N: 0, G: buttonGenre },
  messagePourReponse: { N: messageN, G: 0 },
  listeFichiers: [],
});

const advancedEditor = (session: SessionHandle): boolean => {
  const rights = userData(session).rights as Record<string, unknown>;
  return rights?.AvecDiscussionAvancee === true || rights?.avecDiscussionAvancee === true;
};

const contentOf = (session: SessionHandle, text: string): unknown =>
  advancedEditor(session) ? { _T: TYPE_HTML, V: text.split(/\r?\n/).map((line) => `<p>${line}</p>`).join("") } : text;

export const sendMessage = async (session: SessionHandle, write: MessageWrite): Promise<MessageWriteResult> => {
  const listing = discussionsFromAnswer(await call(session, "discussionsList", { avecMessage: true, avecLu: true, possessionMessageDiscussionUnique: null }));
  if (listing.disabled) throw new HttpError(409, "messaging_disabled");
  if (write.text.trim() === "") throw new HttpError(400, "empty_message");
  const content = contentOf(session, write.text);

  if (write.mode === "new") {
    const subject = String(write.subject ?? "").trim();
    if (!subject) throw new HttpError(400, "subject_required");
    if (!write.recipients?.length) throw new HttpError(400, "recipients_required");
    const kinds = [...new Set(write.recipients.map((item) => item.kind))];
    const publics = {} as Record<RecipientKind, Public[]>;
    for (const kind of kinds) {
      // Sets are encoded as { _T: 26, V: "[g]" }: a bare array is silently ignored by Pronote.
      publics[kind] = publicsOf(await call(session, "recipientsList", {
        pourMessagerie: true,
        genres: { _T: 26, V: `[${RECIPIENT_GENRES[kind]}]` },
        sansFiltreSurEleve: true,
        avecFonctionPersonnel: true,
      }));
    }
    const recipients = resolveRecipients(publics, write.recipients);
    const request = newDiscussionRequest(subject, content, recipients);
    const after = { subject, recipients: recipients.map((item) => item.L), text: write.text, discussion: null as Discussion | null };
    if (write.dryRun) return { before: null, after, request, written: false, dryRun: true, irreversible: true };
    await sendWrite(session, "messageSave", request);
    const reread = discussionsFromAnswer(await call(session, "discussionsList", { avecMessage: true, avecLu: true, possessionMessageDiscussionUnique: null }));
    const created = reread.rows.map((row) => row.discussion).filter((item) => normalise(item.subject) === normalise(subject)).sort((a, b) => b.lastDate - a.lastDate)[0] ?? null;
    if (!created) throw new HttpError(502, "message_not_saved");
    return { before: null, after: { ...after, discussion: created }, request, written: true, dryRun: false, irreversible: true };
  }

  const row = listing.rows.find((item) => item.discussion.id === write.discussion);
  if (!row) throw new HttpError(404, "discussion_not_found");
  const messages = await call(session, "discussionMessages", { listePossessionsMessages: row.possessions, marquerCommeLu: false, nbMessagesVus: 0, estNonPossede: false });
  const button = listOf<any>(messages?.listeBoutons).find((item) => typeof item?.G === "number");
  const target = messages?.messagePourReponse?.V ?? messages?.messagePourReponse;
  if (!button || !target?.N) throw new HttpError(409, "reply_not_possible");
  const request = replyRequest(content, Number(button.G), String(target.N));
  const after = { subject: row.discussion.subject, recipients: row.discussion.participants, text: write.text, discussion: row.discussion };
  if (write.dryRun) return { before: row.discussion, after, request, written: false, dryRun: true, irreversible: true };
  await sendWrite(session, "messageSave", request);
  const reread = discussionsFromAnswer(await call(session, "discussionsList", { avecMessage: true, avecLu: true, possessionMessageDiscussionUnique: null }));
  const updated = reread.rows.map((item) => item.discussion).find((item) => item.subject === row.discussion.subject && item.count > row.discussion.count)
    ?? reread.rows.map((item) => item.discussion).find((item) => item.id === row.discussion.id) ?? null;
  if (!updated) throw new HttpError(502, "message_not_saved");
  return { before: row.discussion, after: { ...after, discussion: updated }, request, written: true, dryRun: false, irreversible: true };
};
