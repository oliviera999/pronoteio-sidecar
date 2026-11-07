export const seconds = (date) => Math.floor(date.getTime() / 1000);
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
/** Label filter: a wanted label matches a group when equal or when the group starts with it ("1G" keeps "1G3"). */
export const matchesLabels = (groups, wanted) => {
    const filter = wanted.map(normalise).filter(Boolean);
    if (filter.length === 0)
        return true;
    const own = groups.map(normalise);
    return filter.some((label) => own.some((group) => group === label || group.startsWith(label)));
};
//# sourceMappingURL=normalise.js.map