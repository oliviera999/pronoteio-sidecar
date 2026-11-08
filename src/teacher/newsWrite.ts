/**
 * Writes on information and surveys: SaisieActualites (tab 8), objetrequetesaisieactualites.js, read statically
 * from the client and compared with Pawnote (newsRead, newsSurveySend); NOT validated on a real server.
 *
 * - Answer, acknowledgement, read flag, removal from the account's list (saisieActualite false): exactly Pawnote's
 *   shape, listeActualites[{ N, L, genrePublic, public, validationDirecte: true, listeQuestions[{ N, L,
 *   genreReponse, reponse { N, Actif: true, valeurReponse, valeurReponseLibre, avecReponse, estReponseAttendue,
 *   _validationSaisie: true } }], marqueLueSeulement, lue, supprimee, saisieActualite: false }]. The chosen ranks
 *   are sent as { _T: 8, V: "[1,3]" }. A closed survey (dateFin past or estVerrouille): 409 survey_closed.
 * - Creation, modification, publication, deletion (saisieActualite true): the same object plus publie, estModele,
 *   nature, dateDebut, dateFin, genreReponse, tailleReponse, reponseAnonyme, the audience flags (avecEleve,
 *   avecResp1, avecResp2, avecProfsPrincipaux, avecTuteurs), listePublicEntite (classes, groups),
 *   listePublicIndividu, complete listeQuestions (texte, listeChoix[{ rang, L, estReponseLibre }],
 *   listePiecesJointes) and E (1 create, 2 modify, 3 delete). Creation and modification ALWAYS send publie: false:
 *   only "publish" sets it, and "unpublish" clears it (both irreversible for the families already notified).
 *   DonneesEditionInformation (init: true, avecCategories, avecListeIndividusPossiblesPartage; capture 0025) gives
 *   the limits (tailleMaxTitre 200, tailleMaxReponse 500) and, with avecPublic, the number of parents, main
 *   teachers and tutors reached (member names not captured: null when not found).
 * Never sent: SaisieActualitesNotification (reminders), GenererFichiersResultatsSondage (results broadcast).
 */
import type { SessionHandle } from "pawnote";
import { HttpError } from "../errors.js";
import { listOf, numberSet, pronoteDate } from "../pronote/encoding.js";
import {
  normalise,
  type NewsItem,
  type NewsResponseResult,
  type NewsResponseWrite,
  type NewsWrite,
  type NewsWriteResult,
  type RecipientKind,
  type WriteAttachmentRef,
} from "../normalise.js";
import { callFunction } from "./functions.js";
import { findNews, newsPage, newsRowsOf, QUESTION_GENRES, type NewsRow } from "./news.js";
import { loadAllPublics, resolveRecipients } from "./recipients.js";
import { sendWrite } from "./write.js";

const STATE_CREATED = 1;
const STATE_MODIFIED = 2;
const STATE_DELETED = 3;
const TYPE_HTML = 21;
/** Type of the set of chosen ranks in an answer (Pawnote newsSurveySend). */
const TYPE_RANKS = 8;
/** Genre of an attached document: 0 URL, 1 file. */
const DOCUMENT_LINK = 0;
const DOCUMENT_FILE = 1;

const unwrap = (value: unknown): any => (value !== null && typeof value === "object" && "V" in (value as object) ? (value as { V: unknown }).V : value);

const integer = (value: unknown): number | null => {
  const raw = unwrap(value);
  const number = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(number) ? number : null;
};

/** Answer identifier as Pawnote sends it (parseInt of the N; "0" or absent for a first answer). */
const answerN = (value: unknown): number | string => {
  const raw = String(unwrap(value) ?? "0");
  const number = Number.parseInt(raw, 10);
  return Number.isFinite(number) && String(number) === raw ? number : raw;
};

const html = (value: string | undefined) => ({ _T: TYPE_HTML, V: String(value ?? "") });

/* ---- Answer to a received item ---- */

export const isSurveyClosed = (item: NewsItem, now = new Date()): boolean =>
  item.locked || (item.end !== null && item.end * 1000 < now.getTime());

/** SaisieActualites JSON of an answer (saisieActualite false), exactly Pawnote's newsRead / newsSurveySend. */
export const newsResponseRequest = (row: NewsRow, response: NewsResponseWrite): Record<string, unknown> => {
  const raw = row.raw;
  const remove = response.remove === true;
  const answering = !remove && (response.acknowledge === true || (response.answers?.length ?? 0) > 0);
  const onlyRead = !remove && !answering;
  const questions = answering
    ? listOf<any>(raw?.listeQuestions).map((question, index) => {
      const normalised = row.item.questions[index];
      const wanted = response.answers?.find((answer) => answer.question === normalised.id);
      const previous = unwrap(question?.reponse) ?? {};
      const textual = normalised.kind === "ack" || normalised.kind === "text";
      // A new answer replaces the previous one entirely; an untouched question keeps what was answered before.
      const text = wanted !== undefined ? wanted.text ?? "" : normalised.kind === "ack" && response.acknowledge === true ? "" : normalised.answer?.text ?? "";
      const ranks = wanted?.choices ?? normalised.answer?.choices ?? [];
      const answered = wanted !== undefined || (normalised.kind === "ack" && response.acknowledge === true) || normalised.answer !== null;
      return {
        N: question?.N,
        L: question?.L ?? "",
        genreReponse: question?.genreReponse,
        reponse: {
          N: answerN(previous?.N),
          Actif: true,
          valeurReponse: textual ? text : { _T: TYPE_RANKS, V: `[${ranks.join(",")}]` },
          ...(normalised.choices.some((choice) => choice.free) ? { valeurReponseLibre: text } : {}),
          avecReponse: answered,
          estReponseAttendue: previous?.estReponseAttendue ?? true,
          _validationSaisie: true,
        },
      };
    })
    : [];
  return {
    listeActualites: [
      {
        N: raw?.N,
        L: raw?.L ?? "",
        genrePublic: raw?.genrePublic ?? unwrap(raw?.public)?.G,
        public: unwrap(raw?.public),
        validationDirecte: true,
        listeQuestions: questions,
        marqueLueSeulement: onlyRead,
        lue: !remove && (response.read ?? true),
        supprimee: remove,
        saisieActualite: false,
      },
    ],
    saisieActualite: false,
  };
};

/** Item as it should read after the answer (dryRun). */
export const plannedResponse = (item: NewsItem, response: NewsResponseWrite): NewsItem => ({
  ...item,
  read: response.remove === true ? item.read : response.read ?? true,
  questions: item.questions.map((question) => {
    const wanted = response.answers?.find((answer) => answer.question === question.id);
    if (wanted) return { ...question, answer: { choices: wanted.choices ?? [], text: wanted.text ?? "", acknowledged: question.kind === "ack" } };
    if (question.kind === "ack" && response.acknowledge === true) return { ...question, answer: { choices: [], text: "", acknowledged: true } };
    return question;
  }),
});

export const writeNewsResponse = async (session: SessionHandle, id: string, response: NewsResponseWrite, dryRun: boolean): Promise<NewsResponseResult> => {
  const page = await newsPage(session);
  const row = findNews(session, page, id);
  const answering = response.acknowledge === true || (response.answers?.length ?? 0) > 0;
  if (answering && isSurveyClosed(row.item)) throw new HttpError(409, "survey_closed");
  for (const answer of response.answers ?? []) {
    if (!row.item.questions.some((question) => question.id === answer.question)) throw new HttpError(404, `question_not_found:${answer.question}`);
  }
  const request = newsResponseRequest(row, response);
  const irreversible = response.acknowledge === true || response.remove === true;
  const planned = plannedResponse(row.item, response);
  if (dryRun) return { before: row.item, after: planned, written: false, dryRun: true, request, irreversible, validated: false };
  await sendWrite(session, "newsSave", request);
  const reread = newsRowsOf(session, await newsPage(session), row.scope === "library" ? "received" : row.scope).find((entry) => entry.item.id === id) ?? null;
  if (response.remove === true) {
    if (reread) throw new HttpError(502, "response_not_saved");
    return { before: row.item, after: planned, written: true, dryRun: false, request, irreversible, validated: false };
  }
  if (!reread) throw new HttpError(502, "response_not_saved");
  const after = reread.item;
  if (response.read !== undefined && response.read !== null && after.read !== response.read) throw new HttpError(502, "response_not_saved");
  for (const answer of response.answers ?? []) {
    if (after.questions.find((question) => question.id === answer.question)?.answer === null) throw new HttpError(502, "response_not_saved");
  }
  if (response.acknowledge === true && after.questions.some((question) => question.kind === "ack" && question.answer === null)) throw new HttpError(502, "response_not_saved");
  return { before: row.item, after, written: true, dryRun: false, request, irreversible, validated: false };
};

/* ---- Creation, modification, publication, deletion ---- */

type Nature = { N: string; L: string; default: boolean };

const naturesOf = (...sources: unknown[]): Nature[] =>
  sources.flatMap((source) => listOf<any>(source))
    .filter((item) => typeof item?.N === "string")
    .map((item) => ({ N: String(item.N), L: String(item.L ?? "").trim(), default: item?.estDefaut === true }));

const resolveNature = (natures: Nature[], wanted: string | undefined, existing: any): { N: string; L: string } | null => {
  if (wanted) {
    const found = natures.find((item) => normalise(item.L) === normalise(wanted));
    if (!found) throw new HttpError(404, `category_not_found:${wanted}`);
    return { N: found.N, L: found.L };
  }
  const current = unwrap(existing);
  if (current?.N) return { N: String(current.N), L: String(current.L ?? "") };
  const fallback = natures.find((item) => item.default) ?? natures[0];
  return fallback ? { N: fallback.N, L: fallback.L } : null;
};

/** listePiecesJointes of a question: uploaded files { L, G: 1, E: 1, IDFichier }, links { L, G: 0, E: 1, url }. */
export const documentsOf = (attachments: WriteAttachmentRef[] | undefined): Record<string, unknown>[] =>
  (attachments ?? []).map((item) => {
    if (item.fileId) return { L: item.name, G: DOCUMENT_FILE, E: STATE_CREATED, IDFichier: item.fileId };
    if (item.url) return { L: item.name || item.url, G: DOCUMENT_LINK, E: STATE_CREATED, url: item.url };
    throw new HttpError(400, "attachment_without_file_or_url");
  });

export const questionMember = (question: NonNullable<NewsWrite["questions"]>[number], rank: number, attachments: WriteAttachmentRef[] = []): Record<string, unknown> => ({
  N: 0,
  E: STATE_CREATED,
  rang: rank,
  texte: html(question.text),
  genreReponse: QUESTION_GENRES[question.kind],
  tailleReponse: question.maxLength ?? 0,
  listeChoix: (question.choices ?? []).map((choice, index) => ({ rang: index + 1, L: choice.label, estReponseLibre: choice.free === true })),
  listePiecesJointes: documentsOf(attachments),
});

export type Audience = { entities: { N: string; G: number }[]; individuals: { N: string; G: number }[] };

/** The audience members of SaisieActualites. */
export const audienceMembers = (write: NewsWrite, audience: Audience): Record<string, unknown> => {
  const parents = write.audience?.parents ?? "none";
  return {
    avecEleve: write.audience?.students === true,
    avecResp1: parents !== "none",
    avecResp2: parents === "all",
    avecProfsPrincipaux: write.audience?.mainTeachers === true,
    avecTuteurs: write.audience?.tutors === true,
    avecElevesRattaches: write.audience?.students === true,
    avecDirecteur: false,
    // not validated on a real server: the set of entity genres of the audience (classes 1, groups 2).
    genresPublicEntite: numberSet([...new Set(audience.entities.map((item) => item.G))]),
    listePublicEntite: audience.entities.map((item) => ({ N: item.N, G: item.G })),
    listePublicIndividu: audience.individuals.map((item) => ({ N: item.N, G: item.G })),
  };
};

/** SaisieActualites JSON of a creation or a modification (publie always false). */
export const newsSaveRequest = (write: NewsWrite, existing: Record<string, any> | null, nature: { N: string; L: string } | null, audience: Audience): Record<string, unknown> => {
  const kind = write.kind ?? (existing?.estSondage === true ? "survey" : "information");
  const questions = write.questions?.length
    ? write.questions
    : kind === "information" && !existing ? [{ text: write.text ?? "", kind: "none" as const }] : [];
  const members = questions.map((question, index) => questionMember(question, index + 1, index === 0 ? write.attachments : []));
  const existingQuestions = listOf<any>(existing?.listeQuestions);
  const listeQuestions = existing && write.questions?.length
    ? [...existingQuestions.map((question) => ({ ...question, E: STATE_DELETED })), ...members]
    : existing && !write.questions?.length ? existingQuestions : members;
  const start = write.start !== undefined ? pronoteDate(new Date(write.start * 1000)) : existing?.dateDebut ?? pronoteDate(new Date());
  const end = write.end === undefined ? existing?.dateFin ?? null : write.end === null ? null : pronoteDate(new Date(write.end * 1000));
  return {
    listeActualites: [
      {
        ...(existing ?? {}),
        N: existing?.N ?? 0,
        E: existing ? STATE_MODIFIED : STATE_CREATED,
        L: String(write.title ?? existing?.L ?? "").trim(),
        estInformation: kind === "information",
        estSondage: kind === "survey",
        publie: false,
        estModele: write.template ?? existing?.estModele === true,
        nature: nature ? { N: nature.N, L: nature.L } : existing?.nature ?? null,
        dateDebut: start,
        dateFin: end,
        genreReponse: members[0]?.genreReponse ?? existingQuestions[0]?.genreReponse ?? QUESTION_GENRES.none,
        tailleReponse: members[0]?.tailleReponse ?? existingQuestions[0]?.tailleReponse ?? 0,
        reponseAnonyme: write.anonymous ?? existing?.reponseAnonyme === true,
        publicationPageEtablissement: existing?.publicationPageEtablissement === true,
        listeIndividusPartage: listOf<any>(existing?.listeIndividusPartage).map((who) => ({ N: who?.N, G: who?.G })),
        avecModificationPublic: true,
        ...(write.audience || !existing ? audienceMembers(write, audience) : {}),
        listeQuestions,
        listeDocuments: [],
        estADupliquer: false,
        estAModeliser: false,
        saisieActualite: true,
      },
    ],
    saisieActualite: true,
  };
};

/** SaisieActualites JSON toggling publie (publish, unpublish) or deleting (E 3) an existing item. */
export const newsStateRequest = (existing: Record<string, any>, mode: "publish" | "unpublish" | "delete"): Record<string, unknown> => ({
  listeActualites: [
    {
      ...existing,
      E: mode === "delete" ? STATE_DELETED : STATE_MODIFIED,
      publie: mode === "delete" ? existing?.publie === true : mode === "publish",
      saisieActualite: true,
    },
  ],
  saisieActualite: true,
});

const resolveAudience = async (session: SessionHandle, audience: NewsWrite["audience"]): Promise<Audience> => {
  const result: Audience = { entities: [], individuals: [] };
  if (!audience) return result;
  const wanted: { kind: RecipientKind; label: string }[] = [
    ...(audience.classes ?? []).map((label) => ({ kind: "class" as const, label })),
    ...(audience.groups ?? []).map((label) => ({ kind: "group" as const, label })),
    ...(audience.individuals ?? []),
  ];
  if (wanted.length === 0) return result;
  const publics = await loadAllPublics(session, wanted.map((item) => item.kind));
  for (const target of resolveRecipients(publics, wanted)) {
    (target.G === 1 || target.G === 2 ? result.entities : result.individuals).push({ N: target.N, G: target.G });
  }
  return result;
};

/** Number of parents, main teachers and tutors reached (DonneesEditionInformation with avecPublic): nulls when unknown. */
const audienceCountOf = async (session: SessionHandle, audience: Audience): Promise<NewsWriteResult["audienceCount"]> => {
  const empty = { parents: null, mainTeachers: null, tutors: null };
  if (audience.entities.length === 0 && audience.individuals.length === 0) return empty;
  try {
    const data = await callFunction(session, "newsEdit", { avecPublic: true, listePublic: [...audience.entities, ...audience.individuals].map((item) => ({ N: item.N, G: item.G })) });
    // not validated on a real server: member names of the counts are guessed from the client labels.
    return {
      parents: integer(data?.nbResponsables ?? data?.nbResp ?? data?.nombreResponsables),
      mainTeachers: integer(data?.nbProfsPrincipaux ?? data?.nbProfPrincipaux ?? data?.nombreProfsPrincipaux),
      tutors: integer(data?.nbTuteurs ?? data?.nombreTuteurs),
    };
  } catch {
    return empty;
  }
};

const findOwn = (session: SessionHandle, page: Record<string, any>, predicate: (row: NewsRow) => boolean): NewsRow | null => {
  for (const scope of ["sent", "drafts"] as const) {
    const row = newsRowsOf(session, page, scope).find(predicate);
    if (row) return row;
  }
  return null;
};

export const writeNews = async (session: SessionHandle, write: NewsWrite, dryRun: boolean): Promise<NewsWriteResult> => {
  const page = await newsPage(session);
  let before: NewsRow | null = null;
  if (write.mode !== "create") {
    if (!write.id) throw new HttpError(400, "news_id_required");
    before = findOwn(session, page, (row) => row.item.id === write.id);
    if (!before) throw new HttpError(404, "news_not_found");
    if (before.item.locked) throw new HttpError(409, "news_locked");
  }
  const limits: NewsWriteResult["limits"] = { maxTitle: null, maxAnswer: null };
  let audienceCount: NewsWriteResult["audienceCount"] = { parents: null, mainTeachers: null, tutors: null };
  let request: Record<string, unknown>;
  let irreversible = false;

  if (write.mode === "create" || write.mode === "update") {
    const init = await callFunction(session, "newsEdit", { init: true, avecCategories: true, avecListeIndividusPossiblesPartage: true });
    limits.maxTitle = integer(init?.tailleMaxTitre);
    limits.maxAnswer = integer(init?.tailleMaxReponse);
    const title = String(write.title ?? before?.item.title ?? "").trim();
    if (!title) throw new HttpError(400, "title_required");
    if (limits.maxTitle !== null && title.length > limits.maxTitle) throw new HttpError(400, "title_too_long");
    if (write.mode === "create" && (write.kind === "survey" ? !write.questions?.length : !write.text && !write.questions?.length)) throw new HttpError(400, "content_required");
    const audience = await resolveAudience(session, write.audience);
    if (write.mode === "create" && audience.entities.length === 0 && audience.individuals.length === 0) throw new HttpError(400, "audience_required");
    if (write.mode === "update" && write.audience && audience.entities.length === 0 && audience.individuals.length === 0) throw new HttpError(400, "audience_required");
    audienceCount = await audienceCountOf(session, audience);
    const nature = resolveNature(naturesOf(page?.listeNatures, init?.listeNatures, init?.listeCategories), write.category, before?.raw?.nature);
    request = newsSaveRequest({ ...write, title }, before?.raw ?? null, nature, audience);
  } else {
    request = newsStateRequest(before!.raw, write.mode);
    irreversible = write.mode === "publish" || write.mode === "unpublish" || before!.item.published;
  }

  const title = normalise(String((request.listeActualites as any[])[0]?.L ?? ""));
  if (dryRun) {
    const planned: NewsItem | null = write.mode === "delete"
      ? null
      : {
        ...(before?.item ?? emptyItem(title)),
        title: String((request.listeActualites as any[])[0]?.L ?? ""),
        published: write.mode === "publish" ? true : write.mode === "unpublish" ? false : false,
        state: write.mode === "publish" ? "published" : write.template || before?.item.state === "template" ? "template" : "draft",
        scope: write.mode === "publish" ? "sent" : before?.item.scope ?? "drafts",
        mine: true,
      };
    return { before: before?.item ?? null, after: planned, written: false, dryRun: true, request, irreversible, limits, audienceCount, validated: false };
  }

  await sendWrite(session, "newsSave", request);
  const reread = await newsPage(session);
  const found = findOwn(session, reread, (row) => normalise(row.item.title) === title && row.item.mine);
  if (write.mode === "delete") {
    if (found) throw new HttpError(502, "news_not_saved");
    return { before: before!.item, after: null, written: true, dryRun: false, request, irreversible, limits, audienceCount, validated: false };
  }
  if (!found) throw new HttpError(502, "news_not_saved");
  if (write.mode === "publish" && !found.item.published) throw new HttpError(502, "news_not_saved");
  if (write.mode === "unpublish" && found.item.published) throw new HttpError(502, "news_not_saved");
  return { before: before?.item ?? null, after: found.item, written: true, dryRun: false, request, irreversible, limits, audienceCount, validated: false };
};

const emptyItem = (title: string): NewsItem => ({
  id: `n:${title}`,
  title,
  date: 0,
  author: "",
  category: "",
  read: false,
  survey: false,
  text: "",
  attachments: [],
  kind: "information",
  scope: "drafts",
  published: false,
  state: "draft",
  start: null,
  end: null,
  publicSummary: "",
  sharedWith: [],
  locked: false,
  anonymous: false,
  mine: true,
  withoutAnswer: null,
  answeredPercent: null,
  questions: [],
});
