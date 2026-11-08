import { HttpError } from "../errors.js";
import { answerData, callPronote, entryReport, propertyKeys } from "../pronote/request.js";
import { listOf } from "../pronote/encoding.js";
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
export const sendWrite = async (session, key, data, force = false) => {
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
//# sourceMappingURL=write.js.map