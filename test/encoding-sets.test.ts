import assert from "node:assert/strict";
import { test } from "node:test";
import { numberSet, parseNumberSet } from "../src/pronote/encoding.js";
import { hasRight } from "../src/pronote/userdata.js";
import { kindOf, stableId } from "../src/teacher/ids.js";

test("number sets are encoded as { _T: 26, V: \"[…]\" } and parsed with ranges", () => {
  assert.deepEqual(numberSet([0, 1, 2, 3]), { _T: 26, V: "[0,1,2,3]" });
  assert.deepEqual(numberSet([]), { _T: 26, V: "[]" });
  assert.deepEqual(parseNumberSet({ _T: 26, V: "[204..206,210]" }), [204, 205, 206, 210]);
  assert.deepEqual(parseNumberSet({ _T: 8, V: "[3]" }), [3]);
  assert.deepEqual(parseNumberSet("[]"), []);
  assert.deepEqual(parseNumberSet([1, "2"]), [1, 2]);
  assert.deepEqual(parseNumberSet("texte"), []);
});

test("rights are looked up by group and name, case-insensitively", () => {
  assert.equal(hasRight({ communication: { avecDiscussionAvancee: true } }, "Communication", "AvecDiscussionAvancee"), true);
  assert.equal(hasRight({ Communication: { AvecDiscussionAvancee: false } }, "communication", "avecDiscussionAvancee"), false);
  assert.equal(hasRight({ avecDiscussionAvancee: true }, "communication", "avecDiscussionAvancee"), true);
  assert.equal(hasRight({}, "communication", "avecDiscussionAvancee"), null);
});

test("the communication id kinds have their own prefixes", () => {
  assert.equal(stableId("recipient", "parent|M. PARENT F."), "r:parent|M. PARENT F.");
  assert.equal(stableId("list", "Équipe 3A"), "dl:Équipe 3A");
  assert.equal(kindOf("mt:x|y"), "meeting");
  assert.equal(kindOf("rdv:x|y"), "appointment");
  assert.equal(kindOf("ft:x|y"), "forumTopic");
});
