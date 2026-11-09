/**
 * Information and surveys ("actualités") of the teacher space, read only.
 *
 * PageActualites (tab 8) with modesAffActus { _T: 26, V: "[0,1,2,3]" } answers listeModesAff[{ G, listeActualites }]
 * (G 0 received, 1 sent by the account or shared with it, 2 drafts, 3 templates), validated on the demo server
 * (captures 0011, 0022, 0085). ListeSondagesDeBiblioEtablissement { estCasSondage: true } (capture 0086) lists the
 * survey templates of the school ("library"). PageActualitesResultats { actualite } answers the results of one
 * item (listeQuestions[{ N, listeRepondant[] }]): the shape of a respondent is not captured, so it is read
 * defensively (not validated on a real server).
 *
 * Received items carry listeQuestions (genreReponse 0 acknowledgement, 1 text, 2 single choice, 3 multiple
 * choice, 4 no acknowledgement, 5 no answer); the shape of a question and its answer is the one Pawnote decodes.
 */
import type { SessionHandle } from "pawnote";
import { HttpError } from "../errors.js";
import { listOf, numberSet, parseNumberSet, parsePronoteDate } from "../pronote/encoding.js";
import {
  seconds,
  type NewsAnswer,
  type NewsAudienceDetail,
  type NewsItem,
  type ParticipantKind,
  type NewsQuestion,
  type NewsQuestionKind,
  type NewsResults,
  type NewsScope,
} from "../normalise.js";
import { isAccessDenied } from "./competencies.js";
import { callFunction, functions } from "./functions.js";
import { stableIds } from "./ids.js";
import { attachmentsOf } from "./notebook.js";

/** listeModesAff[].G of each scope ("library" comes from another function). */
export const SCOPE_MODES: Record<Exclude<NewsScope, "library">, number> = { received: 0, sent: 1, drafts: 2, templates: 3 };

/** genreReponse → question kind. */
const QUESTION_KINDS: Record<number, NewsQuestionKind> = { 0: "ack", 1: "text", 2: "single", 3: "multiple", 4: "none", 5: "noanswer" };
export const QUESTION_GENRES: Record<NewsQuestionKind, number> = { ack: 0, text: 1, single: 2, multiple: 3, none: 4, noanswer: 5 };

/** etatPublication → state. */
const STATES: Record<number, NewsItem["state"]> = { 0: "published", 1: "future", 2: "past", 3: "draft" };

const html = (value: unknown): string => {
  const raw = value !== null && typeof value === "object" && "V" in (value as object) ? (value as { V: unknown }).V : value;
  return typeof raw === "string" ? raw : "";
};

const unwrap = (value: unknown): any => (value !== null && typeof value === "object" && "V" in (value as object) ? (value as { V: unknown }).V : value);

const integer = (value: unknown): number | null => {
  const raw = unwrap(value);
  if (raw === null || raw === undefined || raw === "") return null;
  const number = Number.parseInt(String(raw), 10);
  return Number.isFinite(number) ? number : null;
};

const dateOf = (value: unknown): number | null => {
  const date = parsePronoteDate(unwrap(value));
  return date ? seconds(date) : null;
};

/** Normalised answer of a question (reponse.V), null when none was given. */
export const answerOf = (raw: any, kind: NewsQuestionKind): NewsAnswer | null => {
  const answer = unwrap(raw);
  if (!answer || typeof answer !== "object" || answer.avecReponse !== true) return null;
  const value = answer.valeurReponse;
  return {
    choices: typeof value === "string" ? [] : parseNumberSet(value),
    text: typeof value === "string" ? value : String(answer.valeurReponseLibre ?? ""),
    acknowledged: kind === "ack",
  };
};

export const questionsOf = (items: unknown): NewsQuestion[] =>
  listOf<any>(items).map((question, index) => {
    const kind = QUESTION_KINDS[Number(question?.genreReponse)] ?? "none";
    return {
      id: `q${index + 1}`,
      text: html(question?.texte),
      kind,
      choices: listOf<any>(question?.listeChoix).map((choice) => ({
        rank: Number(choice?.rang ?? 0),
        label: String(choice?.L ?? "").trim(),
        free: choice?.estReponseLibre === true,
      })),
      maxLength: integer(question?.tailleReponse),
      answer: answerOf(question?.reponse, kind),
    };
  });

const INDIVIDUAL_KINDS: Record<number, ParticipantKind> = { 1: "class", 2: "group", 3: "teacher", 4: "student", 5: "parent", 34: "staff" };

const AUDIENCE_MEMBERS = ["listePublicEntite", "listePublicIndividu", "avecEleve", "avecResp1", "avecResp2", "avecProfsPrincipaux", "avecTuteurs"];

/**
 * Audience of a sent or draft item from its raw members (labels only), null when Pronote sends none of them (received
 * items, templates of other authors). Moodle needs it to recreate an item after a deletion.
 */
export const audienceOf = (raw: any): NewsAudienceDetail | null => {
  if (!raw || typeof raw !== "object" || !AUDIENCE_MEMBERS.some((member) => member in raw)) return null;
  const entities = listOf<any>(raw.listePublicEntite);
  const entityLabel = (item: any) => String(item?.L ?? "").trim();
  return {
    classes: entities.filter((item) => Number(item?.G) === 1).map(entityLabel).filter(Boolean),
    groups: entities.filter((item) => Number(item?.G) === 2).map(entityLabel).filter(Boolean),
    students: raw.avecEleve === true,
    parents: raw.avecResp2 === true ? "all" : raw.avecResp1 === true ? "one" : "none",
    mainTeachers: raw.avecProfsPrincipaux === true,
    tutors: raw.avecTuteurs === true,
    individuals: listOf<any>(raw.listePublicIndividu)
      .map((item) => ({ label: String(item?.L ?? "").trim(), kind: INDIVIDUAL_KINDS[Number(item?.G)] ?? "unknown" as ParticipantKind }))
      .filter((item) => item.label),
  };
};

/** Raw item with its scope and stable id (ids are computed per scope, as GET /news does). */
export type NewsRow = { item: NewsItem; raw: Record<string, any>; scope: NewsScope };

export const newsKey = (item: any): string => `${String(item?.L ?? "")}|${String(item?.dateDebut?.V ?? "")}`;

const itemOf = (session: SessionHandle, raw: any, id: string, scope: NewsScope): NewsItem => {
  const date = parsePronoteDate(raw?.dateDebut?.V ?? raw?.dateCreation?.V);
  const questions = questionsOf(raw?.listeQuestions);
  const survey = raw?.estSondage === true;
  const template = raw?.estModele === true || scope === "templates" || scope === "library";
  const stateCode = Number(raw?.etatPublication);
  // Received items (mode 0) carry neither "publie" nor "etatPublication" on the real server: they are published by
  // definition (the account received them), unlike the author's own lists where a missing flag means a draft.
  const received = scope === "received";
  const published = typeof raw?.publie === "boolean" ? raw.publie : received;
  const state: NewsItem["state"] = template ? "template" : STATES[stateCode] ?? (published ? "published" : "draft");
  // Content: the questions' texts; on the real server a received item may carry its text at the root instead
  // (member names not captured on the demonstration: read defensively).
  const rootText = [raw?.contenu, raw?.texte, raw?.description].map(html).find((value) => value !== "") ?? "";
  return {
    id,
    title: String(raw?.L ?? "").trim(),
    date: date ? seconds(date) : 0,
    author: String(raw?.auteur ?? "").trim(),
    category: String(raw?.nature?.V?.L ?? raw?.nature?.L ?? "").trim(),
    read: raw?.lue === true,
    survey,
    text: questions.map((question) => question.text).filter(Boolean).join("\n") || rootText,
    attachments: listOf<any>(raw?.listeQuestions).flatMap((question) => attachmentsOf(session, question?.listePiecesJointes)),
    kind: survey ? "survey" : "information",
    scope,
    published,
    state,
    start: dateOf(raw?.dateDebut),
    end: dateOf(raw?.dateFin),
    publicSummary: String(raw?.detailPublicSuccinct ?? "").trim(),
    sharedWith: listOf<any>(raw?.listeIndividusPartage).map((who) => String(who?.L ?? "").trim()).filter(Boolean),
    locked: raw?.estVerrouille === true,
    anonymous: raw?.reponseAnonyme === true,
    mine: raw?.estAuteur === true,
    withoutAnswer: integer(raw?.nbIndividusSansReponses),
    answeredPercent: integer(raw?.pourcentRepondu),
    questions,
    audience: audienceOf(raw),
  };
};

/** Rows of one scope of a PageActualites answer. */
export const newsRowsOf = (session: SessionHandle, data: Record<string, any>, scope: Exclude<NewsScope, "library">): NewsRow[] => {
  const mode = listOf<any>(data?.listeModesAff).find((entry) => Number(entry?.G ?? -1) === SCOPE_MODES[scope]);
  const items = listOf<any>(mode?.listeActualites);
  const ids = stableIds("news", items, newsKey);
  return items.map((raw, index) => ({ item: itemOf(session, raw, ids[index], scope), raw, scope }));
};

/** Items of a ListeSondagesDeBiblioEtablissement answer (list member name not captured: read defensively). */
export const libraryRowsOf = (session: SessionHandle, data: Record<string, any>): NewsRow[] => {
  // not validated on a real server: the answer is "templates with listeQuestions", the list member is unknown.
  const candidates = [data?.listeSondages, data?.listeActualites, data?.listeModeles, data?.liste];
  let items = candidates.map((candidate) => listOf<any>(candidate)).find((list) => list.length > 0) ?? [];
  if (items.length === 0) {
    items = Object.values(data ?? {}).map((value) => listOf<any>(value)).find((list) => list.some((entry) => typeof entry?.L === "string")) ?? [];
  }
  const ids = stableIds("news", items, newsKey);
  return items.map((raw, index) => ({ item: itemOf(session, raw, ids[index], "library"), raw, scope: "library" }));
};

/** Received information and surveys of a PageActualites answer (mode 0), kept for the callers of 0.1. */
export const newsFromAnswer = (session: SessionHandle, data: Record<string, any>, scope: Exclude<NewsScope, "library"> = "received"): NewsItem[] =>
  newsRowsOf(session, data, scope).map((row) => row.item);

/** The PageActualites request of the web client, every mode at once. */
export const NEWS_REQUEST = { genreRequeteActualite: 0, modesAffActus: numberSet([0, 1, 2, 3]) };

export const newsPage = (session: SessionHandle) => callFunction(session, "newsPage", NEWS_REQUEST);

export const news = async (session: SessionHandle, scope: NewsScope = "received", unreadOnly = false): Promise<{ items: NewsItem[]; disabled: boolean }> => {
  if (scope === "library") {
    const data = await callFunction(session, "surveyLibrary", { estCasSondage: true });
    return { items: libraryRowsOf(session, data).map((row) => row.item), disabled: false };
  }
  const data = await newsPage(session);
  const items = newsRowsOf(session, data, scope).map((row) => row.item);
  return { items: unreadOnly ? items.filter((item) => !item.read) : items, disabled: data?.messagerieDesactivee === true };
};

/** Row of a stable news id, looked for in every mode of the page (received first), or 404 news_not_found. */
export const findNews = (session: SessionHandle, data: Record<string, any>, id: string): NewsRow => {
  for (const scope of ["received", "sent", "drafts", "templates"] as const) {
    const row = newsRowsOf(session, data, scope).find((entry) => entry.item.id === id);
    if (row) return row;
  }
  throw new HttpError(404, "news_not_found");
};

/* ---- Results (PageActualitesResultats) ---- */

const labelOf = (value: unknown): string => {
  const raw = unwrap(value);
  if (typeof raw === "string") return raw.trim();
  return String((raw as any)?.L ?? "").trim();
};

/**
 * Results of one item. The respondent shape ({ L | eleve | individu, classe, dateReponse | reponduLe, reponse })
 * is not captured: every field is optional and the counts are computed from what is found (not validated on a
 * real server). Names only leave when nominative is true; free texts never carry a name.
 */
export const resultsFromAnswer = (row: NewsRow, data: Record<string, any>, nominative: boolean): NewsResults => {
  const questions = listOf<any>(data?.listeQuestions);
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
      const rawChoices = listOf<any>(question?.listeChoix);
      const kind = QUESTION_KINDS[Number(question?.genreReponse)] ?? base[index]?.kind ?? "none";
      const known = rawChoices.length
        ? rawChoices.map((choice) => ({ rank: Number(choice?.rang ?? 0), label: String(choice?.L ?? "").trim(), count: integer(choice?.nbReponses) }))
        : (base[index]?.choices ?? []).map((choice) => ({ rank: choice.rank, label: choice.label, count: null as number | null }));
      // Counts sent by Pronote (nbReponses) win; otherwise they are computed from the respondents.
      const sentCounts = known.some((choice) => choice.count !== null);
      const counts = new Map<number, number>(known.map((choice) => [choice.rank, choice.count ?? 0]));
      const texts: string[] = [];
      const respondents: NewsResults["questions"][number]["respondents"] = [];
      const respondentsRaw = listOf<any>(question?.listeRepondant);
      let answered = 0;
      for (const who of respondentsRaw) {
        const answer = answerOf(who?.reponse ?? who, kind);
        if (!answer) continue;
        answered++;
        if (!sentCounts) for (const rank of answer.choices) counts.set(rank, (counts.get(rank) ?? 0) + 1);
        if (answer.text) texts.push(answer.text);
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

export const newsResults = async (session: SessionHandle, id: string, nominative = false): Promise<NewsResults> => {
  const page = await newsPage(session);
  const row = findNews(session, page, id);
  // The function expects the item as received (genreRequeteActualite 1 refuses a reduced { N, L, G }).
  try {
    const data = await callFunction(session, "newsResults", { actualite: row.raw });
    return resultsFromAnswer(row, data, nominative);
  } catch (error) {
    // Results of another author's item, or a closed tab: an explicit refusal, never a server failure.
    if (isAccessDenied(error)) throw new HttpError(409, `tab_closed:${functions.newsResults.name}`);
    throw error;
  }
};
