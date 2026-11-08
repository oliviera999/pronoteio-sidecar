import { HttpError } from "../errors.js";
import { listOf, parsePronoteDate } from "../pronote/encoding.js";
import { seconds, } from "../normalise.js";
import { isAccessDenied } from "./competencies.js";
import { callFunction, functions } from "./functions.js";
import { stableIds } from "./ids.js";
import { attachmentsOf } from "./notebook.js";
export { news, newsFromAnswer } from "./news.js";
/** Genres of the messaging labels (listeEtiquettes[].G). */
const LABEL_FOLDERS = { 1: "inbox", 2: "archive", 3: "sent", 4: "drafts", 5: "trash" };
const FOLDER_PRIORITY = { inbox: 0, sent: 1, drafts: 2, archive: 3, trash: 4 };
/** TypeHttpRessource of a participant → kind. */
const PARTICIPANT_KINDS = { 1: "class", 2: "group", 3: "teacher", 4: "student", 5: "parent", 34: "staff" };
export const participantKind = (genre) => PARTICIPANT_KINDS[Number(genre)] ?? "unknown";
/** Participants of a list of { L, G } Pronote publics (SaisiePublicMessage.listeDest, ListeDiffusion members...). */
export const participantsOf = (items) => listOf(items)
    .map((item) => ({ label: String(item?.L ?? "").trim(), kind: participantKind(item?.G) }))
    .filter((item) => item.label !== "");
const html = (value) => {
    const raw = value !== null && typeof value === "object" && "V" in value ? value.V : value;
    return typeof raw === "string" ? raw : "";
};
/** The ListeMessagerie request of the web client (interfacelistemessagerie.js). */
export const DISCUSSIONS_REQUEST = { avecMessage: true, avecLu: true, possessionMessageDiscussionUnique: null };
export const discussionsFromAnswer = (data) => {
    const labels = new Map(listOf(data?.listeEtiquettes).map((label) => [String(label?.N ?? ""), Number(label?.G ?? 0)]));
    const all = listOf(data?.listeMessagerie);
    const roots = all.filter((row) => row?.estUneDiscussion === true && Number(row?.profondeur ?? 0) === 0);
    const rootIndexes = roots.map((row) => all.indexOf(row));
    const subParticipants = (rootIndex) => {
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
        // A row may carry several labels: the most specific folder wins (trash > archive > drafts > sent > inbox).
        let folder = "inbox";
        for (const label of listOf(row?.listeEtiquettes)) {
            const genre = labels.get(String(label?.N ?? "")) ?? Number(label?.G ?? 0);
            const candidate = LABEL_FOLDERS[genre];
            if (candidate && FOLDER_PRIORITY[candidate] > FOLDER_PRIORITY[folder])
                folder = candidate;
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
            possessions: listOf(row?.listePossessionsMessages).map((item) => ({ N: String(item?.N ?? "") })).filter((item) => item.N),
            participantsMessage: typeof participantsMessage === "string" ? participantsMessage : "",
        };
    });
    return { rows, disabled: data?.messagerieDesactivee === true };
};
export const listDiscussions = async (session) => discussionsFromAnswer(await callFunction(session, "discussionsList", DISCUSSIONS_REQUEST));
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
        draft: message?.brouillon === true,
    };
});
/** The ListeMessages request of a discussion (never marks anything as read). */
export const messagesRequest = (possessions) => ({
    listePossessionsMessages: possessions,
    marquerCommeLu: false,
    nbMessagesVus: 0,
    estNonPossede: false,
});
/** Send button of a ListeMessages answer: the one labelled "Envoyer…", else the first with a genre; null when none. */
export const replyButton = (data) => {
    const buttons = listOf(data?.listeBoutons).filter((item) => typeof item?.G === "number");
    const button = buttons.find((item) => /^envoyer/i.test(String(item?.L ?? "").trim())) ?? buttons[0];
    return button ? { G: Number(button.G), L: String(button.L ?? "") } : null;
};
/** Message to answer in a discussion (messagePourReponse.N), "" when none. */
export const replyTarget = (data) => {
    const target = data?.messagePourReponse?.V ?? data?.messagePourReponse;
    return typeof target?.N === "string" ? target.N : "";
};
/** Whether a ListeMessages answer offers a reply button and a message to answer. */
export const canReplyFrom = (data) => replyButton(data) !== null && replyTarget(data) !== "";
/** Participants of a discussion (SaisiePublicMessage); [] when the call fails or the discussion has no message. */
export const participantsDetail = async (session, messageN) => {
    if (!messageN)
        return [];
    try {
        const data = await callFunction(session, "participantsList", { message: { N: messageN }, estPublicParticipant: true, estDestinatairesReponse: false });
        return participantsOf(data?.listeDest);
    }
    catch {
        return [];
    }
};
export const discussion = async (session, discussionId) => {
    const { rows } = await listDiscussions(session);
    const row = rows.find((item) => item.discussion.id === discussionId);
    if (!row)
        throw new HttpError(404, "discussion_not_found");
    const data = await callFunction(session, "discussionMessages", messagesRequest(row.possessions));
    const detail = await participantsDetail(session, row.participantsMessage);
    return {
        discussion: { ...row.discussion, participantsDetail: detail, canReply: canReplyFrom(data) },
        messages: messagesFromAnswer(session, data, discussionId),
    };
};
/* ---- Preferences (PreferenceMessagerie) ---- */
const hourOf = (value) => {
    const raw = value !== null && typeof value === "object" && "V" in value ? value.V : value;
    const number = Number.parseInt(String(raw ?? ""), 10);
    return Number.isFinite(number) && number >= 0 && number <= 24 ? number : null;
};
/** Preferences of a PreferenceMessagerie answer (capture 0007), without reopensAt nor the disabled flag. */
export const preferencesFromAnswer = (data) => ({
    onlyParentsStudents: data?.uniquementParentEleve === true,
    hourBefore: hourOf(data?.heureAvant),
    hourAfter: hourOf(data?.heureApres),
    workingDays: listOf(data?.listeJoursOuvres).map((item) => ({ day: Number(item?.jour ?? 0), active: item?.actif === true })),
    nonWorkingDays: listOf(data?.listeJoursNonOuvres).map((item) => ({
        day: Number(item?.jour ?? 0),
        active: item?.actif === true,
        holiday: item?.estJourFerie === true,
    })),
    autoReply: html(data?.messageAuto),
});
/** 1 Monday … 7 Sunday. */
const weekday = (date) => (date.getDay() === 0 ? 7 : date.getDay());
/**
 * Whether the messaging is open at a given instant, from the preferences: a non-working day flagged active is
 * closed all day; a working day flagged active is open between hourBefore and hourAfter only; otherwise open.
 * Holidays (estJourFerie) have no date in the answer: they are ignored here. Interpretation of "actif" not
 * validated on a real server (the demo was read on a Saturday flagged active, with the messaging disabled).
 */
export const isMessagingOpen = (prefs, at) => {
    const day = weekday(at);
    if (prefs.nonWorkingDays.some((item) => item.day === day && item.active && !item.holiday))
        return false;
    const working = prefs.workingDays.find((item) => item.day === day);
    if (working?.active && prefs.hourBefore !== null && prefs.hourAfter !== null) {
        const hour = at.getHours() + at.getMinutes() / 60;
        return hour >= prefs.hourBefore && hour < prefs.hourAfter;
    }
    return true;
};
/** Next opening of the messaging (seconds) within 14 days, null when open now or unknown. */
export const reopensAt = (prefs, now = new Date()) => {
    if (isMessagingOpen(prefs, now))
        return null;
    for (let offset = 0; offset <= 14; offset++) {
        const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
        const candidates = [day, ...(prefs.hourBefore !== null ? [new Date(day.getFullYear(), day.getMonth(), day.getDate(), prefs.hourBefore)] : [])];
        for (const candidate of candidates) {
            if (candidate.getTime() > now.getTime() && isMessagingOpen(prefs, candidate))
                return seconds(candidate);
        }
    }
    return null;
};
export const messagingPreferences = async (session, now = new Date()) => {
    const { disabled } = await listDiscussions(session);
    // Request data of PreferenceMessagerie not captured: sent empty (not validated on a real server).
    let prefs;
    try {
        prefs = preferencesFromAnswer(await callFunction(session, "messagingPreferences", {}));
    }
    catch (error) {
        // A refusal must not look like a server failure (Moodle would fall back on the whole account).
        if (isAccessDenied(error))
            throw new HttpError(409, `tab_closed:${functions.messagingPreferences.name}`);
        throw error;
    }
    return { disabled, ...prefs, reopensAt: disabled ? reopensAt(prefs, now) : null };
};
//# sourceMappingURL=messaging.js.map