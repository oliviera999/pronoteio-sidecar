import { HttpError } from "../errors.js";
import { answerData, callPronote, entryReport, propertyKeys } from "../pronote/request.js";
import { listOf } from "../pronote/encoding.js";
import { countRefusedWrite, exclusiveOf } from "../pronote/exclusive.js";
import { requireFunction } from "./functions.js";
/** Messages of a RapportSaisie, joined as the client shows them. */
export const reportMessages = (report) => [
    String(report?.titre_Messages_Erreur ?? "").trim(),
    ...listOf(report?._messagesErreur_).map((item) => (typeof item === "string" ? item : String(item?.L ?? ""))),
]
    .filter(Boolean)
    .join(" : ");
/** Throws on a refusal or an unconfirmed confirmation request carried by the report, else returns it (or null). */
export const assertAccepted = (report, force) => {
    if (!report)
        return null;
    // 0.16.2: a report carrying error messages is a cancelled save for the client (traiterReponseSaisie: "_messagesErreur_"
    // → EGenreReponseSaisie.annulation), even without _erreurSaisie_. Seen on SaisieAppreciation (23/11/2026): HTTP 200,
    // report { _messagesErreur_ }, nothing saved. An empty list stays an accepted save.
    const messages = listOf(report._messagesErreur_);
    if (report.refusSaisie || report._erreurSaisie_ === true || messages.length > 0) {
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
export const sendWrite = async (session, key, data, force = false) => {
    const fn = requireFunction(key);
    const answer = await callPronote(session, {
        name: fn.name,
        data,
        signature: fn.onglet !== null ? { onglet: fn.onglet } : undefined,
        keepRefusal: true,
    });
    const keys = propertyKeys(session);
    // 0.16.4: an answer that says the server is in exclusive mode is a cancelled write for the web client, even with
    // HTTP 200 and no RapportSaisie message (see pronote/exclusive.ts).
    if (exclusiveOf(answer?.[keys.signature]) === true) {
        countRefusedWrite();
        throw new HttpError(409, "exclusive_mode");
    }
    const report = assertAccepted(entryReport(answer, keys.data), force);
    return { data: answerData(session, answer), report };
};
//# sourceMappingURL=write.js.map