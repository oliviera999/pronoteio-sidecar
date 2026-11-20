import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "../src/errors.js";
import { rememberUserData } from "../src/pronote/userdata.js";
import { overview as competencyOverview, referential, findReferentialItem, referentialFrom } from "../src/teacher/competencies.js";
import { writeCompetency } from "../src/teacher/competenciesWrite.js";
import { mergeServices, overview as gradeOverview, resolveService, serviceIdsOf } from "../src/teacher/grades.js";
import { find, resourceTimetable } from "../src/teacher/resourceTimetable.js";
import { fakeSession } from "./fake-session.js";

/*
 * Case of 17/11/2026, rebuilt from the client code (docs/pronote-matrice/2-3-notes-competences.md in mood_prod), with
 * generated names: a teacher with four grade services in the "lycée" (tab 23) and two groups of 6e assessed by skills
 * only (tab 65, "SCIENCES ET TECHNOLOGIE"), one assessment "Se connecter et accéder à olution" in each group (19 and
 * 20 students, all at "Très bonne maîtrise"), skill D2 / 4.1. NOT VALIDATED on a real server.
 */
const period = { N: "1#t1", L: "Trimestre 1", G: 2 };
const cls = (n: string, label: string) => ({ _T: 24, V: { N: n, L: label, G: 1 } });
const grp = (n: string, label: string) => ({ _T: 24, V: { N: n, L: label, G: 2 } });
const subject = (label: string) => ({ _T: 24, V: { N: `9#${label}`, L: label } });

const gradeServices = [
  { N: "5#snt205", matiere: subject("SNT"), classe: cls("2#205", "205") },
  { N: "5#snt209", matiere: subject("SNT"), classe: cls("2#209", "209") },
  { N: "5#est06", matiere: subject("ES"), classe: cls("2#t06", "T06") },
  { N: "5#est11", matiere: subject("ES"), classe: cls("2#t11", "T11") },
];
const competencyServices = [
  { N: "5#st12", matiere: subject("SCIENCES ET TECHNOLOGIE"), groupe: grp("3#g12", "6-SC-601-602") },
  { N: "5#st3", matiere: subject("SCIENCES ET TECHNOLOGIE"), groupe: grp("3#g3", "6-SC-603") },
  // Also listed in tab 65: the same Pronote service as tab 23, kept once with both kinds.
  { N: "5#est06", matiere: subject("ES"), classe: cls("2#t06", "T06") },
];

const students = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => ({ N: `46#${prefix}${index + 1}`, L: `ELEVE${prefix.toUpperCase()}${String(index + 1).padStart(2, "0")} Prénom` }));
const rosters: Record<string, { N: string; L: string }[]> = { "3#g12": students("a", 19), "3#g3": students("b", 20) };

const skill = {
  N: "14#k41",
  L: "4.1 Utiliser des outils numériques pour réaliser une production.",
  relationESI: { _T: 24, V: { N: "15#r41" } },
  pilier: { _T: 24, V: { N: "16#d2", L: "D2 Les méthodes et outils pour apprendre", palier: { _T: 24, V: { N: "27#c3", G: 27, L: "Cycle 3" } } } },
};
const evaluationOf = (group: string) => ({
  N: `13#e${group}`,
  L: "Se connecter et accéder à olution",
  dateValidation: { _T: 7, V: "17/11/2026" },
  datePublication: { _T: 7, V: "20/11/2026" },
  coefficient: { _T: 10, V: "1" },
  priseEnCompteDansBilan: true,
  listeCompetences: { _T: 24, V: [skill] },
});
const VPLUS = { _T: 24, V: { N: "17#n1", G: 1, L: "Très bonne maîtrise" } };

const referentialAnswer = {
  listePiliers: {
    _T: 24,
    V: [
      {
        N: "16#d2",
        L: "D2 Les méthodes et outils pour apprendre",
        palier: { _T: 24, V: { N: "27#c3", G: 27, L: "Cycle 3" } },
        listeElements: {
          _T: 24,
          V: [
            {
              N: "18#e4",
              L: "4. Mobiliser des outils numériques pour apprendre, échanger, communiquer",
              listeItems: {
                _T: 24,
                V: [
                  { N: "19#i41", L: "4.1 Utiliser des outils numériques pour réaliser une production.", relationESI: { _T: 24, V: { N: "15#r41" } } },
                  { N: "19#i42", L: "4.2 Utiliser des outils numériques pour communiquer des résultats.", relationESI: { _T: 24, V: { N: "15#r42" } } },
                ],
              },
            },
          ],
        },
      },
      {
        N: "16#d4",
        L: "D4 Les systèmes naturels et les systèmes techniques",
        palier: { _T: 24, V: { L: "Cycle 3" } },
        listeElements: { _T: 24, V: [{ N: "19#i11", L: "1.1 Proposer une démarche pour résoudre un problème.", relationESI: { _T: 24, V: { N: "15#r11" } } }] },
      },
    ],
  },
};

const session17 = (options: { saved?: Record<string, any>[] } = {}) => {
  const session = fakeSession({
    ListePeriodes: () => ({ listePeriodes: { _T: 24, V: [period] }, periodeParDefaut: { _T: 24, V: period } }),
    "ListeServices@23": () => ({ services: { _T: 24, V: gradeServices } }),
    "ListeServices@65": () => ({ services: { _T: 24, V: competencyServices } }),
    PageNotes: () => ({ listeDevoirs: { _T: 24, V: [] }, listeEleves: { _T: 24, V: [] } }),
    ListeEvaluations: (data) => {
      const service = String(data?.service?.N ?? "");
      if (service === "5#st12") return { listeEvaluations: { _T: 24, V: [evaluationOf("12")] } };
      if (service === "5#st3") return { listeEvaluations: { _T: 24, V: [evaluationOf("3")] } };
      return { listeEvaluations: { _T: 24, V: [] } };
    },
    PageCompetencesParEvaluation: (data) => {
      const group = String(data?.ressource?.N ?? "");
      return {
        ListeElevesCompetences: {
          _T: 24,
          V: (rosters[group] ?? []).map((student) => ({ ...student, ListeCompetences: { _T: 24, V: [{ N: "15#r41", NiveauDAcquisition: VPLUS }] } })),
        },
      };
    },
    ListePiliers: () => referentialAnswer,
    ListeEleves: (data) => ({ listeEleves: { _T: 24, V: rosters[String(data?.ressource?.N ?? "")] ?? [] } }),
    SaisieEvaluations: (data) => {
      options.saved?.push(data ?? {});
      return {};
    },
    PageEmploiDuTemps: (data) => {
      if (String(data?.Ressource?.N ?? "") === "1#c603") return { Erreur: { Titre: "Vos droits sont insuffisants pour effectuer cette opération." } };
      return { ListeCours: { _T: 24, V: [] } };
    },
  });
  rememberUserData(session, {
    resources: [
      { id: "2#205", label: "205", genre: 1, taught: true, principal: false },
      { id: "2#209", label: "209", genre: 1, taught: true, principal: false },
      { id: "2#t06", label: "T06", genre: 1, taught: true, principal: false },
      { id: "2#t11", label: "T11", genre: 1, taught: true, principal: false },
      { id: "1#c603", label: "603", genre: 1, taught: true, principal: false },
      { id: "3#g12", label: "6-SC-601-602", genre: 2, taught: true, principal: false },
      { id: "3#g3", label: "6-SC-603", genre: 2, taught: true, principal: false },
    ],
    tabs: [16, 23, 56, 65, 105],
    acquisitionLevels: [
      { N: "17#n1", G: 1, L: "Très bonne maîtrise" },
      { N: "17#n2", G: 2, L: "Maîtrise satisfaisante" },
      { N: "17#n8", G: 8, L: "Non évalué" },
    ],
    parentsDelayDays: 1,
  });
  return session;
};

test("services of both tabs: four grade services, two skills services only, kinds, lycée ids unchanged", async () => {
  const session = session17();
  const result = await gradeOverview(session);
  assert.deepEqual(result.services.map((s) => s.id), [
    "s:SNT|205",
    "s:SNT|209",
    "s:ES|T06",
    "s:ES|T11",
    "s:SCIENCES ET TECHNOLOGIE|6-SC-601-602",
    "s:SCIENCES ET TECHNOLOGIE|6-SC-603",
  ]);
  assert.deepEqual(result.services.map((s) => s.kinds), [
    ["grades"], ["grades"], ["grades", "competencies"], ["grades"], ["competencies"], ["competencies"],
  ]);
  const group = result.services[5];
  assert.equal(group.type, "group");
  assert.equal(group.resourceid, "g:6-SC-603");
  assert.deepEqual(group.assessments, []);
  // PageNotes only for the four grade services.
  assert.equal(session.calls.filter((call) => call.name === "PageNotes").length, 4);
  assert.deepEqual(session.calls.filter((call) => call.name === "ListeServices").map((call) => call.onglet), [23, 65]);
});

test("a service id with or without the brackets of its group designates the same service", () => {
  const merged = mergeServices(gradeServices, competencyServices);
  const plain = resolveService("s:SCIENCES ET TECHNOLOGIE|6-SC-603", merged);
  assert.equal(resolveService("s:SCIENCES ET TECHNOLOGIE|[6-SC-603]", merged), plain);
  assert.equal(resolveService("s:sciences et technologie|6-sc-603", merged), plain);
  assert.equal(serviceIdsOf(merged)[merged.indexOf(plain)], "s:SCIENCES ET TECHNOLOGIE|6-SC-603");
  assert.throws(() => resolveService("s:SCIENCES ET TECHNOLOGIE|6-SC-604", merged), (error) => error instanceof HttpError && error.code === "service_not_found");
});

test("skills assessments of the two groups: 39 levels, D2 / 4.1, publication to parents one day later", async () => {
  const result = await competencyOverview(session17());
  assert.equal(result.available, true);
  assert.equal(result.items.length, 2);
  assert.equal(result.items.reduce((sum, item) => sum + item.ratings.length, 0), 39);
  assert.ok(result.items.every((item) => item.ratings.every((rating) => rating.level === 1)));
  const [first] = result.items;
  assert.equal(first.title, "Se connecter et accéder à olution");
  assert.equal(first.serviceid, "s:SCIENCES ET TECHNOLOGIE|6-SC-601-602");
  assert.equal(first.type, "group");
  assert.equal(first.coefficient, 1);
  assert.equal(first.cycleReport, true);
  assert.equal(first.publicationParents! - first.publication!, 86400);
  assert.deepEqual(
    { domainCode: first.skills[0].domainCode, number: first.skills[0].number, code: first.skills[0].code, name: first.skills[0].name },
    { domainCode: "D2", number: "4.1", code: "D2/4.1", name: "Utiliser des outils numériques pour réaliser une production." },
  );
  assert.equal(first.skills[0].cycle, "Cycle 3");
  assert.equal(result.parentsDelayDays, 1);
  assert.deepEqual(result.services.filter((s) => s.kinds?.includes("competencies")).map((s) => s.resourcename), ["T06", "6-SC-601-602", "6-SC-603"]);
});

test("class filter: with or without brackets, any case, or a prefix of both groups", async () => {
  const titles = async (classes: string[]) => (await competencyOverview(session17(), "", classes)).items.map((item) => `${item.resourcename}:${item.ratings.length}`);
  const one = await titles(["6-SC-603"]);
  assert.deepEqual(one, ["6-SC-603:20"]);
  assert.deepEqual(await titles(["[6-SC-603]"]), one);
  assert.deepEqual(await titles(["6-sc-603"]), one);
  assert.deepEqual(await titles(["6-SC"]), ["6-SC-601-602:19", "6-SC-603:20"]);
});

test("referential of a skills service: items with their code, found by code, id or label", async () => {
  const result = await referential(session17(), "s:SCIENCES ET TECHNOLOGIE|[6-SC-603]");
  assert.equal(result.available, true);
  const codes = result.items.map((item) => item.code);
  assert.ok(codes.includes("D2/4.1") && codes.includes("D2/4.2") && codes.includes("D4/1.1"));
  const item = result.items.find((entry) => entry.code === "D2/4.1")!;
  assert.equal(item.cycle, "Cycle 3");
  assert.equal(item.element, "4. Mobiliser des outils numériques pour apprendre, échanger, communiquer");
  assert.ok(!("relation" in item), "session identifiers stay in the sidecar");
  assert.equal(findReferentialItem("d2 4.1", result.items), item);
  assert.equal(findReferentialItem(item.id, result.items), item);
  assert.equal(findReferentialItem("Utiliser des outils numériques pour réaliser une production.", result.items), item);
  assert.equal(findReferentialItem("D2/9.9", result.items), null);
  assert.equal(referentialFrom([]).length, 0);
});

test("creation on a skills service with a default level: every student at V+, one student not assessed", async () => {
  const saved: Record<string, any>[] = [];
  const session = session17({ saved });
  const publication = Math.floor(new Date(2026, 10, 20).getTime() / 1000);
  const result = await writeCompetency(session, {
    assessment: null,
    service: "s:SCIENCES ET TECHNOLOGIE|[6-SC-603]",
    period: "",
    title: "Se connecter et accéder à olution",
    date: Math.floor(new Date(2026, 10, 17).getTime() / 1000),
    publication,
    skills: ["D2/4.1"],
    defaultLevel: 1,
    ratings: [{ student: "ELEVEB07 Prénom", skill: "D2/4.1", level: 8 }],
    dryRun: true,
  });
  assert.equal(result.dryRun, true);
  assert.equal(saved.length, 0, "nothing written in a dry run");
  const evaluation = (result.request.listeEvaluations as any[])[0];
  assert.equal(evaluation.E, 1);
  assert.equal(evaluation.priseEnCompteDansBilan, true);
  // 0.13.0: the skill is the element of the referential with a NEW relation and the cycle of its domain; the levels
  // of the students follow in a second request, once Pronote has created the assessment.
  assert.equal(evaluation.listeCompetences[0].N, "19#i41");
  assert.deepEqual(evaluation.listeCompetences[0].relationESI, { N: -1002, E: 1 });
  assert.deepEqual(evaluation.listeCompetences[0].palier, { N: "27#c3", G: 27, L: "Cycle 3" });
  assert.equal(evaluation.listeCompetences[0].niveauAcquiDefaut.G, 1);
  assert.equal(evaluation.Ressource.G, 2);
  assert.equal(evaluation.listeEleves, undefined);
  const levels = result.after!.ratings.map((rating) => rating.level);
  assert.equal(levels.length, 20);
  assert.equal(levels.filter((level) => level === 1).length, 19);
  assert.equal(levels.filter((level) => level === 8).length, 1);
  assert.deepEqual([result.ratingsSent, result.created, result.publicationDefault], [20, false, false]);
  assert.equal(result.after!.ratings.length, 20);
  assert.equal(result.after!.publicationParents! - publication, 86400);
  assert.equal(result.after!.skills[0].code, "D2/4.1");
  assert.equal(result.parentsDelayDays, 1);
});

test("creation with an unknown code is refused before any write", async () => {
  await assert.rejects(
    writeCompetency(session17(), {
      assessment: null, service: "s:SCIENCES ET TECHNOLOGIE|6-SC-603", period: "", title: "X", date: 1795000000,
      skills: ["D2/9.9"], dryRun: true,
    }),
    (error) => error instanceof HttpError && error.code === "skill_not_found:D2/9.9",
  );
});

test("timetable: group found with or without brackets, 'me' is the teacher, a refused class is not accessible", async () => {
  const items = [{ N: "1", G: 2, L: "6-SC-603" }, { N: "2", G: 2, L: "6-SC-601-602" }];
  assert.equal(find(items, "[6-SC-603]", "group").N, "1");
  assert.equal(find(items, "6-sc-603", "group").N, "1");
  const session = session17();
  (session as any).instance.firstMonday = new Date(2026, 8, 7);
  const from = new Date(2026, 10, 16);
  const to = new Date(2026, 10, 21);
  const own = await resourceTimetable(session, "teacher", "me", from, to);
  assert.equal(own.available, true);
  assert.equal(own.resource?.label, "Prof");
  const page = session.calls.find((call) => call.name === "PageEmploiDuTemps");
  assert.deepEqual(page?.data?.Ressource, { N: "109#p", G: 3, L: "Prof" });
  const group = await resourceTimetable(session, "group", "[6-SC-603]", from, to);
  assert.equal(group.resource?.label, "6-SC-603");
  const refused = await resourceTimetable(session, "class", "603", from, to);
  assert.equal(refused.available, false);
  assert.equal(refused.reason, "resource_not_accessible");
});
