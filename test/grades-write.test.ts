import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { listOf } from "../src/pronote/encoding.js";
import { deletedAssessmentMember, gradeCommentRequest } from "../src/teacher/gradesWrite.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

test("an assessment sent for deletion keeps its members as read, state 3 and no grade", () => {
  const page = fixture("grades-overview-page");
  const [existing] = listOf<any>(page.listeDevoirs);
  const period = { N: "105#p1", G: 2, L: "Trimestre 1" };
  const member = deletedAssessmentMember(period, page, existing);
  assert.equal(member.N, existing.N);
  assert.equal(member.E, 3);
  assert.equal(member.commentaire, String(existing.commentaire ?? ""));
  assert.deepEqual(member.bareme, existing.bareme);
  assert.deepEqual(member.listeEleves, []);
  assert.equal(member.recalculerNotesDevoirSelonBareme, false);
  assert.ok(Array.isArray(member.listeClasses));
});

test("SaisieNotesUnitaire carries one student with its grade and comment", () => {
  assert.deepEqual(gradeCommentRequest("33#d1", "46#e1", "9,5", "TEST olution"), {
    listeDevoirs: [{ N: "33#d1", listeEleves: [{ N: "46#e1", note: { _T: 10, V: "9,5" }, commentaire: "TEST olution" }] }],
  });
  assert.deepEqual((gradeCommentRequest("33#d1", "46#e1", "|1", "") as any).listeDevoirs[0].listeEleves[0].note, { _T: 10, V: "|1" });
});
