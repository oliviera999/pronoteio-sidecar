import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { discussion, isMessagingOpen, messagingPreferences, preferencesFromAnswer, reopensAt } from "../src/teacher/messaging.js";
import { fakeSession } from "./fake-session.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const prefs = preferencesFromAnswer(fixture("messaging-preferences"));

test("preferences of PreferenceMessagerie: hours, working and non-working days, automatic reply", () => {
  assert.equal(prefs.hourBefore, 7);
  assert.equal(prefs.hourAfter, 20);
  assert.equal(prefs.onlyParentsStudents, false);
  assert.deepEqual(prefs.workingDays.map((day) => day.day), [1, 2, 3, 4, 5]);
  assert.deepEqual(prefs.nonWorkingDays, [{ day: 6, active: true, holiday: false }, { day: 7, active: true, holiday: false }, { day: 0, active: true, holiday: true }]);
  assert.match(prefs.autoReply, /heures ouvrées/);
});

test("reopensAt: null when open, next opening hour on a working day, Monday 7h after a week-end", () => {
  // Tuesday 10 November 2026 at 10:00: open.
  assert.equal(isMessagingOpen(prefs, new Date(2026, 10, 10, 10, 0)), true);
  assert.equal(reopensAt(prefs, new Date(2026, 10, 10, 10, 0)), null);
  // Tuesday 21:30: closed until Wednesday 7:00.
  assert.equal(reopensAt(prefs, new Date(2026, 10, 10, 21, 30)), Math.floor(new Date(2026, 10, 11, 7).getTime() / 1000));
  // Wednesday 5:00: closed until 7:00 the same day.
  assert.equal(reopensAt(prefs, new Date(2026, 10, 11, 5, 0)), Math.floor(new Date(2026, 10, 11, 7).getTime() / 1000));
  // Saturday 7 November 2026 (the demo capture): closed until Monday 9 at 7:00.
  assert.equal(reopensAt(prefs, new Date(2026, 10, 7, 12, 0)), Math.floor(new Date(2026, 10, 9, 7).getTime() / 1000));
  // Every day closed: unknown within 14 days.
  const closed = { ...prefs, nonWorkingDays: [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, active: true, holiday: false })) };
  assert.equal(reopensAt(closed, new Date(2026, 10, 7, 12, 0)), null);
  // Without hours, a non-working day reopens at midnight of the next open day.
  const noHours = { ...prefs, hourBefore: null, hourAfter: null };
  assert.equal(reopensAt(noHours, new Date(2026, 10, 7, 12, 0)), Math.floor(new Date(2026, 10, 9).getTime() / 1000));
});

test("GET /messages/preferences combines the disabled flag of ListeMessagerie and PreferenceMessagerie", async () => {
  const session = fakeSession({
    ListeMessagerie: () => fixture("messaging-list"),
    PreferenceMessagerie: () => fixture("messaging-preferences"),
  });
  const result = await messagingPreferences(session, new Date(2026, 10, 7, 12, 0));
  assert.equal(result.disabled, true);
  assert.equal(result.hourBefore, 7);
  assert.equal(result.reopensAt, Math.floor(new Date(2026, 10, 9, 7).getTime() / 1000));
});

test("a discussion carries its participants (SaisiePublicMessage), canReply and draft; a failing participants call gives []", async () => {
  const session = fakeSession({
    ListeMessagerie: () => fixture("messaging-list"),
    ListeMessages: (data) => {
      assert.equal(data?.marquerCommeLu, false);
      return fixture("messaging-messages");
    },
    SaisiePublicMessage: (data) => {
      assert.deepEqual(data, { message: { N: "85#x52" }, estPublicParticipant: true, estDestinatairesReponse: false });
      return { listeDest: { _T: 24, V: [{ L: "M. PARENT F. - ELEVE Un (3A)", N: "128#x60", G: 5 }, { L: "Moi", N: "109#x14", G: 3 }] } };
    },
  });
  const listing = await (await import("../src/teacher/messaging.js")).discussions(session, "inbox", 10);
  const first = listing.items[0];
  assert.equal(first.draft, false);
  assert.equal(first.canReply, true, "avecReponse of the listing");
  assert.deepEqual(first.participantsDetail, []);
  const detail = await discussion(session, first.id);
  assert.deepEqual(detail.discussion.participantsDetail, [{ label: "M. PARENT F. - ELEVE Un (3A)", kind: "parent" }, { label: "Moi", kind: "teacher" }]);
  assert.equal(detail.discussion.canReply, true);
  assert.equal(detail.messages[0].draft, false);
  assert.ok(!JSON.stringify(detail).includes("128#"), "no raw id");

  const failing = fakeSession({ ListeMessagerie: () => fixture("messaging-list"), ListeMessages: () => fixture("messaging-messages") });
  const fallback = await discussion(failing, first.id);
  assert.deepEqual(fallback.discussion.participantsDetail, []);
});
