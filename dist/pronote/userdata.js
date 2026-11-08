import { createSessionHandle } from "pawnote";
import { listOf } from "./encoding.js";
import { compatFetcher } from "./compat.js";
import { decodePayload } from "./request.js";
const EMPTY = { resources: [], maxScale: null, tabs: null, rights: {}, acquisitionLevels: [], maxCommentLength: null };
/** Tab numbers of a listeOnglets tree ([{ G, Onglet: [{ G }...] }...]). */
export const tabsOf = (value) => {
    const result = [];
    const visit = (items) => {
        for (const item of listOf(items)) {
            if (typeof item?.G === "number")
                result.push(item.G);
            visit(item?.Onglet);
        }
    };
    visit(value);
    return result;
};
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
            .map((item) => ({
            id: String(item.N),
            label: String(item.L ?? ""),
            genre: item.G,
            taught: Boolean(item.enseigne),
            principal: Boolean(item.estPrincipal),
        }));
    }
    if (content.listeOnglets)
        data.tabs = tabsOf(content.listeOnglets);
    if (content.autorisations && typeof content.autorisations === "object")
        data.rights = content.autorisations;
    if (content.listeNiveauxDAcquisitions)
        data.acquisitionLevels = listOf(content.listeNiveauxDAcquisitions);
    const maxScale = parseNumber(content.General?.BaremeMaxDevoirs?.V);
    if (maxScale !== null)
        data.maxScale = maxScale;
    if (content.General?.TailleMaxAppreciation !== undefined)
        data.maxCommentLength = content.General.TailleMaxAppreciation;
};
/** Session handle whose fetcher records the login-only data (read back with userData()). */
export const createCapturingHandle = (base = compatFetcher) => {
    const data = { ...EMPTY };
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
export const userData = (session) => store.get(session) ?? { ...EMPTY };
const lower = (value) => value.toLowerCase();
/**
 * Whether a right ("autorisations" of ParametresUtilisateur) is granted, looked up case-insensitively either
 * inside its group ({ communication: { avecDiscussionAvancee: true } }) or at the root ({ avecDiscussionAvancee }).
 * null when the rights were not received or the right is not listed at all.
 */
export const hasRight = (rights, group, name) => {
    if (!rights || typeof rights !== "object")
        return null;
    const groupKey = Object.keys(rights).find((key) => lower(key) === lower(group));
    const inGroup = groupKey ? rights[groupKey] : undefined;
    if (inGroup && typeof inGroup === "object") {
        const key = Object.keys(inGroup).find((item) => lower(item) === lower(name));
        if (key)
            return inGroup[key] === true;
    }
    const flat = Object.keys(rights).find((key) => lower(key) === lower(name) || lower(key) === lower(`${group}.${name}`));
    if (flat)
        return rights[flat] === true;
    return null;
};
/** Whether the tab of a function is closed to the account: true only when the tabs were received and lack it. */
export const tabClosed = (session, onglet) => {
    const tabs = userData(session).tabs;
    return onglet !== null && Array.isArray(tabs) && !tabs.includes(onglet);
};
/** Replaces the login data of a session (tests, or a session handle created outside createCapturingHandle). */
export const rememberUserData = (session, data) => {
    store.set(session, { ...EMPTY, ...data });
};
//# sourceMappingURL=userdata.js.map