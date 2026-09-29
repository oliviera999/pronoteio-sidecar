import { createSessionHandle } from "pawnote";
import { listOf } from "./encoding.js";
import { compatFetcher } from "./compat.js";
import { decodePayload } from "./request.js";
const store = new WeakMap();
const parseNumber = (value) => {
    const number = Number.parseFloat(String(value ?? "").replace(",", "."));
    return Number.isFinite(number) ? number : null;
};
const absorb = (data, answer) => {
    const content = answer?.data ?? answer?.donnees ?? {};
    if (content.listeClasses) {
        data.resources = listOf(content.listeClasses)
            .filter((item) => item.G === 1 || item.G === 2)
            .map((item) => ({ id: String(item.N), label: String(item.L ?? ""), genre: item.G, taught: Boolean(item.enseigne) }));
    }
    const maxScale = parseNumber(content.General?.BaremeMaxDevoirs?.V);
    if (maxScale !== null)
        data.maxScale = maxScale;
};
/** Session handle whose fetcher records the login-only data (read back with userData()). */
export const createCapturingHandle = (base = compatFetcher) => {
    const data = { resources: [], maxScale: null };
    let handle = null;
    const fetcher = async (request) => {
        const response = await base(request);
        const body = String(request.content ?? "");
        if (handle && (body.includes('"ParametresUtilisateur"') || body.includes('"FonctionParametres"'))) {
            try {
                const envelope = JSON.parse(response.content);
                absorb(data, decodePayload(handle, envelope.dataSec ?? envelope.donneesSec));
            }
            catch {
                // Unexpected format: the routes that need these data report it themselves.
            }
        }
        return response;
    };
    handle = createSessionHandle(fetcher);
    store.set(handle, data);
    return handle;
};
export const userData = (session) => store.get(session) ?? { resources: [], maxScale: null };
//# sourceMappingURL=userdata.js.map