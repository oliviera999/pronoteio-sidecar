/**
 * Parent-teacher meetings ("rencontres parents-professeurs") and appointments ("RDV"), read only.
 *
 * SessionRencontres (tab 90, no data, capture 0009): listeSessions[{ L, N, date, strHeureDebut, strHeureFin,
 * visibleDesiderataIndispo, visiblePlanning }]. RencontresParentsProfs (tab 90, { sessionRencontre: { N } },
 * capture 0047): dateDebutSaisie, dateFinSaisie, indisponibilites { avecSaisie, placeDebutSession, dureeSession,
 * placesIndisponibilitesSession { _T: 26 }, placesIndisponibilitesPersonnelles }, desiderata { avecSaisie,
 * listeRencontres[], autorisations { saisieDesiderata, saisieDuree, listeVoeux[{ G, legende }] } },
 * planning { listeRencontres[] }, autorisations { saisieDesiderata, saisieDisponibilite }. The members of one
 * "rencontre" (parent, student, class, duration, wish) were not captured: they are read defensively (not validated
 * on a real server). RencontrePlanning (tab 94) is only called when the tab is open to the account (it was refused
 * on the demo); otherwise planningVisible is false.
 *
 * RDV (tab 284, { type: "rdvcr_RDV", avecRdvPasses: true }, captures 0087-0088): listeRDV[] (empty on the demo,
 * members read defensively, not validated), lieux[]. SaisieRdv is never sent.
 */
import type { SessionHandle } from "pawnote";
import { HttpError } from "../errors.js";
import { listOf, parseNumberSet, parsePronoteDate } from "../pronote/encoding.js";
import { seconds, type Appointment, type MeetingSession, type MeetingWish } from "../normalise.js";
import { isAccessDenied } from "./competencies.js";
import { userData } from "../pronote/userdata.js";
import { callFunction, functions, isTabClosed } from "./functions.js";
import { stableIds } from "./ids.js";

const unwrap = (value: unknown): any => (value !== null && typeof value === "object" && "V" in (value as object) ? (value as { V: unknown }).V : value);

const label = (value: unknown): string => {
  const raw = unwrap(value);
  if (typeof raw === "string") return raw.trim();
  return String((raw as any)?.L ?? "").trim();
};

const integer = (value: unknown): number | null => {
  const raw = unwrap(value);
  if (raw === null || raw === undefined || raw === "") return null;
  const number = Number.parseInt(String(raw), 10);
  return Number.isFinite(number) ? number : null;
};

const dateOf = (value: unknown): number | null => {
  const date = parsePronoteDate(unwrap(value));
  return date ? seconds(date) : null;
};

const time = (value: unknown): string => {
  const match = String(unwrap(value) ?? "").match(/(\d{1,2})\s*[h:]\s*(\d{2})?/);
  return match ? `${match[1].padStart(2, "0")}:${match[2] ?? "00"}` : "";
};

export type SessionRow = { session: MeetingSession; raw: Record<string, any>; details: Record<string, any> | null };

/** Session list of a SessionRencontres answer, before the details. */
export const sessionsFromAnswer = (data: Record<string, any>): { raw: Record<string, any>; session: MeetingSession }[] => {
  const items = listOf<any>(data?.listeSessions).filter((item) => typeof item?.N === "string");
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
export const wishOf = (raw: any, index: number): MeetingWish => ({
  id: `w${index + 1}`,
  with: label(raw?.responsable ?? raw?.resp ?? raw?.L),
  student: label(raw?.eleve),
  class: label(raw?.classe),
  duration: integer(raw?.duree),
  wish: integer(raw?.voeu),
  validated: typeof raw?.validationvoeu === "boolean" ? raw.validationvoeu : null,
});

/** Session completed with a RencontresParentsProfs answer (and an optional RencontrePlanning answer). */
export const withDetails = (session: MeetingSession, details: Record<string, any>, planning: Record<string, any> | null): MeetingSession => {
  const unavailability = details?.indisponibilites ?? {};
  const wishes = details?.desiderata ?? {};
  const rights = details?.autorisations ?? {};
  const planningRows = listOf<any>(planning?.listeRencontres ?? planning?.planning?.listeRencontres ?? details?.planning?.listeRencontres);
  return {
    ...session,
    entryFrom: dateOf(details?.dateDebutSaisie),
    entryTo: dateOf(details?.dateFinSaisie),
    canEnterWishes: wishes?.avecSaisie === true && (wishes?.autorisations?.saisieDesiderata ?? rights?.saisieDesiderata) !== false,
    canEnterUnavailability: unavailability?.avecSaisie === true && rights?.saisieDisponibilite !== false,
    wishOptions: listOf<any>(wishes?.autorisations?.listeVoeux).map((item) => ({ code: Number(item?.G ?? 0), label: String(item?.legende ?? item?.L ?? "").trim() })),
    wishes: listOf<any>(wishes?.listeRencontres).map(wishOf),
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
export const loadSessions = async (session: SessionHandle): Promise<SessionRow[]> => {
  const rows = sessionsFromAnswer(await callFunction(session, "meetingSessions"));
  // RencontrePlanning has its own tab (94): only called when the tabs received at login include it.
  const tabs = userData(session).tabs;
  const planningOpen = Array.isArray(tabs) && functions.meetingPlanning.onglet !== null && tabs.includes(functions.meetingPlanning.onglet);
  const result: SessionRow[] = [];
  for (const row of rows) {
    const details = await callFunction(session, "meetingDetails", { sessionRencontre: { N: row.raw.N } });
    let planning: Record<string, any> | null = null;
    if (planningOpen) {
      try {
        planning = await callFunction(session, "meetingPlanning", { sessionRencontre: { N: row.raw.N } });
      } catch (error) {
        if (!isAccessDenied(error)) throw error;
      }
    }
    result.push({ raw: row.raw, details, session: withDetails(row.session, details, planning) });
  }
  return result;
};

export const meetings = async (session: SessionHandle): Promise<{ available: boolean; reason: string; sessions: MeetingSession[] }> => {
  if (isTabClosed(session, "meetingSessions")) return { available: false, reason: "tab_closed", sessions: [] };
  try {
    return { available: true, reason: "", sessions: (await loadSessions(session)).map((row) => row.session) };
  } catch (error) {
    if (isAccessDenied(error)) return { available: false, reason: "access_denied", sessions: [] };
    throw error;
  }
};

/** Session row of a stable id, or 404 session_not_found. */
export const findSession = (rows: SessionRow[], id: string): SessionRow => {
  const row = rows.find((item) => item.session.id === id);
  if (!row) throw new HttpError(404, "session_not_found");
  return row;
};

/* ---- Appointments ---- */

export const appointmentsFromAnswer = (data: Record<string, any>): Appointment[] => {
  const items = listOf<any>(data?.listeRDV);
  const ids = stableIds("appointment", items, (item) => `${String(unwrap(item?.date ?? item?.debut) ?? "")}|${label(item?.sujet ?? item?.L)}`);
  return items.map((raw, index) => ({
    id: ids[index],
    date: dateOf(raw?.date ?? raw?.debut) ?? 0,
    end: dateOf(raw?.fin),
    subject: label(raw?.sujet ?? raw?.L),
    description: String(unwrap(raw?.description) ?? "").trim(),
    participants: listOf<any>(raw?.listeParticipantRDV ?? raw?.listeParticipants).map(label).filter(Boolean),
    place: label(raw?.lieu ?? raw?.salle),
    status: String(unwrap(raw?.etat) ?? "").trim(),
    mode: String(unwrap(raw?.modalite) ?? "").trim(),
  }));
};

export const appointments = async (session: SessionHandle): Promise<{ available: boolean; reason: string; items: Appointment[] }> => {
  if (isTabClosed(session, "appointments")) return { available: false, reason: "tab_closed", items: [] };
  let data: Record<string, any>;
  try {
    data = await callFunction(session, "appointments", { type: "rdvcr_RDV", avecRdvPasses: true });
  } catch (error) {
    if (isAccessDenied(error)) return { available: false, reason: "access_denied", items: [] };
    throw error;
  }
  if (!data || Object.keys(data).length === 0) return { available: false, reason: "access_denied", items: [] };
  return { available: true, reason: "", items: appointmentsFromAnswer(data) };
};
