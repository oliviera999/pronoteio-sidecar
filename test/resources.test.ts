import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { SessionHandle } from "pawnote";
import { lockerFromAnswer, quizzesFromAnswer } from "../src/teacher/resources.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const session = {
  information: { url: "https://demo.example/pronote", id: "sess1", aesKey: "0123456789abcdef", aesIV: "fedcba9876543210" },
} as unknown as SessionHandle;

test("locker: received documents with a session-bound download URL", () => {
  const items = lockerFromAnswer(session, fixture("locker-page"), "received");
  assert.equal(items.length, 3);
  assert.equal(items[0].name, "Projet pédagogique.docx");
  assert.equal(items[0].read, false);
  assert.equal(items[0].category, "Divers");
  assert.equal(items[0].from, "SUPERVISEUR (Proviseur)");
  assert.equal(items[0].files.length, 1);
  assert.match(items[0].files[0].url ?? "", /FichiersExternes\/.+\?Session=sess1$/);
  assert.deepEqual(lockerFromAnswer(session, fixture("locker-page"), "deposited"), []);
});

test("quizzes: genre 55 rows with their executions counted", () => {
  const items = quizzesFromAnswer(fixture("quiz-list"));
  assert.equal(items.length, 2);
  assert.equal(items[0].name, "QCM 1 - Mathématiques 3C 1");
  assert.equal(items[0].subject, "MATHÉMATIQUES");
  assert.equal(items[0].level, "3EME");
  assert.equal(items[0].questions, 10);
  assert.deepEqual(items[0].tags, ["Equations"]);
  assert.equal(items[0].executions, 1);
  assert.equal(items[1].executions, 2);
  assert.ok(items[0].id.startsWith("q:"));
});
