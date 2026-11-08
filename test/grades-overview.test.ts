import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assessmentsFromPage, statusOf, valueOf } from "../src/teacher/grades.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

test("grade cells: values, statuses and empty cells", () => {
  assert.equal(valueOf("12,5"), 12.5);
  assert.equal(valueOf("17"), 17);
  assert.equal(valueOf("|1"), null);
  assert.equal(valueOf(""), null);
  assert.equal(statusOf("|1"), "abs");
  assert.equal(statusOf("|7"), "nonrenduzero");
  assert.equal(statusOf("|9"), "", "unknown code");
  assert.equal(statusOf("12"), "");
});

test("assessments of a PageNotes answer with their grades (demo fixture, 6A, no sub-service)", () => {
  const items = assessmentsFromPage(fixture("grades-overview-page"));
  assert.equal(items.length, 2);
  const [first] = items;
  assert.equal(first.max, 20);
  assert.equal(first.coefficient, 1);
  assert.equal(first.locked, false);
  assert.equal(first.hasGrades, true);
  assert.equal(first.subservice, "");
  assert.equal(first.publication, first.date, "published the same day");
  assert.equal(first.grades.length, 4);
  assert.match(first.grades[0].student, /^ELEVE /);
  assert.equal(typeof first.grades[0].value, "number");
  assert.equal(first.grades[0].status, "");
  assert.equal(first.grades[0].comment, "");
  assert.ok(items[0].date <= items[1].date, "sorted by date");
});

test("assessments of a service with sub-services are tagged (3A fixture of the assessments test)", () => {
  const page = fixture("grades-page");
  const items = assessmentsFromPage(page);
  assert.ok(items.length >= 1);
  const tagged = items.filter((item) => item.subservice !== "");
  assert.ok(tagged.every((item) => ["Écrit", "Oral"].includes(item.subservice)));
});
