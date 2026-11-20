/**
 * Shape of an answer of Pronote: names and types of its members, never a value (0.14.0, moved out of students.ts so
 * that the decoders can describe an answer they do not understand without importing the student files).
 */
import { isPlain } from "./tolerant.js";
/** Members never described, not even by name: health, support plans, memos and attestations. */
export const SENSITIVE = /(medic|allerg|sante|pai|pap|handicap|memo|attestation|projet|alimentaire|dispens)/i;
/** Largest number of lines of a shape, and of the whole shape of ONE function (GET /pp/check?function=…). */
export const MAX_SHAPE = 150;
export const MAX_SHAPE_FULL = 1500;
/** Elements of a list whose members are merged, further elements looked at for a member empty in all of them. */
const SHAPE_SIBLINGS = 5;
const SHAPE_REST = 200;
const SHAPE_DEPTH = 14;
const lengthClass = (length) => (length === 0 ? "0" : length === 1 ? "1" : "2+");
/** null, an empty list, an empty object, or a typed value ({ _T, V }) holding one of them. */
const isHollow = (value) => {
    if (value === null || value === undefined)
        return true;
    if (Array.isArray(value))
        return value.length === 0;
    if (isPlain(value))
        return "V" in value ? isHollow(value.V) : Object.keys(value).length === 0;
    return false;
};
const describe = (candidates, rest, path, depth, out, skip, max) => {
    if (out.length >= max || depth > SHAPE_DEPTH || candidates.length === 0)
        return;
    if (path !== "") {
        const kinds = [];
        let longest = 0;
        for (const candidate of candidates) {
            const kind = Array.isArray(candidate) ? "list" : candidate === null ? "null" : typeof candidate;
            if (Array.isArray(candidate))
                longest = Math.max(longest, candidate.length);
            if (!kinds.includes(kind))
                kinds.push(kind);
        }
        out.push(`${path}: ${kinds.map((kind) => (kind === "list" ? `list[${lengthClass(longest)}]` : kind)).join("|")}`);
    }
    const elements = candidates.filter((candidate) => Array.isArray(candidate)).flat();
    if (elements.length > 0) {
        describe(elements.slice(0, SHAPE_SIBLINGS), elements.slice(SHAPE_SIBLINGS, SHAPE_SIBLINGS + SHAPE_REST), `${path}[]`, depth + 1, out, skip, max);
    }
    const objects = candidates.filter(isPlain);
    if (objects.length === 0)
        return;
    const keys = [];
    for (const object of objects) {
        for (const key of Object.keys(object))
            if (!keys.includes(key))
                keys.push(key);
    }
    for (const key of keys) {
        if (out.length >= max)
            break;
        if (skip?.test(key))
            continue;
        const child = path === "" ? key : `${path}.${key}`;
        const values = objects.filter((object) => key in object).map((object) => object[key]);
        if (key === "_T" && values.every((value) => typeof value === "number")) {
            out.push(`${child}=${[...new Set(values)].join("|")}`);
            continue;
        }
        // A member empty in the first elements (a first line without cells) is described from the first element that fills it.
        if (values.every(isHollow)) {
            const filled = rest.find((item) => isPlain(item) && key in item && !isHollow(item[key]));
            if (filled !== undefined)
                values.push(filled[key]);
        }
        describe(values, [], child, depth + 1, out, skip, max);
    }
};
/**
 * Shape of an answer of Pronote, to finish a decoder on a real account WITHOUT any value: one line per member path with
 * its type ("Scolarite.V.classe: object"), the type code of typed values ("_T=7") and, for a list, the class of its
 * length ("list[0]", "list[1]", "list[2+]"). 0.14.0: the elements of a list are described by the members of its first
 * five elements together (a first element empty or unusual no longer hides the others), and a member empty in all of
 * them by the first element that fills it; several types seen for one member are joined ("object|null"). Sensitive
 * members are left out (their presence alone would say something about the student). Never a value: no string, number
 * or date of the answer, only names of members, types, type codes and classes of length.
 */
export const shapeOf = (value, path = "", depth = 0, out = [], skip = SENSITIVE, max = MAX_SHAPE) => {
    describe([value], [], path, depth, out, skip, max);
    return out;
};
//# sourceMappingURL=shape.js.map