import { answerData, callPronote } from "../pronote/request.js";
import { listOf, parsePronoteDate } from "../pronote/encoding.js";
import { seconds } from "../normalise.js";
import { isAccessDenied } from "./competencies.js";
import { requireFunction } from "./functions.js";
import { stableIds } from "./ids.js";
import { attachmentsOf } from "./notebook.js";
const GENRE_QUIZ = 55;
const GENRE_EXECUTION = 56;
const call = async (session, key, data) => {
    const fn = requireFunction(key);
    const answer = await callPronote(session, { name: fn.name, data, signature: fn.onglet !== null ? { onglet: fn.onglet } : undefined });
    return answerData(session, answer);
};
/** Documents of a Casier answer, for one of the two teacher lists. */
export const lockerFromAnswer = (session, data, kind) => {
    const items = listOf(kind === "received" ? data?.listeDocumentsMonCasier : data?.listeDocumentsDepositaire);
    const ids = stableIds("document", items, (item) => `${String(item?.L ?? "")}|${String(item?.date?.V ?? "")}`);
    return items.map((item, index) => {
        const date = parsePronoteDate(item?.date?.V);
        const file = item?.documentCasier?.V;
        return {
            id: ids[index],
            name: String(item?.L ?? "").trim(),
            date: date ? seconds(date) : 0,
            from: String(item?.infoDepositaire ?? "").trim(),
            read: item?.estNonLu !== true,
            category: String(item?.categorie?.V?.L ?? "").trim(),
            files: file && typeof file === "object" ? attachmentsOf(session, [file]) : [],
        };
    });
};
export const locker = async (session, kind = "received") => {
    let data;
    try {
        data = await call(session, "lockerPage", { genreRequeteCasier: 0 });
    }
    catch (error) {
        if (isAccessDenied(error))
            return { available: false, reason: "access_denied", items: [] };
        throw error;
    }
    if (!data || Object.keys(data).length === 0)
        return { available: false, reason: "access_denied", items: [] };
    return { available: true, reason: "", items: lockerFromAnswer(session, data, kind) };
};
/** Quizzes of a listeQCM answer: rows of genre 55, each followed by its executions (genre 56). */
export const quizzesFromAnswer = (data) => {
    const rows = listOf(data?.listeQCM);
    const quizzes = rows.filter((row) => Number(row?.G) === GENRE_QUIZ);
    const ids = stableIds("quiz", quizzes, (row) => String(row?.L ?? ""));
    const result = [];
    let current = null;
    for (const row of rows) {
        if (Number(row?.G) === GENRE_QUIZ) {
            current = {
                id: ids[result.length],
                name: String(row?.L ?? "").trim(),
                subject: String(row?.matiere?.L ?? row?.matiere?.V?.L ?? "").trim(),
                level: String(row?.niveau?.L ?? row?.niveau?.V?.L ?? "").trim(),
                questions: Number(row?.nbQuestionsTotal ?? 0),
                tags: listOf(row?.ListeThemes).map((theme) => String(theme?.L ?? "").trim()).filter(Boolean),
                executions: 0,
            };
            result.push(current);
        }
        else if (Number(row?.G) === GENRE_EXECUTION && current) {
            current.executions++;
        }
    }
    return result;
};
export const quizzes = async (session) => {
    let data;
    try {
        data = await call(session, "quizList", {});
    }
    catch (error) {
        if (isAccessDenied(error))
            return { available: false, reason: "access_denied", items: [] };
        throw error;
    }
    if (!data || Object.keys(data).length === 0)
        return { available: false, reason: "access_denied", items: [] };
    return { available: true, reason: "", items: quizzesFromAnswer(data) };
};
//# sourceMappingURL=resources.js.map