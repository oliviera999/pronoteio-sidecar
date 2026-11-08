/** Value encodings of the Pronote protocol (same conventions as Pawnote). */
/** Pronote date: { _T: 7, V: "d/m/yyyy h:m:s" } in server local time. */
export const pronoteDate = (date) => ({
    _T: 7,
    V: `${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear()} ${date.getHours()}:${date.getMinutes()}:${date.getSeconds()}`,
});
/** Parses "dd/mm/yyyy" or "dd/mm/yyyy hh:mm:ss". */
export const parsePronoteDate = (value) => {
    if (typeof value !== "string")
        return null;
    const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?: (\d{1,2}):(\d{1,2}):(\d{1,2}))?$/);
    if (!match)
        return null;
    const [, d, m, y, h = "0", i = "0", s = "0"] = match;
    return new Date(Number(y), Number(m) - 1, Number(d), Number(h), Number(i), Number(s));
};
/** Entity reference { N: id, G: genre, L: label }. */
export const entity = (id, genre, label) => ({
    N: id,
    ...(genre !== undefined ? { G: genre } : {}),
    ...(label !== undefined ? { L: label } : {}),
});
/**
 * Set of numbers: { _T: 26, V: "[0,1,2]" } (genres of ListePublics, modesAffActus of PageActualites, roles,
 * actions...). A bare JSON array is silently ignored by Pronote.
 */
export const numberSet = (values) => ({ _T: 26, V: `[${[...values].join(",")}]` });
/**
 * Numbers of a Pronote set, whatever its type ({ _T: 26 | 8, V: "[1,3..5]" }, a bare "[…]" string or an array);
 * ranges "a..b" are expanded as Pawnote does.
 */
export const parseNumberSet = (value) => {
    if (Array.isArray(value))
        return value.map(Number).filter(Number.isFinite);
    const raw = value !== null && typeof value === "object" && "V" in value ? value.V : value;
    if (Array.isArray(raw))
        return raw.map(Number).filter(Number.isFinite);
    if (typeof raw !== "string")
        return [];
    const text = raw.trim();
    if (!text.startsWith("[") || !text.endsWith("]"))
        return [];
    const result = [];
    for (const part of text.slice(1, -1).split(",")) {
        const item = part.trim();
        if (item === "")
            continue;
        if (item.includes("..")) {
            const [from, to] = item.split("..").map((bound) => Number.parseInt(bound, 10));
            if (Number.isFinite(from) && Number.isFinite(to))
                for (let i = from; i <= to; i++)
                    result.push(i);
        }
        else {
            const number = Number.parseInt(item, 10);
            if (Number.isFinite(number))
                result.push(number);
        }
    }
    return result;
};
/** Items of a Pronote list ({ _T: 24, V: [...] } or a plain array). */
export const listOf = (value) => {
    if (Array.isArray(value))
        return value;
    if (value && typeof value === "object" && Array.isArray(value.V)) {
        return value.V;
    }
    return [];
};
/** Moodle-side grade statuses and their Pronote kind (GradeKind in Pawnote). */
export const GRADE_STATUS = {
    abs: 1,
    disp: 2,
    nonnote: 3,
    inapte: 4,
    nonrendu: 5,
    abszero: 6,
    nonrenduzero: 7,
};
/** Grade cell: "12,5" for a value, "|n" for a special status. */
export const gradeValue = (value, status) => {
    if (status !== "")
        return `|${GRADE_STATUS[status]}`;
    if (value === null)
        return "";
    return String(Math.round(value * 100) / 100).replace(".", ",");
};
/** Pronote numbers are sent with a decimal comma. */
export const pronoteNumber = (value) => String(value).replace(".", ",");
//# sourceMappingURL=encoding.js.map