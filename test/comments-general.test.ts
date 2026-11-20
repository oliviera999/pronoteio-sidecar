import assert from "node:assert/strict";
import { test } from "node:test";
import { rememberUserData } from "../src/pronote/userdata.js";
import { kindsFromAnswer, mainKind, reportComments } from "../src/teacher/comments.js";
import { fakeSession, type FakeCall } from "./fake-session.js";

/*
 * General comments of the main teacher (0.12.0). Case of 20/11/2026: the main teacher of T06 got the comments of his
 * own service but no general comment, without any reason: only a kind named "globale" (or of genre 0) was read, and
 * every failure was silent. Synthetic answers from the client code (docs/pronote-matrice/4-9-bulletins-divers.md in
 * mood_prod), generated names; NOT VALIDATED on a real server.
 */
const period = { N: "1#t1", L: "Trimestre 1", G: 2 };
const subject = (label: string) => ({ _T: 24, V: { N: `9#${label}`, L: label } });
const cls = (n: string, label: string) => ({ _T: 24, V: { N: n, L: label, G: 1 } });
const student = (label: string) => ({ _T: 24, V: { N: `46#${label}`, G: 4, L: label } });
const app = (label: string) => ({ _T: 24, V: { N: "17#a", G: 1, L: label, editable: true, cloture: false } });

/** Kinds as a school may name them: no "globale", a rubric with children, a CPE comment. */
const kinds = { listeAppreciations: { _T: 24, V: [
  { N: "50#r1", G: 1, L: "Conseil de classe", estUneRubrique: true },
  { N: "50#k2", G: 2, L: "Appréciation générale" },
  { N: "50#k3", G: 6, L: "Appréciation CPE" },
] } };

const generalPage = (data: Record<string, any> | undefined) => ({ listeLignes: { _T: 24, V: [
  { estPere: true, eleve: null, appreciationGle: { _T: 24, V: { L: "Rubrique" } } },
  { eleve: student("ELEVE Un"), appreciationGle: { _T: 24, V: { L: data?.appreciation?.N === "50#k2" ? "Trimestre satisfaisant" : "Assidue", editable: true } } },
  { eleve: student("ELEVE Deux"), appreciationGle: { _T: 24, V: { L: data?.appreciation?.N === "50#k2" ? "" : "Deux retards" } } },
] } });

const servicePage = { strInfoCloture: "", appreciationClasse: app("Classe agréable"), listeLignes: { _T: 24, V: [
  { eleve: student("ELEVE Un"), appA: app("Bon trimestre") },
  { eleve: student("ELEVE Deux"), appA: app("") },
] } };

const session = (principal: boolean, extra: Record<string, (data: any, call: FakeCall) => any> = {}, teaches = true) => {
  const fake = fakeSession({
    ListePeriodes: () => ({ listePeriodes: { _T: 24, V: [period] }, periodeParDefaut: { _T: 24, V: period } }),
    ListeServices: () => ({ services: { _T: 24, V: teaches ? [{ N: "5#es", matiere: subject("ENSEIGNEMENT SCIENTIFIQUE"), classe: cls("2#t06", "T06") }] : [] } }),
    PageApprBulletin: () => servicePage,
    ListeAppreciations: () => kinds,
    PageAppreciationsGenerales: generalPage,
    ...extra,
  });
  rememberUserData(fake, { resources: [{ id: "2#t06", label: "T06", genre: 1 as const, taught: teaches, principal }], tabs: [23, 25, 27] });
  return fake;
};

test("every kind that is not a rubric is read, whatever its name", async () => {
  const fake = session(true);
  const result = await reportComments(fake, "c:T06", "p:Trimestre 1");
  assert.equal(result.available, true);
  assert.deepEqual(result.general, { available: true, reason: "", kind: "Appréciation générale", kinds: [
    { name: "Conseil de classe", rubric: true }, { name: "Appréciation générale", rubric: false }, { name: "Appréciation CPE", rubric: false }],
    source: "kinds", variant: "ressource+periode" });
  assert.deepEqual(result.students, [
    { student: "ELEVE Un", comment: "Bon trimestre", general: "Trimestre satisfaisant",
      generals: [{ kind: "Appréciation générale", text: "Trimestre satisfaisant" }, { kind: "Appréciation CPE", text: "Assidue" }] },
    { student: "ELEVE Deux", comment: "", general: "", generals: [{ kind: "Appréciation CPE", text: "Deux retards" }] },
  ]);
  // The rubric is not asked; each kind is asked with its own element.
  const asked = fake.calls.filter((call) => call.name === "PageAppreciationsGenerales");
  assert.deepEqual(asked.map((call) => call.data?.appreciation?.N), ["50#k2", "50#k3"]);
  assert.equal(asked[0].data?.estUneRubrique, false);
  assert.equal(asked[0].onglet, 27);
  assert.equal(result.classComment, "Classe agréable");
  assert.equal(result.service?.name, "ENSEIGNEMENT SCIENTIFIQUE - T06");
});

test("an account that is not main teacher: its own comments, and the reason for no general comment", async () => {
  const fake = session(false);
  const result = await reportComments(fake, "c:T06", "p:Trimestre 1");
  assert.equal(result.available, true);
  assert.deepEqual(result.general, { available: false, reason: "not_principal", kind: "", kinds: [] });
  assert.deepEqual(result.students[0], { student: "ELEVE Un", comment: "Bon trimestre", general: null, generals: [] });
  assert.equal(fake.calls.some((call) => call.name === "ListeAppreciations" || call.name === "PageAppreciationsGenerales"), false);
});

test("a main teacher without service in the class still reads the general comments", async () => {
  const fake = session(true, {}, false);
  const result = await reportComments(fake, "c:T06", "p:Trimestre 1");
  assert.equal(result.available, true);
  assert.equal(result.service, null);
  assert.equal(result.general.available, true);
  assert.deepEqual(result.students.map((item) => [item.student, item.comment, item.general]),
    [["ELEVE Un", null, "Trimestre satisfaisant"], ["ELEVE Deux", null, ""]]);
  assert.equal(fake.calls.some((call) => call.name === "PageApprBulletin"), false);
  // Without service and without being main teacher: not found, as before.
  await assert.rejects(reportComments(session(false, {}, false), "c:T06", "p:Trimestre 1"), /service_not_found/);
});

test("nothing is silent any more: refusal, no kind, unknown shape", async () => {
  const denied = { Erreur: { Titre: "Vos droits sont insuffisants pour effectuer cette opération." } };
  const refused = await reportComments(session(true, { ListeAppreciations: () => denied }), "c:T06", "p:Trimestre 1");
  assert.equal(refused.available, true, "the comments of the service are still returned");
  assert.equal(refused.general.reason, "access_denied");
  assert.equal(refused.students[0].comment, "Bon trimestre");

  const pagesRefused = await reportComments(session(true, { PageAppreciationsGenerales: () => denied }), "c:T06", "p:Trimestre 1");
  assert.equal(pagesRefused.general.available, false);
  assert.equal(pagesRefused.general.reason, "access_denied");
  assert.equal(pagesRefused.general.kinds.length, 3, "the kinds are listed even when their pages are refused");

  const rubricsOnly = await reportComments(session(true, { ListeAppreciations: () => ({ listeAppreciations: { _T: 24, V: [
    { N: "50#r1", L: "Conseil de classe", estUneRubrique: true }] } }) }), "c:T06", "p:Trimestre 1");
  assert.equal(rubricsOnly.general.reason, "no_kind");

  const unknownKinds = await reportComments(session(true, { ListeAppreciations: () => ({ rubriques: [{ nom: "Secret" }] }) }), "c:T06", "p:Trimestre 1");
  assert.equal(unknownKinds.general.reason, "format_unknown");
  assert.deepEqual(unknownKinds.general.shape, ["rubriques: list[1]", "rubriques[]: object", "rubriques[].nom: string"]);
  assert.equal(JSON.stringify(unknownKinds.general).includes("Secret"), false);

  const unknownPage = await reportComments(session(true, { PageAppreciationsGenerales: () => ({ grille: { eleves: [] } }) }), "c:T06", "p:Trimestre 1");
  assert.equal(unknownPage.general.reason, "format_unknown");
  assert.deepEqual(unknownPage.general.shape, ["grille: object", "grille.eleves: list[0]"]);

  // Neither the service page nor the general comments: the refusal is relayed.
  const nothing = await reportComments(session(true, { PageApprBulletin: () => denied, ListeAppreciations: () => denied }), "c:T06", "p:Trimestre 1");
  assert.equal(nothing.available, false);
  assert.equal(nothing.reason, "access_denied");
});

test("kinds: other member names and flags, and the kind shown first", () => {
  const read = kindsFromAnswer({ ListeAppreciations: [{ L: "Vie scolaire", estPere: true }, { L: "Appréciation globale" }] });
  assert.deepEqual(read.map(({ name, rubric }) => [name, rubric]), [["Vie scolaire", true], ["Appréciation globale", false]]);
  assert.equal(mainKind(["Appréciation CPE", "Appréciation globale"]), "Appréciation globale");
  assert.equal(mainKind(["Assiduité", "Autonomie"]), "Assiduité");
  assert.equal(mainKind([]), "");
});
