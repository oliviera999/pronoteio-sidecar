import { HttpError } from "../errors.js";
import { listOf, numberSet } from "../pronote/encoding.js";
import { hasRight, userData } from "../pronote/userdata.js";
import { normalise } from "../normalise.js";
import { callFunction } from "./functions.js";
import { stableId } from "./ids.js";
import { listDiscussions } from "./messaging.js";
/** TypeHttpRessource of each recipient kind in ListePublics. */
export const RECIPIENT_GENRES = { class: 1, group: 2, teacher: 3, student: 4, parent: 5, staff: 34 };
export const RECIPIENT_KINDS = Object.keys(RECIPIENT_GENRES);
const label = (value) => {
    const raw = value !== null && typeof value === "object" && "V" in value ? value.V : value;
    if (typeof raw === "string")
        return raw.trim();
    return String(raw?.L ?? "").trim();
};
const labels = (value) => listOf(value).map(label).filter(Boolean);
/** Class of a child of a parent item: eleves[].classe (object or label) or the first of eleves[].classes. */
// not validated on a real server: the children shape of a parent item (eleves[]) was captured without its class member.
const childClass = (child) => label(child?.classe) || labels(child?.classes)[0] || "";
const roleOf = (kind, item) => {
    if (kind === "teacher")
        return item?.estProfPrincipal === true ? "main" : item?.estProfTuteur === true ? "tutor" : "";
    if (kind === "staff")
        return label(item?.fonction);
    return "";
};
const taughtOf = (session, kind, item) => {
    if (item?.enseigne === true)
        return true;
    if (kind !== "class" && kind !== "group")
        return false;
    const name = normalise(String(item?.L ?? ""));
    return userData(session).resources.some((resource) => resource.taught && normalise(resource.label) === name);
};
/** Publics of one kind of a ListePublics (or ListeRessourcesPourCommunication) answer, minimised. */
export const publicsOf = (session, kind, data) => listOf(data?.listePublics ?? data?.listeRessources ?? data?.liste)
    .filter((item) => typeof item?.N === "string")
    .map((item) => {
    const text = String(item.L ?? "").trim();
    const recipient = {
        id: stableId("recipient", `${kind}|${text}`),
        kind,
        label: text,
        classes: kind === "student" ? labels(item?.classes) : [],
        refuses: item?.discussionInterdit === true || item?.refusMess === true,
        children: kind === "parent" ? listOf(item?.eleves).map((child) => ({ label: label(child), class: childClass(child) })).filter((child) => child.label) : [],
        role: roleOf(kind, item),
        taught: taughtOf(session, kind, item),
    };
    return { N: String(item.N), G: Number(item.G ?? RECIPIENT_GENRES[kind]), L: text, refuses: recipient.refuses, recipient };
});
/** Whether the account has the "discussion avancée" right (ListePublics); null when the rights are unknown. */
export const advancedMessaging = (session) => hasRight(userData(session).rights, "communication", "avecDiscussionAvancee");
/**
 * Publics of one kind: ListePublics, or ListeRessourcesPourCommunication when the right is absent; null when the
 * fallback answers nothing (recipients unavailable for this account).
 */
export const loadPublics = async (session, kind) => {
    const genre = RECIPIENT_GENRES[kind];
    if (advancedMessaging(session) !== false) {
        const data = await callFunction(session, "recipientsList", { pourMessagerie: true, genres: numberSet([genre]), sansFiltreSurEleve: true, avecFonctionPersonnel: true });
        return publicsOf(session, kind, data);
    }
    const data = await callFunction(session, "recipientsFallback", { onglet: { N: 0, G: genre } });
    const publics = publicsOf(session, kind, data);
    return publics.length ? publics : null;
};
/** Publics of several kinds, or 409 recipients_unavailable when the account cannot list them. */
export const loadAllPublics = async (session, kinds) => {
    const result = {};
    for (const kind of [...new Set(kinds)]) {
        const publics = await loadPublics(session, kind);
        if (publics === null)
            throw new HttpError(409, "recipients_unavailable");
        result[kind] = publics;
    }
    return result;
};
/** Resolves recipient labels against the publics of their kind; 404 when unknown, 409 when one refuses messages. */
export const resolveRecipients = (publics, recipients) => recipients.map((recipient) => {
    const candidates = publics[recipient.kind] ?? [];
    const matches = candidates.filter((item) => normalise(item.L) === normalise(recipient.label));
    if (matches.length === 0)
        throw new HttpError(404, `recipient_not_found:${recipient.label}`);
    if (matches.length > 1)
        throw new HttpError(409, `recipient_ambiguous:${recipient.label}`);
    if (matches[0].refuses)
        throw new HttpError(409, `recipient_refuses:${recipient.label}`);
    return matches[0];
});
const includes = (haystack, needle) => normalise(haystack).includes(normalise(needle));
const same = (a, b) => normalise(a) === normalise(b);
/**
 * Filters the recipients: "query" on the label (and the children of a parent); "class" keeps the class itself,
 * its students and the parents of its students (teachers and staff carry no class in ListePublics: kept as is);
 * "student" keeps the classes of that student, the student and his or her parents only.
 */
export const filterRecipients = (items, filter) => {
    let result = items;
    if (filter.student) {
        const student = filter.student;
        const classes = result.filter((item) => item.kind === "student" && same(item.label, student)).flatMap((item) => item.classes);
        result = result.filter((item) => (item.kind === "student" && same(item.label, student))
            || (item.kind === "parent" && item.children.some((child) => same(child.label, student)))
            || (item.kind === "class" && classes.some((name) => same(name, item.label))));
    }
    if (filter.class) {
        const wanted = filter.class;
        result = result.filter((item) => {
            if (item.kind === "class" || item.kind === "group")
                return same(item.label, wanted);
            if (item.kind === "student")
                return item.classes.some((name) => same(name, wanted));
            if (item.kind === "parent")
                return item.children.some((child) => same(child.class, wanted));
            return true;
        });
    }
    if (filter.query) {
        const query = filter.query;
        result = result.filter((item) => includes(item.label, query) || item.children.some((child) => includes(child.label, query)));
    }
    return result;
};
export const recipients = async (session, kinds, filter = {}) => {
    const { disabled } = await listDiscussions(session);
    const wanted = kinds.length ? kinds : RECIPIENT_KINDS;
    const items = [];
    for (const kind of wanted) {
        const publics = await loadPublics(session, kind);
        if (publics === null)
            return { available: false, reason: "recipients_unavailable", disabled, items: [], total: 0, truncated: false };
        items.push(...publics.map((item) => item.recipient));
    }
    const filtered = filterRecipients(items, filter);
    const limit = Math.min(500, Math.max(1, filter.limit ?? 200));
    return { available: true, reason: "", disabled, items: filtered.slice(0, limit), total: filtered.length, truncated: filtered.length > limit };
};
//# sourceMappingURL=recipients.js.map