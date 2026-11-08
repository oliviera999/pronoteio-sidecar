/**
 * Pedagogical forum (ForumPedagogique, tab 275), read only, validated on the demo server (captures 0067, 0089):
 * { type: "fpcr_Sujets" } → listeSujets[{ N, titre, strAuteur, genreModeration, matiere, listeThemes, etatPub,
 * roles { _T: 26 }, nbNonLu, nbMembres, nbAModerer, nbExclus, dateTri }];
 * { type: "fpcr_Posts", sujet: { N }, avecSujet: true, modeVisuMembre: false } → sujet { …, htmlPost },
 * listePosts[{ N, etatHeader, strAuteur, strDate, estImportant, actions { _T: 26 }, contenu }].
 * Posts are written by students and nominative: they only leave through the authenticated teacher's session.
 * SaisieForumPedagogique (fpcs_*) is never sent.
 */
import type { SessionHandle } from "pawnote";
import { HttpError } from "../errors.js";
import { listOf, parsePronoteDate } from "../pronote/encoding.js";
import { seconds, type ForumPost, type ForumTopic } from "../normalise.js";
import { isAccessDenied } from "./competencies.js";
import { callFunction, isTabClosed } from "./functions.js";
import { stableIds } from "./ids.js";

const unwrap = (value: unknown): any => (value !== null && typeof value === "object" && "V" in (value as object) ? (value as { V: unknown }).V : value);

const label = (value: unknown): string => {
  const raw = unwrap(value);
  if (typeof raw === "string") return raw.trim();
  return String((raw as any)?.L ?? "").trim();
};

const html = (value: unknown): string => {
  const raw = unwrap(value);
  return typeof raw === "string" ? raw : "";
};

/** Date of "dateTri" or a displayed "strDate" ("jeu. 24/11/22 12h36" is read as dd/mm/yy hh:mm). */
const dateOf = (value: unknown): number => {
  const raw = unwrap(value);
  const parsed = parsePronoteDate(raw);
  if (parsed) return seconds(parsed);
  const match = String(raw ?? "").match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2})[h:](\d{2}))?/);
  if (!match) return 0;
  const [, d, m, y, h = "0", i = "0"] = match;
  const year = y.length === 2 ? 2000 + Number(y) : Number(y);
  return seconds(new Date(year, Number(m) - 1, Number(d), Number(h), Number(i)));
};

export type TopicRow = { topic: ForumTopic; raw: Record<string, any> };

export const topicsFromAnswer = (data: Record<string, any>): TopicRow[] => {
  const items = listOf<any>(data?.listeSujets).filter((item) => typeof item?.N === "string");
  const ids = stableIds("forumTopic", items, (item) => `${String(item?.titre ?? item?.L ?? "")}|${String(unwrap(item?.dateTri) ?? "")}`);
  return items.map((raw, index) => ({
    raw,
    topic: {
      id: ids[index],
      title: String(raw?.titre ?? raw?.L ?? "").trim(),
      author: String(raw?.strAuteur ?? "").trim(),
      subject: label(raw?.matiere),
      themes: listOf<any>(raw?.listeThemes).map(label).filter(Boolean),
      state: String(unwrap(raw?.etatPub) ?? ""),
      moderated: Number(raw?.genreModeration ?? 0) !== 0,
      unread: Number(raw?.nbNonLu ?? 0),
      members: Number(raw?.nbMembres ?? 0),
      toModerate: Number(raw?.nbAModerer ?? 0),
      excluded: Number(raw?.nbExclus ?? 0),
      date: dateOf(raw?.dateTri),
    },
  }));
};

export const postsFromAnswer = (data: Record<string, any>, topicId: string): ForumPost[] =>
  listOf<any>(data?.listePosts).map((raw, index) => ({
    id: `${topicId}|${index + 1}`,
    author: String(raw?.strAuteur ?? "").trim(),
    date: dateOf(raw?.strDate ?? raw?.date),
    text: html(raw?.contenu),
    important: raw?.estImportant === true,
    state: String(unwrap(raw?.etatHeader) ?? ""),
  }));

export type ForumResult =
  | { available: boolean; reason: string; topics: ForumTopic[] }
  | { available: boolean; reason: string; topic: ForumTopic; posts: ForumPost[] };

export const forum = async (session: SessionHandle, topicId?: string): Promise<ForumResult> => {
  if (isTabClosed(session, "forum")) return { available: false, reason: "tab_closed", topics: [] };
  let rows: TopicRow[];
  try {
    rows = topicsFromAnswer(await callFunction(session, "forum", { type: "fpcr_Sujets" }));
  } catch (error) {
    if (isAccessDenied(error)) return { available: false, reason: "access_denied", topics: [] };
    throw error;
  }
  if (!topicId) return { available: true, reason: "", topics: rows.map((row) => row.topic) };
  const row = rows.find((item) => item.topic.id === topicId);
  if (!row) throw new HttpError(404, "topic_not_found");
  const data = await callFunction(session, "forum", { type: "fpcr_Posts", sujet: { N: row.raw.N }, avecSujet: true, modeVisuMembre: false });
  return { available: true, reason: "", topic: row.topic, posts: postsFromAnswer(data, row.topic.id) };
};
