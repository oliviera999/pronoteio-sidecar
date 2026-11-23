/**
 * Writes report card comments: SaisieAppreciation (tab 25 for the teacher's subject comment of a student or of the
 * class, tab 27 for the general comment of the main teacher), built from the client code (_saisirAppreciation and
 * clbckValidationAutoSurEditionPdB; docs/pronote-matrice/4-9-bulletins-divers.md in mood_prod).
 *
 * NOT VALIDATED: tabs 25 and 27 are closed to the demo profile. A comment is always modified, never created (every
 * cell exists with its N, or 0); the text read before is the only undo. Refused before any call when the entry is
 * closed by the administration or the text exceeds the school's limit. Comments reach families when the report card
 * is published.
 */
import type { SessionHandle } from "pawnote";
import { HttpError } from "../errors.js";
import { listOf } from "../pronote/encoding.js";
import { normalise } from "../normalise.js";
import { isAccessDenied, } from "./competencies.js";
import { commentResource, findCommentService, maxLengthOf, readKinds } from "./comments.js";
import { call, pickPeriod, ref, type Element } from "./grades.js";
import { sendWrite } from "./write.js";
import { currentContext } from "../context.js";

/** Member names of an object (never its values), for the access log of a write Pronote did not keep. */
const memberNames = (value: unknown): string =>
  value && typeof value === "object" ? Object.keys(value).filter((key) => /^[\w$]{1,40}$/.test(key)).sort().slice(0, 20).join(",") : "-";

const GENRE_CLASS = 1;
const GENRE_PERIOD = 2;
const GENRE_STUDENT = 4;
const STATE_MODIFIED = 2;
/**
 * TypeGenreAppreciation: 0 teacher's bulletin comment (GA_Bulletin_Professeur), 1 general bulletin comment
 * (GA_Bulletin_Generale). 0.16.1: the class comment of a service is a teacher's comment too: the client sends 0
 * (interfacesaisieapprbulletin.js, _saisirAppreciationClasse), where 1 was sent until 0.16.0.
 */
const KIND_SUBJECT = 0;
const KIND_GENERAL = 1;

export type CommentChange = { student?: string; kind: "subject" | "general"; text: string };

export type CommentsWrite = { class: string; period: string; items: CommentChange[]; dryRun: boolean;
  /** 0.14.0: name of the kind of general comment to write, when the school has several (see generalKindFor). */
  generalKind?: string };

export type CommentCell = { student: string | null; kind: "subject" | "general"; text: string | null };

export type CommentsWriteResult = {
  class: { id: string; name: string };
  period: { id: string; name: string };
  maxLength: number | null;
  before: CommentCell[];
  after: CommentCell[];
  requests: Record<string, unknown>[];
  written: boolean;
  dryRun: boolean;
  validated: false;
  /** 0.14.0: kind of general comment written, "" when none was. */
  generalKind: string;
};

/**
 * One comment that can be written. "classe" and "service" (0.16.1): the class and the service of the line when the
 * grid gives them, sent as is by the client (_getInfoClasseEleve: the student's own class for a group, the line's
 * service for a sub-service); absent, the requested resource and the chosen service are sent.
 */
type Cell = {
  student: { N: string; L: string } | null;
  /** N: null when Pronote gives none (empty cell of the grid), 0 for "0" (see numberOf). */
  appreciation: { N: string | number | null; G: number; L: string };
  classe?: { N: string; G: number };
  service?: { N: string };
};

/**
 * Identifier of an appreciation as the client sends it back (0.16.1, real grid of 23/11/2026). The client reads "N"
 * with ObjetElement.fromJSON ("0" becomes the number 0) and writes it with toJSON (an absent N is left out): an empty
 * cell of PageApprBulletin carries no N at all ({ G, estEditable }), an empty general comment carries "0". Until 0.16.0
 * the sidecar sent the string "0" in both cases and Pronote ignored the write silently (HTTP 200, nothing saved).
 */
export const numberOf = (value: unknown): string | number | null => {
  if (value === undefined || value === null || value === "") return null;
  if (value === "0" || value === 0) return 0;
  return String(value);
};

/** Text of an appreciation element: "L", else "appreciation" (class comment and general comments carry it there). */
const textOf = (app: Record<string, any>): string =>
  typeof app.L === "string" ? app.L : typeof app.appreciation === "string" ? app.appreciation : "";

const elementOf = (value: unknown): Record<string, any> | null => {
  const raw = value !== null && typeof value === "object" && "V" in (value as object) ? (value as { V: unknown }).V : value;
  return raw !== null && typeof raw === "object" ? (raw as Record<string, any>) : null;
};

/**
 * Comment of the teacher in a line: the first of appA, appB, appC that is not marked editable=false (0.16.1; appA only
 * until 0.16.0). The rank ("G", 1 to 3) is kept: Pronote stores the text in the column of that rank.
 */
const ownComment = (line: Record<string, any>): Record<string, any> | null => {
  const candidates = [line?.appA, line?.appB, line?.appC].map(elementOf).filter((item): item is Record<string, any> => item !== null);
  return candidates.find((item) => item.editable !== false && item.estEditable !== false) ?? candidates[0] ?? null;
};

const text = (value: unknown): string | null => {
  const raw = value !== null && typeof value === "object" && "V" in (value as object) ? (value as { V: unknown }).V : value;
  if (raw !== null && typeof raw === "object") return text((raw as { L?: unknown }).L);
  return typeof raw === "string" ? raw : null;
};

/** Cells of a PageApprBulletin answer with their identifiers (subject comments, then the class comment). */
export const subjectCells = (page: Record<string, any>): { cells: Cell[]; classCell: Cell | null; closed: boolean } => {
  const cells: Cell[] = [];
  for (const line of listOf<any>(page?.listeLignes)) {
    const student = line?.eleve?.V ?? line?.eleve;
    const app = ownComment(line);
    if (!student || !app) continue;
    const classe = elementOf(line?.classe);
    const service = elementOf(line?.service);
    cells.push({
      student: { N: String(student.N), L: String(student.L ?? "").trim() },
      appreciation: { N: numberOf(app.N), G: Number(app.G ?? 1), L: textOf(app) },
      ...(classe?.N !== undefined && classe.N !== "" ? { classe: { N: String(classe.N), G: Number(classe.G ?? GENRE_CLASS) } } : {}),
      ...(service?.N !== undefined && service.N !== "" ? { service: { N: String(service.N) } } : {}),
    });
  }
  const classApp = page?.appreciationClasse?.V ?? page?.appreciationClasse;
  const classCell = classApp && typeof classApp === "object"
    ? { student: null, appreciation: { N: numberOf(classApp.N), G: Number(classApp.G ?? 1), L: textOf(classApp) } }
    : null;
  const closed = String(page?.strInfoCloture ?? "").trim() !== ""
    || listOf<any>(page?.listeLignes).some((line) => line?.appA?.cloture === true || line?.appA?.V?.cloture === true);
  return { cells, classCell, closed };
};

/** Cells of a PageAppreciationsGenerales answer (general comment of each student). */
export const generalCells = (page: Record<string, any>): { cells: Cell[]; closed: boolean } => {
  const cells: Cell[] = [];
  let closed = false;
  for (const line of listOf<any>(page?.listeLignes)) {
    if (line?.estPere === true) continue;
    const student = line?.eleve?.V ?? line?.eleve;
    const app = line?.appreciationGle?.V ?? line?.appreciationGle;
    if (!student || !app) continue;
    if (app.cloture === true) closed = true;
    cells.push({
      student: { N: String(student.N), L: String(student.L ?? "").trim() },
      // 0.14.1: the real element has no "L" while nothing is entered (its text is then in "appreciation", empty).
      appreciation: { N: numberOf(app.N), G: Number(app.G ?? 0), L: textOf(app) },
    });
  }
  return { cells, closed };
};

/**
 * Kind of general comment to write (0.14.0): the same kinds as the read (comments.ts readKinds, every request variant,
 * member "liste"), rubrics left out. Until 0.13.0 the kind was looked for by the label "globale" or the genre 0, and
 * failed on a school that names it otherwise. With "wanted": the kind of that name (accents and case ignored). Without:
 * the only kind, else the only one named global or general, else 409 general_kind_ambiguous with the candidates.
 * No kind: 404 no_kind.
 */
export const generalKindFor = (kinds: { element: Element; name: string; rubric: boolean }[], wanted = ""): Element => {
  const usable = kinds.filter((item) => !item.rubric && item.name !== "");
  if (usable.length === 0) throw new HttpError(404, "no_kind");
  const candidates = usable.map((item) => item.name);
  if (wanted !== "") {
    const found = usable.filter((item) => normalise(item.name) === normalise(wanted));
    if (found.length !== 1) throw new HttpError(404, "general_kind_not_found", { candidates });
    return found[0].element;
  }
  if (usable.length === 1) return usable[0].element;
  const main = usable.filter((item) => /global|general/.test(normalise(item.name)));
  if (main.length === 1) return main[0].element;
  throw new HttpError(409, "general_kind_ambiguous", { candidates });
};

/** SaisieAppreciation JSON for one cell. */
export const commentRequest = (
  classe: { N: string; G: number },
  period: Element,
  service: Element | null,
  cell: Cell,
  textValue: string,
  kind: "subject" | "general",
): Record<string, unknown> => ({
  classe: kind === "subject" && cell.classe ? { N: cell.classe.N, G: cell.classe.G } : { N: classe.N, G: classe.G },
  // 0.16.1: the period element as Pronote gave it (genre included), as the client and the skills writes send it.
  periode: { N: period.N, G: period.G ?? GENRE_PERIOD },
  ...(cell.student ? { eleve: { N: cell.student.N, G: GENRE_STUDENT } } : {}),
  ...(kind === "subject" && (cell.service || service) ? { service: { N: cell.service?.N ?? service!.N } } : {}),
  appreciation: { ...(cell.appreciation.N !== null ? { N: cell.appreciation.N } : {}), G: cell.appreciation.G, L: textValue, E: STATE_MODIFIED },
  typeGenreAppreciation: kind === "general" ? KIND_GENERAL : KIND_SUBJECT,
});

/* non validé sur la démo : onglets 25 et 27 fermés au profil de démonstration */
export const writeComments = async (session: SessionHandle, write: CommentsWrite): Promise<CommentsWriteResult> => {
  const { resource, genre } = commentResource(session, write.class);
  const picked = await pickPeriod(session, write.period);
  const maxLength = maxLengthOf(session);
  for (const item of write.items) {
    if (maxLength !== null && item.text.length > maxLength) throw new HttpError(409, `comment_too_long:${maxLength}`);
    if (item.kind === "general" && !item.student) throw new HttpError(400, "general_comment_without_student");
  }
  const needsSubject = write.items.some((item) => item.kind === "subject");
  const needsGeneral = write.items.some((item) => item.kind === "general");
  const service = needsSubject ? (await findCommentService(session, picked.period, resource))?.service ?? null : null;
  if (needsSubject && !service) throw new HttpError(404, "service_not_found");
  if (needsGeneral && !resource.principal) throw new HttpError(403, "not_main_teacher");

  const classe = { N: resource.id, G: genre };
  let subject: ReturnType<typeof subjectCells> | null = null;
  let general: ReturnType<typeof generalCells> | null = null;
  let rubric: Element | null = null;
  try {
    if (needsSubject) {
      subject = subjectCells(await call(session, "commentsPage", { ressource: classe, periode: { N: picked.period.N, G: GENRE_PERIOD }, service: { N: service!.N } }));
    }
    if (needsGeneral) {
      const found = await readKinds(session, resource, picked.period);
      if (found.kinds.length === 0 && found.reason === "access_denied") throw new HttpError(403, "access_denied");
      rubric = generalKindFor(found.kinds, write.generalKind ?? "");
      general = generalCells(await call(session, "generalCommentsPage", {
        classe: { N: resource.id, G: GENRE_CLASS },
        periode: { N: picked.period.N, G: GENRE_PERIOD },
        appreciation: ref(rubric),
        estUneRubrique: false,
      }));
    }
  } catch (error) {
    if (isAccessDenied(error)) throw new HttpError(403, "access_denied");
    throw error;
  }
  if (subject?.closed || general?.closed) throw new HttpError(409, "comments_closed");

  const before: CommentCell[] = [];
  const after: CommentCell[] = [];
  const requests: Record<string, unknown>[] = [];
  const targets: { cell: Cell; item: CommentChange; key: "commentSave" | "generalCommentSave" }[] = [];
  for (const item of write.items) {
    const source = item.kind === "general" ? general! : subject!;
    const cell = item.student
      ? source.cells.find((candidate) => candidate.student && normalise(candidate.student.L) === normalise(item.student!))
      : (source as { classCell?: Cell | null }).classCell ?? undefined;
    if (!cell) throw new HttpError(404, item.student ? `student_not_found:${item.student}` : "class_comment_not_found");
    before.push({ student: cell.student?.L ?? null, kind: item.kind, text: cell.appreciation.L });
    after.push({ student: cell.student?.L ?? null, kind: item.kind, text: item.text });
    requests.push(commentRequest(classe, picked.period, service, cell, item.text, item.kind));
    targets.push({ cell, item, key: item.kind === "general" ? "generalCommentSave" : "commentSave" });
  }
  const base = { class: { id: write.class, name: resource.label }, period: { id: picked.periodId, name: String(picked.period.L ?? "") }, maxLength, before, after, requests, validated: false as const,
    generalKind: rubric ? String(rubric.L ?? "") : "" };
  if (write.dryRun) return { ...base, written: false, dryRun: true };

  const answers: string[] = [];
  for (const [index, target] of targets.entries()) {
    const sent = await sendWrite(session, target.key, requests[index]);
    answers.push(`${target.item.kind}:data=${memberNames(sent.data)};report=${memberNames(sent.report)}`);
  }
  // 0.16.1: a write Pronote ignores answers HTTP 200 without refusal; the shape of its answers (member names only) goes
  // to the access log and to the error, the only trace to diagnose it.
  const notSaved = (who: string) => {
    const shape = answers.join("|").slice(0, 400);
    const context = currentContext();
    if (context) context.shape = shape;
    return new HttpError(502, `comment_not_saved:${who}`, { detail: shape });
  };
  // Read again: every cell must now carry the requested text.
  const checked: CommentCell[] = [];
  if (needsSubject) {
    const reread = subjectCells(await call(session, "commentsPage", { ressource: classe, periode: { N: picked.period.N, G: GENRE_PERIOD }, service: { N: service!.N } }));
    for (const [index, target] of targets.entries()) {
      if (target.item.kind !== "subject") continue;
      const cell = target.cell.student
        ? reread.cells.find((candidate) => candidate.student && normalise(candidate.student.L) === normalise(target.cell.student!.L))
        : reread.classCell;
      if (!cell || cell.appreciation.L.trim() !== target.item.text.trim()) throw notSaved(target.cell.student?.L ?? "classe");
      checked[index] = { student: cell.student?.L ?? null, kind: "subject", text: cell.appreciation.L };
    }
  }
  if (needsGeneral && rubric) {
    const reread = generalCells(await call(session, "generalCommentsPage", {
      classe: { N: resource.id, G: GENRE_CLASS },
      periode: { N: picked.period.N, G: GENRE_PERIOD },
      appreciation: ref(rubric),
      estUneRubrique: false,
    }));
    for (const [index, target] of targets.entries()) {
      if (target.item.kind !== "general") continue;
      const cell = reread.cells.find((candidate) => candidate.student && normalise(candidate.student.L) === normalise(target.cell.student!.L));
      if (!cell || cell.appreciation.L.trim() !== target.item.text.trim()) throw notSaved(target.cell.student?.L ?? "");
      checked[index] = { student: cell.student?.L ?? null, kind: "general", text: cell.appreciation.L };
    }
  }
  return { ...base, after: checked.map((cell, index) => cell ?? after[index]), written: true, dryRun: false };
};
