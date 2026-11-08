/**
 * Possible recipients of a message (teacher space), read only and MINIMISED.
 *
 * ListePublics (tab 131), one call per nature: { pourMessagerie: true, genres: { _T: 26, V: "[g]" },
 * sansFiltreSurEleve: true, avecFonctionPersonnel: true } with genres 1 class, 2 group, 3 teacher, 4 student,
 * 5 parent, 34 staff (captures 0077-0084 on the demo server). The student items carry listeProjetsAcc (support
 * plans) and regimeEleve, the parent items niveauResponsabilite and their children: only the label, the nature,
 * the classes, the refusal flag and, for a parent, the label and class of each child leave this module. No
 * Pronote N leaves the sidecar: ids are built on the labels ("r:<kind>|<label>").
 *
 * ListePublics is the call of the client when the right communication.avecDiscussionAvancee is granted; the
 * accounts without it use ListeRessourcesPourCommunication { onglet: { N: 0, G: genre }, filtreElement: { N, G, L }
 * of the connected teacher } whose answer is listeRessourcesPourCommunication[] filtered on avecDiscussion (as
 * Pawnote's newDiscussionRecipients; empty on the demo, captures 0041-0046: not validated), and an empty answer
 * gives available: false, reason recipients_unavailable.
 */
import type { SessionHandle } from "pawnote";
import { HttpError } from "../errors.js";
import { listOf, numberSet } from "../pronote/encoding.js";
import { hasRight, userData } from "../pronote/userdata.js";
import { normalise, type Recipient, type RecipientKind, type RecipientsResult } from "../normalise.js";
import { isAccessDenied } from "./competencies.js";
import { callFunction, functions } from "./functions.js";
import { stableIds } from "./ids.js";
import { listDiscussions } from "./messaging.js";

/** TypeHttpRessource of each recipient kind in ListePublics. */
export const RECIPIENT_GENRES: Record<RecipientKind, number> = { class: 1, group: 2, teacher: 3, student: 4, parent: 5, staff: 34 };

export const RECIPIENT_KINDS = Object.keys(RECIPIENT_GENRES) as RecipientKind[];

/** Pronote public kept in memory for a write: identifier, genre, label and the minimised details. */
export type Public = { N: string; G: number; L: string; refuses: boolean; recipient: Recipient };

const label = (value: unknown): string => {
  const raw = value !== null && typeof value === "object" && "V" in (value as object) ? (value as { V: unknown }).V : value;
  if (typeof raw === "string") return raw.trim();
  return String((raw as any)?.L ?? "").trim();
};

const labels = (value: unknown): string[] => listOf<any>(value).map(label).filter(Boolean);

/** Class of a child of a parent item: eleves[].classe (object or label) or the first of eleves[].classes. */
// not validated on a real server: the children shape of a parent item (eleves[]) was captured without its class member.
const childClass = (child: any): string => label(child?.classe) || labels(child?.classes)[0] || "";

const roleOf = (kind: RecipientKind, item: any): string => {
  if (kind === "teacher") return item?.estProfPrincipal === true ? "main" : item?.estProfTuteur === true ? "tutor" : "";
  if (kind === "staff") return label(item?.fonction);
  return "";
};

const taughtOf = (session: SessionHandle, kind: RecipientKind, item: any): boolean => {
  if (item?.enseigne === true) return true;
  if (kind !== "class" && kind !== "group") return false;
  const name = normalise(String(item?.L ?? ""));
  return userData(session).resources.some((resource) => resource.taught && normalise(resource.label) === name);
};

/** Publics of one kind of a ListePublics (or ListeRessourcesPourCommunication) answer, minimised. */
export const publicsOf = (session: SessionHandle, kind: RecipientKind, data: Record<string, any>): Public[] => {
  const items = listOf<any>(data?.listePublics ?? data?.listeRessourcesPourCommunication).filter((item) => typeof item?.N === "string");
  // Homonyms get "~2", "~3"… in Pronote order, like every stable id of the sidecar.
  const ids = stableIds("recipient", items, (item) => `${kind}|${String(item.L ?? "").trim()}`);
  return items.map((item, index) => {
      const text = String(item.L ?? "").trim();
      const recipient: Recipient = {
        id: ids[index],
        kind,
        label: text,
        classes: kind === "student" ? labels(item?.classes) : [],
        refuses: item?.discussionInterdit === true || item?.refusMess === true,
        children: kind === "parent" ? listOf<any>(item?.eleves).map((child) => ({ label: label(child), class: childClass(child) })).filter((child) => child.label) : [],
        role: roleOf(kind, item),
        taught: taughtOf(session, kind, item),
      };
      return { N: String(item.N), G: Number(item.G ?? RECIPIENT_GENRES[kind]), L: text, refuses: recipient.refuses, recipient };
    });
};

/** The connected teacher as Pawnote's userResource ({ N, G, L }), for filtreElement. */
const connectedTeacher = (session: SessionHandle): { N: string; G: number; L: string } => {
  const user = (session as any).userResource ?? (session as any).user?.resources?.[0] ?? (session as any).user ?? {};
  return { N: String(user.id ?? ""), G: Number(user.kind ?? RECIPIENT_GENRES.teacher), L: String(user.name ?? "") };
};

/** Whether the account has the "discussion avancée" right (ListePublics); null when the rights are unknown. */
export const advancedMessaging = (session: SessionHandle): boolean | null =>
  hasRight(userData(session).rights as Record<string, unknown>, "communication", "avecDiscussionAvancee");

/**
 * Publics of one kind: ListePublics, or ListeRessourcesPourCommunication when the right is absent; null when the
 * fallback answers nothing (recipients unavailable for this account).
 */
export const loadPublics = async (session: SessionHandle, kind: RecipientKind): Promise<Public[] | null> => {
  const genre = RECIPIENT_GENRES[kind];
  if (advancedMessaging(session) !== false) {
    const data = await callFunction(session, "recipientsList", { pourMessagerie: true, genres: numberSet([genre]), sansFiltreSurEleve: true, avecFonctionPersonnel: true });
    return publicsOf(session, kind, data);
  }
  const data = await callFunction(session, "recipientsFallback", { onglet: { N: 0, G: genre }, filtreElement: connectedTeacher(session) });
  const publics = publicsOf(session, kind, { listeRessourcesPourCommunication: listOf<any>(data?.listeRessourcesPourCommunication).filter((item) => item?.avecDiscussion === true) });
  return publics.length ? publics : null;
};

/** Publics of several kinds, or 409 recipients_unavailable when the account cannot list them. */
export const loadAllPublics = async (session: SessionHandle, kinds: RecipientKind[]): Promise<Record<RecipientKind, Public[]>> => {
  const result = {} as Record<RecipientKind, Public[]>;
  for (const kind of [...new Set(kinds)]) {
    let publics: Public[] | null;
    try {
      publics = await loadPublics(session, kind);
    } catch (error) {
      if (isAccessDenied(error)) throw new HttpError(409, `tab_closed:${functions.recipientsList.name}`);
      throw error;
    }
    if (publics === null) throw new HttpError(409, "recipients_unavailable");
    result[kind] = publics;
  }
  return result;
};

/** Resolves recipient labels against the publics of their kind; 404 when unknown, 409 when one refuses messages. */
export const resolveRecipients = (publics: Partial<Record<RecipientKind, Public[]>>, recipients: { kind: RecipientKind; label: string }[]): Public[] =>
  recipients.map((recipient) => {
    const candidates = publics[recipient.kind] ?? [];
    const matches = candidates.filter((item) => normalise(item.L) === normalise(recipient.label));
    if (matches.length === 0) throw new HttpError(404, `recipient_not_found:${recipient.label}`);
    if (matches.length > 1) throw new HttpError(409, `recipient_ambiguous:${recipient.label}`);
    if (matches[0].refuses) throw new HttpError(409, `recipient_refuses:${recipient.label}`);
    return matches[0];
  });

export type RecipientFilter = { query?: string; class?: string; student?: string; limit?: number };

const includes = (haystack: string, needle: string): boolean => normalise(haystack).includes(normalise(needle));
const same = (a: string, b: string): boolean => normalise(a) === normalise(b);

/**
 * Filters the recipients: "query" on the label (and the children of a parent); "class" keeps the class itself,
 * its students and the parents of its students (teachers and staff carry no class in ListePublics: kept as is);
 * "student" keeps the classes of that student, the student and his or her parents only.
 */
export const filterRecipients = (items: Recipient[], filter: RecipientFilter): Recipient[] => {
  let result = items;
  if (filter.student) {
    const student = filter.student;
    const classes = result.filter((item) => item.kind === "student" && same(item.label, student)).flatMap((item) => item.classes);
    result = result.filter((item) =>
      (item.kind === "student" && same(item.label, student))
      || (item.kind === "parent" && item.children.some((child) => same(child.label, student)))
      || (item.kind === "class" && classes.some((name) => same(name, item.label))),
    );
  }
  if (filter.class) {
    const wanted = filter.class;
    result = result.filter((item) => {
      if (item.kind === "class" || item.kind === "group") return same(item.label, wanted);
      if (item.kind === "student") return item.classes.some((name) => same(name, wanted));
      if (item.kind === "parent") return item.children.some((child) => same(child.class, wanted));
      return true;
    });
  }
  if (filter.query) {
    const query = filter.query;
    result = result.filter((item) => includes(item.label, query) || item.children.some((child) => includes(child.label, query)));
  }
  return result;
};

export const recipients = async (session: SessionHandle, kinds: RecipientKind[], filter: RecipientFilter = {}): Promise<RecipientsResult> => {
  const { disabled } = await listDiscussions(session);
  const wanted = kinds.length ? kinds : RECIPIENT_KINDS;
  const items: Recipient[] = [];
  for (const kind of wanted) {
    let publics: Public[] | null;
    try {
      publics = await loadPublics(session, kind);
    } catch (error) {
      if (isAccessDenied(error)) return { available: false, reason: "access_denied", disabled, items: [], total: 0, truncated: false };
      throw error;
    }
    if (publics === null) return { available: false, reason: "recipients_unavailable", disabled, items: [], total: 0, truncated: false };
    items.push(...publics.map((item) => item.recipient));
  }
  const filtered = filterRecipients(items, filter);
  const limit = Math.min(500, Math.max(1, filter.limit ?? 200));
  return { available: true, reason: "", disabled, items: filtered.slice(0, limit), total: filtered.length, truncated: filtered.length > limit };
};
