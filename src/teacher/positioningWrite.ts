/**
 * 0.17.0 (chantier olutionsuivi 0.3.0, lot NS): writes the positioning ("Pos.") and the LSU mark ("N. LSU") of the
 * students of a service, in the grid of tab 25. Requests EXACTLY as the web client sent them on the real server
 * (capture of 24/11/2026, docs/pronoteio/capture-saisies-2026-11-24.md):
 * - SaisiePositionnement { estPourElementCompetence: false, positionnement { N "93#…", G, L }, classe { N, G 1, L } (the
 *   student's own class, also for a group), periode { N, G 2, L }, eleve { N, G 4, L }, service { N, L } (no G) };
 *   reset: positionnement { N: 0, G: 0, L: "Aucun" }; answer RapportSaisie { service, eleve, niveauAcqu { L, N, G } },
 *   without niveauAcqu after a reset;
 * - SaisieNoteLSU { classe, periode, eleve, service, posLSUNote { _T: 10, V: "15,00" } } (0,00 to 100,00, decimal
 *   comma; V "" clears it); answer RapportSaisie { service, eleve, posLSUNote { _T: 10, V: "15" } }.
 * Never estCalculAuto, ValidationAuto* nor CalculAutoNotesSelonCompetences (the "Σ" buttons of the client).
 * Flow: grid read before; differences (unchanged, not_editable, student_not_found, period_closed: skipped); in
 * simulation nothing is sent; else one request per cell, in order, stopping at the first one whose RapportSaisie does
 * not carry the requested value (502 positioning_not_saved:<student>, with done); then the grid is read again.
 * The access log gets no value and no student name (only the shape of the request on a refusal).
 */
import type { SessionHandle } from "pawnote";
import { currentContext } from "../context.js";
import { HttpError } from "../errors.js";
import { requestShape } from "./commentsWrite.js";
import { matchStudent } from "./ids.js";
import { GENRE_CLASS, gridFromPage, gridTarget, readGridPage, serviceName, type GridRead, type GridRow, type GridTarget, type Ref } from "./reportGrid.js";
import { sendWrite } from "./write.js";

const GENRE_PERIOD = 2;
const GENRE_STUDENT = 4;
const TYPE_NUMBER = 10;

export type PositioningKind = "positioning" | "lsu";

export type PositioningItem = { student: string; kind: PositioningKind; value: number | string | null };

export type PositioningWrite = { resource: string; period: string; service: string; items: PositioningItem[]; dryRun?: boolean };

export type PositioningCell = { student: string; kind: PositioningKind; value: number | string | null };

export type PositioningSkipped = { student: string; kind: PositioningKind; reason: "unchanged" | "not_editable" | "student_not_found" | "period_closed" };

export type PositioningResult = {
  class: { id: string; name: string };
  period: { id: string; name: string };
  service: { id: string; name: string };
  before: PositioningCell[];
  after: PositioningCell[];
  skipped: PositioningSkipped[];
  requests: Record<string, unknown>[];
  written: boolean;
  dryRun: boolean;
  done: number;
  stoppedAt: { student: string; kind: PositioningKind } | null;
  validated: false;
};

/**
 * LSU mark as SaisieNoteLSU sends it: "15,00" (two decimals, decimal comma), "" to clear. A dot is accepted and
 * turned into a comma. Outside 0 to 100, or not a number: 400 lsu_out_of_range.
 */
export const lsuValue = (value: unknown): string => {
  if (value === "" ) return "";
  if (typeof value !== "string" && typeof value !== "number") throw new HttpError(400, "lsu_out_of_range");
  const text = String(value).trim().replace(",", ".");
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text)) throw new HttpError(400, "lsu_out_of_range");
  const number = Number(text);
  if (!Number.isFinite(number) || number < 0 || number > 100) throw new HttpError(400, "lsu_out_of_range");
  return number.toFixed(2).replace(".", ",");
};

/** Number of an LSU mark as Pronote gives it ("15", "15,5"), null for "". */
const lsuNumber = (value: string | null | undefined): number | null => {
  const text = String(value ?? "").trim();
  if (text === "") return null;
  const number = Number(text.replace(",", "."));
  return Number.isFinite(number) ? number : null;
};

const withLabel = (element: Ref | null | undefined): { L?: string } => (element?.L ? { L: element.L } : {});

/** Members common to both writes: the student's own class, the period, the student, the service (no G). */
const commonMembers = (row: GridRow, target: GridTarget): Record<string, unknown> => {
  const classe = row.classe
    ? { N: row.classe.N, G: row.classe.G ?? GENRE_CLASS, ...withLabel(row.classe) }
    : { N: target.resource.id, G: target.genre, L: target.resource.label };
  const service = row.service ?? { N: target.service.service.N, L: target.service.service.L ?? target.service.service.matiere?.V?.L };
  return {
    classe,
    periode: { N: target.period.N, G: target.period.G ?? GENRE_PERIOD, ...(target.period.L ? { L: target.period.L } : {}) },
    eleve: { N: row.student.N, G: row.student.G ?? GENRE_STUDENT, ...withLabel(row.student) },
    service: { N: service.N, ...(service.L ? { L: service.L } : {}) },
  };
};

/** SaisiePositionnement of one cell: the level element of the grid, or the reset { N: 0, G: 0, L: "Aucun" }. */
export const positioningRequest = (row: GridRow, target: GridTarget, level: Ref | null): Record<string, unknown> => ({
  estPourElementCompetence: false,
  positionnement: level ? { N: level.N, G: level.G, L: level.L ?? "" } : { N: 0, G: 0, L: "Aucun" },
  ...commonMembers(row, target),
});

/** SaisieNoteLSU of one cell: posLSUNote { _T: 10, V } ("15,00", or "" to clear). */
export const lsuRequest = (row: GridRow, target: GridTarget, value: string): Record<string, unknown> => ({
  ...commonMembers(row, target),
  posLSUNote: { _T: TYPE_NUMBER, V: value },
});

const unwrap = (value: unknown): any =>
  value !== null && typeof value === "object" && "V" in (value as object) && !("_T" in (value as object)) ? (value as { V: unknown }).V : value;

/** Whether the RapportSaisie of a write carries the requested value (niveauAcqu.G, or posLSUNote.V). */
export const reportConfirms = (report: Record<string, any> | null, kind: PositioningKind, value: number | string | null): boolean => {
  if (!report) return false;
  if (kind === "positioning") {
    const level = unwrap(report.niveauAcqu);
    if (value === null) return !level || Number(level.G ?? 0) === 0;
    return !!level && Number(level.G) === Number(value);
  }
  const note = report.posLSUNote;
  if (!note || typeof note !== "object") return false;
  const read = typeof note.V === "string" || typeof note.V === "number" ? String(note.V) : null;
  if (read === null) return false;
  const wanted = lsuNumber(String(value ?? ""));
  return wanted === null ? read.trim() === "" : lsuNumber(read) === wanted;
};

/** Current value of a cell as the routes show it: genre of the level (or null), LSU mark (or null). */
const cellValue = (row: GridRow, kind: PositioningKind): number | string | null =>
  kind === "positioning" ? (row.positioning?.G ?? null) : row.lsu;

/** 0.17.1: the student is named by its name or by its stable id "e:NOM Prénom" ("~2" for a homonym), see matchStudent. */
const findRow = (grid: GridRead, student: string): GridRow | undefined =>
  matchStudent(grid.rows, student, (row) => String(row.student.L ?? ""));

type Planned = { item: PositioningItem; row: GridRow; value: number | string | null; request: Record<string, unknown> };

/** POST /reports/positioning (contract N, 6.1 point 4). The write mode is checked by the route. */
export const writePositioning = async (session: SessionHandle, write: PositioningWrite): Promise<PositioningResult> => {
  // Validation before any call: LSU values, positioning genres.
  const items = write.items.map((item) => {
    if (item.kind === "lsu") return { ...item, value: lsuValue(item.value) };
    if (item.value !== null && (typeof item.value !== "number" || !Number.isInteger(item.value) || item.value <= 0)) {
      throw new HttpError(400, "validation_failed:value");
    }
    return item;
  });
  const target = await gridTarget(session, write.resource, write.period, write.service);
  const page = await readGridPage(session, target);
  if (!page) throw new HttpError(403, "access_denied");
  const grid = gridFromPage(page);
  const closed = target.periodClosed || grid.closed;

  const before: PositioningCell[] = [];
  const after: PositioningCell[] = [];
  const skipped: PositioningSkipped[] = [];
  const planned: Planned[] = [];
  for (const item of items) {
    const row = findRow(grid, item.student);
    if (!row) {
      skipped.push({ student: item.student, kind: item.kind, reason: "student_not_found" });
      continue;
    }
    const name = String(row.student.L ?? "");
    if (closed || row.closed) {
      skipped.push({ student: name, kind: item.kind, reason: "period_closed" });
      continue;
    }
    const editable = item.kind === "positioning" ? row.positioningEditable : row.lsuEditable;
    if (!editable) {
      skipped.push({ student: name, kind: item.kind, reason: "not_editable" });
      continue;
    }
    const current = cellValue(row, item.kind);
    let request: Record<string, unknown>;
    if (item.kind === "positioning") {
      const genre = item.value as number | null;
      if (genre === current) {
        skipped.push({ student: name, kind: item.kind, reason: "unchanged" });
        continue;
      }
      let level: Ref | null = null;
      if (genre !== null) {
        level = grid.levels.find((candidate) => candidate.genre === genre)?.element ?? null;
        if (!level) throw new HttpError(400, `positioning_level_unknown:${genre}`);
      }
      request = positioningRequest(row, target, level);
    } else {
      const value = item.value as string;
      if (lsuNumber(value) === lsuNumber(current === null ? null : String(current))) {
        skipped.push({ student: name, kind: item.kind, reason: "unchanged" });
        continue;
      }
      request = lsuRequest(row, target, value);
    }
    before.push({ student: name, kind: item.kind, value: current });
    after.push({ student: name, kind: item.kind, value: item.value });
    planned.push({ item, row, value: item.value, request });
  }
  const requests = planned.map((entry) => entry.request);
  const base = {
    class: { id: write.resource, name: target.resource.label },
    period: { id: target.periodId, name: String(target.period.L ?? "") },
    service: { id: target.service.id, name: serviceName(target.service.service, target.resource) },
    skipped,
    requests,
    validated: false as const,
  };
  if (write.dryRun) return { ...base, before, after, written: false, dryRun: true, done: 0, stoppedAt: null };
  // A real write: nothing is sent when the period is closed or a student is unknown (the plan said so).
  if (closed) throw new HttpError(409, "period_closed");
  const missing = skipped.find((entry) => entry.reason === "student_not_found");
  if (missing) throw new HttpError(404, `student_not_found:${missing.student}`);

  let done = 0;
  for (const entry of planned) {
    const name = String(entry.row.student.L ?? "");
    let sent: Awaited<ReturnType<typeof sendWrite>>;
    try {
      sent = await sendWrite(session, entry.item.kind === "positioning" ? "positioningSave" : "lsuSave", entry.request);
    } catch (error) {
      const context = currentContext();
      if (context) context.shape = requestShape(entry.request).slice(0, 400);
      // A refusal after some writes: how many were done goes with the error.
      if (error instanceof HttpError && done > 0) throw new HttpError(error.status, error.code, { ...error.extra, done }, error.headers);
      throw error;
    }
    if (!reportConfirms(sent.report, entry.item.kind, entry.value)) {
      const context = currentContext();
      if (context) context.shape = requestShape(entry.request).slice(0, 400);
      throw new HttpError(502, `positioning_not_saved:${name}`, { done });
    }
    done++;
  }
  // Read again: the values as Pronote now shows them.
  const reread = await readGridPage(session, target);
  const regrid = reread ? gridFromPage(reread) : null;
  const checked = planned.map((entry, index) => {
    // 0.17.1: found again by the name or id the caller gave, so that a homonym keeps its rank.
    const row = regrid ? findRow(regrid, entry.item.student) : undefined;
    return row ? { student: after[index].student, kind: entry.item.kind, value: cellValue(row, entry.item.kind) } : after[index];
  });
  return { ...base, before, after: checked, written: planned.length > 0, dryRun: false, done, stoppedAt: null };
};
