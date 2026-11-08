/**
 * Messaging (discussions) of the teacher space, read only.
 *
 * ListeMessagerie and ListeMessages have the same shape as in the student space (Pawnote decodes them), validated
 * on the demo server in reading; the calls go through callFunction so that the adapter (functions.ts) stays the
 * single place to change. Nothing here writes: marquerCommeLu is always false and SaisieMessage is never called.
 *
 * Communication lot (0.2.0, docs/pronote-matrice/7-communication.md):
 * - SaisiePublicMessage (tab 131) is a READ despite its name: participants of a discussion
 *   ({ message: { N: messagePourParticipants }, estPublicParticipant: true, estDestinatairesReponse: false }
 *   → listeDest[{ L, N, G }]); its failure never fails the discussion (participantsDetail is then []);
 * - PreferenceMessagerie (tab 131): disconnection hours and days ("droit à la déconnexion"), automatic reply;
 *   the next opening (reopensAt) is computed here from the ranges, Pronote does not send it.
 * News (PageActualites) moved to news.ts; its reading helpers stay exported from here for compatibility.
 */
import type { SessionHandle } from "pawnote";
import { HttpError } from "../errors.js";
import { listOf, parsePronoteDate } from "../pronote/encoding.js";
import {
  seconds,
  type Discussion,
  type DiscussionFolder,
  type DiscussionsResult,
  type Message,
  type MessagingPrefs,
  type Participant,
  type ParticipantKind,
} from "../normalise.js";
import { callFunction } from "./functions.js";
import { stableIds } from "./ids.js";
import { attachmentsOf } from "./notebook.js";

export { news, newsFromAnswer } from "./news.js";

/** Genres of the messaging labels (listeEtiquettes[].G). */
const LABEL_FOLDERS: Record<number, DiscussionFolder> = { 1: "inbox", 2: "archive", 3: "sent", 4: "drafts", 5: "trash" };

/** TypeHttpRessource of a participant → kind. */
const PARTICIPANT_KINDS: Record<number, ParticipantKind> = { 1: "class", 2: "group", 3: "teacher", 4: "student", 5: "parent", 34: "staff" };

export const participantKind = (genre: unknown): ParticipantKind => PARTICIPANT_KINDS[Number(genre)] ?? "unknown";

/** Participants of a list of { L, G } Pronote publics (SaisiePublicMessage.listeDest, ListeDiffusion members...). */
export const participantsOf = (items: unknown): Participant[] =>
  listOf<any>(items)
    .map((item) => ({ label: String(item?.L ?? "").trim(), kind: participantKind(item?.G) }))
    .filter((item) => item.label !== "");

const html = (value: unknown): string => {
  const raw = value !== null && typeof value === "object" && "V" in (value as object) ? (value as { V: unknown }).V : value;
  return typeof raw === "string" ? raw : "";
};

/** Discussion rows (depth 0) of a ListeMessagerie answer, with the message possessions needed to read them. */
export type DiscussionRow = {
  discussion: Discussion;
  possessions: { N: string }[];
  /** messagePourParticipants.N, for SaisiePublicMessage ("" when absent). */
  participantsMessage: string;
};

/** The ListeMessagerie request of the web client (interfacelistemessagerie.js). */
export const DISCUSSIONS_REQUEST = { avecMessage: true, avecLu: true, possessionMessageDiscussionUnique: null };

export const discussionsFromAnswer = (data: Record<string, any>): { rows: DiscussionRow[]; disabled: boolean } => {
  const labels = new Map(listOf<any>(data?.listeEtiquettes).map((label) => [String(label?.N ?? ""), Number(label?.G ?? 0)]));
  const all = listOf<any>(data?.listeMessagerie);
  const roots = all.filter((row) => row?.estUneDiscussion === true && Number(row?.profondeur ?? 0) === 0);
  const rootIndexes = roots.map((row) => all.indexOf(row));
  const subParticipants = (rootIndex: number): string[] => {
    const result: string[] = [];
    for (let i = rootIndex + 1; i < all.length && Number(all[i]?.profondeur ?? 0) > 0; i++) {
      const label = String(all[i]?.public ?? "").trim();
      if (label && !result.includes(label)) result.push(label);
    }
    return result;
  };
  const ids = stableIds("discussion", roots, (row) => `${String(row?.objet ?? "")}|${String(row?.dateActivite?.V ?? "")}`);
  const rows: DiscussionRow[] = roots.map((row, index) => {
    let folder: DiscussionFolder = "inbox";
    for (const label of listOf<any>(row?.listeEtiquettes)) {
      const genre = labels.get(String(label?.N ?? "")) ?? Number(label?.G ?? 0);
      if (LABEL_FOLDERS[genre]) folder = LABEL_FOLDERS[genre];
    }
    const date = parsePronoteDate(row?.dateActivite?.V);
    const participantsMessage = row?.messagePourParticipants?.V?.N ?? row?.messagePourParticipants?.N;
    return {
      discussion: {
        id: ids[index],
        subject: String(row?.objet ?? "").trim(),
        participants: subParticipants(rootIndexes[index]),
        lastDate: date ? seconds(date) : 0,
        unread: Number(row?.nbNonLus ?? 0) > 0,
        count: Number(row?.nombreMessages ?? 0),
        folder,
        participantsDetail: [],
        canReply: row?.avecReponse === true,
        draft: folder === "drafts",
      },
      possessions: listOf<any>(row?.listePossessionsMessages).map((item) => ({ N: String(item?.N ?? "") })).filter((item) => item.N),
      participantsMessage: typeof participantsMessage === "string" ? participantsMessage : "",
    };
  });
  return { rows, disabled: data?.messagerieDesactivee === true };
};

export const listDiscussions = async (session: SessionHandle) =>
  discussionsFromAnswer(await callFunction(session, "discussionsList", DISCUSSIONS_REQUEST));

export const discussions = async (session: SessionHandle, folder: DiscussionFolder = "inbox", limit = 50): Promise<DiscussionsResult> => {
  const { rows, disabled } = await listDiscussions(session);
  const items = rows.map((row) => row.discussion).filter((item) => item.folder === folder).sort((a, b) => b.lastDate - a.lastDate);
  return { available: true, reason: "", disabled, items: items.slice(0, Math.max(1, limit)) };
};

/** Messages of a ListeMessages answer. */
export const messagesFromAnswer = (session: SessionHandle, data: Record<string, any>, discussionId: string): Message[] =>
  listOf<any>(data?.listeMessages).map((message, index) => {
    const date = parsePronoteDate(message?.date?.V);
    return {
      id: `${discussionId}|${index + 1}`,
      author: message?.emetteur === true ? "Moi" : String(message?.public_gauche ?? "").trim(),
      date: date ? seconds(date) : 0,
      text: message?.estHTML === true ? html(message?.contenu) : html(message?.contenu).replace(/\n/g, "<br>"),
      attachments: attachmentsOf(session, message?.listeFichiers),
      draft: message?.brouillon === true,
    };
  });

/** The ListeMessages request of a discussion (never marks anything as read). */
export const messagesRequest = (possessions: { N: string }[]) => ({
  listePossessionsMessages: possessions,
  marquerCommeLu: false,
  nbMessagesVus: 0,
  estNonPossede: false,
});

/** Whether a ListeMessages answer offers a reply button and a message to answer. */
export const canReplyFrom = (data: Record<string, any>): boolean => {
  const button = listOf<any>(data?.listeBoutons).find((item) => typeof item?.G === "number");
  const target = data?.messagePourReponse?.V ?? data?.messagePourReponse;
  return Boolean(button && target?.N);
};

/** Participants of a discussion (SaisiePublicMessage); [] when the call fails or the discussion has no message. */
export const participantsDetail = async (session: SessionHandle, messageN: string): Promise<Participant[]> => {
  if (!messageN) return [];
  try {
    const data = await callFunction(session, "participantsList", { message: { N: messageN }, estPublicParticipant: true, estDestinatairesReponse: false });
    return participantsOf(data?.listeDest);
  } catch {
    return [];
  }
};

export const discussion = async (session: SessionHandle, discussionId: string): Promise<{ discussion: Discussion; messages: Message[] }> => {
  const { rows } = await listDiscussions(session);
  const row = rows.find((item) => item.discussion.id === discussionId);
  if (!row) throw new HttpError(404, "discussion_not_found");
  const data = await callFunction(session, "discussionMessages", messagesRequest(row.possessions));
  const detail = await participantsDetail(session, row.participantsMessage);
  return {
    discussion: { ...row.discussion, participantsDetail: detail, canReply: canReplyFrom(data) },
    messages: messagesFromAnswer(session, data, discussionId),
  };
};

/* ---- Preferences (PreferenceMessagerie) ---- */

const hourOf = (value: unknown): number | null => {
  const raw = value !== null && typeof value === "object" && "V" in (value as object) ? (value as { V: unknown }).V : value;
  const number = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(number) && number >= 0 && number <= 24 ? number : null;
};

export type PreferenceRanges = Pick<MessagingPrefs, "hourBefore" | "hourAfter" | "workingDays" | "nonWorkingDays">;

/** Preferences of a PreferenceMessagerie answer (capture 0007), without reopensAt nor the disabled flag. */
export const preferencesFromAnswer = (data: Record<string, any>): Omit<MessagingPrefs, "disabled" | "reopensAt"> => ({
  onlyParentsStudents: data?.uniquementParentEleve === true,
  hourBefore: hourOf(data?.heureAvant),
  hourAfter: hourOf(data?.heureApres),
  workingDays: listOf<any>(data?.listeJoursOuvres).map((item) => ({ day: Number(item?.jour ?? 0), active: item?.actif === true })),
  nonWorkingDays: listOf<any>(data?.listeJoursNonOuvres).map((item) => ({
    day: Number(item?.jour ?? 0),
    active: item?.actif === true,
    holiday: item?.estJourFerie === true,
  })),
  autoReply: html(data?.messageAuto),
});

/** 1 Monday … 7 Sunday. */
const weekday = (date: Date): number => (date.getDay() === 0 ? 7 : date.getDay());

/**
 * Whether the messaging is open at a given instant, from the preferences: a non-working day flagged active is
 * closed all day; a working day flagged active is open between hourBefore and hourAfter only; otherwise open.
 * Holidays (estJourFerie) have no date in the answer: they are ignored here. Interpretation of "actif" not
 * validated on a real server (the demo was read on a Saturday flagged active, with the messaging disabled).
 */
export const isMessagingOpen = (prefs: PreferenceRanges, at: Date): boolean => {
  const day = weekday(at);
  if (prefs.nonWorkingDays.some((item) => item.day === day && item.active && !item.holiday)) return false;
  const working = prefs.workingDays.find((item) => item.day === day);
  if (working?.active && prefs.hourBefore !== null && prefs.hourAfter !== null) {
    const hour = at.getHours() + at.getMinutes() / 60;
    return hour >= prefs.hourBefore && hour < prefs.hourAfter;
  }
  return true;
};

/** Next opening of the messaging (seconds) within 14 days, null when open now or unknown. */
export const reopensAt = (prefs: PreferenceRanges, now = new Date()): number | null => {
  if (isMessagingOpen(prefs, now)) return null;
  for (let offset = 0; offset <= 14; offset++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    const candidates = [day, ...(prefs.hourBefore !== null ? [new Date(day.getFullYear(), day.getMonth(), day.getDate(), prefs.hourBefore)] : [])];
    for (const candidate of candidates) {
      if (candidate.getTime() > now.getTime() && isMessagingOpen(prefs, candidate)) return seconds(candidate);
    }
  }
  return null;
};

export const messagingPreferences = async (session: SessionHandle, now = new Date()): Promise<MessagingPrefs> => {
  const { disabled } = await listDiscussions(session);
  // Request data of PreferenceMessagerie not captured: sent empty (not validated on a real server).
  const prefs = preferencesFromAnswer(await callFunction(session, "messagingPreferences", {}));
  return { disabled, ...prefs, reopensAt: disabled ? reopensAt(prefs, now) : null };
};
