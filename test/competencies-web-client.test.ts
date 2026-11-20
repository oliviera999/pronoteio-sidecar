import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "../src/errors.js";
import { createCapturingHandle, rememberUserData, userData } from "../src/pronote/userdata.js";
import { levelsOf, overview, referential } from "../src/teacher/competencies.js";
import { defaultPublication, writeCompetency } from "../src/teacher/competenciesWrite.js";
import { requestContext } from "../src/context.js";
import { ROSTERS, SCHOOL_LEVELS, skillsPronote } from "./helpers/fake-skills-pronote.js";

/*
 * 0.13.0, after the first real try of 20/11/2026 (6e, "SCIENCES ET TECHNOLOGIE", groups 6-SC-601-602 and 6-SC-603):
 * the reads and writes of the skills assessments follow the code of the web client. Pronote is the in-memory one of
 * helpers/fake-skills-pronote.ts (generated names): NOT VALIDATED on a real server.
 */
const SERVICE_12 = "s:SCIENCES ET TECHNOLOGIE|6-SC-601-602";
const SERVICE_3 = "s:SCIENCES ET TECHNOLOGIE|6-SC-603";
const NOON_19_NOV = 1795089600;

/** The plan of 20/11/2026: S4 for the 19 students of 601-602, codes 1, 2 and 4, cycle report, no publication date. */
const planOf2011 = (dryRun: boolean) => ({
  assessment: null,
  service: SERVICE_12,
  period: "p:Trimestre 1",
  title: "S4 · Évaluation du chapitre 1 (Mission pour M. Blanc)",
  date: NOON_19_NOV,
  skills: ["SCIE/13.4"],
  cycleReport: true,
  ratings: ROSTERS["2#g12"].map((student, index) => ({ student: student.L, skill: "SCIE/13.4", level: [1, 2, 4][index % 3] })),
  dryRun,
});

test("lot 5: each group gets its own assessments, with its own students and distinct ids", async () => {
  const { session } = skillsPronote();
  const first = await overview(session, "", ["6-SC-601-602"]);
  const second = await overview(session, "", ["6-SC-603"]);
  assert.deepEqual(first.items.map((item) => item.title), ["Classeur", "Se connecter et accéder à olution"]);
  assert.deepEqual(second.items.map((item) => item.title), ["Evaluation classeur", "Se connecter et accéder à olution"]);
  assert.ok(first.items.every((item) => item.serviceid === SERVICE_12 && item.resourcename === "6-SC-601-602"));
  assert.ok(first.items.every((item) => item.ratings.length === 19 && item.ratings.every((rating) => rating.student.startsWith("ELEVEA"))));
  assert.ok(second.items.every((item) => item.ratings.length === 20 && item.ratings.every((rating) => rating.student.startsWith("ELEVEB"))));
  // Same title, same date, two groups: two ids.
  assert.notEqual(first.items[1].id, second.items[1].id);
  // The list of a service is asked in "Saisie des évaluations" (tab 56), the levels with the class of the assessment.
  assert.deepEqual([...new Set(session.calls.filter((call) => call.name === "ListeEvaluations").map((call) => call.onglet))], [56]);
  const page = session.calls.filter((call) => call.name === "PageCompetencesParEvaluation").at(-1)!;
  assert.equal(page.data?.ressource?.N, "2#g3");
  assert.equal(page.data?.periodeEvaluation?.N, "11#t1");
});

test("lot 5: tab 56 refused, the list of tab 65 holds every assessment and is filtered by the class of each one", async () => {
  const { session, stored } = skillsPronote({ refuseEntryTab: true });
  const both = await overview(session);
  assert.equal(both.available, true);
  assert.deepEqual(both.items.map((item) => `${item.resourcename}|${item.title}|${item.ratings.length}`), [
    "6-SC-601-602|Classeur|19",
    "6-SC-601-602|Se connecter et accéder à olution|19",
    "6-SC-603|Evaluation classeur|20",
    "6-SC-603|Se connecter et accéder à olution|20",
  ]);
  assert.equal(new Set(both.items.map((item) => item.id)).size, 4);
  // One refusal of tab 56, then one read of tab 65 for the two services.
  assert.deepEqual(session.calls.filter((call) => call.name === "ListeEvaluations").map((call) => call.onglet), [56, 65]);
  // Two assessments with the same title and date in ONE group: distinct ids too.
  stored.push({ ...stored[3], N: "29#twin", levels: new Map() });
  const twins = (await overview(session, "", ["6-SC-603"])).items.filter((item) => item.title.startsWith("Se connecter"));
  assert.equal(twins.length, 2);
  assert.equal(twins[1].id, `${twins[0].id}~2`);
});

test("lot 4: four active levels out of six, annotations apart, source 'school'", async () => {
  const { session } = skillsPronote();
  const result = await overview(session, "", ["6-SC-603"]);
  assert.equal(result.levelsSource, "school");
  assert.deepEqual(result.levels.map((level) => [level.code, level.name, level.abbreviation, level.points]), [
    [1, "Très bonne maîtrise", "V+", 50],
    [2, "Maîtrise satisfaisante", "V", 40],
    [4, "Maîtrise fragile", "J", 25],
    [6, "Maîtrise insuffisante", "R", 10],
  ]);
  assert.equal(result.levels[0].color, "#00B050");
  assert.deepEqual(result.statuses.map((level) => [level.code, level.name]), [[7, "Absent"], [8, "Non évalué"], [9, "Dispensé"], [10, "Non rendu"]]);
  assert.ok(result.levels.every((level) => level.active && !level.status));
  // The levels the school does not use (3 and 5) are known but not offered.
  assert.deepEqual(levelsOf(session).all.filter((level) => !level.active).map((level) => level.code), [3, 5]);
});

test("lot 4: the levels are General.ListeNiveauxDAcquisitions of FonctionParametres, captured at login", async () => {
  const answers: Record<string, unknown> = {
    FonctionParametres: { General: { ListeNiveauxDAcquisitions: { _T: 24, V: SCHOOL_LEVELS }, NbJDecalageDatePublicationParDefaut: 2,
      JoursOuvres: { _T: 26, V: "[1..5]" }, NbJDecalagePublicationAuxParents: 1 } },
    ParametresUtilisateur: { ressource: { N: "3#p", G: 3, L: "PROF Test" }, listeClasses: { _T: 24, V: [] } },
  };
  const handle = createCapturingHandle(async (request) => {
    const name = JSON.parse(String(request.content)).id as string;
    return { content: JSON.stringify({ dataSec: { data: answers[name] } }), headers: {}, status: 200 } as any;
  });
  Object.assign(handle, { information: { skipCompression: true, skipEncryption: true, aesKey: "", aesIV: "" } });
  for (const id of ["FonctionParametres", "ParametresUtilisateur"]) {
    await handle.fetcher({ url: new URL("https://demo.example/pronote/appelfonction"), method: "POST", content: JSON.stringify({ id }) } as any);
  }
  const data = userData(handle);
  assert.equal(data.acquisitionLevels.length, SCHOOL_LEVELS.length);
  assert.equal(data.publicationDelayDays, 2);
  assert.deepEqual(data.workingDays, [1, 2, 3, 4, 5]);
  assert.equal(data.parentsDelayDays, 1);
  assert.equal(levelsOf(handle).source, "school");
  // Thursday 19/11/2026 + 2 days = Saturday, moved to Monday 23/11.
  assert.deepEqual(defaultPublication(handle, new Date(2026, 10, 19)), new Date(2026, 10, 23));
});

test("lot 4: without the school's list, the levels are the client enumeration ('fallback') and no level is written", async () => {
  const { session, saves } = skillsPronote({ levels: [] });
  const context: any = { priority: 1, deadline: Date.now() + 60_000, calls: 0, route: "/competencies" };
  const result = await requestContext.run(context, () => overview(session, "", ["6-SC-603"]));
  assert.equal(result.levelsSource, "fallback");
  assert.equal(result.levels.length, 6);
  assert.equal(context.shape, "levels:missing");
  for (const dryRun of [true, false]) {
    await assert.rejects(writeCompetency(session, planOf2011(dryRun)), (error) => error instanceof HttpError && error.status === 409 && error.code === "levels_unknown");
  }
  assert.equal(saves.length, 0, "nothing sent to Pronote");
});

test("lot 4: a level the school does not use, or does not have, is refused before any write", async () => {
  const { session, saves } = skillsPronote();
  const plan = planOf2011(false);
  plan.ratings[0].level = 3;
  await assert.rejects(writeCompetency(session, plan), (error) => error instanceof HttpError && error.code === "level_inactive:3");
  plan.ratings[0].level = 42;
  await assert.rejects(writeCompetency(session, plan), (error) => error instanceof HttpError && error.code === "level_unknown:42");
  assert.equal(saves.length, 0);
});

test("lot 0: the plan of 20/11 is simulated with Pronote's default publication date and writes nothing", async () => {
  const { session, saves } = skillsPronote();
  const result = await writeCompetency(session, planOf2011(true));
  assert.equal(result.dryRun, true);
  assert.equal(saves.length, 0);
  assert.equal(result.before, null);
  assert.equal(result.after!.ratings.length, 19);
  assert.equal(result.after!.skills[0].code, "SCIE/13.4");
  assert.equal(result.publicationDefault, true);
  // 19/11/2026 is a Thursday: published the next working day, to the parents one day later.
  assert.equal(result.after!.publication! - result.after!.date!, 86400);
  assert.equal(result.after!.publicationParents! - result.after!.publication!, 86400);
});

test("lot 0: the plan of 20/11 creates the assessment, then its 19 levels, in the right group", async () => {
  const { session, saves, stored } = skillsPronote();
  const result = await writeCompetency(session, planOf2011(false));
  assert.equal(result.written, true);
  assert.equal(result.created, true);
  assert.deepEqual([result.ratingsSent, result.ratingsSaved, result.warnings], [19, 19, []]);
  assert.deepEqual(saves.map((save) => save.onglet), [56, 56]);

  // First request: the assessment alone, as the creation window of the client sends it.
  const [creation] = saves[0].data.listeEvaluations as any[];
  assert.equal(creation.E, 1);
  assert.ok(creation.N < 0);
  assert.equal(creation.listeEleves, undefined, "no student with a creation");
  assert.deepEqual(creation.Service, { N: "12#st12", G: 12, L: "SCIENCES ET TECHNOLOGIE" });
  assert.deepEqual(creation.Ressource, { N: "2#g12", G: 2, L: "6-SC-601-602" });
  assert.deepEqual(creation.DateValidation, { _T: 7, V: "19/11/2026 0:0:0" });
  assert.deepEqual(creation.DatePublication, { _T: 7, V: "20/11/2026 0:0:0" });
  assert.equal(creation.coefficient, 1);
  assert.equal(creation.Descriptif, "");
  assert.equal(creation.priseEnCompteDansBilan, true);
  assert.deepEqual(creation.listeCompetences, [{
    N: "25#i134", G: 25, L: "13.4 Interpréter un résultat, en tirer une conclusion", E: 1, coefficient: 1,
    relationESI: { N: -1002, E: 1 }, ordre: 1, palier: { N: "27#c3", G: 27, L: "Cycle 3" },
  }]);
  assert.deepEqual(saves[0].data.service, { N: "12#st12", G: 12, L: "SCIENCES ET TECHNOLOGIE" });

  // Second request: the levels on the assessment Pronote created, with its identifier and the relation of its skill.
  const created = stored.at(-1)!;
  const [levels] = saves[1].data.listeEvaluations as any[];
  assert.equal(levels.N, created.N);
  assert.equal(levels.E, undefined, "levels only: the assessment itself is not modified");
  assert.equal(levels.listeCompetences, undefined);
  assert.equal(levels.listeEleves.length, 19);
  assert.deepEqual(levels.listeEleves[0], {
    N: "4#a1", G: 4, L: "ELEVEA01 Prénom", E: 2,
    listeCompetences: [{
      N: "25#i134", G: 25, L: "13.4 Interpréter un résultat, en tirer une conclusion", E: 2,
      relationESI: { N: created.skills[0].relation },
      niveauDAcquisition: { N: "16#n1", G: 1, L: "Très bonne maîtrise" },
    }],
  });

  // Read again in the right group, and only there.
  assert.equal(result.after!.resourcename, "6-SC-601-602");
  assert.equal(result.after!.ratings.length, 19);
  assert.deepEqual(result.after!.ratings.slice(0, 3).map((rating) => rating.level), [1, 2, 4]);
  const first = await overview(session, "", ["6-SC-601-602"]);
  const second = await overview(session, "", ["6-SC-603"]);
  assert.ok(first.items.some((item) => item.id === result.after!.id && item.title.startsWith("S4")));
  assert.ok(!second.items.some((item) => item.title.startsWith("S4")));

  // The same plan again: the assessment is designated by its id, only changed levels would be sent.
  const again = await writeCompetency(session, { ...planOf2011(false), assessment: result.after!.id, ratings: [{ student: "ELEVEA02 Prénom", skill: "SCIE/13.4", level: 6 }] });
  assert.equal(again.created, false);
  assert.equal(again.after!.ratings.find((rating) => rating.student === "ELEVEA02 Prénom")!.level, 6);
  assert.equal(stored.filter((item) => item.L.startsWith("S4")).length, 1, "no duplicate");
});

test("lot 0: creation with a publication date far away, and with one before the assessment (moved to its day)", async () => {
  const { session, saves } = skillsPronote();
  const later = await writeCompetency(session, { ...planOf2011(false), publication: Math.floor(Date.UTC(2027, 5, 30, 12) / 1000) });
  assert.equal(later.publicationDefault, false);
  assert.deepEqual((saves[0].data.listeEvaluations as any[])[0].DatePublication, { _T: 7, V: "30/6/2027 0:0:0" });
  assert.equal(later.after!.publication! > later.after!.date! + 200 * 86400, true);
  const early = await writeCompetency(session, { ...planOf2011(true), title: "Autre", publication: NOON_19_NOV - 5 * 86400 });
  assert.equal(early.after!.publication, early.after!.date);
});

test("lot 0: a refusal of Pronote comes back with its own message", async () => {
  const { session } = skillsPronote({ refusal: "La période est clôturée pour la saisie des évaluations." });
  await assert.rejects(
    writeCompetency(session, planOf2011(false)),
    (error) => error instanceof HttpError && error.status === 409
      && error.code === "pronote_refused:Saisie impossible : La période est clôturée pour la saisie des évaluations.",
  );
});

test("lot 0: a save Pronote ignores is reported with the shape of its answer, never as 'nothing found' alone", async () => {
  // Tab 56 refused for the list: the save is still signed 56 and this Pronote ignores nothing; simulate an ignored save
  // by asking a skill of another referential element Pronote does not know.
  const { session } = skillsPronote();
  const handlers = session as any;
  const original = handlers.fetcher;
  handlers.fetcher = async (request: { content?: string }) => {
    const body = JSON.parse(String(request.content ?? "{}"));
    if (body.id === "SaisieEvaluations") return { content: JSON.stringify({ dataSec: { data: {} } }), headers: {}, status: 200 };
    return original(request);
  };
  const context: any = { priority: 0, deadline: Date.now() + 60_000, calls: 0, route: "/competencies" };
  await assert.rejects(
    requestContext.run(context, () => writeCompetency(session, planOf2011(false))),
    (error) => error instanceof HttpError && error.status === 502 && error.code === "assessment_not_saved"
      && error.extra.detail === "save:;report:-",
  );
  assert.equal(context.shape, "save:;report:-");
});

test("lot 0: Pronote's message when the creation is impossible for the service is relayed before any write", async () => {
  const { session, saves } = skillsPronote();
  const original = (session as any).fetcher;
  (session as any).fetcher = async (request: { content?: string }) => {
    const body = JSON.parse(String(request.content ?? "{}"));
    if (body.id === "ListeEvaluations") {
      return { content: JSON.stringify({ dataSec: { data: { listeEvaluations: { _T: 24, V: [] }, messageCreationImpossible: "Aucun référentiel pour ce service." } } }), headers: {}, status: 200 };
    }
    return original(request);
  };
  await assert.rejects(writeCompetency(session, planOf2011(true)), (error) => error instanceof HttpError && error.code === "pronote_refused:Aucun référentiel pour ce service.");
  assert.equal(saves.length, 0);
});

test("levels of an existing assessment: one request, only the changed students, deletion read again", async () => {
  const { session, saves, stored } = skillsPronote();
  const target = (await overview(session, "", ["6-SC-603"])).items.find((item) => item.title === "Evaluation classeur")!;
  const result = await writeCompetency(session, {
    assessment: target.id, service: SERVICE_3, period: "", dryRun: false,
    ratings: [{ student: "eleveb03 prénom", skill: target.skills[0].id, level: 4, observation: "À revoir", published: true }],
  });
  assert.equal(saves.length, 1);
  const [sent] = saves[0].data.listeEvaluations as any[];
  assert.equal(sent.E, undefined);
  assert.equal(sent.listeEleves.length, 1);
  assert.equal(sent.listeEleves[0].listeCompetences[0].observation, "À revoir");
  assert.equal(sent.listeEleves[0].listeCompetences[0].observationPubliee, true);
  assert.equal(saves[0].data.listeFichiers, undefined);
  assert.equal(result.after!.ratings.find((rating) => rating.student === "ELEVEB03 Prénom")!.level, 4);
  assert.deepEqual([result.created, result.ratingsSent, result.ratingsSaved], [false, 1, 1]);

  const removed = await writeCompetency(session, { assessment: target.id, service: SERVICE_3, period: "", delete: true, dryRun: false });
  assert.equal(removed.after, null);
  assert.equal((saves[1].data.listeEvaluations as any[])[0].E, 3);
  assert.ok(!stored.some((item) => item.L === "Evaluation classeur"));
});

test("a skill added to an existing assessment: the skill first, its levels in a second request", async () => {
  const { session, saves } = skillsPronote();
  const target = (await overview(session, "", ["6-SC-603"])).items.find((item) => item.title === "Evaluation classeur")!;
  const result = await writeCompetency(session, {
    assessment: target.id, service: SERVICE_3, period: "", dryRun: false,
    skills: [target.skills[0].id, "SCIE/13.4"],
    ratings: [{ student: "ELEVEB01 Prénom", skill: "SCIE/13.4", level: 2 }],
  });
  assert.equal(saves.length, 2);
  const [first] = saves[0].data.listeEvaluations as any[];
  assert.equal(first.E, 2);
  assert.equal(first.listeEleves, undefined);
  assert.deepEqual(first.listeCompetences.map((skill: any) => [skill.N, skill.E, skill.ordre]), [["25#i134", 1, 2]]);
  assert.equal(result.after!.skills.length, 2);
  assert.equal(result.ratingsSaved, 1);
});

test("referential of a service: flat list of ListePiliers, element of each item, session identifiers kept inside", async () => {
  const { session } = skillsPronote();
  const result = await referential(session, SERVICE_3);
  assert.equal(result.available, true);
  const item = result.items.find((entry) => entry.code === "SCIE/13.4")!;
  assert.equal(item.name, "Interpréter un résultat, en tirer une conclusion");
  assert.equal(item.element, "13 Pratiquer des démarches scientifiques");
  assert.equal(item.cycle, "Cycle 3");
  assert.deepEqual(Object.keys(item).sort(), ["code", "cycle", "domain", "domainCode", "element", "id", "name", "number"]);
  assert.ok(result.items.some((entry) => entry.code === "Comp/9.1"));
  assert.equal(session.calls.find((call) => call.name === "ListePiliers")!.onglet, 56);
});

test("a mobile session without the school's levels says so in the session, levels of another session are not mixed", () => {
  const { session } = skillsPronote();
  const { session: other } = skillsPronote({ levels: [] });
  assert.equal(levelsOf(session).source, "school");
  assert.equal(levelsOf(other).source, "fallback");
  rememberUserData(other, { acquisitionLevels: [{ N: "0", G: 0, L: "" }] });
  assert.equal(levelsOf(other).source, "fallback", "the 'none' entry alone is not a list");
});

test("lot 3: the grade context with competencies=1 adds the services of the skills tab, with their kinds", async () => {
  const { context } = await import("../src/teacher/grades.js");
  const { session } = skillsPronote();
  const plain = await context(session);
  assert.deepEqual(plain.services, [], "the grade context alone has no service for the 6e");
  const full = await context(session, true);
  assert.deepEqual(full.services.map((service) => [service.id, service.type, service.kinds, service.periods]), [
    [SERVICE_12, "group", ["competencies"], ["p:Trimestre 1"]],
    [SERVICE_3, "group", ["competencies"], ["p:Trimestre 1"]],
  ]);
  assert.equal(full.services[0].resourceid, "g:6-SC-601-602");
});
