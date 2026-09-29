import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "../src/errors.js";
import type { Assessment } from "../src/normalise.js";
import { splitDisplayName } from "../src/normalise.js";
import { assessmentIdFor, servicesByPeriod, validate } from "../src/teacher/grades.js";
import { functions, requireFunction } from "../src/teacher/functions.js";

const assessment: Assessment = {
  id: null,
  title: "Contrôle",
  date: 1790000000,
  publication: null,
  max: 20,
  coefficient: 1,
  scaleTo20: false,
  optional: false,
  bonus: false,
  comment: "",
};

test("validate rejects duplicates and grades outside the scale", () => {
  const rejected = validate(assessment, [
    { studentid: "a", value: 12, status: "" },
    { studentid: "b", value: 21, status: "" },
    { studentid: "c", value: -1, status: "" },
    { studentid: "a", value: 10, status: "" },
    { studentid: "d", value: null, status: "abs" },
  ]);
  assert.deepEqual(rejected, [
    { studentid: "b", reason: "out_of_scale" },
    { studentid: "c", reason: "out_of_scale" },
    { studentid: "a", reason: "duplicate" },
  ]);
});

test("validate accepts a status whatever the value", () => {
  assert.deepEqual(validate(assessment, [{ studentid: "a", value: 50, status: "disp" }]), []);
});

test("splitDisplayName separates upper-case last names", () => {
  assert.deepEqual(splitDisplayName("DUPONT Marie"), { lastname: "DUPONT", firstname: "Marie" });
  assert.deepEqual(splitDisplayName("DE LA FONTAINE Jean-Paul"), { lastname: "DE LA FONTAINE", firstname: "Jean-Paul" });
  assert.deepEqual(splitDisplayName("Martin Léa"), { lastname: "Martin", firstname: "Léa" });
  assert.deepEqual(splitDisplayName("ÉLODIE"), { lastname: "ÉLODIE", firstname: "" });
});

test("every teacher function is configured by default", () => {
  for (const [key, fn] of Object.entries(functions)) {
    assert.ok(fn.name, `${key} has no Pronote function name`);
  }
});

test("unconfigured teacher functions answer 501", () => {
  const saved = functions.absencesList;
  functions.absencesList = { name: "", onglet: null };
  try {
    assert.throws(() => requireFunction("absencesList"), (error: unknown) =>
      error instanceof HttpError && error.status === 501 && error.code === "not_configured:absencesList");
  } finally {
    functions.absencesList = saved;
  }
});

test("validate refuses a scale above the school maximum", () => {
  assert.throws(() => validate({ ...assessment, max: 1000 }, [], 999), (error: unknown) =>
    error instanceof HttpError && error.code === "scale_too_large");
});

test("services of every period are merged with the periods they are graded in", () => {
  const svt = { N: "1", matiere: { V: { L: "SPE SVT" } }, groupe: { V: { L: "1-SPE SVT-10" } } };
  const snt = { N: "2", matiere: { V: { L: "SNT" } }, classe: { V: { L: "205" } } };
  const merged = servicesByPeriod([
    { periodId: "p:Trimestre 1", services: [snt] },
    { periodId: "p:Semestre 1", services: [svt] },
    { periodId: "p:Semestre 2", services: [{ ...svt, N: "3" }] },
    { periodId: "p:Trimestre 2", services: [snt] },
  ]);
  assert.deepEqual(merged.map((entry) => [entry.service.N, entry.periods]), [
    ["2", ["p:Trimestre 1", "p:Trimestre 2"]],
    ["1", ["p:Semestre 1", "p:Semestre 2"]],
  ]);
});

test("assessment ids depend on the day and the title only", () => {
  const morning = assessmentIdFor(new Date(2026, 8, 17, 8, 0), " Contrôle 1 ");
  assert.equal(morning, "d:17/09/2026|Contrôle 1");
  assert.equal(assessmentIdFor(new Date(2026, 8, 17, 18, 30), "Contrôle 1"), morning);
});
