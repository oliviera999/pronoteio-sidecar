import assert from "node:assert/strict";
import { test } from "node:test";
import { exclusiveOf, exclusiveStats, noteExclusive, resetExclusive } from "../src/pronote/exclusive.js";
import { callPronote } from "../src/pronote/request.js";
import { rememberUserData } from "../src/pronote/userdata.js";
import { sendWrite } from "../src/teacher/write.js";
import { fullHealth } from "../src/health.js";
import { fakeSession } from "./fake-session.js";

const session = (exclusive: boolean | undefined) => {
  const handle = fakeSession({
    SaisieAppreciation: () => (exclusive === undefined ? {} : { __signature: { ModeExclusif: exclusive } }),
    ListePeriodes: () => ({ __signature: { ModeExclusif: exclusive ?? false }, listePeriodes: { _T: 24, V: [] } }),
  });
  rememberUserData(handle, { resources: [], maxScale: null, tabs: null, rights: {}, maxCommentLength: null });
  return handle;
};

test("exclusive mode is read from the answer signature only when it is a boolean", () => {
  assert.equal(exclusiveOf({ ModeExclusif: true }), true);
  assert.equal(exclusiveOf({ ModeExclusif: false }), false);
  assert.equal(exclusiveOf({ ModeExclusif: "true" }), null);
  assert.equal(exclusiveOf(undefined), null);
  resetExclusive();
  assert.equal(noteExclusive({ onglet: 25 }, "PageApprBulletin"), null);
  assert.equal(exclusiveStats().value, null);
  noteExclusive({ ModeExclusif: true }, "PageApprBulletin", Date.UTC(2026, 10, 24, 10));
  noteExclusive({ ModeExclusif: true }, "PageApprBulletin", Date.UTC(2026, 10, 24, 11));
  assert.equal(exclusiveStats().lastTrueAt, "2026-11-24T10:00:00.000Z");
  noteExclusive({ ModeExclusif: false }, "ListePeriodes", Date.UTC(2026, 10, 24, 12));
  assert.deepEqual({ ...exclusiveStats(), seenAt: null }, {
    value: false, seenAt: null, function: "ListePeriodes", lastTrueAt: "2026-11-24T10:00:00.000Z", refusedWrites: 0,
  });
});

test("a read records the exclusive mode carried by its answer", async () => {
  resetExclusive();
  await callPronote(session(true), { name: "ListePeriodes", signature: { onglet: 23 } });
  assert.equal(exclusiveStats().value, true);
  assert.equal(exclusiveStats().function, "ListePeriodes");
});

test("a write answered in exclusive mode is refused (exclusive_mode), not reported as saved", async () => {
  resetExclusive();
  await assert.rejects(
    sendWrite(session(true), "commentSave", { appreciation: { G: 1, L: "Test", E: 2 } }),
    (error: any) => error.status === 409 && error.code === "exclusive_mode",
  );
  assert.equal(exclusiveStats().refusedWrites, 1);
  assert.equal(fullHealth().pronote.exclusiveMode.value, true);
  assert.equal(fullHealth().pronote.exclusiveMode.refusedWrites, 1);
});

test("a write answered outside exclusive mode, or without the member, goes on as before", async () => {
  resetExclusive();
  const accepted = await sendWrite(session(false), "commentSave", { appreciation: { G: 1, L: "Test", E: 2 } });
  assert.equal(accepted.report, null);
  const silent = await sendWrite(session(undefined), "commentSave", { appreciation: { G: 1, L: "Test", E: 2 } });
  assert.equal(silent.report, null);
  assert.equal(exclusiveStats().refusedWrites, 0);
  assert.equal(exclusiveStats().value, false);
});
