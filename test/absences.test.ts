import assert from "node:assert/strict";
import { test } from "node:test";
import { absencesFromCallSheet, uniqueAbsences } from "../src/teacher/absences.js";
import type { RosterEntry } from "../src/teacher/roster.js";

const students: RosterEntry[] = [
  { pronoteId: "46#aaa", label: "DUPONT Léa", id: "e:DUPONT Léa" },
  { pronoteId: "46#bbb", label: "MARTIN Paul", id: "e:MARTIN Paul" },
];

const absence = (overrides: Record<string, unknown> = {}) => ({
  N: "1#abs",
  G: 13,
  eleve: { _T: 24, V: { L: "DUPONT Léa", N: "46#aaa" } },
  justifie: true,
  DateDebut: { _T: 7, V: "25/09/2026 14:00:00" },
  DateFin: { _T: 7, V: "25/09/2026 17:10:00" },
  listeMotifs: { _T: 24, V: [{ L: "Maladie", N: "89#m" }] },
  ...overrides,
});

/** Anonymised shape of a PageSaisieAbsences answer (PRONOTE 2026.2). */
const callSheet = (items: unknown[], studentOverrides: Record<string, unknown> = {}) => ({
  ListeEleves: {
    _T: 24,
    V: [
      { L: "DUPONT Léa", N: "46#aaa", ListeAbsences: { _T: 24, V: items }, ...studentOverrides },
      { L: "MARTIN Paul", N: "46#bbb", ListeAbsences: { _T: 24, V: [] } },
    ],
  },
});

test("reads the absences of the call sheet", () => {
  const [item, ...rest] = absencesFromCallSheet(callSheet([absence()]), students);
  assert.equal(rest.length, 0);
  assert.equal(item.studentid, "e:DUPONT Léa");
  assert.equal(item.start, Math.floor(new Date(2026, 8, 25, 14, 0, 0).getTime() / 1000));
  assert.equal(item.end, Math.floor(new Date(2026, 8, 25, 17, 10, 0).getTime() / 1000));
  assert.equal(item.justified, true);
  assert.equal(item.reason, "Maladie");
  assert.match(item.id, /^a:/);
});

test("ignores late arrivals and students outside the class or group", () => {
  const late = absence({ G: 14 });
  const other = absence({ eleve: { _T: 24, V: { L: "DURAND Zoé", N: "46#zzz" } } });
  assert.deepEqual(absencesFromCallSheet(callSheet([late, other]), students), []);
});

test("falls back to the label when the Pronote id differs, never for homonyms", () => {
  const renumbered = absence({ eleve: { _T: 24, V: { L: "DUPONT Léa", N: "46#other" } } });
  assert.equal(absencesFromCallSheet(callSheet([renumbered]), students).length, 1);

  const homonyms: RosterEntry[] = [...students, { pronoteId: "46#ccc", label: "DUPONT Léa", id: "e:DUPONT Léa~2" }];
  assert.deepEqual(absencesFromCallSheet(callSheet([renumbered]), homonyms), []);
});

test("unjustified absence without reason", () => {
  const [item] = absencesFromCallSheet(callSheet([absence({ justifie: false, listeMotifs: { _T: 24, V: [] } })]), students);
  assert.equal(item.justified, false);
  assert.equal(item.reason, "");
});

test("an absence seen on several lessons is kept once", () => {
  const first = absencesFromCallSheet(callSheet([absence()]), students);
  const second = absencesFromCallSheet(callSheet([absence({ N: "1#other-session-id" })]), students);
  assert.equal(uniqueAbsences([...first, ...second]).length, 1);
});
