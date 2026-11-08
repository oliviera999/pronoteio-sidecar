import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionHandle } from "pawnote";
import { rememberUserData } from "../src/pronote/userdata.js";
import { commentsFromPage, generalFromPage, maxLengthOf } from "../src/teacher/comments.js";

/* Synthetic fixtures from the client code (docs/pronote-matrice/4-9-bulletins-divers.md): tabs 25 and 27 are
   closed on the demo server, nothing here is validated against a real answer. */
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

test("comments grid of PageApprBulletin: one line per student, class comment, not closed", () => {
  const read = commentsFromPage(page);
  assert.equal(read.closed, false);
  assert.equal(read.classComment, "Classe agréable");
  assert.deepEqual(read.students, [
    { student: "ELEVE Un", comment: "Bon trimestre" },
    { student: "ELEVE Deux", comment: "" },
  ]);
  assert.equal(commentsFromPage({ ...page, strInfoCloture: "Saisie close le 10/12" }).closed, true);
});

test("general comments of the main teacher are mapped by student, rubric lines skipped", () => {
  const general = generalFromPage({
    listeLignes: { _T: 24, V: [
      { estPere: true, eleve: null, appreciationGle: { _T: 24, V: { L: "Rubrique" } } },
      { eleve: { _T: 24, V: { L: "ELEVE Un" } }, appreciationGle: { _T: 24, V: { L: "Ensemble satisfaisant", editable: true } } },
    ] },
  });
  assert.equal(general.get("ELEVE Un"), "Ensemble satisfaisant");
  assert.equal(general.has("Rubrique"), false);
});

test("maximum comment length from the login data", () => {
  const session = { information: { id: "s2" } } as unknown as SessionHandle;
  assert.equal(maxLengthOf(session), null);
  rememberUserData(session, { maxCommentLength: { _T: 24, V: [255, 500] } });
  assert.equal(maxLengthOf(session), 255);
  rememberUserData(session, { maxCommentLength: [0] });
  assert.equal(maxLengthOf(session), null, "0 means no limit");
});
