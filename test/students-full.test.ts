import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { rememberUserData } from "../src/pronote/userdata.js";
import { fileOf, groupKind, guardianRead, phoneNumber, planType, studentFiles, teamOf, type Include } from "../src/teacher/students.js";
import { MAX_PHOTOS, studentPhotos, type Downloaded } from "../src/teacher/photos.js";
import { ppCheck } from "../src/teacher/ppcheck.js";
import { fakeSession, type FakeCall } from "./fake-session.js";
import { buildApp, createSession, get } from "./helpers/app.js";

const { readCache } = await import("../src/cache.js");
const { accountKey } = await import("../src/tokenStore.js");

/*
 * Complete student file (0.12.0). The 32 member names left unmapped on a real class on 20/11/2026 (CP, L, P,
 * accompagnant, adresse1…4, autorisationSortie, autorise*, avecDiscussion, delegue, engagements, estMajeur, indPort,
 * listeEquipePeda, listePP, listeRessources, listeTuteurs, nombreJoursSelectionnables, numeroCasier, numeroSelf, pays,
 * profPrincipal, telPort, tuteur, useTransport, ville, villeNaiss) are all in the fixture, with generated values: their
 * real values were never seen. NOT VALIDATED.
 */
const full = JSON.parse(readFileSync(new URL("./fixtures/student-file-full.json", import.meta.url), "utf8"));
const REAL_KEYS = ["CP", "L", "P", "accompagnant", "adresse1", "adresse2", "adresse3", "adresse4", "autorisationSortie", "autoriseCourrier",
  "autoriseDiscussion", "autoriseEmail", "autoriseSMS", "avecDiscussion", "delegue", "engagements", "estMajeur", "indPort", "listeEquipePeda",
  "listePP", "listeRessources", "listeTuteurs", "nombreJoursSelectionnables", "numeroCasier", "numeroSelf", "pays", "profPrincipal", "telPort",
  "tuteur", "useTransport", "ville", "villeNaiss"];
const classT06 = { id: "1#c1", label: "T06", genre: 1 as const, taught: true, principal: true };
const roster = [{ N: "4#e1", L: "BENALI Yasmine", G: 4 }, { N: "4#e2", L: "PETIT Hugo", G: 4 }, { N: "4#e3", L: "ROCHE Inès", G: 4 }];

const session = (extra: Record<string, (data: any, call: FakeCall) => any> = {}) => {
  const fake = fakeSession({
    ListeEleves: () => ({ listeEleves: { _T: 24, V: roster } }),
    FicheEleve: (data) => (data?.Eleve?.N === "4#e1" ? full : { Eleve: { N: data?.Eleve?.N, L: data?.Eleve?.L, estMajeur: false } }),
    ...extra,
  });
  rememberUserData(fake, { resources: [classT06], tabs: [105, 23] });
  return fake;
};

test("the fixture holds every member name seen in production, and none is left unmapped", async () => {
  const members = { ...full.Eleve.V, ...full.Scolarite.V };
  for (const key of REAL_KEYS) assert.ok(key in members, key);
  const result = await studentFiles(session(), "c:T06", ["imagerights", "guardians", "health", "photo", "contact", "school"], "e:BENALI Yasmine");
  assert.deepEqual(result.unmappedKeys, []);
  assert.deepEqual(result.unmappedGuardianKeys, ["champResponsableInconnu"]);
  assert.equal(JSON.stringify(result).includes('"x"'), false, "never the value of an unmapped member");
});

/*
 * 0.12.1, first real read (20/11/2026): listeRessources of FicheEleve lists the GUARDIANS of the student, not his
 * classes and groups. Their names came out in "groups" and "groupDetails", even without the "guardians" part.
 */
test("listeRessources holds the guardians: nothing of it is read, their names never leave without the guardians part", async () => {
  const names = (full.Scolarite.V.listeRessources.V as { L: string }[]).map((item) => item.L);
  assert.deepEqual(names, ["M. BENALI Karim", "Mme BENALI Salma"]);
  for (const include of [[], ["imagerights", "photo", "contact", "school", "health"]] as Include[][]) {
    const result = await studentFiles(session(), "c:T06", include, "e:BENALI Yasmine");
    const json = JSON.stringify(result);
    for (const name of names) assert.equal(json.includes(name), false, `${name} with include=${include.join(",")}`);
    assert.equal(result.unmappedKeys.includes("listeRessources"), false, "a known member");
  }
  // With the guardians part, the names come from listeResponsables, in "guardians" only.
  const withGuardians = (await studentFiles(session(), "c:T06", ["guardians"], "e:BENALI Yasmine")).items[0];
  assert.equal(withGuardians.guardians?.[0].name, "M. BENALI Karim");
  for (const name of names) {
    assert.equal(withGuardians.groups.includes(name), false);
    assert.equal(withGuardians.groupDetails.some((item) => item.label === name), false);
    assert.equal(withGuardians.options.includes(name), false);
  }
  // A file whose only "group" member is listeRessources has no group at all.
  const { file } = fileOf({ pronoteId: "4#e9", label: "ROCHE Inès", id: "e:ROCHE Inès" },
    { Eleve: { N: "4#e9", L: "ROCHE Inès", listeRessources: { _T: 24, V: [{ L: "Mme ROCHE Anne", N: "5#r9", G: 2 }] } } }, []);
  assert.deepEqual([file.groups, file.options, file.groupDetails], [[], [], []]);
});

test("identity alone: class, groups and options of a terminale with two specialities and an option; nothing else leaves", async () => {
  const result = await studentFiles(session(), "c:T06", [], "e:BENALI Yasmine");
  const file = result.items[0];
  assert.equal(file.class, "T06");
  assert.deepEqual(file.groups, ["T-SPE SVT 2", "T-SPE PC 1", "T-OPT MATHS COMP", "TLVA ANG 3", "[T06AP ORIENT]"]);
  assert.deepEqual(file.groupDetails, [
    { label: "T-SPE SVT 2", kind: "speciality", source: "file" },
    { label: "T-SPE PC 1", kind: "speciality", source: "file" },
    { label: "T-OPT MATHS COMP", kind: "option", source: "file" },
    { label: "TLVA ANG 3", kind: "language", source: "file" },
    { label: "[T06AP ORIENT]", kind: "group", source: "file" },
    // 0.14.0: the subjects of the pedagogical team that name a speciality, a language or an option.
    { label: "SC. VIE & TERRE SPE", kind: "speciality", source: "team" },
    { label: "PHYSIQUE-CHIMIE SPE", kind: "speciality", source: "team" },
  ]);
  assert.deepEqual(file.options, ["T-SPE SVT 2", "T-SPE PC 1", "T-OPT MATHS COMP", "TLVA ANG 3", "SC. VIE & TERRE SPE", "PHYSIQUE-CHIMIE SPE"]);
  assert.equal(file.adult, true, "a student of age");
  assert.equal(file.birthplace, "Rabat");
  assert.equal(file.sex, "F");
  assert.equal(file.birthdate, Date.UTC(2008, 4, 2) / 1000);
  for (const key of ["imageRights", "guardians", "health", "photo", "contact", "school", "memos"]) assert.equal(key in file, false, key);
  const json = JSON.stringify(result);
  for (const secret of ["rue des Fictifs", "600000010", "Arachide", "Trouble fictif", "Tiers-temps", "Mme ROUX", "B-112", "Mémo intégré", "parent1"]) {
    assert.equal(json.includes(secret), false, secret);
  }
  // A minor: the flag is false, never guessed.
  assert.equal((await studentFiles(session(), "c:T06", [], "e:PETIT Hugo")).items[0].adult, false);
});

test("contact and schooling on request: address, mobile with its prefix, AESH, delegate, team, main teachers", async () => {
  const result = await studentFiles(session(), "c:T06", ["contact", "school"], "e:BENALI Yasmine");
  const file = result.items[0];
  assert.deepEqual(file.contact, { address: "12 rue des Fictifs, Résidence Exemple", postcode: "20100", city: "Casablanca", country: "Maroc",
    mobile: "+212 600000010" });
  assert.deepEqual(file.school, {
    delegate: true,
    commitments: ["Déléguée titulaire", "Éco-déléguée", "CVL"],
    exitAuthorisation: "Autorisée après le dernier cours",
    transport: false,
    locker: "B-112",
    canteen: "45012",
    aesh: "Mme ROUX A.",
    tutors: ["M. EVRARD O."],
    mainTeachers: ["M. EVRARD O.", "Mme FABRE N."],
    team: [
      { subject: "SC. VIE & TERRE SPE", teachers: ["M. EVRARD O."] },
      { subject: "ENSEIGNEMENT SCIENTIFIQUE", teachers: ["M. EVRARD O.", "Mme FABRE N."] },
      { subject: "PHYSIQUE-CHIMIE SPE", teachers: ["Mme FABRE N."] },
      { subject: "PHILOSOPHIE", teachers: ["Mme ARNAUD C."] },
    ],
    communication: { email: true, sms: false, mail: true, discussion: true },
  });
  // A student without these members: empty values, never invented.
  const other = (await studentFiles(session(), "c:T06", ["school"], "e:PETIT Hugo")).items[0].school!;
  assert.equal(other.delegate, null);
  assert.equal(other.aesh, "");
  assert.deepEqual(other.team, []);
});

test("guardians: order, parental authority, letters, phones with their prefix", async () => {
  const result = await studentFiles(session(), "c:T06", ["guardians"], "e:BENALI Yasmine");
  const [father, mother] = result.items[0].guardians!;
  assert.deepEqual(father, { name: "M. BENALI Karim", relation: "Père", legal: true, phones: ["+212 600000011", "+212 500000012"],
    email: "parent1.fictif@example.org", address: "12 rue des Fictifs 20100 Casablanca",
    preferences: ["autoriseCourrier", "autoriseSMS", "autoriseEmail"], order: 1, authority: true, mail: true, sms: true, emailAllowed: true,
    phoneDetails: [{ type: "mobile", number: "+212 600000011" }, { type: "home", number: "+212 500000012" }], responsibility: "", classDelegate: null, boardMember: null, emergency: null, emailReason: "" });
  assert.equal(mother.order, 2);
  assert.equal(mother.mail, false, "does not receive the letters");
  assert.equal(mother.emailAllowed, false);
  assert.deepEqual(mother.phoneDetails, [{ type: "mobile", number: "+33 600000013" }, { type: "work", number: "0500000014" }]);
  assert.equal(phoneNumber("+212", "600"), "+212 600");
  assert.equal(phoneNumber("", "0600"), "0600");
  assert.equal(phoneNumber("212", ""), "");
  assert.deepEqual(guardianRead({ L: "X", telPort: "06", inconnu: 1, listeMemos: [] }).unused, ["inconnu"]);
});

test("health on request only: several plans with their detail, allergies; the labels stay as before", async () => {
  const result = await studentFiles(session(), "c:T06", ["health"], "e:BENALI Yasmine");
  const health = result.items[0].health!;
  assert.deepEqual(health.plans, ["PAP", "AMENAGTS EXAMS", "PAI."]);
  assert.deepEqual(health.allergies, ["Arachide fictive"]);
  assert.deepEqual(health.planDetails, [
    { type: "PAP", label: "PAP", title: "Trouble fictif", start: "2026-09-01", end: "2027-07-03", comment: "Commentaire fictif",
      accommodations: ["Tiers-temps", "Supports agrandis"], examAccommodations: false, documents: [{ name: "pap-fictif.pdf" }] },
    { type: "accommodation", label: "AMENAGTS EXAMS", title: "", start: "", end: "", comment: "Tiers-temps aux examens", accommodations: [],
      examAccommodations: true, documents: [] },
    { type: "PAI", label: "PAI.", title: "Allergie fictive", start: "", end: "", comment: "", accommodations: [], examAccommodations: false,
      documents: [] },
  ]);
  assert.equal(planType("PPS"), "PPS");
  assert.equal(planType("AMENAGT EPS"), "accommodation");
  assert.equal(planType("INFO CAT PATHOLOGIE"), "other");
});

test("memos on request: ListeMemosEleves for the memos then the valorisations; a refusal gives those of the file", async () => {
  const fake = session({ ListeMemosEleves: (data) => ({ listeMemos: { _T: 24, V: data?.estValorisation
    ? [{ commentaire: "Engagement remarqué", date: { _T: 7, V: "12/11/2026" }, auteur: { _T: 24, V: { L: "M. EVRARD O." } }, publie: true }]
    : [{ commentaire: "Entretien avec la famille", date: { _T: 7, V: "03/11/2026" }, auteur: { _T: 24, V: { L: "Mme FABRE N." } }, publie: false }] } }) });
  const result = await studentFiles(fake, "c:T06", ["memos"], "e:BENALI Yasmine");
  assert.deepEqual(result.items[0].memos, [
    { date: "2026-11-03", text: "Entretien avec la famille", author: "Mme FABRE N.", published: false, kind: "memo" },
    { date: "2026-11-12", text: "Engagement remarqué", author: "M. EVRARD O.", published: true, kind: "valorisation" },
  ]);
  const asked = fake.calls.filter((call) => call.name === "ListeMemosEleves");
  assert.deepEqual(asked.map((call) => call.data?.estValorisation), [false, true]);
  assert.deepEqual(asked[0].data?.eleve, { N: "4#e1", G: 4, L: "BENALI Yasmine" });
  assert.equal(asked[0].onglet, 105);
  // Refused by Pronote: the memos embedded in the file, or none; never an error.
  const refused = await studentFiles(session(), "c:T06", ["memos"]);
  assert.deepEqual(refused.items[0].memos, [{ date: "2026-10-10", text: "Mémo intégré fictif", author: "", published: null, kind: "memo" }]);
  assert.deepEqual(refused.items[1].memos, []);
  // Without the part: no call, no memo.
  const none = session();
  assert.equal("memos" in (await studentFiles(none, "c:T06", [], "e:BENALI Yasmine")).items[0], false);
  assert.equal(none.calls.some((call) => call.name === "ListeMemosEleves"), false);
});

test("kinds of groups and pedagogical team from other shapes", () => {
  assert.equal(groupKind("T06", 1), "class");
  assert.equal(groupKind("1G-SPE HGGSP 2"), "speciality");
  assert.equal(groupKind("TLVB ESP 3"), "language");
  assert.equal(groupKind("T ARABE LVC"), "language");
  assert.equal(groupKind("T-OPT LATIN"), "option");
  assert.equal(groupKind("T MATHS EXP 1"), "option");
  assert.equal(groupKind("[T06AP ORIENT]"), "group");
  // Entries that are subjects naming their teachers.
  assert.deepEqual(teamOf({ _T: 24, V: [{ L: "SVT", listeProfesseurs: { _T: 24, V: [{ L: "M. A" }, { L: "Mme B" }] } }] }),
    [{ subject: "SVT", teachers: ["M. A", "Mme B"] }]);
  assert.deepEqual(teamOf([{ L: "M. C" }]), [{ subject: "", teachers: ["M. C"] }]);
  assert.deepEqual(teamOf(undefined), []);
});

const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]);

test("photos of a page: one roster read, a missing photo and a page that is not a picture are told apart", async () => {
  const fake = session();
  const urls: string[] = [];
  const downloader = async (url: string): Promise<Downloaded> => {
    urls.push(url);
    if (urls.length === 1) return { contentType: "image/jpeg", bytes: jpeg };
    if (urls.length === 2) return { contentType: "text/html", bytes: Buffer.from("<html>La page demandée n'existe pas</html>") };
    return null;
  };
  const result = await studentPhotos(fake, "c:T06", { offset: 0, limit: 10 }, downloader);
  assert.equal(result.available, true);
  assert.equal(result.validated, false);
  assert.equal(result.total, 3);
  assert.deepEqual(result.items.map((item) => [item.student, item.label, item.available, item.reason, item.mime]), [
    ["e:BENALI Yasmine", "BENALI Yasmine", true, "", "image/jpeg"],
    ["e:PETIT Hugo", "PETIT Hugo", false, "no_photo", ""],
    ["e:ROCHE Inès", "ROCHE Inès", false, "no_photo", ""],
  ]);
  assert.equal(result.items[0].size, jpeg.length);
  assert.equal(Buffer.from(result.items[0].base64, "base64").equals(jpeg), true);
  assert.equal(fake.calls.filter((call) => call.name === "ListeEleves").length, 1);
  assert.match(urls[0], /FichiersExternes\/.+\/photo\.jpg\?Session=/);
  // One student, and a page beyond the largest size.
  const one = await studentPhotos(session(), "c:T06", { student: "e:ROCHE Inès" }, async () => ({ contentType: "image/jpeg", bytes: jpeg }));
  assert.deepEqual(one.items.map((item) => item.student), ["e:ROCHE Inès"]);
  assert.equal(one.offset, 2);
  assert.equal((await studentPhotos(session(), "c:T06", { limit: 50 }, async () => null)).items.length, Math.min(3, MAX_PHOTOS));
  const closed = session();
  rememberUserData(closed, { resources: [classT06], tabs: [16] });
  assert.equal((await studentPhotos(closed, "c:T06", {}, downloader)).reason, "tab_closed:105");
});

test("GET /students/photos and the extended includes through the routes; the photos are never cached", async () => {
  readCache.clear();
  const app = await buildApp({ logger: false });
  const fake = session();
  const login = { url: "https://demo.example/pronote", username: "prof-fiches", deviceuuid: "device-fiches" };
  const id = createSession(fake, { key: accountKey(login.url, login.username, login.deviceuuid), login });
  const files = await get(app, "/students/files?resource=c%3AT06&include=contact,school,memos&limit=1", id);
  assert.equal(files.statusCode, 200, files.body);
  assert.equal(files.json().items[0].contact.city, "Casablanca");
  assert.deepEqual(files.json().unmappedGuardianKeys, ["champResponsableInconnu"], "names only, never a value");
  assert.equal((await get(app, "/students/photos?resource=c%3AT06&limit=11", id)).statusCode, 400);
  // The photo files of the fake Pronote do not exist: the route answers, each photo says why it is missing.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;
  try {
    const photos = await get(app, "/students/photos?resource=c%3AT06&limit=2", id);
    assert.equal(photos.statusCode, 200, photos.body);
    assert.deepEqual(photos.json().items.map((item: { reason: string }) => item.reason), ["no_photo", "no_photo"]);
    assert.equal(photos.headers["x-cache"], undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
  await app.close();
});

test("check of the main teacher view: a status and a shape per function, never a value", async () => {
  const period = { N: "1#t1", L: "Trimestre 1", G: 2 };
  const fake = session({
    ListePeriodes: () => ({ listePeriodes: { _T: 24, V: [period] }, periodeParDefaut: { _T: 24, V: period } }),
    PageBulletins: () => ({ Message: "Le bulletin de DUPONT Secret sera publié plus tard." }),
    ResultatsClasses: () => ({ tableau: [{ nom: "DUPONT Secret" }] }),
    ListeAppreciations: () => ({ listeAppreciations: { _T: 24, V: [{ N: "50#k", G: 2, L: "Appréciation générale" }] } }),
    PageAppreciationsGenerales: () => ({ listeLignes: { _T: 24, V: [{ eleve: { _T: 24, V: { L: "DUPONT Secret" } }, appreciationGle: { _T: 24, V: { L: "Texte secret" } } }] } }),
    RecapitulatifVSEleve: () => ({ listeAbsences: { _T: 24, V: [{ G: 13, dateDebut: { _T: 7, V: "09/11/2026 08:00:00" }, listeMotifs: { _T: 24, V: [{ L: "Motif secret" }] } }] } }),
    PageSaisieCarnetCorrespondance: () => ({ Erreur: { Titre: "Erreur inattendue pour DUPONT Secret" } }),
    ListeMemosEleves: () => ({ listeMemos: { _T: 24, V: [{ commentaire: "Mémo secret", publie: true }] } }),
  });
  rememberUserData(fake, { resources: [classT06], tabs: [13, 19, 27, 64, 78, 105, 23] });
  // 0.14.0: the functions of the view are the "core" group; the photo is downloaded by a fake (no picture here).
  const result = await ppCheck(fake, "c:T06", { groups: ["core"], downloader: async () => null });
  assert.equal(result.students, 3);
  assert.deepEqual(result.groups, ["core"]);
  // The first line of each key (the kinds and the memos have one line per request variant).
  const by = new Map([...result.checks].reverse().map((check) => [check.key, check]));
  assert.deepEqual([...new Set(result.checks.map((check) => check.key))], ["reportCard", "transcript", "classResults", "commentKinds",
    "generalCommentsPage", "studentLifeRecap", "studentNotebook", "studentMemos", "studentFile", "studentFileMembers", "studentPhoto"]);
  assert.deepEqual([by.get("reportCard")?.status, by.get("reportCard")?.function, by.get("reportCard")?.onglet], ["ok", "PageBulletins", 13]);
  // Tab 12 is not in the session: the refusal is a closed tab; the call was still tried (the tab list is not exhaustive).
  assert.equal(by.get("transcript")?.status, "tab_closed");
  assert.equal(fake.calls.some((call) => call.name === "PageReleve"), true);
  assert.equal(by.get("classResults")?.status, "format_unknown");
  assert.deepEqual(by.get("classResults")?.shape, ["tableau: list[1]", "tableau[]: object", "tableau[].nom: string"]);
  assert.equal(by.get("commentKinds")?.status, "ok");
  assert.equal(by.get("generalCommentsPage")?.status, "ok");
  assert.equal(by.get("studentLifeRecap")?.status, "ok");
  assert.deepEqual([by.get("studentNotebook")?.status, by.get("studentNotebook")?.detail], ["error", "pronote_error"]);
  assert.equal(by.get("studentMemos")?.status, "ok");
  assert.ok(by.get("studentMemos")?.shape.includes("listeMemos.V[].commentaire: string"), "the shape of the memos is given");
  assert.deepEqual([by.get("studentFile")?.status, by.get("studentFile")?.detail], ["ok", "unmapped=0;guardians=1"]);
  // The student file read once, with its guardians; its sensitive members are not even named.
  assert.equal(fake.calls.filter((call) => call.name === "FicheEleve").length, 1);
  assert.equal(by.get("studentFile")?.shape.some((line) => /Projets|allergies|Memos/.test(line)), false);
  const json = JSON.stringify(result);
  for (const secret of ["Secret", "secret", "BENALI", "Casablanca", "600000010", "Arachide"]) assert.equal(json.includes(secret), false, secret);

  // Through the route, for a group: the functions of a class are not applicable.
  const empty = fakeSession({ ListeEleves: () => ({ listeEleves: { _T: 24, V: [] } }) });
  rememberUserData(empty, { resources: [classT06], tabs: [105] });
  assert.deepEqual(await ppCheck(empty, "c:T06"), { students: 0, groups: ["core", "life", "reports", "misc"], checks: [] });
});
