import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "../src/errors.js";
import { kindOf, resolve, stableId, stableIds } from "../src/teacher/ids.js";

test("stable ids are built from normalised labels", () => {
  assert.equal(stableId("class", " T06 "), "c:T06");
  assert.equal(stableId("period", "Trimestre  1"), "p:Trimestre 1");
  assert.equal(kindOf("g:ANG LVA-GR1"), "group");
  assert.equal(kindOf("x:1"), null);
});

test("long keys are hashed to fit Moodle columns", () => {
  const id = stableId("service", "S".repeat(200));
  assert.match(id, /^s:#[0-9a-f]{32}$/);
  assert.equal(stableId("service", "S".repeat(200)), id);
});

test("duplicate labels get an ordinal suffix", () => {
  assert.deepEqual(stableIds("student", ["DUPONT Léa", "MARTIN Paul", "DUPONT Léa"], (x) => x),
    ["e:DUPONT Léa", "e:MARTIN Paul", "e:DUPONT Léa~2"]);
});

test("resolve finds the session element or answers 404", () => {
  const items = [{ N: "105#aaa", L: "Trimestre 1" }, { N: "105#bbb", L: "Trimestre 2" }];
  assert.equal(resolve("period", "p:Trimestre 2", items, (x) => x.L).N, "105#bbb");
  assert.throws(() => resolve("period", "p:Semestre 1", items, (x) => x.L), (error: unknown) =>
    error instanceof HttpError && error.status === 404 && error.code === "period_not_found");
});
