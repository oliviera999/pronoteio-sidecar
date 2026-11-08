/**
 * Messaging (discussions) and information/surveys of the teacher space, read only.
 *
 * ListeMessagerie and ListeMessages have the same shape as in the student space (Pawnote decodes them), validated
 * on the demo server in reading; the calls go through callPronote so that the adapter (functions.ts) stays the
 * single place to change. Nothing here writes: marquerCommeLu is always false and SaisieMessage is never called.
 */
import type { SessionHandle } from "pawnote";
import { HttpError } from "../errors.js";
import { answerData, callPronote } from "../pronote/request.js";
import { listOf, parsePronoteDate } from "../pronote/encoding.js";
import { seconds, type Discussion, type DiscussionFolder, type DiscussionsResult, type Message, type NewsItem } from "../normalise.js";
import { requireFunction, type FunctionKey } from "./functions.js";
import { stableIds } from "./ids.js";
import { attachmentsOf } from "./notebook.js";

/** Genres of the messaging labels (listeEtiquettes[].G). */
const LABEL_FOLDERS: Record<number, DiscussionFolder> = { 1: "inbox", 2: "archive", 3: "sent", 4: "drafts", 5: "trash" };

const call = async (session: SessionHandle, key: FunctionKey, data: Record<string, unknown>) => {
  const fn = requireFunction(key);
  const answer = await callPronote(session, { name: fn.name, data, signature: fn.onglet !== null ? { onglet: fn.onglet } : undefined });
  return answerData(session, answer);
};

const html = (value: unknown): string => {
  const raw = value !== null && typeof value === "object" && "V" in (value as object) ? (value as { V: unknown }).V : value;
  return typeof raw === "string" ? raw : "";
};

/** Discussion rows (depth 0) of a ListeMessagerie answer, with the message possessions needed to read them. */
export type DiscussionRow = { discussion: Discussion; possessions: { N: string }[] };

export const discussionsFromAnswer = (data: Record<string, any>): { rows: DiscussionRow[]; disabled: boolean } => {
  const labels = new Map(listOf<any>(data?.listeEtiquettes).map((label) => [String(label?.N ?? ""), Number(label?.G ?? 0)]));
  const all = listOf<any>(data?.listeMessagerie);
  const roots = all.filter((row) => row?.estUneDiscussion === true && Number(row?.profondeur ?? 0) === 0);
  const rootIndexes = roots.map((row) => all.indexOf(row));
  const participantsOf = (rootIndex: number): string[] => {
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
    return {
      discussion: {
        id: ids[index],
        subject: String(row?.objet ?? "").trim(),
        participants: participantsOf(rootIndexes[index]),
        lastDate: date ? seconds(date) : 0,
        unread: Number(row?.nbNonLus ?? 0) > 0,
        count: Number(row?.nombreMessages ?? 0),
        folder,
      },
      possessions: listOf<any>(row?.listePossessionsMessages).map((item) => ({ N: String(item?.N ?? "") })).filter((item) => item.N),
    };
  });
  return { rows, disabled: data?.messagerieDesactivee === true };
};

const listDiscussions = async (session: SessionHandle) =>
  discussionsFromAnswer(await call(session, "discussionsList", { avecMessage: true, avecLu: true, possessionMessageDiscussionUnique: null }));

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
    };
  });

export const discussion = async (session: SessionHandle, discussionId: string): Promise<{ discussion: Discussion; messages: Message[] }> => {
  const { rows } = await listDiscussions(session);
  const row = rows.find((item) => item.discussion.id === discussionId);
  if (!row) throw new HttpError(404, "discussion_not_found");
  const data = await call(session, "discussionMessages", {
    listePossessionsMessages: row.possessions,
    marquerCommeLu: false,
    nbMessagesVus: 0,
    estNonPossede: false,
  });
  return { discussion: row.discussion, messages: messagesFromAnswer(session, data, discussionId) };
};

/** Received information and surveys of a PageActualites answer (mode 0). */
export const newsFromAnswer = (session: SessionHandle, data: Record<string, any>): NewsItem[] => {
  const modes = listOf<any>(data?.listeModesAff);
  const received = modes.find((mode) => Number(mode?.G ?? -1) === 0);
  const items = listOf<any>(received?.listeActualites);
  const ids = stableIds("news", items, (item) => `${String(item?.L ?? "")}|${String(item?.dateDebut?.V ?? "")}`);
  return items.map((item, index) => {
    const date = parsePronoteDate(item?.dateDebut?.V ?? item?.dateCreation?.V);
    const questions = listOf<any>(item?.listeQuestions);
    return {
      id: ids[index],
      title: String(item?.L ?? "").trim(),
      date: date ? seconds(date) : 0,
      author: String(item?.auteur ?? "").trim(),
      category: String(item?.nature?.V?.L ?? "").trim(),
      read: item?.lue === true,
      survey: item?.estSondage === true,
      text: questions.map((question) => html(question?.texte)).filter(Boolean).join("\n"),
      attachments: questions.flatMap((question) => attachmentsOf(session, question?.listePiecesJointes)),
    };
  });
};

export const news = async (session: SessionHandle, unreadOnly = false): Promise<{ items: NewsItem[] }> => {
  const data = await call(session, "newsPage", { genreRequeteActualite: 0, modesAffActus: { _T: 26, V: "[0]" } });
  const items = newsFromAnswer(session, data);
  return { items: unreadOnly ? items.filter((item) => !item.read) : items };
};
