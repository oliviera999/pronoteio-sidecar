import { localString, wallToEpoch } from "./time.js";
/** LocalTimes of the given wall Dates (null and undefined left out). */
export const localTimes = (dates) => {
    const result = {};
    for (const [key, date] of Object.entries(dates)) {
        if (date instanceof Date && !Number.isNaN(date.getTime()))
            result[key] = localString(date);
    }
    return result;
};
/**
 * Timestamp (seconds) of a wall Date read from Pronote, in the school's time zone (time.ts). Until 0.8.0 the host's
 * time zone was used: one hour too early on a host in UTC+1 while Casablanca is in UTC+0.
 */
export const seconds = (date) => wallToEpoch(date);
export const lessonFromPawnote = (item) => {
    if (item.is !== "lesson")
        return null;
    return {
        id: item.id,
        subject: item.subject?.name ?? "",
        teacher: item.teacherNames.join(", "),
        rooms: [...item.classrooms],
        groups: [...item.groupNames],
        start: seconds(item.startDate),
        end: seconds(item.endDate),
        cancelled: item.canceled,
        status: item.status ?? "",
        local: localTimes({ start: item.startDate, end: item.endDate }),
    };
};
export const homeworkFromPawnote = (item) => ({
    id: item.id,
    subject: item.subject.name,
    description: item.description,
    due: seconds(item.deadline),
    // TODO: Pawnote does not expose the target groups of an assignment; resolve them via item.resourceID.
    groups: [],
    attachments: item.attachments.map((file) => ({ name: file.name, url: file.url })),
    local: localTimes({ due: item.deadline }),
});
/** Splits a Pronote display name "NOM Prénom" (upper-case words form the last name). */
export const splitDisplayName = (label) => {
    const words = label.trim().split(/\s+/);
    let index = 0;
    while (index < words.length - 1 && /\p{L}/u.test(words[index]) && words[index] === words[index].toLocaleUpperCase("fr")) {
        index++;
    }
    if (index === 0)
        index = 1;
    return { lastname: words.slice(0, index).join(" "), firstname: words.slice(index).join(" ") };
};
/** Category kinds of a notebook content (PageSaisieCahierDeTextes_General.ListeCategories[].G). */
export const CONTENT_KIND = {
    custom: 0,
    lesson: 1,
    correction: 2,
    writtenTest: 3,
    oralTest: 4,
    td: 5,
    tp: 6,
    skillsAssessment: 7,
    epi: 8,
    ap: 9,
    visio: 12,
    ccf: 13,
    certifyingAssessment: 14,
};
/** Content kinds that flag an assessment. */
export const ASSESSMENT_KINDS = [
    CONTENT_KIND.writtenTest,
    CONTENT_KIND.skillsAssessment,
    CONTENT_KIND.ccf,
    CONTENT_KIND.certifyingAssessment,
];
/** Comparable form of a label: lower case, no accents, single spaces. */
export const normalise = (value) => value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
/** Plain text of an HTML fragment, whitespace collapsed, truncated. */
export const plainText = (html, max = 300) => {
    const text = html
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/<\/(p|div|li|tr|h[1-6])>/gi, " ")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim();
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};
/* ---- Lot 2 (0.7.0): grades overview, skills, report comments, messaging, news, locker, quizzes ---- */
/**
 * Comparable form of a class or group label: normalise(), then brackets, dashes and any other punctuation become
 * single spaces ("[T06AP ORIENT]" → "t06ap orient", "[1-SPE SVT-10]" → "1 spe svt 10"). Same rule as
 * get_pronote_classes::normalise() in local_olutionmcp.
 */
export const labelKey = (value) => normalise(value).replace(/[^a-z0-9]+/g, " ").trim();
/**
 * Does a class or group label match a wanted label? Both sides go through labelKey(); the wanted label matches when
 * equal, or when it is a prefix that ends at a word boundary: followed by a space ("T06AP" keeps "[T06AP ORIENT]"),
 * or by a digit when the wanted label ends with a letter ("1G" keeps "1G3"). A wanted label ending with a digit never
 * catches a longer number ("T11" does not keep "T110").
 */
export const labelMatches = (label, wanted) => {
    const key = labelKey(label);
    const want = labelKey(wanted);
    if (want === "" || key === "")
        return false;
    if (key === want)
        return true;
    if (!key.startsWith(want))
        return false;
    const next = key.charAt(want.length);
    return next === " " || (/[0-9]/.test(next) && /[a-z]/.test(want.charAt(want.length - 1)));
};
/** Label filter: a group is kept when one of the wanted labels matches it (labelMatches), all kept when none. */
export const matchesLabels = (groups, wanted) => {
    const filter = wanted.filter((label) => labelKey(label) !== "");
    if (filter.length === 0)
        return true;
    return filter.some((label) => groups.some((group) => labelMatches(group, label)));
};
//# sourceMappingURL=normalise.js.map