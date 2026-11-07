import { HttpError } from "../errors.js";
import { answerData, callPronote } from "../pronote/request.js";
import { listOf, parsePronoteDate } from "../pronote/encoding.js";
import { seconds } from "../normalise.js";
import { requireFunction } from "./functions.js";
import { stableIds } from "./ids.js";
import { attachmentsOf } from "./notebook.js";
/** Genres of the messaging labels (listeEtiquettes[].G). */
const LABEL_FOLDERS = { 1: "inbox", 2: "archive", 3: "sent", 4: "drafts", 5: "trash" };
const call = async (session, key, data) => {
    const fn = requireFunction(key);
    const answer = await callPronote(session, { name: fn.name, data, signature: fn.onglet !== null ? { onglet: fn.onglet } : undefined });
    return answerData(session, answer);
};
const html = (value) => {
    const raw = value !== null && typeof value === "object" && "V" in value ? value.V : value;
    return typeof raw === "string" ? raw : "";
};
export const discussionsFromAnswer = (data) => {
    const labels = new Map(listOf(data?.listeEtiquettes).map((label) => [String(label?.N ?? ""), Number(label?.G ?? 0)]));
    const all = listOf(data?.listeMessagerie);
    const roots = all.filter((row) => row?.estUneDiscussion === true && Number(row?.profondeur ?? 0) === 0);
    const rootIndexes = roots.map((row) => all.indexOf(row));
    const participantsOf = (rootIndex) => {
        const result = [];
        for (let i = rootIndex + 1; i < all.length && Number(all[i]?.profondeur ?? 0) > 0; i++) {
            const label = String(all[i]?.public ?? "").trim();
            if (label && !result.includes(label))
                result.push(label);
        }
        return result;
    };
    const ids = stableIds("discussion", roots, (row) => `${String(row?.objet ?? "")}|${String(row?.dateActivite?.V ?? "")}`);
    const rows = roots.map((row, index) => {
        let folder = "inbox";
        for (const label of listOf(row?.listeEtiquettes)) {
            const genre = labels.get(String(label?.N ?? "")) ?? Number(label?.G ?? 0);
            if (LABEL_FOLDERS[genre])
                folder = LABEL_FOLDERS[genre];
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
            possessions: listOf(row?.listePossessionsMessages).map((item) => ({ N: String(item?.N ?? "") })).filter((item) => item.N),
        };
    });
    return { rows, disabled: data?.messagerieDesactivee === true };
};
const listDiscussions = async (session) => discussionsFromAnswer(await call(session, "discussionsList", { avecMessage: true, avecLu: true, possessionMessageDiscussionUnique: null }));
export const discussions = async (session, folder = "inbox", limit = 50) => {
    const { rows, disabled } = await listDiscussions(session);
    const items = rows.map((row) => row.discussion).filter((item) => item.folder === folder).sort((a, b) => b.lastDate - a.lastDate);
    return { available: true, reason: "", disabled, items: items.slice(0, Math.max(1, limit)) };
};
/** Messages of a ListeMessages answer. */
export const messagesFromAnswer = (session, data, discussionId) => listOf(data?.listeMessages).map((message, index) => {
    const date = parsePronoteDate(message?.date?.V);
    return {
        id: `${discussionId}|${index + 1}`,
        author: message?.emetteur === true ? "Moi" : String(message?.public_gauche ?? "").trim(),
        date: date ? seconds(date) : 0,
        text: message?.estHTML === true ? html(message?.contenu) : html(message?.contenu).replace(/\n/g, "<br>"),
        attachments: attachmentsOf(session, message?.listeFichiers),
    };
});
export const discussion = async (session, discussionId) => {
    const { rows } = await listDiscussions(session);
    const row = rows.find((item) => item.discussion.id === discussionId);
    if (!row)
        throw new HttpError(404, "discussion_not_found");
    const data = await call(session, "discussionMessages", {
        listePossessionsMessages: row.possessions,
        marquerCommeLu: false,
        nbMessagesVus: 0,
        estNonPossede: false,
    });
    return { discussion: row.discussion, messages: messagesFromAnswer(session, data, discussionId) };
};
/** Received information and surveys of a PageActualites answer (mode 0). */
export const newsFromAnswer = (session, data) => {
    const modes = listOf(data?.listeModesAff);
    const received = modes.find((mode) => Number(mode?.G ?? -1) === 0);
    const items = listOf(received?.listeActualites);
    const ids = stableIds("news", items, (item) => `${String(item?.L ?? "")}|${String(item?.dateDebut?.V ?? "")}`);
    return items.map((item, index) => {
        const date = parsePronoteDate(item?.dateDebut?.V ?? item?.dateCreation?.V);
        const questions = listOf(item?.listeQuestions);
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
export const news = async (session, unreadOnly = false) => {
    const data = await call(session, "newsPage", { genreRequeteActualite: 0, modesAffActus: { _T: 26, V: "[0]" } });
    const items = newsFromAnswer(session, data);
    return { items: unreadOnly ? items.filter((item) => !item.read) : items };
};
//# sourceMappingURL=messaging.js.map