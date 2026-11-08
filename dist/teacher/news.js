import { HttpError } from "../errors.js";
import { listOf, numberSet, parseNumberSet, parsePronoteDate } from "../pronote/encoding.js";
import { seconds, } from "../normalise.js";
import { callFunction } from "./functions.js";
import { stableIds } from "./ids.js";
import { attachmentsOf } from "./notebook.js";
/** listeModesAff[].G of each scope ("library" comes from another function). */
export const SCOPE_MODES = { received: 0, sent: 1, drafts: 2, templates: 3 };
/** genreReponse → question kind. */
const QUESTION_KINDS = { 0: "ack", 1: "text", 2: "single", 3: "multiple", 4: "none", 5: "noanswer" };
export const QUESTION_GENRES = { ack: 0, text: 1, single: 2, multiple: 3, none: 4, noanswer: 5 };
/** etatPublication → state. */
const STATES = { 0: "published", 1: "future", 2: "past", 3: "draft" };
const html = (value) => {
    const raw = value !== null && typeof value === "object" && "V" in value ? value.V : value;
    return typeof raw === "string" ? raw : "";
};
const unwrap = (value) => (value !== null && typeof value === "object" && "V" in value ? value.V : value);
const integer = (value) => {
    const raw = unwrap(value);
    if (raw === null || raw === undefined || raw === "")
        return null;
    const number = Number.parseInt(String(raw), 10);
    return Number.isFinite(number) ? number : null;
};
const dateOf = (value) => {
    const date = parsePronoteDate(unwrap(value));
    return date ? seconds(date) : null;
};
/** Normalised answer of a question (reponse.V), null when none was given. */
export const answerOf = (raw, kind) => {
    const answer = unwrap(raw);
    if (!answer || typeof answer !== "object" || answer.avecReponse !== true)
        return null;
    const value = answer.valeurReponse;
    return {
        choices: typeof value === "string" ? [] : parseNumberSet(value),
        text: typeof value === "string" ? value : String(answer.valeurReponseLibre ?? ""),
        acknowledged: kind === "ack",
    };
};
export const questionsOf = (items) => listOf(items).map((question, index) => {
    const kind = QUESTION_KINDS[Number(question?.genreReponse)] ?? "none";
    return {
        id: `q${index + 1}`,
        text: html(question?.texte),
        kind,
        choices: listOf(question?.listeChoix).map((choice) => ({
            rank: Number(choice?.rang ?? 0),
            label: String(choice?.L ?? "").trim(),
            free: choice?.estReponseLibre === true,
        })),
        maxLength: integer(question?.tailleReponse),
        answer: answerOf(question?.reponse, kind),
    };
});
export const newsKey = (item) => `${String(item?.L ?? "")}|${String(item?.dateDebut?.V ?? "")}`;
const itemOf = (session, raw, id, scope) => {
    const date = parsePronoteDate(raw?.dateDebut?.V ?? raw?.dateCreation?.V);
    const questions = questionsOf(raw?.listeQuestions);
    const survey = raw?.estSondage === true;
    const template = raw?.estModele === true || scope === "templates" || scope === "library";
    const stateCode = Number(raw?.etatPublication);
    const state = template ? "template" : STATES[stateCode] ?? (raw?.publie === true ? "published" : "draft");
    return {
        id,
        title: String(raw?.L ?? "").trim(),
        date: date ? seconds(date) : 0,
        author: String(raw?.auteur ?? "").trim(),
        category: String(raw?.nature?.V?.L ?? raw?.nature?.L ?? "").trim(),
        read: raw?.lue === true,
        survey,
        text: questions.map((question) => question.text).filter(Boolean).join("\n"),
        attachments: listOf(raw?.listeQuestions).flatMap((question) => attachmentsOf(session, question?.listePiecesJointes)),
        kind: survey ? "survey" : "information",
        scope,
        published: raw?.publie === true,
        state,
        start: dateOf(raw?.dateDebut),
        end: dateOf(raw?.dateFin),
        publicSummary: String(raw?.detailPublicSuccinct ?? "").trim(),
        sharedWith: listOf(raw?.listeIndividusPartage).map((who) => String(who?.L ?? "").trim()).filter(Boolean),
        locked: raw?.estVerrouille === true,
        anonymous: raw?.reponseAnonyme === true,
        mine: raw?.estAuteur === true,
        withoutAnswer: integer(raw?.nbIndividusSansReponses),
        answeredPercent: integer(raw?.pourcentRepondu),
        questions,
    };
};
/** Rows of one scope of a PageActualites answer. */
export const newsRowsOf = (session, data, scope) => {
    const mode = listOf(data?.listeModesAff).find((entry) => Number(entry?.G ?? -1) === SCOPE_MODES[scope]);
    const items = listOf(mode?.listeActualites);
    const ids = stableIds("news", items, newsKey);
    return items.map((raw, index) => ({ item: itemOf(session, raw, ids[index], scope), raw, scope }));
};
/** Items of a ListeSondagesDeBiblioEtablissement answer (list member name not captured: read defensively). */
export const libraryRowsOf = (session, data) => {
    // not validated on a real server: the answer is "templates with listeQuestions", the list member is unknown.
    const candidates = [data?.listeSondages, data?.listeActualites, data?.listeModeles, data?.liste];
    let items = candidates.map((candidate) => listOf(candidate)).find((list) => list.length > 0) ?? [];
    if (items.length === 0) {
        items = Object.values(data ?? {}).map((value) => listOf(value)).find((list) => list.some((entry) => typeof entry?.L === "string")) ?? [];
    }
    const ids = stableIds("news", items, newsKey);
    return items.map((raw, index) => ({ item: itemOf(session, raw, ids[index], "library"), raw, scope: "library" }));
};
/** Received information and surveys of a PageActualites answer (mode 0), kept for the callers of 0.1. */
export const newsFromAnswer = (session, data, scope = "received") => newsRowsOf(session, data, scope).map((row) => row.item);
/** The PageActualites request of the web client, every mode at once. */
export const NEWS_REQUEST = { genreRequeteActualite: 0, modesAffActus: numberSet([0, 1, 2, 3]) };
export const newsPage = (session) => callFunction(session, "newsPage", NEWS_REQUEST);
export const news = async (session, scope = "received", unreadOnly = false) => {
    if (scope === "library") {
        const data = await callFunction(session, "surveyLibrary", { estCasSondage: true });
        return { items: libraryRowsOf(session, data).map((row) => row.item), disabled: false };
    }
    const data = await newsPage(session);
    const items = newsRowsOf(session, data, scope).map((row) => row.item);
    return { items: unreadOnly ? items.filter((item) => !item.read) : items, disabled: data?.messagerieDesactivee === true };
};
/** Row of a stable news id, looked for in every mode of the page (received first), or 404 news_not_found. */
export const findNews = (session, data, id) => {
    for (const scope of ["received", "sent", "drafts", "templates"]) {
        const row = newsRowsOf(session, data, scope).find((entry) => entry.item.id === id);
        if (row)
            return row;
    }
    throw new HttpError(404, "news_not_found");
};
/* ---- Results (PageActualitesResultats) ---- */
const labelOf = (value) => {
    const raw = unwrap(value);
    if (typeof raw === "string")
        return raw.trim();
    return String(raw?.L ?? "").trim();
};
/**
 * Results of one item. The respondent shape ({ L | eleve | individu, classe, dateReponse | reponduLe, reponse })
 * is not captured: every field is optional and the counts are computed from what is found (not validated on a
 * real server). Names only leave when nominative is true; free texts never carry a name.
 */
export const resultsFromAnswer = (row, data, nominative) => {
    const questions = listOf(data?.listeQuestions);
    const base = row.item.questions;
    return {
        news: {
            id: row.item.id,
            title: row.item.title,
            kind: row.item.kind,
            anonymous: row.item.anonymous,
            recipients: integer(data?.nbDestinataires ?? data?.nbIndividus) ?? (row.item.withoutAnswer !== null && row.item.answeredPercent !== null && row.item.answeredPercent < 100
                ? Math.round(row.item.withoutAnswer / (1 - row.item.answeredPercent / 100))
                : null),
            answered: integer(data?.nbRepondants ?? data?.nbReponses),
        },
        nominative,
        questions: questions.map((question, index) => {
            const rawChoices = listOf(question?.listeChoix);
            const kind = QUESTION_KINDS[Number(question?.genreReponse)] ?? base[index]?.kind ?? "none";
            const known = rawChoices.length
                ? rawChoices.map((choice) => ({ rank: Number(choice?.rang ?? 0), label: String(choice?.L ?? "").trim(), count: integer(choice?.nbReponses) }))
                : (base[index]?.choices ?? []).map((choice) => ({ rank: choice.rank, label: choice.label, count: null }));
            // Counts sent by Pronote (nbReponses) win; otherwise they are computed from the respondents.
            const sentCounts = known.some((choice) => choice.count !== null);
            const counts = new Map(known.map((choice) => [choice.rank, choice.count ?? 0]));
            const texts = [];
            const respondents = [];
            const respondentsRaw = listOf(question?.listeRepondant);
            let answered = 0;
            for (const who of respondentsRaw) {
                const answer = answerOf(who?.reponse ?? who, kind);
                if (!answer)
                    continue;
                answered++;
                if (!sentCounts)
                    for (const rank of answer.choices)
                        counts.set(rank, (counts.get(rank) ?? 0) + 1);
                if (answer.text)
                    texts.push(answer.text);
                if (nominative) {
                    respondents.push({
                        label: labelOf(who?.L ?? who?.eleve ?? who?.individu ?? who?.responsable),
                        class: labelOf(who?.classe),
                        date: dateOf(who?.dateReponse ?? who?.reponduLe ?? unwrap(who?.reponse)?.reponduLe),
                        answer,
                    });
                }
            }
            return {
                id: base[index]?.id ?? `q${index + 1}`,
                text: html(question?.texte) || String(question?.L ?? base[index]?.text ?? ""),
                kind,
                total: integer(question?.nbIndividus ?? question?.nbDestinataires),
                answered: integer(question?.nbReponses ?? question?.nbRepondants) ?? (respondentsRaw.length ? answered : null),
                choices: [...counts.entries()].map(([rank, count]) => ({ rank, label: known.find((choice) => choice.rank === rank)?.label ?? "", count })),
                texts,
                respondents,
            };
        }),
    };
};
export const newsResults = async (session, id, nominative = false) => {
    const page = await newsPage(session);
    const row = findNews(session, page, id);
    // The function expects the item as received (genreRequeteActualite 1 refuses a reduced { N, L, G }).
    const data = await callFunction(session, "newsResults", { actualite: row.raw });
    return resultsFromAnswer(row, data, nominative);
};
//# sourceMappingURL=news.js.map