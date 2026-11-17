import assert from "node:assert/strict";
import { test } from "node:test";
import { labelKey, labelMatches, matchesLabels } from "../src/normalise.js";
import { notebook } from "../src/teacher/notebook.js";
import { findLesson, writeNotebook } from "../src/teacher/notebookWrite.js";
import { discriminate, filterByGroups, lessonFromPage, lessonIdFor, lessons, rebaseElementId } from "../src/teacher/timetable.js";
import { fakeSession } from "./fake-session.js";

/**
 * Change of room of 12/11/2026 (anonymised): Pronote keeps the original lesson, cancelled and empty (G006), and the
 * lesson actually held (I305 INFO math), with one content and one homework, at the same time for the same group.
 */
const BASE = "l:2026-11-12 17:10|[T06AP ORIENT]|AP ORIENTATION";

type Lesson = { N: string; room: string; cancelled?: boolean; notebook?: boolean; group?: string; date?: string };

const cours = (item: Lesson) => ({
  N: item.N,
  G: 0,
  place: 9,
  duree: 1,
  DateDuCours: { _T: 7, V: item.date ?? "12/11/2026 17:10:00" },
  ListeContenus: {
    _T: 24,
    V: [
      { L: "AP ORIENTATION", N: "79#s", G: 16 },
      { L: item.group ?? "[T06AP ORIENT]", N: "23#g", G: 2 },
      ...(item.room ? [{ L: item.room, N: `129#${item.N}`, G: 17 }] : []),
    ],
  },
  ...(item.cancelled ? { estAnnule: true, Statut: 0 } : {}),
  AvecCdT: item.notebook === true,
  AvecCdTPublie: item.notebook === true,
  ...(item.notebook ? { cahierDeTextes: { _T: 24, V: { N: `18#${item.N}` } } } : {}),
  modifiable: true,
});

/** Notebook page of a lesson: one content and one homework when the lesson has a notebook. */
const page = (withEntry: boolean) => ({
  listeClassesEleves: { _T: 24, V: [{ L: "[T06AP ORIENT]", N: "23#g", G: 2, listeEleves: { _T: 24, V: [{ L: "ELEVE Une", N: "46#e1", G: 4 }] } }] },
  listeCahiersDeTexte: {
    _T: 24,
    V: withEntry
      ? [
          {
            N: "18#cdt",
            verrouille: false,
            publie: true,
            noteProchaineSeance: "",
            commentairePrive: "",
            listeContenus: { _T: 24, V: [{ L: "Parcoursup", N: "27#c1", descriptif: { _T: 21, V: "<p>Vœux</p>" }, categorie: { _T: 24, V: { L: "Cours", N: "19#c", G: 1 } } }] },
            ListeTravailAFaire: { _T: 24, V: [{ N: "20#t1", descriptif: { _T: 21, V: "<p>Lire la fiche</p>" }, PourLe: { _T: 7, V: "19/11/2026" }, DonneLe: { _T: 7, V: "12/11/2026" } }] },
          },
        ]
      : [],
  },
});

const session = (items: Lesson[]) => {
  const s = fakeSession({
    PageEmploiDuTemps: () => ({ ListeCours: { _T: 24, V: items.map(cours) } }),
    PageSaisieCahierDeTextes: (data) => page(items.some((item) => item.N === data?.cours?.N && item.notebook)),
  });
  (s.instance as any).firstMonday = new Date(2026, 8, 7);
  return s;
};

const MOVED: Lesson[] = [
  { N: "29#a", room: "G006", cancelled: true },
  { N: "29#b", room: "I305 INFO math", notebook: true },
];

const day = [new Date(2026, 10, 12), new Date(2026, 10, 13)] as const;

test("a lesson alone keeps exactly its stable id", async () => {
  const refs = await lessons(session([{ N: "29#a", room: "G006" }]), ...day);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].lesson.id, BASE);
  assert.equal(refs[0].lesson.id, lessonIdFor(new Date(2026, 10, 12, 17, 10), ["[T06AP ORIENT]"], "AP ORIENTATION"));
  assert.equal(refs[0].lesson.baseId, BASE);
  assert.equal(refs[0].lesson.duplicates, 1);
});

test("a cancelled lesson and the moved one get distinct ids with their room", async () => {
  const refs = await lessons(session(MOVED), ...day);
  assert.deepEqual(refs.map((ref) => ref.lesson.id).sort(), [`${BASE}|r:G006`, `${BASE}|r:I305 INFO math`]);
  assert.ok(refs.every((ref) => ref.lesson.baseId === BASE && ref.lesson.duplicates === 2));
});

test("the notebook gives the moved lesson's elements ids built on its full id", async () => {
  const result = await notebook(session(MOVED), ...day, [], true);
  const held = result.items.find((item) => !item.lesson.cancelled)!;
  assert.equal(held.lesson.id, `${BASE}|r:I305 INFO math`);
  assert.equal(held.homework[0].id, `${BASE}|r:I305 INFO math|h1`);
  assert.equal(held.contents[0].id, `${BASE}|r:I305 INFO math|c1|Parcoursup`);
  const cancelled = result.items.find((item) => item.lesson.cancelled)!;
  assert.deepEqual([cancelled.contents.length, cancelled.homework.length], [0, 0]);
});

test("the base id resolves to the only lesson held, and old element ids follow it", async () => {
  const s = session(MOVED);
  assert.equal((await findLesson(s, BASE)).lesson.rooms[0], "I305 INFO math");
  const result = await writeNotebook(s, BASE, { homework: [{ id: `${BASE}|h1`, description: "<p>Lire la fiche et répondre</p>", due: 1795000000 }] }, { dryRun: true });
  assert.equal(result.lesson.id, `${BASE}|r:I305 INFO math`);
  assert.equal(result.before.homework.length, 1);
  assert.equal(result.after.homework[0].id, `${BASE}|r:I305 INFO math|h1`);
  assert.match(result.after.homework[0].description, /répondre/);
  const created = await writeNotebook(s, BASE, { homework: [{ description: "<p>Nouveau</p>", due: 1795000000 }] }, { dryRun: true });
  assert.equal(created.lesson.rooms[0], "I305 INFO math");
  assert.equal(created.after.homework.length, 2);
});

test("the full id of the cancelled lesson still targets it (the refusal belongs to Moodle)", async () => {
  const result = await writeNotebook(session(MOVED), `${BASE}|r:G006`, { homework: [{ description: "<p>x</p>", due: 1795000000 }] }, { dryRun: true });
  assert.equal(result.lesson.cancelled, true);
  assert.equal(result.before.homework.length, 0);
});

test("an element id of another duplicate is not moved onto the resolved lesson", async () => {
  await assert.rejects(
    writeNotebook(session(MOVED), BASE, { homework: [{ id: `${BASE}|r:G006|h1`, description: "<p>x</p>", due: 1795000000 }] }, { dryRun: true }),
    /homework_not_found/,
  );
});

test("two lessons held at the same time: the base id is refused with the candidates, each full id works", async () => {
  const s = session([
    { N: "29#a", room: "G105-Info", notebook: true },
    { N: "29#b", room: "G106-Info" },
  ]);
  await assert.rejects(findLesson(s, BASE), (error: any) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, `lesson_ambiguous:${BASE}|r:G105-Info ; ${BASE}|r:G106-Info`);
    return true;
  });
  assert.equal((await findLesson(s, `${BASE}|r:G105-Info`)).pronoteId, "29#a");
  assert.equal((await findLesson(s, `${BASE}|r:G106-Info`)).pronoteId, "29#b");
});

test("duplicates without distinct rooms are ranked, lesson held first", async () => {
  const refs = await lessons(session([
    { N: "29#z", room: "", cancelled: true },
    { N: "29#y", room: "" },
  ]), ...day);
  const byPronote = Object.fromEntries(refs.map((ref) => [ref.pronoteId, ref.lesson.id]));
  assert.equal(byPronote["29#y"], `${BASE}|n:1`);
  assert.equal(byPronote["29#z"], `${BASE}|n:2`);
});

test("an unknown id is not found", async () => {
  await assert.rejects(findLesson(session(MOVED), `${BASE}|r:B12`), /lesson_not_found/);
});

test("discriminate is idempotent and rebaseElementId only moves element ids of the base", () => {
  const s = session(MOVED);
  const refs = MOVED.map((item) => lessonFromPage(s, cours(item), 10)!);
  discriminate(refs);
  const first = refs.map((ref) => ref.lesson.id);
  discriminate(refs);
  assert.deepEqual(refs.map((ref) => ref.lesson.id), first);
  const held = refs.find((ref) => !ref.lesson.cancelled)!.lesson;
  assert.equal(rebaseElementId(held, `${BASE}|c1|Parcoursup`), `${held.id}|c1|Parcoursup`);
  assert.equal(rebaseElementId(held, `${held.id}|h1`), `${held.id}|h1`);
  assert.equal(rebaseElementId(held, "l:2026-11-12 17:10|T11|SVT|h1"), "l:2026-11-12 17:10|T11|SVT|h1");
  assert.equal(rebaseElementId(held, null), null);
});

test("class labels: brackets, case and accents ignored, prefix at a word boundary", () => {
  assert.equal(labelKey("[T06AP ORIENT]"), "t06ap orient");
  assert.equal(labelKey("[1-SPE SVT-10]"), "1 spe svt 10");
  for (const wanted of ["T06AP", "t06ap orient", "[T06AP ORIENT]", "  [t06ap   ORIENT] "]) {
    assert.ok(labelMatches("[T06AP ORIENT]", wanted), wanted);
  }
  assert.ok(labelMatches("[1-SPE SVT-10]", "1-spe svt"));
  assert.ok(labelMatches("[6-SC-603]", "6-SC"));
  assert.ok(labelMatches("Équipe Élèves", "equipe eleves"));
  assert.ok(labelMatches("1G3", "1G"));
  assert.ok(labelMatches("T11", "T11"));
  assert.equal(labelMatches("T110", "T11"), false);
  assert.equal(labelMatches("[T06AP ORIENT]", "T06"), false);
  assert.equal(labelMatches("[T06AP ORIENT]", "AP"), false);
  assert.equal(matchesLabels(["T110"], ["T11"]), false);
  assert.equal(matchesLabels(["T110"], []), true);
});

test("lessons are filtered by a bracketed group with or without brackets", async () => {
  const refs = await lessons(session([...MOVED, { N: "29#c", room: "B1", group: "T110", date: "12/11/2026 08:00:00" }, { N: "29#d", room: "B2", group: "T11", date: "12/11/2026 09:00:00" }]), ...day);
  assert.equal(filterByGroups(refs, ["T06AP"]).length, 2);
  assert.equal(filterByGroups(refs, ["[T06AP ORIENT]"]).length, 2);
  assert.deepEqual(filterByGroups(refs, ["T11"]).map((ref) => ref.lesson.groups[0]), ["T11"]);
  assert.equal(filterByGroups(refs, ["T1"]).length, 0);
});
