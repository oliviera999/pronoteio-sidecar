import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionHandle } from "pawnote";
import { rememberUserData } from "../src/pronote/userdata.js";
import { itemFromList } from "../src/teacher/competencies.js";
import { buildCompetencyRequest, levelElement, mergeRatings } from "../src/teacher/competenciesWrite.js";

/* Synthetic fixtures from the client code (docs/pronote-matrice/2-3-notes-competences.md): NOT validated on the
   demo server, whose profile does not open the skills tabs and which ignores writes. */
const evaluation = {
  N: "13#e1",
  L: "Évaluation TP respiration",
  dateValidation: { _T: 7, V: "12/11/2026" },
  datePublication: { _T: 7, V: "13/11/2026" },
  coefficient: { _T: 10, V: "1" },
  priseEnCompteDansBilan: true,
  listeCompetences: {
    _T: 24,
    V: [
      { N: "14#c1", L: "Pratiquer une démarche scientifique", relationESI: { _T: 24, V: { N: "15#r1" } }, pilier: { _T: 24, V: { L: "D4" } }, coefficient: { _T: 10, V: "1" } },
      { N: "14#c2", L: "Communiquer", relationESI: { _T: 24, V: { N: "15#r2" } }, pilier: { _T: 24, V: { L: "D1" } }, coefficient: { _T: 10, V: "1" } },
    ],
  },
};
const service = { N: "s1", L: "SVT", matiere: { V: { L: "SVT" } }, classe: { V: { N: "23#k1", L: "1G3" } } };
const period = { N: "105#p1", G: 2, L: "Trimestre 1" };
const students = [{ N: "46#x1", L: "ELEVE Un" }, { N: "46#x2", L: "ELEVE Deux" }];

const session = () => {
  const handle = { user: { name: "M. PROF" } } as unknown as SessionHandle;
  rememberUserData(handle, { resources: [], maxScale: null, tabs: null, rights: {}, maxCommentLength: null, acquisitionLevels: [
    { N: "16#n2", G: 2, L: "Acquis", actifPour: { _T: 26, V: "[0,1]" } },
    { N: "16#n5", G: 5, L: "Début d'acquisition", actifPour: { _T: 26, V: "[]" } },
  ] } as any);
  return handle;
};

test("0.13.0: a level is the element of the school's list; unknown, unused or without list: refused", () => {
  assert.deepEqual(levelElement(session(), 2), { N: "16#n2", G: 2, L: "Acquis" });
  assert.throws(() => levelElement(session(), 6), /level_unknown:6/);
  assert.throws(() => levelElement(session(), 5), /level_inactive:5/);
  assert.throws(() => levelElement({ user: {} } as unknown as SessionHandle, 2), /levels_unknown/);
});

test("levels of an assessment: the assessment as read, without state, and only the rated students", () => {
  const { item, skillIds } = itemFromList(evaluation as any, "SVT", "1G3", "class");
  const request = buildCompetencyRequest(session(), service as any, { N: "23#k1", G: 1, L: "1G3" }, period, evaluation as any, skillIds, students, {
    assessment: item.id,
    service: "s:SVT|1G3",
    period: "p:Trimestre 1",
    ratings: [{ student: "eleve un", skill: item.skills[0].id, level: 2, observation: "Bien", published: true }],
    dryRun: true,
  });
  const [sent] = request.listeEvaluations as any[];
  assert.equal(sent.N, "13#e1");
  assert.equal(sent.E, undefined, "levels only: as the unit entry of the client");
  assert.equal(sent.L, "Évaluation TP respiration");
  assert.deepEqual(sent.Periode, { N: "105#p1", G: 2, L: "Trimestre 1" });
  assert.equal(sent.listeCompetences, undefined, "unchanged skills are not sent");
  assert.deepEqual(sent.DateValidation, { _T: 7, V: "12/11/2026" });
  assert.equal(sent.listeEleves.length, 1);
  assert.deepEqual(sent.listeEleves[0], {
    N: "46#x1", G: 4, L: "ELEVE Un", E: 2,
    listeCompetences: [{
      N: "14#c1", L: "Pratiquer une démarche scientifique", E: 2,
      relationESI: { N: "15#r1" },
      niveauDAcquisition: { N: "16#n2", G: 2, L: "Acquis" },
      observation: "Bien",
      observationPubliee: true,
    }],
  });
  assert.equal(request.listeFichiers, undefined);
  // A change of the title makes it a modification of the assessment (state E 2), as the window of the client.
  const renamed = buildCompetencyRequest(session(), service as any, undefined, period, evaluation as any, skillIds, students, {
    assessment: item.id, service: "s", period: "p", title: "Nouveau titre", dryRun: true,
  });
  assert.equal((renamed.listeEvaluations as any[])[0].E, 2);
  assert.deepEqual(renamed.listeFichiers, []);
});

test("creation, deletion and unknown students or skills", () => {
  const created = buildCompetencyRequest(session(), service as any, undefined, period, null, new Map(), students, {
    assessment: null, service: "s:SVT|1G3", period: "p:Trimestre 1", title: "Nouvelle", date: Math.floor(new Date(2026, 10, 20).getTime() / 1000), skills: ["14#c9"], dryRun: true,
  });
  const [sent] = created.listeEvaluations as any[];
  assert.ok(sent.N < 0);
  assert.equal(sent.E, 1);
  assert.deepEqual(sent.DateValidation, { _T: 7, V: "20/11/2026 0:0:0" });
  // 20/11/2026 is a Friday: Pronote's default publication is the next working day.
  assert.deepEqual(sent.DatePublication, { _T: 7, V: "23/11/2026 0:0:0" });
  assert.equal(sent.listeEleves, undefined);
  // Legacy raw identifier: taken as the element of the referential, with a new relation.
  assert.deepEqual(sent.listeCompetences[0], { N: "14#c9", E: 1, coefficient: 1, relationESI: { N: -1002, E: 1 }, ordre: 1 });
  const deleted = buildCompetencyRequest(session(), service as any, undefined, period, evaluation as any, new Map(), students, {
    assessment: "cp:x", service: "s", period: "p", delete: true, dryRun: true,
  });
  assert.equal((deleted.listeEvaluations as any[])[0].E, 3);
  assert.throws(
    () => buildCompetencyRequest(session(), service as any, undefined, period, evaluation as any, new Map(), students, { assessment: "cp:x", service: "s", period: "p", ratings: [{ student: "INCONNU", skill: "x", level: 2 }], dryRun: true }),
    /student_not_found:INCONNU/,
  );
  assert.throws(
    () => buildCompetencyRequest(session(), service as any, undefined, period, evaluation as any, new Map(), students, { assessment: "cp:x", service: "s", period: "p", ratings: [{ student: "ELEVE Un", skill: "cp:inconnue", level: 2 }], dryRun: true }),
    /skill_not_found/,
  );
});

test("planned ratings replace the ones read", () => {
  const merged = mergeRatings(
    [{ student: "ELEVE Un", skill: "cp:a", level: 4, observation: "" }],
    [{ student: "eleve un", skill: "cp:a", level: 2 }, { student: "ELEVE Deux", skill: "cp:a", level: 6, observation: "Privé", published: false }],
  );
  assert.deepEqual(merged, [
    { student: "ELEVE Un", skill: "cp:a", level: 2, observation: "" },
    { student: "ELEVE Deux", skill: "cp:a", level: 6, observation: "" },
  ]);
});
