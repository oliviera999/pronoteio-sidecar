import assert from "node:assert/strict";
import { test } from "node:test";
import { appreciationMember, commentRequest, generalCells, requestShape, subjectCells } from "../src/teacher/commentsWrite.js";

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
  assert.deepEqual(read.cells[1], { student: { N: "46#x2", L: "ELEVE Deux", G: 4 }, appreciation: { N: 0, G: 1, L: "" } });
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
    // 0.16.5: every element carries its libellé, as the web client sends it (ObjetElement.toJSON).
    classe: { N: "23#k1", G: 1 },
    periode: { N: "105#p1", G: 2, L: "Trimestre 1" },
    eleve: { N: "46#x1", G: 4, L: "ELEVE Un" },
    service: { N: "s1", L: "SVT" },
    appreciation: { N: "17#a1", G: 1, L: "Très bon trimestre", E: 2 },
    typeGenreAppreciation: 0,
  });
  const classRequest = commentRequest({ N: "23#k1", G: 1 }, period, service, read.classCell!, "Classe dynamique", "subject");
  // 0.16.6: the class comment sends "eleve": null, as the client (capture, scenario D).
  assert.equal(classRequest.eleve, null);
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
  assert.deepEqual(read.cells[0].classe, { N: "23#601", G: 1, L: "601" });
  const request = commentRequest({ N: "g#603", G: 2 }, period, { N: "s#list" }, read.cells[0], "Bon trimestre", "subject");
  assert.deepEqual(request.classe, { N: "23#601", G: 1, L: "601" });
  assert.deepEqual(request.service, { N: "s#line", L: "SCIENCES ET TECHNOLOGIE" });
  assert.deepEqual(request.eleve, { N: "46#x1", G: 4, L: "ELEVE Un" });
  assert.equal(request.typeGenreAppreciation, 0);
  // The class comment keeps the requested resource (the group) and the chosen service.
  const classRequest = commentRequest({ N: "g#603", G: 2 }, period, { N: "s#list" }, read.classCell!, "Groupe actif", "subject");
  assert.deepEqual(classRequest.classe, { N: "g#603", G: 2 });
  assert.deepEqual(commentRequest({ N: "g#603", G: 2, L: "6-SC-603" }, period, { N: "s#list" }, read.classCell!, "x", "subject").classe, { N: "g#603", G: 2, L: "6-SC-603" });
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
  // 0.16.6: an empty cell is created: negative provisional N and E 1 (capture of 24/11/2026, scenario B1).
  const created = request.appreciation as { N: unknown; G: number; L: string; E: number };
  assert.equal(created.E, 1);
  assert.ok(typeof created.N === "number" && created.N <= -1001);
  assert.equal(created.L, "Bon trimestre");
  assert.equal(created.G, 1);
  assert.deepEqual(request.service, { N: "5#es", L: "ENSEIGNEMENT SCIENTIFIQUE" });
  assert.deepEqual(request.periode, { N: "105#p1", G: 1, L: "Trimestre 1" });
  assert.deepEqual(request.eleve, { N: "46#x1", G: 4, L: "ELEVE Un" });
  const general = generalCells({ listeLignes: { _T: 24, V: [{ eleve: { _T: 24, V: { N: "46#x1", G: 4, L: "ELEVE Un" } },
    appreciationGle: { _T: 24, V: { N: "0", G: 2, titre: "Appréciation globale", appreciation: "", editable: true, cloture: false } } }] } });
  const generalRequest = commentRequest({ N: "23#k1", G: 1 }, period, null, general.cells[0], "Bilan positif", "general");
  // 0.16.6: an empty general comment is created with N 0 (number) and E 1 (capture, scenario C2a).
  assert.deepEqual(generalRequest.appreciation, { N: 0, G: 2, L: "Bilan positif", E: 1 });
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

test("0.16.5: the shape of a request names members and genres, never a value", () => {
  const shape = requestShape({
    classe: { N: "23#k1", G: 1, L: "T11" }, periode: { N: "105#p1", G: 2, L: "Trimestre 1" },
    eleve: { N: "46#x1", G: 4, L: "ELEVE Un" }, service: { N: "s1", L: "SVT" },
    appreciation: { G: 1, L: "Texte privé", E: 2 }, typeGenreAppreciation: 0,
  });
  assert.equal(shape, "appreciation{E=2,G=1,L}|classe{G=1,L,N}|eleve{G=4,L,N}|periode{G=2,L,N}|service{L,N}|typeGenreAppreciation=0");
  assert.doesNotMatch(shape, /ELEVE|Texte|T11|23#/);
});

test("0.16.6: creation, modification and clearing of an appreciation, as captured from the web client", () => {
  // Creation of an empty subject comment: negative N, decreasing, E 1.
  const first = appreciationMember(null, 1, "Essai");
  const second = appreciationMember(null, 9, "Classe");
  assert.equal(first.E, 1);
  assert.equal(second.E, 1);
  assert.ok((second.N as number) < (first.N as number));
  assert.equal(second.G, 9);
  // Empty general comment ("0" in the grid, 0 once read): created with the number 0.
  assert.deepEqual(appreciationMember(0, 3, "Bilan"), { N: 0, G: 3, L: "Bilan", E: 1 });
  // Existing comment: modified with its N, E 2.
  assert.deepEqual(appreciationMember("10#abc", 1, "Essai 2"), { N: "10#abc", G: 1, L: "Essai 2", E: 2 });
  // Clearing: E 2 and no L at all (not an empty L).
  assert.deepEqual(appreciationMember("10#abc", 1, ""), { N: "10#abc", G: 1, E: 2 });
});
