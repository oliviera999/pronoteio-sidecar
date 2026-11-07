import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionHandle } from "pawnote";
import { ServerSideError } from "pawnote";
import { rememberUserData } from "../src/pronote/userdata.js";
import { DEFAULT_LEVELS, isAccessDenied, itemFromList, levelsOf, ratingsFromPage } from "../src/teacher/competencies.js";

/* Synthetic fixtures built from the client code (docs/pronote-matrice/2-3-notes-competences.md): not validated on
   the demo server, whose profile does not open the skills tabs. */
const evaluation = {
  N: "13#e1",
  L: "Évaluation TP respiration",
  dateValidation: { _T: 7, V: "12/11/2026" },
  datePublication: { _T: 7, V: "13/11/2026" },
  listeCompetences: {
    _T: 24,
    V: [
      { N: "14#c1", L: "Pratiquer une démarche scientifique", relationESI: { _T: 24, V: { N: "15#r1" } }, pilier: { _T: 24, V: { L: "D4" } } },
      { N: "14#c2", L: "Communiquer", relationESI: { _T: 24, V: { N: "15#r2" } }, pilier: { _T: 24, V: { L: "D1" } } },
    ],
  },
};

const page = {
  ListeElevesCompetences: {
    _T: 24,
    V: [
      {
        L: "ELEVE Un",
        N: "46#x1",
        ListeCompetences: { _T: 24, V: [
          { N: "15#r1", NiveauDAcquisition: { _T: 24, V: { N: "16#n2", G: 2, L: "Acquis" } }, Observation: "Bien", ObservationPubliee: true },
          { N: "15#r2", NiveauDAcquisition: { _T: 24, V: { N: "16#n8", G: 8, L: "Non évalué" } }, Observation: "privé", ObservationPubliee: false },
        ] },
      },
    ],
  },
};

test("an assessment of ListeEvaluations is normalised with stable skill ids", () => {
  const { item, skillIds } = itemFromList(evaluation as any, "SVT", "1G3", "class");
  assert.equal(item.title, "Évaluation TP respiration");
  assert.equal(item.subject, "SVT");
  assert.equal(item.skills.length, 2);
  assert.equal(item.skills[0].domain, "D4");
  assert.equal(skillIds.get("15#r1"), item.skills[0].id);
  assert.notEqual(item.publication, null);
  assert.ok(item.id.startsWith("cp:"));
});

test("levels given in PageCompetencesParEvaluation, observations only when published", () => {
  const { skillIds } = itemFromList(evaluation as any, "SVT", "1G3", "class");
  const ratings = ratingsFromPage(page, skillIds);
  assert.equal(ratings.length, 2);
  assert.equal(ratings[0].student, "ELEVE Un");
  assert.equal(ratings[0].level, 2);
  assert.equal(ratings[0].observation, "Bien");
  assert.equal(ratings[1].level, 8);
  assert.equal(ratings[1].observation, "", "unpublished observation is not returned");
});

test("levels come from the school list captured at login, else the client enumeration", () => {
  const session = { information: { id: "s" } } as unknown as SessionHandle;
  assert.deepEqual(levelsOf(session), DEFAULT_LEVELS);
  rememberUserData(session, { acquisitionLevels: [{ N: "16#n1", G: 2, L: "Maîtrise satisfaisante" }] });
  assert.deepEqual(levelsOf(session), [{ code: 2, name: "Maîtrise satisfaisante" }]);
  assert.equal(isAccessDenied(new ServerSideError("Vos droits sont insuffisants pour effectuer cette opération.")), true);
  assert.equal(isAccessDenied(new Error("boom")), false);
});
