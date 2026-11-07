import assert from "node:assert/strict";
import { test } from "node:test";
import { commentRequest, generalCells, subjectCells } from "../src/teacher/commentsWrite.js";

/* Synthetic fixtures from the client code (docs/pronote-matrice/4-9-bulletins-divers.md): tabs 25 and 27 are closed
   on the demo server, nothing here is validated against a real answer. */
const page = {
  strInfoCloture: "",
  appreciationClasse: { _T: 24, V: { N: "17#c", G: 1, L: "Classe agréable", editable: true } },
  listeLignes: {
    _T: 24,
    V: [
      { eleve: { _T: 24, V: { N: "46#x1", G: 4, L: "ELEVE Un" } }, appA: { _T: 24, V: { N: "17#a1", G: 1, L: "Bon trimestre", editable: true, cloture: false } } },
      { eleve: { _T: 24, V: { N: "46#x2", G: 4, L: "ELEVE Deux" } }, appA: { _T: 24, V: { N: "0", G: 1, L: "", editable: true, cloture: false } } },
    ],
  },
};
const period = { N: "105#p1", G: 2, L: "Trimestre 1" };

test("cells of the comments grid keep the identifiers needed to write them", () => {
  const read = subjectCells(page);
  assert.equal(read.closed, false);
  assert.deepEqual(read.cells[1], { student: { N: "46#x2", L: "ELEVE Deux" }, appreciation: { N: "0", G: 1, L: "" } });
  assert.deepEqual(read.classCell, { student: null, appreciation: { N: "17#c", G: 1, L: "Classe agréable" } });
  assert.equal(subjectCells({ ...page, strInfoCloture: "Saisie close" }).closed, true);
});

test("general comment cells skip rubric lines and detect a closed entry", () => {
  const read = generalCells({
    listeLignes: { _T: 24, V: [
      { estPere: true, eleve: null, appreciationGle: { _T: 24, V: { L: "Rubrique" } } },
      { eleve: { _T: 24, V: { N: "46#x1", L: "ELEVE Un" } }, appreciationGle: { _T: 24, V: { N: "17#g1", G: 2, L: "Ensemble satisfaisant", cloture: true } } },
    ] },
  });
  assert.equal(read.cells.length, 1);
  assert.equal(read.closed, true);
});

test("SaisieAppreciation requests: subject comment of a student, class comment, general comment", () => {
  const read = subjectCells(page);
  const service = { N: "s1", L: "SVT" };
  assert.deepEqual(commentRequest({ N: "23#k1", G: 1 }, period, service, read.cells[0], "Très bon trimestre", "subject"), {
    classe: { N: "23#k1", G: 1 },
    periode: { N: "105#p1", G: 2 },
    eleve: { N: "46#x1", G: 4 },
    service: { N: "s1" },
    appreciation: { N: "17#a1", G: 1, L: "Très bon trimestre", E: 2 },
    typeGenreAppreciation: 0,
  });
  const classRequest = commentRequest({ N: "23#k1", G: 1 }, period, service, read.classCell!, "Classe dynamique", "subject");
  assert.equal(classRequest.eleve, undefined);
  assert.equal(classRequest.typeGenreAppreciation, 1);
  const general = commentRequest({ N: "23#k1", G: 1 }, period, service, { student: { N: "46#x1", L: "ELEVE Un" }, appreciation: { N: "17#g1", G: 2, L: "" } }, "Bilan positif", "general");
  assert.equal(general.service, undefined);
  assert.equal(general.typeGenreAppreciation, 1);
  assert.deepEqual(general.appreciation, { N: "17#g1", G: 2, L: "Bilan positif", E: 2 });
});
