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
  assert.deepEqual(read.cells[1], { student: { N: "46#x2", L: "ELEVE Deux" }, appreciation: { N: 0, G: 1, L: "" } });
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
  // 0.16.1: the class comment of a service is a teacher's comment (GA_Bulletin_Professeur), as the client sends it.
  assert.equal(classRequest.typeGenreAppreciation, 0);
  const general = commentRequest({ N: "23#k1", G: 1 }, period, service, { student: { N: "46#x1", L: "ELEVE Un" }, appreciation: { N: "17#g1", G: 2, L: "" } }, "Bilan positif", "general");
  assert.equal(general.service, undefined);
  assert.equal(general.typeGenreAppreciation, 1);
  assert.deepEqual(general.appreciation, { N: "17#g1", G: 2, L: "Bilan positif", E: 2 });
});

/* 0.16.1: 6e groups (skills only), lines carrying the student's class and the line's service (client:
   _getInfoClasseEleve), comment of the teacher in another column than appA. */
test("a comment of a group line is sent with the student's own class and the line's service", () => {
  const grid = {
    listeLignes: { _T: 24, V: [
      {
        eleve: { _T: 24, V: { N: "46#x1", G: 4, L: "ELEVE Un" } },
        classe: { _T: 24, V: { N: "23#601", G: 1, L: "601" } },
        service: { _T: 24, V: { N: "s#line", L: "SCIENCES ET TECHNOLOGIE" } },
        appA: { _T: 24, V: { N: "0", G: 1, L: "", editable: true } },
      },
    ] },
    appreciationClasse: { _T: 24, V: { N: "0", G: 1, L: "" } },
  };
  const read = subjectCells(grid);
  assert.deepEqual(read.cells[0].classe, { N: "23#601", G: 1 });
  const request = commentRequest({ N: "g#603", G: 2 }, period, { N: "s#list" }, read.cells[0], "Bon trimestre", "subject");
  assert.deepEqual(request.classe, { N: "23#601", G: 1 });
  assert.deepEqual(request.service, { N: "s#line" });
  assert.equal(request.typeGenreAppreciation, 0);
  // The class comment keeps the requested resource (the group) and the chosen service.
  const classRequest = commentRequest({ N: "g#603", G: 2 }, period, { N: "s#list" }, read.classCell!, "Groupe actif", "subject");
  assert.deepEqual(classRequest.classe, { N: "g#603", G: 2 });
  assert.deepEqual(classRequest.service, { N: "s#list" });
});

test("the teacher's comment is the first column not marked read-only", () => {
  const read = subjectCells({ listeLignes: { _T: 24, V: [{
    eleve: { _T: 24, V: { N: "46#x1", G: 4, L: "ELEVE Un" } },
    appA: { _T: 24, V: { N: "17#a", G: 1, L: "Autre enseignant", editable: false } },
    appB: { _T: 24, V: { N: "0", G: 2, L: "", editable: true } },
  }] } });
  assert.deepEqual(read.cells[0].appreciation, { N: 0, G: 2, L: "" });
});

/* 0.16.1, real grid of PageApprBulletin (T06, 23/11/2026): an empty cell is { G, estEditable } without N, the class
   comment is { G, titre, appreciation, editable, cloture, estParamAppVisible }. The write of "0" as a string was
   ignored by Pronote: the client leaves an absent N out and sends "0" back as the number 0. */
test("real grid: no N sent for an empty cell, class comment read from 'appreciation', general N 0 as a number", () => {
  const grid = {
    listeLignes: { _T: 24, V: [{
      estService: false, estPere: false,
      service: { _T: 24, V: { L: "ENSEIGNEMENT SCIENTIFIQUE", N: "5#es" } },
      eleve: { _T: 24, V: { L: "ELEVE Un", N: "46#x1", G: 4, P: 1, avecPhoto: true } },
      appA: { _T: 24, V: { G: 1, estEditable: true } },
    }] },
    appreciationClasse: { _T: 24, V: { G: 1, titre: "Appréciation", appreciation: "Groupe sérieux", editable: true, cloture: false, estParamAppVisible: false } },
  };
  const read = subjectCells(grid);
  assert.deepEqual(read.cells[0].appreciation, { N: null, G: 1, L: "" });
  assert.equal(read.classCell!.appreciation.L, "Groupe sérieux");
  const request = commentRequest({ N: "23#k1", G: 1 }, { N: "105#p1", G: 1, L: "Trimestre 1" }, { N: "5#list" }, read.cells[0], "Bon trimestre", "subject");
  assert.deepEqual(request.appreciation, { G: 1, L: "Bon trimestre", E: 2 });
  assert.deepEqual(request.service, { N: "5#es" });
  assert.deepEqual(request.periode, { N: "105#p1", G: 1 });
  const general = generalCells({ listeLignes: { _T: 24, V: [{ eleve: { _T: 24, V: { N: "46#x1", G: 4, L: "ELEVE Un" } },
    appreciationGle: { _T: 24, V: { N: "0", G: 2, titre: "Appréciation globale", appreciation: "", editable: true, cloture: false } } }] } });
  const generalRequest = commentRequest({ N: "23#k1", G: 1 }, period, null, general.cells[0], "Bilan positif", "general");
  assert.deepEqual(generalRequest.appreciation, { N: 0, G: 2, L: "Bilan positif", E: 2 });
});

test("0.16.2: read-only cells are marked (estEditable / editable false)", () => {
  const read = subjectCells({
    listeLignes: { _T: 24, V: [{ eleve: { _T: 24, V: { N: "46#x1", G: 4, L: "ELEVE Un" } }, appA: { _T: 24, V: { G: 1, estEditable: false } } }] },
    appreciationClasse: { _T: 24, V: { G: 1, appreciation: "", editable: false, cloture: false } },
  });
  assert.equal(read.cells[0].editable, false);
  assert.equal(read.classCell!.editable, false);
  const general = generalCells({ listeLignes: { _T: 24, V: [{ eleve: { _T: 24, V: { N: "46#x1", L: "ELEVE Un" } },
    appreciationGle: { _T: 24, V: { N: "0", G: 2, appreciation: "", editable: true } } }] } });
  assert.equal(general.cells[0].editable, undefined);
});
