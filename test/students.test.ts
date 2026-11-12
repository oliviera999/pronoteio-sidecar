import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { rememberUserData } from "../src/pronote/userdata.js";
import { parseInclude } from "../src/routes/students.js";
import { edtResources, resourceTimetable } from "../src/teacher/resourceTimetable.js";
import { roster } from "../src/teacher/roster.js";
import { checkStudentFiles, imageRightsOf, MAX_SHAPE, sexCode, sexOf, shapeOf, studentFiles } from "../src/teacher/students.js";
import { fakeSession } from "./fake-session.js";

const file = JSON.parse(readFileSync(new URL("./fixtures/student-file.json", import.meta.url), "utf8"));
const wrapped = JSON.parse(readFileSync(new URL("./fixtures/student-file-wrapped.json", import.meta.url), "utf8"));
const edt = JSON.parse(readFileSync(new URL("./fixtures/resources-edt.json", import.meta.url), "utf8"));
const page = JSON.parse(readFileSync(new URL("./fixtures/timetable-page.json", import.meta.url), "utf8"));

const classT06 = { id: "1#c1", label: "T06", genre: 1 as const, taught: true, principal: false };

const filesSession = () => {
  const session = fakeSession({
    ListeEleves: () => ({ listeEleves: { _T: 24, V: [{ N: "4#e1", L: "MARTIN Léa", G: 4 }, { N: "4#e2", L: "PETIT Hugo", G: 4 }] } }),
    FicheEleve: (data) => (data?.Eleve?.N === "4#e1" ? file : { Eleve: { N: "4#e2", L: "PETIT Hugo", Sexe: "M" } }),
  });
  rememberUserData(session, { resources: [classT06], tabs: [105, 16] });
  return session;
};

test("identity only: no image rights, guardians, health nor photo", async () => {
  const session = filesSession();
  const result = await studentFiles(session, "c:T06", []);
  assert.equal(result.available, true);
  assert.equal(result.validated, false);
  assert.equal(result.items.length, 2);
  const lea = result.items[0];
  assert.equal(lea.lastname, "MARTIN");
  assert.equal(lea.firstname, "Léa Anne");
  assert.equal(lea.sex, "F");
  assert.equal(lea.birthdate, Math.floor(new Date(2010, 2, 14).getTime() / 1000));
  assert.equal(lea.number, "E000123");
  assert.equal(lea.email, "lea.martin@pedagolyautey.org");
  assert.equal(lea.class, "T06");
  assert.deepEqual(lea.groups, ["T-SPE SVT 2", "T-EMC 3"]);
  assert.deepEqual(lea.options, ["Latin"]);
  assert.equal(lea.regime, "Demi-pensionnaire");
  for (const key of ["imageRights", "guardians", "health", "photo"]) assert.equal(key in lea, false, key);
  const json = JSON.stringify(result);
  assert.equal(json.includes("Allergie"), false);
  assert.equal(json.includes("Mémo"), false);
  assert.equal(json.includes("valeur à ne pas renvoyer"), false);
  // Keys only: unknown members are named so that the mapping can be checked, health and memos never.
  assert.deepEqual(result.unmappedKeys, ["L", "champInconnu"]);
  assert.equal(session.calls.filter((call) => call.name === "FicheEleve")[0].data?.AvecResponsables, false);
});

test("image rights, guardians, health and photo only on request", async () => {
  const session = filesSession();
  const result = await studentFiles(session, "c:T06", ["imagerights", "guardians", "health", "photo"], "e:MARTIN Léa");
  assert.equal(result.items.length, 1);
  const lea = result.items[0];
  assert.equal(lea.imageRights, "refused");
  assert.equal(lea.guardians?.length, 2);
  assert.deepEqual(lea.guardians?.[0], { name: "MARTIN Paul", relation: "Père", legal: true, phones: ["0600000001"],
    email: "parent.fictif@example.org", address: "1 rue Fictive 20000 Casablanca", preferences: ["accepteSMS"] });
  assert.equal(lea.guardians?.[1].legal, false);
  assert.deepEqual(lea.health, { plans: ["PAI"], medical: ["Allergie fictive"] });
  assert.deepEqual(lea.photo, { exists: true });
  assert.equal(JSON.stringify(result).includes("Mémo"), false);
  assert.equal(session.calls.filter((call) => call.name === "FicheEleve")[0].data?.AvecResponsables, true);
});

test("a page of files reads only its students (one FicheEleve call each), with the roster total", async () => {
  const session = filesSession();
  const page = await studentFiles(session, "c:T06", [], "", { offset: 1, limit: 1 });
  assert.equal(page.available, true);
  assert.equal(page.total, 2);
  assert.equal(page.offset, 1);
  assert.deepEqual(page.items.map((item) => item.lastname), ["PETIT"]);
  assert.equal(page.truncated, false);
  assert.equal(session.calls.filter((call) => call.name === "FicheEleve").length, 1);
  const beyond = await studentFiles(filesSession(), "c:T06", [], "", { offset: 5, limit: 3 });
  assert.equal(beyond.items.length, 0);
  assert.equal(beyond.total, 2);
});

test("student files check: roster and ONE FicheEleve call, counts only, never a value", async () => {
  const session = filesSession();
  const check = await checkStudentFiles(session, "c:T06");
  assert.equal(check.available, true);
  assert.equal(check.students, 2);
  assert.equal(check.read, 1);
  assert.ok(check.mappedKeys >= 5);
  assert.equal(session.calls.filter((call) => call.name === "FicheEleve").length, 1);
  const json = JSON.stringify(check);
  for (const value of ["MARTIN", "Léa", "E000123", "pedagolyautey"]) assert.equal(json.includes(value), false, value);
  const closed = filesSession();
  rememberUserData(closed, { resources: [classT06], tabs: [16] });
  assert.equal((await checkStudentFiles(closed, "c:T06")).reason, "tab_closed:105");
  const refused = fakeSession({
    ListeEleves: () => ({ listeEleves: { _T: 24, V: [{ N: "4#e1", L: "MARTIN Léa", G: 4 }] } }),
  });
  rememberUserData(refused, { resources: [classT06], tabs: [105] });
  const failed = await checkStudentFiles(refused, "c:T06");
  assert.equal(failed.available, false);
  assert.match(failed.reason, /droits sont insuffisants/);
});

test("image rights unknown when Pronote gives nothing, and the labelled forms", () => {
  assert.equal(imageRightsOf({ Nom: "X" }, new Set()), "unknown");
  assert.equal(imageRightsOf({ accordDroitImage: { L: "Autorisé" } }, new Set()), "authorized");
  assert.equal(imageRightsOf({ autorisationPhoto: "Non" }, new Set()), "refused");
  assert.equal(sexOf("Masculin"), "M");
  assert.equal(sexOf({ L: "F" }), "F");
  assert.equal(sexOf(""), "");
});

test("a closed tab or a refusal of Pronote is relayed, never bypassed", async () => {
  const closed = filesSession();
  rememberUserData(closed, { resources: [classT06], tabs: [16] });
  assert.deepEqual((await studentFiles(closed, "c:T06", [])).reason, "tab_closed:105");
  const refused = fakeSession({ ListeEleves: () => ({ listeEleves: { _T: 24, V: [{ N: "4#e1", L: "MARTIN Léa" }] } }) });
  rememberUserData(refused, { resources: [classT06], tabs: [105] });
  const result = await studentFiles(refused, "c:T06", []);
  assert.equal(result.available, false);
  assert.match(result.reason, /droits sont insuffisants/);
  assert.deepEqual(parseInclude("imagerights,guardians"), ["imagerights", "guardians"]);
  assert.throws(() => parseInclude("memos"), /invalid_include:memos/);
});

test("teachers and rooms of RessourceEDT, timetable of a room week by week", async () => {
  assert.deepEqual(edtResources(edt, 17).map((item) => item.L), ["Amphi", "207", "Labo SVT 1"]);
  const withTeacher = { listeRessources: { _T: 24, V: [{ L: "Professeurs", G: 3, liste: { _T: 24, V: [{ L: "DUPONT Ana", N: "3#t1", G: 3 }] } }] } };
  assert.deepEqual(edtResources(withTeacher, 3), [{ N: "3#t1", G: 3, L: "DUPONT Ana" }]);

  const session = fakeSession({ RessourceEDT: () => edt, PageEmploiDuTemps: () => page });
  (session.instance as any).firstMonday = new Date(2026, 8, 7);
  rememberUserData(session, { resources: [classT06], tabs: [16] });
  const result = await resourceTimetable(session, "room", "207", new Date(2026, 10, 9), new Date(2026, 10, 16));
  assert.equal(result.available, true);
  assert.deepEqual(result.resource, { kind: "room", label: "207" });
  assert.ok(result.items.length > 0);
  const call = session.calls.find((item) => item.name === "PageEmploiDuTemps");
  assert.deepEqual(call?.data?.Ressource, { N: "129#r1", G: 17, L: "207" });
  assert.equal("hasNotebook" in result.items[0], false);
  await assert.rejects(resourceTimetable(session, "room", "Inconnue", new Date(2026, 10, 9), new Date(2026, 10, 16)), /room_not_found/);
});

test("photo of one student: picture type checked, absence and size relayed", async () => {
  const { imageType, studentPhoto } = await import("../src/teacher/photos.js");
  const session = filesSession();
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  const urls: string[] = [];
  const photo = await studentPhoto(session, "c:T06", "e:MARTIN Léa", async (url) => {
    urls.push(url);
    return { contentType: "image/jpeg", bytes: jpeg };
  });
  assert.equal(photo.available, true);
  assert.equal(photo.mime, "image/jpeg");
  assert.equal(photo.base64, jpeg.toString("base64"));
  assert.match(urls[0], /\/FichiersExternes\/.+\/photo\.jpg\?Session=/);
  const none = await studentPhoto(session, "c:T06", "e:MARTIN Léa", async () => ({ contentType: "text/html", bytes: Buffer.from("<html>") }));
  assert.deepEqual([none.available, none.reason, none.base64], [false, "no_photo", ""]);
  await assert.rejects(studentPhoto(session, "c:T06", "e:INCONNU Max", async () => null), /student_not_found/);
  assert.equal(imageType(Buffer.from("GIF89a....")), "image/gif");
  assert.equal(imageType(Buffer.from("nope")), "");
});

/**
 * 10/11/2026, real account: the answer wraps the student in a typed value ({ _T, V }) and puts schooling members in
 * "Scolarite"; only "Scolarite", "V", "_T" and the project lists were seen at the first level, so sex and birth date
 * stayed empty (check: mappedKeys 2, the names coming from the roster label). Fictitious file of the same shape.
 */
const wrappedSession = () => {
  const session = fakeSession({
    ListeEleves: () => ({ listeEleves: { _T: 24, V: [{ N: "4#e1", L: "MARTIN Léa", G: 4 }] } }),
    FicheEleve: () => wrapped,
  });
  rememberUserData(session, { resources: [classT06], tabs: [105] });
  return session;
};

test("a file wrapped in typed values and Scolarite is read: sex, birth date, class, regime", async () => {
  const result = await studentFiles(wrappedSession(), "c:T06", []);
  const lea = result.items[0];
  assert.equal(lea.lastname, "MARTIN");
  assert.equal(lea.firstname, "Léa Anne");
  assert.equal(lea.sex, "F");
  assert.equal(lea.birthdate, Math.floor(new Date(2010, 2, 14).getTime() / 1000));
  assert.equal(lea.number, "E000123");
  assert.equal(lea.class, "T06");
  assert.equal(lea.regime, "Externe");
  assert.deepEqual(lea.options, ["Latin"]);
  // Containers, type codes, health and project members are never "unmapped" keys.
  assert.deepEqual(result.unmappedKeys, ["L", "champScolariteInconnu"]);
  const json = JSON.stringify(result);
  for (const value of ["Allergie", "Motif fictif", "PAP", "valeur à ne pas renvoyer"]) assert.equal(json.includes(value), false, value);
});

test("check of a wrapped file: field names and shape of the answer, never a value", async () => {
  const check = await checkStudentFiles(wrappedSession(), "c:T06");
  assert.equal(check.mappedKeys, 8);
  assert.deepEqual(check.mapped, ["lastname", "firstname", "sex", "birthdate", "number", "email", "class", "regime"]);
  assert.ok(check.shape.includes("Eleve._T=8"));
  assert.ok(check.shape.includes("Eleve.V.estFeminin: boolean"));
  assert.ok(check.shape.includes("Eleve.V.DateNaissance.V: string"));
  assert.ok(check.shape.includes("Scolarite.V.classe.L: string"));
  assert.ok(check.shape.includes("Scolarite.V.listeOptions.V[]: object"));
  // Health and project members are left out of the shape, even by name.
  assert.equal(check.shape.some((line) => /infosMedicales|Projets/.test(line)), false);
  const json = JSON.stringify(check);
  for (const value of ["MARTIN", "Léa", "E000123", "pedagolyautey", "14/03/2010", "T06", "Externe", "Latin", "Allergie", "PAP"]) {
    assert.equal(json.includes(value), false, value);
  }
});

test("shape: lists by their first element, bounded length", () => {
  assert.deepEqual(shapeOf({ a: [{ b: 1 }, { c: 2 }], d: null }), ["a: list", "a[]: object", "a[].b: number", "d: null"]);
  const big = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`k${i}`, i]));
  assert.equal(shapeOf(big).length, MAX_SHAPE);
});

test("sex labels: civil titles and estFeminin", () => {
  assert.equal(sexOf("Mme"), "F");
  assert.equal(sexOf("Mlle"), "F");
  assert.equal(sexOf("M."), "M");
  assert.equal(sexOf("Monsieur"), "M");
});

/**
 * 11/11/2026, real account: Pronote codes the sex 1 for the girls and 0 for the boys. Read as the INSEE code (1 = male)
 * until then, every girl came out "Garçon" and no boy was recognised (plan_profile_fields dryrun).
 */
test("Pronote sex code: 1 = girl, 0 = boy, typed or not", async () => {
  assert.equal(sexCode(1), "F");
  assert.equal(sexCode(0), "M");
  assert.equal(sexCode("1"), "F");
  assert.equal(sexCode({ _T: 1, V: 0 }), "M");
  assert.equal(sexCode(true), "F");
  assert.equal(sexCode("Féminin"), "F");
  assert.equal(sexCode(2), "");
  const session = (sexe: unknown) => {
    const answer = structuredClone(wrapped);
    delete answer.Eleve.V.estFeminin;
    answer.Eleve.V.Sexe = sexe;
    const fake = fakeSession({
      ListeEleves: () => ({ listeEleves: { _T: 24, V: [{ N: "4#e1", L: "MARTIN Léa", G: 4 }] } }),
      FicheEleve: () => answer,
    });
    rememberUserData(fake, { resources: [classT06], tabs: [105] });
    return fake;
  };
  assert.equal((await studentFiles(session(1), "c:T06", [])).items[0].sex, "F");
  assert.equal((await studentFiles(session(0), "c:T06", [])).items[0].sex, "M");
  assert.equal((await studentFiles(session({ _T: 1, V: "1" }), "c:T06", [])).items[0].sex, "F");
  // An explicit masculine flag keeps its meaning.
  assert.equal(sexOf(true), "M");
});

/**
 * 12/11/2026: two students with the same name, in two classes of the same teacher, were both matched to one Moodle
 * account (name only). Each student now carries an opaque key from its Pronote id: the same in every list of the
 * session, different for two homonyms, never the Pronote id itself.
 */
test("student key: tells homonyms apart, same student same key, never the Pronote id", async () => {
  const session = fakeSession({
    ListeEleves: (data) => ({
      listeEleves: { _T: 24, V: data?.ressource?.L === "T06"
        ? [{ N: "4#e1", L: "MARTIN Léa", G: 4 }, { N: "4#e9", L: "MARTIN Léa", G: 4 }]
        : [{ N: "4#e1", L: "MARTIN Léa", G: 4 }] },
    }),
    FicheEleve: () => file,
  });
  const group = { id: "2#g1", label: "T-SPE SVT 2", genre: 2 as const, taught: true, principal: false };
  rememberUserData(session, { resources: [classT06, group], tabs: [105] });
  const inClass = await roster(session, "c:T06");
  assert.equal(inClass.length, 2);
  assert.notEqual(inClass[0].key, inClass[1].key);
  assert.match(inClass[0].key, /^[0-9a-f]{16}$/);
  const inGroup = await roster(session, "g:T-SPE SVT 2");
  assert.equal(inGroup[0].key, inClass[0].key);
  assert.equal(JSON.stringify(inClass).includes("4#e"), false);
  const files = await studentFiles(session, "c:T06", []);
  assert.deepEqual(files.items.map((item) => item.key), inClass.map((item) => item.key));
});
