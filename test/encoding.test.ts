import assert from "node:assert/strict";
import { test } from "node:test";
import { entity, gradeValue, listOf, parsePronoteDate, pronoteDate, pronoteNumber } from "../src/pronote/encoding.js";

test("gradeValue uses a decimal comma and rounds to two decimals", () => {
  assert.equal(gradeValue(12.5, ""), "12,5");
  assert.equal(gradeValue(13.456, ""), "13,46");
  assert.equal(gradeValue(20, ""), "20");
  assert.equal(gradeValue(null, ""), "");
});

test("gradeValue encodes special statuses as |kind", () => {
  assert.equal(gradeValue(null, "abs"), "|1");
  assert.equal(gradeValue(15, "disp"), "|2");
  assert.equal(gradeValue(null, "nonrenduzero"), "|7");
});

test("pronoteDate and parsePronoteDate round-trip", () => {
  const date = new Date(2026, 8, 28, 14, 5, 9);
  const encoded = pronoteDate(date);
  assert.deepEqual(encoded, { _T: 7, V: "28/9/2026 14:5:9" });
  assert.equal(parsePronoteDate(encoded.V)?.getTime(), date.getTime());
  assert.equal(parsePronoteDate("28/09/2026")?.getTime(), new Date(2026, 8, 28).getTime());
  assert.equal(parsePronoteDate("2026-09-28"), null);
  assert.equal(parsePronoteDate(42), null);
});

test("entity omits undefined members", () => {
  assert.deepEqual(entity("12#a"), { N: "12#a" });
  assert.deepEqual(entity("12#a", 1, "3A"), { N: "12#a", G: 1, L: "3A" });
});

test("listOf accepts Pronote lists and arrays", () => {
  assert.deepEqual(listOf({ _T: 24, V: [1, 2] }), [1, 2]);
  assert.deepEqual(listOf([3]), [3]);
  assert.deepEqual(listOf(null), []);
  assert.deepEqual(listOf({ V: "x" }), []);
});

test("pronoteNumber uses a decimal comma", () => {
  assert.equal(pronoteNumber(1.5), "1,5");
  assert.equal(pronoteNumber(2), "2");
});
