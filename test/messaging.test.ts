import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { SessionHandle } from "pawnote";
import { discussionsFromAnswer, messagesFromAnswer, newsFromAnswer } from "../src/teacher/messaging.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const session = {
  information: { url: "https://demo.example/pronote", id: "sess1", aesKey: "0123456789abcdef", aesIV: "fedcba9876543210" },
} as unknown as SessionHandle;

test("discussions of ListeMessagerie: roots only, participants from the sub-rows, disabled flag", () => {
  const { rows, disabled } = discussionsFromAnswer(fixture("messaging-list"));
  assert.equal(disabled, true, "the demo was read on a non-working day");
  assert.ok(rows.length >= 1);
  const [first] = rows;
  assert.equal(first.discussion.subject, "Motivation");
  assert.equal(first.discussion.count, 2);
  assert.equal(first.discussion.unread, true);
  assert.equal(first.discussion.folder, "inbox");
  assert.deepEqual(first.discussion.participants, ["M. PARENT F. - ELEVE Un (3A)"]);
  assert.equal(first.possessions.length, 2);
  assert.ok(first.discussion.lastDate > 0);
  assert.ok(first.discussion.id.startsWith("m:"));
  assert.ok(!JSON.stringify(rows.map((row) => row.discussion)).includes("108#"), "no raw Pronote id");
});

test("messages of ListeMessages: author, date, text, no attachment", () => {
  const messages = messagesFromAnswer(session, fixture("messaging-messages"), "m:x");
  assert.equal(messages.length, 2);
  assert.equal(messages[0].id, "m:x|1");
  assert.equal(messages[0].author, "M. PARENT F. - ELEVE Un (3A)");
  assert.match(messages[0].text, /Bonjour/);
  assert.ok(messages[0].date > 0);
  assert.deepEqual(messages[0].attachments, []);
});

test("news of PageActualites: only the received mode (0) is read", () => {
  const data = fixture("news-page");
  assert.deepEqual(newsFromAnswer(session, data), [], "the demo teacher received nothing");
  const modes = Array.isArray(data.listeModesAff) ? data.listeModesAff : data.listeModesAff.V;
  const sent = modes.find((mode: any) => mode.G === 1);
  const received = modes.find((mode: any) => mode.G === 0);
  received.listeActualites = sent.listeActualites;
  const items = newsFromAnswer(session, data);
  assert.equal(items.length, 2);
  assert.equal(items[0].category, "Sorties");
  assert.equal(items[0].survey, false);
  assert.equal(items[0].read, false);
  assert.ok(items[0].id.startsWith("n:"));
});
