import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { rememberUserData } from "../src/pronote/userdata.js";
import { notifications, notificationsFromAnswer } from "../src/teacher/notifications.js";
import { fakeSession } from "./fake-session.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

test("notifications of CentraleNotifications: groups flattened, HTML titles and messages as plain text", () => {
  const items = notificationsFromAnswer(fixture("notifications"));
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    id: "notif-1",
    group: "Messagerie",
    kind: "message",
    action: "ouvrir",
    date: Math.floor(new Date(2026, 10, 7, 8, 12).getTime() / 1000),
    title: "2 nouveaux messages",
    text: "M. PARENT F. & ELEVE Un (3A) Motivation",
    count: 2,
  });
  assert.equal(items[1].group, "Informations");
  assert.equal(items[1].count, null);
  assert.equal(items[1].text, "Autorisation de sortie");
  assert.ok(items[1].id.startsWith("Informations|1|"), "id built when Pronote sends none");
});

test("GET /notifications calls CentraleNotifications without data, with tab 7; a closed tab answers without a call", async () => {
  const session = fakeSession({ CentraleNotifications: (data) => {
    assert.equal(data, undefined);
    return fixture("notifications");
  } });
  const result = await notifications(session);
  assert.equal(result.available, true);
  assert.equal(result.items.length, 2);
  const closed = fakeSession({});
  rememberUserData(closed, { tabs: [131] });
  assert.deepEqual(await notifications(closed), { available: false, reason: "tab_closed", items: [] });
  assert.equal(closed.calls.length, 0);
  const empty = fakeSession({ CentraleNotifications: () => ({}) });
  assert.equal((await notifications(empty)).reason, "access_denied");
});
