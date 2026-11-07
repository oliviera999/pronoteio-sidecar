/**
 * Shared steps of every write to Pronote: the call that keeps the RapportSaisie for the caller, and the reading of
 * that report (business refusal → 409 pronote_refused, confirmation asked → 409 confirmation_required unless forced).
 * Every write module reads the current state before, builds the request as the web client does, writes only when
 * not dryRun and the write mode allows it (checked by the routes), then reads again to prove the write: Pronote
 * answers HTTP 200 and an empty "data" to a write it ignores.
 */
import type { SessionHandle } from "pawnote";
import { HttpError } from "../errors.js";
import { answerData, callPronote, entryReport, propertyKeys } from "../pronote/request.js";
import { listOf } from "../pronote/encoding.js";
import { requireFunction, type FunctionKey } from "./functions.js";

/** Messages of a RapportSaisie, joined as the client shows them. */
export const reportMessages = (report: Record<string, any>): string =>
  [
    String(report?.titre_Messages_Erreur ?? "").trim(),
    ...listOf<unknown>(report?._messagesErreur_).map((item) => (typeof item === "string" ? item : String((item as any)?.L ?? ""))),
  ]
    .filter(Boolean)
    .join(" : ");

/** Throws on a refusal or an unconfirmed confirmation request carried by the report, else returns it (or null). */
export const assertAccepted = (report: Record<string, any> | null, force: boolean): Record<string, any> | null => {
  if (!report) return null;
  if (report.refusSaisie || report._erreurSaisie_ === true) {
    throw new HttpError(409, `pronote_refused:${reportMessages(report) || "Saisie refusée par Pronote"}`);
  }
  if (report.demandeConfirmationSaisie && !force) {
    const confirmation = report.demandeConfirmationSaisie;
    throw new HttpError(409, `confirmation_required:${[confirmation?.titre, confirmation?.message].filter(Boolean).join(" : ")}`);
  }
  if (report.messageRefusDest) {
    throw new HttpError(409, `pronote_refused:${String(report.messageRefusDest)}`);
  }
  return report;
};

/** Sends a Saisie* function and returns its "data" and its RapportSaisie once accepted. */
export const sendWrite = async (
  session: SessionHandle,
  key: FunctionKey,
  data: Record<string, unknown>,
  force = false,
): Promise<{ data: Record<string, any>; report: Record<string, any> | null }> => {
  const fn = requireFunction(key);
  const answer = await callPronote(session, {
    name: fn.name,
    data,
    signature: fn.onglet !== null ? { onglet: fn.onglet } : undefined,
    keepRefusal: true,
  });
  const report = assertAccepted(entryReport(answer, propertyKeys(session).data), force);
  return { data: answerData(session, answer), report };
};
