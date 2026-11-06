import assert from "node:assert/strict";
import { test } from "node:test";
import { tabsOf } from "../src/pronote/userdata.js";
import { reportFromAnswer, reportNumber, reportStatus } from "../src/teacher/reports.js";

const student = { id: "e:DUPONT Léa", label: "DUPONT Léa" };

/**
 * Anonymised shape of a PageBulletins answer, as decoded by the client (objetrequetepagebulletins.js,
 * utilitairedeserialiserpiedbulletin.js) and by Pawnote's gradebook().
 */
const answer = {
  Editable: false,
  ListeServices: {
    _T: 24,
    V: [
      {
        L: "FRANCAIS",
        N: "13#s1",
        Matiere: { _T: 24, V: { L: "FRANCAIS", N: "21#m1" } },
        SurMatiere: { _T: 24, V: { L: "", N: "0" } },
        Coefficient: { _T: 10, V: "3" },
        MoyenneEleve: { _T: 10, V: "12,50" },
        MoyenneClasse: { _T: 10, V: "11,20" },
        MoyenneInf: { _T: 10, V: "6,00" },
        MoyenneSup: { _T: 10, V: "17,25" },
        ListeAppreciations: { _T: 24, V: [{ L: "Bon trimestre.", N: "0", G: 1 }] },
        ListeElements: { _T: 24, V: [{ ListeProfesseurs: { _T: 24, V: [{ L: "M. MARTIN P.", N: "109#p1" }] } }] },
      },
      {
        L: "EPS",
        N: "13#s2",
        Matiere: { _T: 24, V: { L: "ED.PHYSIQUE & SPORT.", N: "21#m2" } },
        Coefficient: { _T: 10, V: "1" },
        MoyenneEleve: { _T: 10, V: "|2" },
        MoyenneClasse: { _T: 10, V: "14,00" },
        ListeAppreciations: { _T: 24, V: [] },
        ListeProfesseurs: { _T: 24, V: [{ L: "Mme DURAND C.", N: "109#p2" }] },
      },
    ],
  },
  General: { _T: 24, V: { MoyenneEleve: { _T: 10, V: "13,02" }, MoyenneClasse: { _T: 10, V: "12,10" } } },
  ObjetListeAppreciations: {
    _T: 24,
    V: {
      Editable: false,
      ListeAppreciations: {
        _T: 24,
        V: [
          { L: "Ensemble satisfaisant.", N: "1", G: 0, Intitule: "Appréciation générale" },
          { L: "Félicitations", N: "2", G: 8, Intitule: "Mention" },
          { L: "", N: "3", G: 7, Intitule: "Vie scolaire" },
        ],
      },
    },
  },
  ListeAbsences: { strAbsences: "2 demi-journées dont 1 non justifiée", strRetards: "1 retard", strPunitions: "", strSanctions: "" },
};

test("reads the subjects, averages and teachers of a report card", () => {
  const report = reportFromAnswer(answer, student, "Trimestre 1");
  assert.equal(report.studentid, "e:DUPONT Léa");
  assert.equal(report.lastname, "DUPONT");
  assert.equal(report.firstname, "Léa");
  assert.equal(report.period, "Trimestre 1");
  assert.equal(report.average, 13.02);
  assert.equal(report.classAverage, 12.1);
  assert.equal(report.message, "");

  const [french, sport] = report.subjects;
  assert.deepEqual(french, {
    subject: "FRANCAIS",
    teachers: ["M. MARTIN P."],
    coefficient: 3,
    average: 12.5,
    classAverage: 11.2,
    min: 6,
    max: 17.25,
    status: "",
    comments: ["Bon trimestre."],
  });
  assert.equal(sport.subject, "ED.PHYSIQUE & SPORT.");
  assert.equal(sport.average, null);
  assert.equal(sport.status, "Disp");
  assert.deepEqual(sport.teachers, ["Mme DURAND C."]);
});

test("reads the general comments and the attendance footer", () => {
  const report = reportFromAnswer(answer, student, "Trimestre 1");
  assert.deepEqual(report.comments, [
    { kind: "general", title: "Appréciation générale", text: "Ensemble satisfaisant." },
    { kind: "council", title: "Mention", text: "Félicitations" },
  ]);
  assert.deepEqual(report.attendance, {
    absences: "2 demi-journées dont 1 non justifiée",
    lates: "1 retard",
    punishments: "",
    sanctions: "",
  });
});

test("keeps the message of a report card that cannot be shown", () => {
  const report = reportFromAnswer({ Editable: false, Message: "Le bulletin sera publié à partir du 22/11/26." }, student, "Trimestre 1");
  assert.equal(report.message, "Le bulletin sera publié à partir du 22/11/26.");
  assert.deepEqual(report.subjects, []);
  assert.equal(report.average, null);
});

test("converts Pronote cells", () => {
  assert.equal(reportNumber("12,5"), 12.5);
  assert.equal(reportNumber({ _T: 10, V: " 9,75 " }), 9.75);
  assert.equal(reportNumber("|1"), null);
  assert.equal(reportNumber(""), null);
  assert.equal(reportNumber(undefined), null);
  assert.equal(reportStatus("|1"), "Abs");
  assert.equal(reportStatus("|9"), "9");
  assert.equal(reportStatus("12"), "");
});

test("flattens the tabs of the account", () => {
  const tabs = tabsOf([{ G: 7 }, { G: 3, Onglet: [{ G: 23 }, { G: 227 }] }, { G: 4, Onglet: [{ G: 13 }] }]);
  assert.deepEqual(tabs, [7, 3, 23, 227, 4, 13]);
  assert.deepEqual(tabsOf(undefined), []);
});
