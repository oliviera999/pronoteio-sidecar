import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assertEditable, buildLessonRequest, resolveRooms, roomsOf } from "../src/teacher/lessonWrite.js";
import type { LessonRef } from "../src/teacher/timetable.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

const ref = (editable = true, roomsEditable = true): LessonRef => ({
  lesson: {
    id: "l:2026-11-10 13:30|3D|MATHÉMATIQUES",
    subject: "MATHÉMATIQUES",
    teacher: "M. PROFESSEUR Maxime",
    rooms: ["207"],
    groups: ["3D"],
    start: Math.floor(new Date(2026, 10, 10, 13, 30).getTime() / 1000),
    end: Math.floor(new Date(2026, 10, 10, 15, 30).getTime() / 1000),
    cancelled: false,
    status: "",
    hasNotebook: true,
    notebookPublished: false,
    attendanceDone: false,
    editable,
    roomsEditable,
  },
  pronoteId: "29#x2",
  week: 11,
  notebookId: null,
  label: "MATHÉMATIQUES 3D",
  rooms: [{ N: "129#r1", L: "207" }],
});

test("rooms of the school are read from RessourceEDT and resolved by label", () => {
  const rooms = roomsOf(fixture("resources-edt"));
  assert.deepEqual(rooms.map((item) => item.L), ["Amphi", "207", "Labo SVT 1"]);
  assert.deepEqual(resolveRooms(rooms, ["labo svt 1"]), [{ N: "129#r2", L: "Labo SVT 1" }]);
  assert.throws(() => resolveRooms(rooms, ["B12"]), /room_not_found:B12/);
});

test("a lesson that Pronote marks as not modifiable is refused before any write", () => {
  assert.throws(() => assertEditable(ref(false, false), {}, true), /lesson_not_editable/);
  assert.throws(() => assertEditable(ref(true, false), {}, true), /lesson_rooms_not_editable/);
  assert.throws(() => assertEditable(ref(), { cours: { modifierSalles: false } }, true), /lesson_rooms_not_editable/);
  assert.doesNotThrow(() => assertEditable(ref(), { cours: { modifierSalles: true } }, true));
  assert.doesNotThrow(() => assertEditable(ref(true, false), {}, false), "a memo does not need the rooms right");
});

test("the SaisieCours request replaces the rooms of the lesson, one change per request", () => {
  const request = buildLessonRequest(ref(), { rooms: ["Labo SVT 1"], dryRun: false }, [{ N: "129#r2", L: "Labo SVT 1" }]);
  assert.deepEqual(request, {
    cours: { N: "29#x2", G: 0, L: "MATHÉMATIQUES 3D" },
    numeroSemaine: 11,
    estEDTAnnuel: false,
    suppressionCours: false,
    deplacementCours: false,
    forcerSaisie: false,
    genreRessource: 17,
    listeRessources: [{ N: "129#r2", G: 17, L: "Labo SVT 1" }],
    ressourcesRemplacees: [{ N: "129#r1", G: 17, L: "207" }],
  });
  const memo = buildLessonRequest(ref(), { memo: "Apporter les loupes", dryRun: false, force: true }, null);
  assert.equal(memo.modificationMemo, "Apporter les loupes");
  assert.equal(memo.forcerSaisie, true);
  assert.equal(memo.genreRessource, undefined);
});
