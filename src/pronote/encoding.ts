/** Value encodings of the Pronote protocol (same conventions as Pawnote). */

/** Pronote date: { _T: 7, V: "d/m/yyyy h:m:s" } in server local time. */
export const pronoteDate = (date: Date) => ({
  _T: 7,
  V: `${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear()} ${date.getHours()}:${date.getMinutes()}:${date.getSeconds()}`,
});

/** Parses "dd/mm/yyyy" or "dd/mm/yyyy hh:mm:ss". */
export const parsePronoteDate = (value: unknown): Date | null => {
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?: (\d{1,2}):(\d{1,2}):(\d{1,2}))?$/);
  if (!match) return null;
  const [, d, m, y, h = "0", i = "0", s = "0"] = match;
  return new Date(Number(y), Number(m) - 1, Number(d), Number(h), Number(i), Number(s));
};

/** Entity reference { N: id, G: genre, L: label }. */
export const entity = (id: string, genre?: number, label?: string) => ({
  N: id,
  ...(genre !== undefined ? { G: genre } : {}),
  ...(label !== undefined ? { L: label } : {}),
});

/** Items of a Pronote list ({ _T: 24, V: [...] } or a plain array). */
export const listOf = <T = any>(value: unknown): T[] => {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object" && Array.isArray((value as { V?: unknown }).V)) {
    return (value as { V: T[] }).V;
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
} as const;

export type GradeStatus = "" | keyof typeof GRADE_STATUS;

/** Grade cell: "12,5" for a value, "|n" for a special status. */
export const gradeValue = (value: number | null, status: GradeStatus): string => {
  if (status !== "") return `|${GRADE_STATUS[status]}`;
  if (value === null) return "";
  return String(Math.round(value * 100) / 100).replace(".", ",");
};

/** Pronote numbers are sent with a decimal comma. */
export const pronoteNumber = (value: number): string => String(value).replace(".", ",");
