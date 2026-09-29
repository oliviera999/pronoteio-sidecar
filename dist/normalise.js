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
//# sourceMappingURL=normalise.js.map