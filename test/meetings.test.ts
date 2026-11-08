import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { rememberUserData } from "../src/pronote/userdata.js";
import { appointments, appointmentsFromAnswer, meetings, sessionsFromAnswer, withDetails } from "../src/teacher/meetings.js";
import { unavailabilityRequest, wishesRequest, writeMeetingWishes } from "../src/teacher/meetingsWrite.js";
import { fakeSession } from "./fake-session.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const data = fixture("meetings");

test("meeting sessions: SessionRencontres then RencontresParentsProfs give dates, rights, wishes and unavailability", () => {
  const [row] = sessionsFromAnswer(data.sessions);
  assert.equal(row.session.id, "mt:Rencontres parents-professeurs 3e|12/12/2026");
  assert.equal(row.session.start, "17:00");
  assert.equal(row.session.end, "20:30");
  const session = withDetails(row.session, data.details, null);
  assert.equal(session.canEnterWishes, true);
  assert.equal(session.canEnterUnavailability, true);
  assert.equal(session.entryFrom, Math.floor(new Date(2026, 10, 1).getTime() / 1000));
  assert.deepEqual(session.wishOptions.map((option) => option.label), ["Sans avis", "Souhaitée", "Indispensable", "Non souhaitée"]);
  assert.deepEqual(session.wishes[0], { id: "w1", with: "M. PARENT F.", student: "ELEVE Un", class: "3A", duration: 10, wish: 1, validated: false });
  assert.equal(session.wishes[1].validated, null);
  assert.deepEqual(session.unavailability, { slotStart: 204, slotMinutes: 10, session: Array.from({ length: 21 }, (_, i) => 204 + i), mine: [204, 205] });
  assert.equal(session.planningVisible, false);
  assert.ok(!JSON.stringify(session).includes("#"), "no raw id");
  const closed = withDetails(row.session, data.closed, null);
  assert.equal(closed.canEnterWishes, false);
  assert.equal(closed.canEnterUnavailability, false);
});

test("GET /meetings: RencontrePlanning is only called when tab 94 is open; tab 90 closed answers without a call", async () => {
  const open = fakeSession({
    SessionRencontres: () => data.sessions,
    RencontresParentsProfs: (sent) => {
      assert.deepEqual(sent, { sessionRencontre: { N: "150#s1" } });
      return data.details;
    },
    RencontrePlanning: () => ({ listeRencontres: { _T: 24, V: [{ date: { _T: 7, V: "12/12/2026 17:00:00" }, responsable: { _T: 24, V: { L: "M. PARENT F." } }, eleve: { _T: 24, V: { L: "ELEVE Un" } }, salle: "B12", visio: false }] } }),
  });
  rememberUserData(open, { tabs: [90, 94] });
  const result = await meetings(open);
  assert.equal(result.available, true);
  assert.equal(result.sessions[0].planningVisible, true);
  assert.equal(result.sessions[0].planning[0].with, "M. PARENT F.");
  assert.equal(result.sessions[0].planning[0].room, "B12");

  const noPlanning = fakeSession({ SessionRencontres: () => data.sessions, RencontresParentsProfs: () => data.details });
  rememberUserData(noPlanning, { tabs: [90] });
  const partial = await meetings(noPlanning);
  assert.equal(partial.sessions[0].planningVisible, false);
  assert.ok(!noPlanning.calls.some((call) => call.name === "RencontrePlanning"));

  const closed = fakeSession({});
  rememberUserData(closed, { tabs: [131] });
  assert.deepEqual(await meetings(closed), { available: false, reason: "tab_closed", sessions: [] });
  assert.deepEqual(await meetings(fakeSession({})), { available: false, reason: "access_denied", sessions: [] });
});

test("appointments of RDV (rdvcr_RDV, avecRdvPasses): subject, dates, participants, place, status", async () => {
  const items = appointmentsFromAnswer(data.appointments);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "rdv:20/11/2026 17:30:00|Point scolarité");
  assert.equal(items[0].subject, "Point scolarité");
  assert.deepEqual(items[0].participants, ["M. PARENT F."]);
  assert.equal(items[0].place, "Salle 12");
  assert.equal(items[0].status, "confirme");
  assert.ok(items[0].end! > items[0].date);
  const session = fakeSession({ RDV: (sent) => {
    assert.deepEqual(sent, { type: "rdvcr_RDV", avecRdvPasses: true });
    return data.appointments;
  } });
  assert.equal((await appointments(session)).items.length, 1);
  assert.equal((await appointments(fakeSession({ RDV: () => ({}) }))).reason, "access_denied");
});

test("meeting wishes: SaisieRencontreDesiderata and SaisieRencontreIndisponibilites shapes, closed period refused", async () => {
  assert.deepEqual(unavailabilityRequest("150#s1", [206, 204, 206]), { session: { N: "150#s1" }, indisponibilites: { _T: 26, V: "[204,206]" } });
  assert.deepEqual(wishesRequest("150#s1", [{ N: "151#r1", duree: 10, voeu: 2, validationvoeu: true }]).listeRencontres, [{ N: "151#r1", duree: 10, voeu: 2, validationvoeu: true }]);
  const session = fakeSession({ SessionRencontres: () => data.sessions, RencontresParentsProfs: () => data.details });
  rememberUserData(session, { tabs: [90] });
  const id = "mt:Rencontres parents-professeurs 3e|12/12/2026";
  const result = await writeMeetingWishes(session, id, { wishes: [{ id: "w2", wish: 2, duration: 20 }], unavailability: [204, 210] }, true);
  assert.equal(result.written, false);
  assert.equal(result.validated, false);
  assert.equal(result.requests.length, 2);
  const wishes = result.requests[0].listeRencontres as any[];
  assert.equal(wishes.length, 1, "only the modified rencontre is sent");
  assert.equal(wishes[0].N, "151#r2");
  assert.equal(wishes[0].voeu, 2);
  assert.equal(wishes[0].duree, 20);
  assert.equal(wishes[0].validationvoeu, true);
  assert.deepEqual(result.requests[1], { session: { N: "150#s1" }, indisponibilites: { _T: 26, V: "[204,210]" } });
  assert.deepEqual(result.after.wishes[1], { ...result.before.wishes[1], wish: 2, duration: 20, validated: true });
  assert.deepEqual(result.after.unavailability.mine, [204, 210]);
  await assert.rejects(writeMeetingWishes(session, id, { wishes: [{ id: "w9", wish: 1 }] }, true), /wish_not_found/);
  await assert.rejects(writeMeetingWishes(session, "mt:absente|x", { unavailability: [] }, true), /session_not_found/);
  const closed = fakeSession({ SessionRencontres: () => data.sessions, RencontresParentsProfs: () => data.closed });
  rememberUserData(closed, { tabs: [90] });
  await assert.rejects(writeMeetingWishes(closed, id, { unavailability: [204] }, true), /meeting_entry_closed/);
  assert.ok(session.calls.every((call) => !call.name.startsWith("Saisie")), "dryRun writes nothing");
});
