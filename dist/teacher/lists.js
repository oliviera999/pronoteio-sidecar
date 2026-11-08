import { HttpError } from "../errors.js";
import { listOf } from "../pronote/encoding.js";
import { normalise } from "../normalise.js";
import { isAccessDenied } from "./competencies.js";
import { assertTabOpen, callFunction, isTabClosed } from "./functions.js";
import { stableIds } from "./ids.js";
import { participantsOf } from "./messaging.js";
import { loadAllPublics, resolveRecipients } from "./recipients.js";
import { sendWrite } from "./write.js";
const STATE_CREATED = 1;
const STATE_MODIFIED = 2;
const STATE_DELETED = 3;
export const listsFromAnswer = (data) => {
    const items = listOf(data?.liste).filter((item) => typeof item?.N === "string");
    const ids = stableIds("list", items, (item) => String(item?.L ?? ""));
    return items.map((raw, index) => {
        const members = participantsOf(raw?.listePublicIndividu);
        return {
            list: {
                id: ids[index],
                label: String(raw?.L ?? "").trim(),
                public: raw?.estPublique === true,
                mine: raw?.estAuteur === true,
                author: String(raw?.libelleAuteur ?? "").trim(),
                members,
                count: members.length,
            },
            raw,
            members: listOf(raw?.listePublicIndividu).filter((item) => typeof item?.N === "string").map((item) => ({ N: String(item.N), G: Number(item.G ?? 0) })),
        };
    });
};
export const loadLists = async (session) => listsFromAnswer(await callFunction(session, "distributionLists", {}));
export const distributionLists = async (session) => {
    if (isTabClosed(session, "distributionLists"))
        return { available: false, reason: "tab_closed", items: [] };
    let rows;
    try {
        rows = await loadLists(session);
    }
    catch (error) {
        if (isAccessDenied(error))
            return { available: false, reason: "access_denied", items: [] };
        throw error;
    }
    return { available: true, reason: "", items: rows.map((row) => row.list) };
};
/** Distribution list whose label matches (for the "list" recipient kind of a message), or 404 list_not_found. */
export const findList = (rows, idOrLabel) => {
    const row = rows.find((item) => item.list.id === idOrLabel) ?? rows.find((item) => normalise(item.list.label) === normalise(idOrLabel));
    if (!row)
        throw new HttpError(404, "list_not_found");
    return row;
};
/** SaisieListeDiffusion JSON of one list. */
export const listRequest = (state, N, label, isPublic, members) => ({
    liste: [{ N, L: label, E: state, estPublique: isPublic, listePublicIndividu: members.map((item) => ({ N: item.N, G: item.G })) }],
});
export const writeDistributionList = async (session, write, dryRun) => {
    assertTabOpen(session, "distributionListSave");
    const rows = await loadLists(session);
    let before = null;
    if (write.action !== "create") {
        if (!write.id)
            throw new HttpError(400, "invalid_request:list_id_required");
        before = findList(rows, write.id);
        if (!before.list.mine)
            throw new HttpError(409, "list_not_mine");
    }
    const label = String(write.label ?? before?.list.label ?? "").trim();
    if (!label)
        throw new HttpError(400, "invalid_request:label_required");
    const isPublic = write.public ?? before?.list.public ?? false;
    let members = before?.members ?? [];
    if (write.action !== "delete" && write.members !== undefined) {
        const kinds = write.members.map((member) => member.kind);
        const publics = await loadAllPublics(session, kinds);
        members = resolveRecipients(publics, write.members).map((item) => ({ N: item.N, G: item.G }));
    }
    const state = write.action === "create" ? STATE_CREATED : write.action === "update" ? STATE_MODIFIED : STATE_DELETED;
    const request = listRequest(state, before ? String(before.raw.N) : 0, label, isPublic, members);
    const planned = write.action === "delete"
        ? null
        : {
            id: before?.list.id ?? `dl:${label}`,
            label,
            public: isPublic,
            mine: true,
            author: before?.list.author ?? "",
            members: write.members === undefined ? before?.list.members ?? [] : write.members.map((member) => ({ label: member.label, kind: member.kind })),
            count: members.length,
        };
    if (dryRun)
        return { before: before?.list ?? null, after: planned, written: false, dryRun: true, request, validated: false };
    await sendWrite(session, "distributionListSave", request);
    const reread = await loadLists(session);
    const found = reread.find((row) => normalise(row.list.label) === normalise(label)) ?? null;
    if (write.action === "delete" ? found !== null && found.list.mine : found === null)
        throw new HttpError(502, "list_not_saved");
    return { before: before?.list ?? null, after: found?.list ?? null, written: true, dryRun: false, request, validated: false };
};
//# sourceMappingURL=lists.js.map