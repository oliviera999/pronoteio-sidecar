/**
 * State of the two sessions of an account (0.16.0, docs/olutionsuivi/CONTRAT_SIDECAR.md 7.5), for GET /session/info and
 * for a grouped read (GET /collect/:id): what the client must do before a read that needs the web Espace Professeurs.
 *
 * - mobile: "open" while the main session (Pawnote login, reconnected with its token chain) is alive, else "closed":
 *   Moodle logs in again with the token.
 * - web: "open" while a web session of the account is alive; "backoff" during the back-off of the web logins (no login
 *   may be sent before retry_after, webLoginGuard.ts); "pin_required" when the last web login needed the teacher (PIN,
 *   double authentication) and none succeeded since; "reopen_required" when a web session was open and is gone: a web
 *   login without PIN may be sent; "closed" when none was ever opened since the start of the sidecar.
 * Nothing here calls Pronote, and nothing extends the lifetime of a session.
 */
import { accountSession, sessionById, webOpenedAt } from "./session.js";
import { webLoginGuard } from "./webLoginGuard.js";

export type SessionState = {
  mobile: "open" | "closed";
  web: "open" | "closed" | "reopen_required" | "backoff" | "pin_required";
  /** "", session_expired, web_session_expired, web_login_backoff, or the kind of the last web login that needed the teacher. */
  reason: string;
  /** Seconds before a web login may be sent (back-off), else 0. */
  retry_after: number;
};

/** Outcomes of a web login only the teacher can answer. */
const INTERACTIVE = new Set(["pin_required", "bad_pin", "security_setup_required", "double_auth_required"]);

export const sessionState = (ids: { main: string; web: string }, account: string | null): SessionState => {
  const main = sessionById(ids.main) ?? (account ? accountSession(account, "mobile") : undefined);
  const web = [sessionById(ids.web), main, account ? accountSession(account, "web") : undefined].find((entry) => entry?.space === "web");
  const mobile = main && main.space === "mobile" ? "open" : "closed";
  // A web session sent as the main one: there is no mobile session, and none is needed.
  const lost = mobile === "closed" && !(main && main.space === "web") ? "session_expired" : "";
  if (web) return { mobile, web: "open", reason: lost, retry_after: 0 };
  if (account) {
    const retry = webLoginGuard.retryAfter(account);
    if (retry > 0) return { mobile, web: "backoff", reason: lost || "web_login_backoff", retry_after: retry };
    const status = webLoginGuard.status(account);
    const opened = webOpenedAt(account);
    // The last failure is the news only when no web session was opened after it.
    if (status.lastKind && INTERACTIVE.has(status.lastKind) && (status.lastFailureAt ?? 0) * 1000 > (opened ?? 0)) {
      return { mobile, web: "pin_required", reason: lost || status.lastKind, retry_after: 0 };
    }
    if (opened !== null) return { mobile, web: "reopen_required", reason: lost || "web_session_expired", retry_after: 0 };
  }
  return { mobile, web: "closed", reason: lost, retry_after: 0 };
};
