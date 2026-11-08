/**
 * Wishes ("desiderata") and unavailability of the teacher for a parent-teacher meeting session:
 * SaisieRencontreDesiderata (tab 92) { session, listeRencontres: [{ …rencontre as read, duree, voeu,
 * validationvoeu }] } and SaisieRencontreIndisponibilites (tab 91) { session, indisponibilites } (static reading of
 * the client, docs/pronote-matrice/7-communication.md; not validated on a real server, the demo was outside the
 * entry period). Only the modified "rencontres" are sent, each as read in RencontresParentsProfs with the new
 * duration and wish; the unavailability is the whole set of personal slots. Outside the entry period
 * (avecSaisie false): 409 meeting_entry_closed. SaisieRencontreAEuLieu is never sent.
 */
import type { SessionHandle } from "pawnote";
import { HttpError } from "../errors.js";
import { listOf, numberSet } from "../pronote/encoding.js";
import type { MeetingWishesResult, MeetingWishesWrite } from "../normalise.js";
import { findSession, loadSessions } from "./meetings.js";
import { sendWrite } from "./write.js";

export const wishesRequest = (sessionN: string, rencontres: Record<string, unknown>[]): Record<string, unknown> => ({
  session: { N: sessionN },
  listeRencontres: rencontres,
});

export const unavailabilityRequest = (sessionN: string, slots: number[]): Record<string, unknown> => ({
  session: { N: sessionN },
  indisponibilites: numberSet([...new Set(slots)].sort((a, b) => a - b)),
});

/** Index of a wish id "w<n>" in desiderata.listeRencontres, or 400. */
const wishIndex = (id: string, count: number): number => {
  const match = id.match(/^w(\d+)$/);
  const index = match ? Number(match[1]) - 1 : -1;
  if (index < 0 || index >= count) throw new HttpError(404, `wish_not_found:${id}`);
  return index;
};

export const writeMeetingWishes = async (session: SessionHandle, sessionId: string, write: MeetingWishesWrite, dryRun: boolean): Promise<MeetingWishesResult> => {
  const rows = await loadSessions(session);
  const row = findSession(rows, sessionId);
  const details = row.details ?? {};
  const requests: Record<string, unknown>[] = [];
  const planned = structuredClone(row.session);

  if (write.wishes?.length) {
    if (!row.session.canEnterWishes) throw new HttpError(409, "meeting_entry_closed");
    const rencontres = listOf<any>(details?.desiderata?.listeRencontres);
    const modified = write.wishes.map((wish) => {
      const index = wishIndex(wish.id, rencontres.length);
      const raw = rencontres[index];
      const duration = wish.duration === undefined ? planned.wishes[index].duration : wish.duration;
      const choice = wish.wish === undefined ? planned.wishes[index].wish : wish.wish;
      planned.wishes[index] = { ...planned.wishes[index], duration, wish: choice, validated: choice !== null };
      // validationvoeu: the client flag of an entered wish (not validated on a real server).
      return { ...raw, duree: duration ?? 0, voeu: choice ?? 0, validationvoeu: choice !== null };
    });
    requests.push(wishesRequest(String(row.raw.N), modified));
  }

  if (write.unavailability !== undefined && write.unavailability !== null) {
    if (!row.session.canEnterUnavailability) throw new HttpError(409, "meeting_entry_closed");
    planned.unavailability = { ...planned.unavailability, mine: [...new Set(write.unavailability)].sort((a, b) => a - b) };
    requests.push(unavailabilityRequest(String(row.raw.N), write.unavailability));
  }

  if (requests.length === 0) throw new HttpError(400, "nothing_to_write");
  if (dryRun) return { before: row.session, after: planned, written: false, dryRun: true, requests, validated: false };

  const keys = ["meetingWishesSave", "meetingUnavailabilitySave"] as const;
  if (write.wishes?.length) await sendWrite(session, keys[0], requests[0]);
  if (write.unavailability !== undefined && write.unavailability !== null) await sendWrite(session, keys[1], requests[requests.length - 1]);

  const after = findSession(await loadSessions(session), sessionId).session;
  for (const wish of write.wishes ?? []) {
    const index = wishIndex(wish.id, after.wishes.length);
    const expected = planned.wishes[index];
    if (after.wishes[index].wish !== expected.wish || (wish.duration !== undefined && after.wishes[index].duration !== expected.duration)) {
      throw new HttpError(502, "wishes_not_saved");
    }
  }
  if (write.unavailability !== undefined && write.unavailability !== null) {
    const mine = new Set(after.unavailability.mine);
    if (!planned.unavailability.mine.every((slot) => mine.has(slot))) throw new HttpError(502, "wishes_not_saved");
  }
  return { before: row.session, after, written: true, dryRun: false, requests, validated: false };
};
