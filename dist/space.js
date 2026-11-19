import { currentContext } from "./context.js";
import { HttpError } from "./errors.js";
const spaces = new WeakMap();
/** Records the space a session handle was opened in (login, reconnection). */
export const setSpace = (handle, space) => {
    spaces.set(handle, space);
};
/** Space of a session handle, null when unknown (sessions of the tests, handles created elsewhere). */
export const spaceOf = (handle) => (handle ? spaces.get(handle) ?? null : null);
/** Functions that answer in the mobile session although their tab is not listed there. */
export const mobileWithoutTab = () => new Set((process.env.PRONOTEIO_MOBILE_WITHOUT_TAB ?? "ListePeriodes,PageTrombinoscope,listeQCM")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean));
/** Routing by tab enabled (PRONOTEIO_WEB_ROUTING=off turns it off). */
export const webRoutingEnabled = () => (process.env.PRONOTEIO_WEB_ROUTING ?? "on").toLowerCase() !== "off";
/**
 * A call needs a tab the mobile session lacks: thrown before the call is sent (no Pronote call, no write), answered
 * 409 web_session_required with the tab and the function, or turned by app.ts into a replay on the web session.
 */
export class WebSessionRequired extends HttpError {
    onglet;
    fn;
    constructor(onglet, fn) {
        super(409, "web_session_required", { onglet, function: fn });
        this.onglet = onglet;
        this.fn = fn;
    }
}
/** Headers of a request that announce a client able to open the web session (local_pronoteio 0.18.0). */
export const announcesWeb = (headers) => String(headers["x-pronoteio-web"] ?? "") === "1" || String(headers["x-pronoteio-web-session"] ?? "") !== "";
/**
 * Stops a call whose tab is missing from the mobile session (WebSessionRequired), when the routing applies: mobile
 * session with its tabs received, client able to open a web session, function not known to answer without its tab.
 * Once a write was sent in the request, the replay is impossible: 409 web_session_required_after_write (not replayed).
 */
export const assertReachable = (session, tabs, onglet, fn) => {
    if (typeof onglet !== "number" || !Array.isArray(tabs) || tabs.includes(onglet))
        return;
    if (spaceOf(session) !== "mobile" || !webRoutingEnabled())
        return;
    const context = currentContext();
    if (!context?.webCapable || context.webActive)
        return;
    if (mobileWithoutTab().has(fn))
        return;
    if (context.writeSent)
        throw new HttpError(409, "web_session_required_after_write", { onglet, function: fn });
    throw new WebSessionRequired(onglet, fn);
};
//# sourceMappingURL=space.js.map