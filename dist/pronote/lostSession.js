/**
 * Does a Pronote error mean the session is gone? Kept apart from session.ts (0.16.0) so that the decoders can tell a
 * lost session from a refusal without loading the configuration of the service.
 */
import { ServerSideError, SessionExpiredError } from "pawnote";
/** Pronote messages of a session closed because the account connected elsewhere (candidates, not validated). */
const REPLACED = /autre (poste|appareil|navigateur)|connect[ée]+ ailleurs|nouvelle connexion|session (a été )?(fermée|interrompue|terminée)|vous avez été déconnecté/i;
/** Why a Pronote error means the session is gone: "expired", "replaced", or null for any other error. */
export const lostSessionReason = (error) => {
    if (error instanceof SessionExpiredError)
        return "expired";
    if (error instanceof ServerSideError && REPLACED.test(error.message))
        return "replaced";
    return null;
};
//# sourceMappingURL=lostSession.js.map