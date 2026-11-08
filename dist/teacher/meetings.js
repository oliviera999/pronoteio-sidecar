import { HttpError } from "../errors.js";
import { listOf, parseNumberSet, parsePronoteDate } from "../pronote/encoding.js";
import { seconds } from "../normalise.js";
import { isAccessDenied } from "./competencies.js";
import { userData } from "../pronote/userdata.js";
import { callFunction, functions, isTabClosed } from "./functions.js";
import { stableIds } from "./ids.js";
const unwrap = (value) => (value !== null && typeof value === "object" && "V" in value ? value.V : value);
const label = (value) => {
    const raw = unwrap(value);
    if (typeof raw === "string")
        return raw.trim();
    return String(raw?.L ?? "").trim();
};
const integer = (value) => {
    const raw = unwrap(value);
    if (raw === null || raw === undefined || raw === "")
        return null;
    const number = Number.parseInt(String(raw), 10);
    return Number.isFinite(number) ? number : null;
};
const dateOf = (value) => {
    const date = parsePronoteDate(unwrap(value));
    return date ? seconds(date) : null;
};
const time = (value) => {
    const match = String(unwrap(value) ?? "").match(/(\d{1,2})\s*[h:]\s*(\d{2})?/);
    return match ? `${match[1].padStart(2, "0")}:${match[2] ?? "00"}` : "";
};
/** Session list of a SessionRencontres answer, before the details. */
export const sessionsFromAnswer = (data) => {
    const items = listOf(data?.listeSessions).filter((item) => typeof item?.N === "string");
    const ids = stableIds("meeting", items, (item) => `${String(item?.L ?? "")}|${String(item?.date?.V ?? "")}`);
    return items.map((raw, index) => ({
        raw,
        session: {
            id: ids[index],
            label: String(raw?.L ?? "").trim(),
            date: dateOf(raw?.date) ?? 0,
            start: time(raw?.strHeureDebut),
            end: time(raw?.strHeureFin),
            entryFrom: null,
            entryTo: null,
            canEnterWishes: false,
            canEnterUnavailability: false,
            wishOptions: [],
            wishes: [],
            unavailability: { slotStart: null, slotMinutes: null, session: [], mine: [] },
            planningVisible: raw?.visiblePlanning === true,
            planning: [],
        },
    }));
};
/** One wish ("rencontre" of desiderata.listeRencontres), members read defensively. */
export const wishOf = (raw, index) => ({
    id: `w${index + 1}`,
    with: label(raw?.responsable ?? raw?.resp ?? raw?.L),
    student: label(raw?.eleve),
    class: label(raw?.classe),
    duration: integer(raw?.duree),
    wish: integer(raw?.voeu),
    validated: typeof raw?.validationvoeu === "boolean" ? raw.validationvoeu : null,
});
/** Session completed with a RencontresParentsProfs answer (and an optional RencontrePlanning answer). */
export const withDetails = (session, details, planning) => {
    const unavailability = details?.indisponibilites ?? {};
    const wishes = details?.desiderata ?? {};
    const rights = details?.autorisations ?? {};
    const planningRows = listOf(planning?.listeRencontres ?? planning?.planning?.listeRencontres ?? details?.planning?.listeRencontres);
    return {
        ...session,
        entryFrom: dateOf(details?.dateDebutSaisie),
        entryTo: dateOf(details?.dateFinSaisie),
        canEnterWishes: wishes?.avecSaisie === true && (wishes?.autorisations?.saisieDesiderata ?? rights?.saisieDesiderata) !== false,
        canEnterUnavailability: unavailability?.avecSaisie === true && rights?.saisieDisponibilite !== false,
        wishOptions: listOf(wishes?.autorisations?.listeVoeux).map((item) => ({ code: Number(item?.G ?? 0), label: String(item?.legende ?? item?.L ?? "").trim() })),
        wishes: listOf(wishes?.listeRencontres).map(wishOf),
        unavailability: {
            slotStart: integer(unavailability?.placeDebutSession),
            slotMinutes: integer(unavailability?.dureeSession),
            session: parseNumberSet(unavailability?.placesIndisponibilitesSession),
            mine: parseNumberSet(unavailability?.placesIndisponibilitesPersonnelles),
        },
        planningVisible: planning !== null,
        planning: planningRows.map((row) => ({
            start: dateOf(row?.date ?? row?.debut) ?? 0,
            end: dateOf(row?.fin),
            with: label(row?.responsable ?? row?.L),
            student: label(row?.eleve),
            room: label(row?.salle),
            happened: typeof row?.aEuLieu === "boolean" ? row.aEuLieu : null,
            visio: row?.visio === true,
        })),
    };
};
/** Sessions with their details, kept raw for the writes. */
export const loadSessions = async (session) => {
    const rows = sessionsFromAnswer(await callFunction(session, "meetingSessions"));
    // RencontrePlanning has its own tab (94): only called when the tabs received at login include it.
    const tabs = userData(session).tabs;
    const planningOpen = Array.isArray(tabs) && functions.meetingPlanning.onglet !== null && tabs.includes(functions.meetingPlanning.onglet);
    const result = [];
    for (const row of rows) {
        const details = await callFunction(session, "meetingDetails", { sessionRencontre: { N: row.raw.N } });
        let planning = null;
        if (planningOpen) {
            try {
                planning = await callFunction(session, "meetingPlanning", { sessionRencontre: { N: row.raw.N } });
            }
            catch (error) {
                if (!isAccessDenied(error))
                    throw error;
            }
        }
        result.push({ raw: row.raw, details, session: withDetails(row.session, details, planning) });
    }
    return result;
};
export const meetings = async (session) => {
    if (isTabClosed(session, "meetingSessions"))
        return { available: false, reason: "tab_closed", sessions: [] };
    try {
        return { available: true, reason: "", sessions: (await loadSessions(session)).map((row) => row.session) };
    }
    catch (error) {
        if (isAccessDenied(error))
            return { available: false, reason: "access_denied", sessions: [] };
        throw error;
    }
};
/** Session row of a stable id, or 404 session_not_found. */
export const findSession = (rows, id) => {
    const row = rows.find((item) => item.session.id === id);
    if (!row)
        throw new HttpError(404, "session_not_found");
    return row;
};
/* ---- Appointments ---- */
export const appointmentsFromAnswer = (data) => {
    const items = listOf(data?.listeRDV);
    const ids = stableIds("appointment", items, (item) => `${String(unwrap(item?.date ?? item?.debut) ?? "")}|${label(item?.sujet ?? item?.L)}`);
    return items.map((raw, index) => ({
        id: ids[index],
        date: dateOf(raw?.date ?? raw?.debut) ?? 0,
        end: dateOf(raw?.fin),
        subject: label(raw?.sujet ?? raw?.L),
        description: String(unwrap(raw?.description) ?? "").trim(),
        participants: listOf(raw?.listeParticipantRDV ?? raw?.listeParticipants).map(label).filter(Boolean),
        place: label(raw?.lieu ?? raw?.salle),
        status: String(unwrap(raw?.etat) ?? "").trim(),
        mode: String(unwrap(raw?.modalite) ?? "").trim(),
    }));
};
export const appointments = async (session) => {
    if (isTabClosed(session, "appointments"))
        return { available: false, reason: "tab_closed", items: [] };
    let data;
    try {
        data = await callFunction(session, "appointments", { type: "rdvcr_RDV", avecRdvPasses: true });
    }
    catch (error) {
        if (isAccessDenied(error))
            return { available: false, reason: "access_denied", items: [] };
        throw error;
    }
    if (!data || Object.keys(data).length === 0)
        return { available: false, reason: "access_denied", items: [] };
    return { available: true, reason: "", items: appointmentsFromAnswer(data) };
};
//# sourceMappingURL=meetings.js.map