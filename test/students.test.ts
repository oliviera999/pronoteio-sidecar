import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { rememberUserData } from "../src/pronote/userdata.js";
import { parseInclude } from "../src/routes/students.js";
import { edtResources, resourceTimetable } from "../src/teacher/resourceTimetable.js";
import { checkStudentFiles, imageRightsOf, sexOf, studentFiles } from "../src/teacher/students.js";
import { fakeSession } from "./fake-session.js";

const file = JSON.parse(readFileSync(new URL("./fixtures/student-file.json", import.meta.url), "utf8"));
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
