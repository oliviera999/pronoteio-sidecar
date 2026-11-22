import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// First: the helper sets the signing secret before config.ts is loaded.
import { buildApp, createSession, get, post, signedHeaders } from "./helpers/app.js";
import { collectTiming, resetCollects } from "../src/collect.js";
import { AccessLog } from "../src/logs.js";
import { limiterOf } from "../src/pronote/limiter.js";
import { rememberUserData } from "../src/pronote/userdata.js";
import { fakeSession, type FakeCall } from "./fake-session.js";

const { readCache } = await import("../src/cache.js");
const { HttpError } = await import("../src/errors.js");
const { forgetSession, sessionById } = await import("../src/session.js");
const { sessionState } = await import("../src/sessionState.js");
const { accountKey } = await import("../src/tokenStore.js");
const { webLoginGuard } = await import("../src/webLoginGuard.js");

/*
 * Grouped read of a class (0.16.0, docs/olutionsuivi/CONTRAT_SIDECAR.md 7.4 and 7.5). Fake Pronote sessions, generated
 * names and values; the shapes of the four new functions are those the decoders suppose (test/suivi.test.ts).
 */
type App = Awaited<ReturnType<typeof buildApp>>;
type Handlers = Record<string, (data: any, call: FakeCall) => any>;

// Short times: no pause between two reads, 10 ms for a second of retry_after, a look every 15 ms while waiting.
Object.assign(collectTiming, { pauseMs: 0, secondMs: 10, pollMs: 15 });

const typed = <T>(items: T[]) => ({ _T: 24, V: items });
const note = (value: string) => ({ _T: 10, V: value });
const date = (value: string) => ({ _T: 7, V: value });
const denied = { Erreur: { Titre: "Vos droits sont insuffisants pour effectuer cette opération." } };

const period = { N: "1#t1", L: "Trimestre 1", G: 2 };
const classT06 = { id: "1#c1", label: "T06", genre: 1 as const, taught: true, principal: true };
const students = Array.from({ length: 31 }, (_, i) => ({ N: `4#e${i + 1}`, L: `ELEVE${String(i + 1).padStart(2, "0")} Prénom`, G: 4 }));
const ids = students.map((student) => `e:${student.L}`);
const SUBJECTS = ["PHILOSOPHIE", "MATHEMATIQUES"];

/** Pronote of a main teacher: every function of the nine blocks answers. */
const everything = (): Handlers => ({
  ListeEleves: () => ({ listeEleves: typed(students) }),
  ListePeriodes: () => ({ listePeriodes: typed([period]), periodeParDefaut: { _T: 24, V: period } }),
  ListeServices: () => ({ services: typed([{ N: "5#es", matiere: { _T: 24, V: { N: "9#es", L: "ENSEIGNEMENT SCIENTIFIQUE" } },
    classe: { _T: 24, V: { N: "1#c1", L: "T06", G: 1 } } }]) }),
  PageNotes: () => ({ listeDevoirs: typed([]), listeEleves: typed([]) }),
  FicheEleve: (data) => ({ Eleve: { N: data?.Eleve?.N, L: data?.Eleve?.L, Sexe: "M" } }),
  PageBulletins: (data) => ({ ListeServices: typed([{ L: "PHILOSOPHIE", MoyenneEleve: note("12,00") }]),
    ObjetListeAppreciations: { _T: 24, V: { ListeAppreciations: typed([{ G: 0, Intitule: "Appréciation générale", L: `Bilan de ${String(data?.eleve?.L)}` }]) } } }),
  ListeAppreciations: () => ({ liste: typed([]) }),
  ResultatsClasses: () => ({
    titresColonnes: typed(SUBJECTS.map((name) => ({ ColMoy: { visible: true, titre1: " ", titre2: name, titre3: "Moy.", estPere: true } }))),
    resultats: typed(students.map((student, index) => ({ nom: student.L, position: index, periode: "Trimestre 1", moyenneGenerale: note("12,50"), lignePere: 0,
      ressource: index, rang: index + 1, notesEleve: typed(SUBJECTS.map(() => ({ ColMoy: { moyenne: note("11,00") } }))) }))),
    moyennes: typed(SUBJECTS.map(() => ({ moyenneService: note("10,20") }))),
    moyenneGeneraleClasse: note("12,10") }),
  RecapitulatifVSEleve: () => ({ listeMatiere: typed([]), listeTotal: typed([{ G: 0, L: "Absences", valeur: 2, nbDJAbsence: 3 }, { G: 1, L: "Retards", valeur: 1 }]) }),
  RecapAbsencesEleves: () => ({ ListeLignes: typed(students.map((student, index) => ({ eleve: { _T: 24, V: { N: student.N, L: student.L } }, nbRetards: index % 2,
    listeAbsences: typed(index % 5 === 0 ? [{ G: 13, DateDebut: date("05/10/2026 08:00:00"), DateFin: date("05/10/2026 09:55:00"), justifie: false }] : []) }))) }),
  DetailsPIEleve: (data) => ({ listeProjets: typed(Number(String(data?.eleve?.N).slice(3)) % 10 === 1
    ? [{ L: "PAP", commentaire: "Commentaire fictif du plan", listeAmenagements: typed([{ L: "Temps majoré" }]) }] : []) }),
  LivretScolaire: () => ({ anneeScolaire: "2026-2027", listeServices: typed([{ L: "EPS", MoyenneEleve: "15", MoyenneClasse: "13" }]) }),
  PageSuiviPluriannuel: () => ({ listeAnnees: typed([{ L: "2025-2026", moyenneGenerale: "13,42", listeMatieres: typed([{ L: "MATHEMATIQUES", moyenneEleve: "14,50" }]) }]) }),
});

const ALL_TABS = Array.from({ length: 300 }, (_, index) => index);

/** A fake Pronote session without limit of rate (the tests that need one set their own). */
const pronote = (handlers: Handlers, tabs: number[] = ALL_TABS, unlimited = true) => {
  const fake = fakeSession(handlers);
  Object.assign(fake.instance, { firstMonday: new Date(2026, 8, 7), firstDate: new Date(2026, 8, 1), lastDate: new Date(2027, 6, 3) });
  rememberUserData(fake, { resources: [classT06], tabs });
  if (unlimited) limiterOf(fake, { ratePerMinute: 0, burst: 1000, minSpacingMs: 0, maxWaitMs: 20_000 });
  return fake;
};

let accounts = 0;
const account = () => {
  const login = { url: "https://demo.example/pronote", username: `prof-collecte-${++accounts}`, deviceuuid: "device-collecte" };
  return { key: accountKey(login.url, login.username, login.deviceuuid), login };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const signed = (app: App, method: "GET" | "DELETE", url: string, session: string, web?: string) =>
  app.inject({ method, url, headers: { ...signedHeaders(method, url, "", session), ...(web ? { "x-pronoteio-web-session": web } : {}) } });

/** Polls GET /collect/:id until the state satisfies the predicate. */
const until = async (app: App, id: string, session: string, predicate: (state: any) => boolean, tries = 1500): Promise<any> => {
  let state: any = null;
  for (let i = 0; i < tries; i++) {
    const answer = await get(app, `/collect/${id}`, session);
    assert.equal(answer.statusCode, 200, answer.body);
    state = answer.json();
    if (predicate(state)) return state;
    await sleep(10);
  }
  throw new Error(`collect never reached the expected state: ${JSON.stringify(state)}`);
};

const ended = (state: any) => ["done", "partial", "failed"].includes(state.status);
const count = (fake: { calls: FakeCall[] }, name: string) => fake.calls.filter((call) => call.name === name).length;
const results = async (app: App, id: string, session: string, block: string, more = "") => (await get(app, `/collect/${id}/results?block=${block}${more}`, session)).json();

test("a class of 31 students, every block: each result has the shape of its route, merged; nothing of it in the logs", async () => {
  resetCollects();
  readCache.clear();
  const file = join(mkdtempSync(join(tmpdir(), "sidecar-collect-")), "access.log");
  const lines: string[] = [];
  const app = await buildApp({ logStream: { write: (line) => lines.push(line) }, accessLog: new AccessLog(file) });
  const fake = pronote(everything());
  const session = createSession(fake, account());
  const blocks = ["files", "reportcards", "results", "comments", "classlife", "absences", "plans", "history", "grades"];
  const created = await post(app, "/collect", { resource: "c:T06", blocks,
    options: { classlife: { sources: ["recap"], include: "absences,lateness" }, files: { include: [] }, grades: { classes: "T06" } } }, session);
  assert.equal(created.statusCode, 202, created.body);
  const { collectid, status, progress } = created.json();
  assert.match(collectid, /^[0-9a-f-]{36}$/);
  assert.ok(["queued", "running"].includes(status), status);
  assert.deepEqual(Object.keys(progress), ["done", "total", "block", "student"]);

  const state = await until(app, collectid, session, ended);
  assert.equal(state.status, "done", JSON.stringify(state.blocks));
  assert.deepEqual(Object.keys(state), ["collectid", "status", "created", "finished", "expires", "progress", "retry_after", "session", "blocks"]);
  assert.deepEqual(Object.keys(state.blocks), blocks);
  for (const block of blocks) {
    const paged = !["results", "absences", "grades"].includes(block);
    assert.deepEqual(state.blocks[block], { status: "done", reason: "", validated: false, read: paged ? 31 : 1, total: paged ? 31 : 1, remaining: 0 }, block);
  }
  // Six blocks of 31 students and three single reads.
  assert.deepEqual(state.progress, { done: 6 * 31 + 3, total: 6 * 31 + 3, block: null, student: 0 });
  assert.deepEqual([state.retry_after, state.session], [0, { mobile: "open", web: "closed", reason: "" }]);
  assert.ok(state.finished >= state.created && state.expires >= state.finished + 1790, "results kept 30 minutes after the end");

  // Each student read once per block (one call per student, two for the history).
  for (const name of ["FicheEleve", "RecapitulatifVSEleve", "DetailsPIEleve", "LivretScolaire", "PageSuiviPluriannuel"]) assert.equal(count(fake, name), 31, name);
  // Report cards: once for the block, once more for the general comments read from them.
  assert.equal(count(fake, "PageBulletins"), 62);
  assert.deepEqual([count(fake, "RecapAbsencesEleves"), count(fake, "ResultatsClasses")], [1, 1]);
  for (const student of students) assert.equal(fake.calls.filter((call) => call.name === "DetailsPIEleve" && call.data?.eleve?.N === student.N).length, 1);

  // Results: the shape of the route, items merged, read and remaining; pages of 40 items at most.
  const files = await results(app, collectid, session, "files");
  assert.deepEqual([files.available, files.items.length, files.itemsTotal, files.itemsOffset, files.itemsMore, files.total], [true, 31, 31, 0, false, 31]);
  assert.deepEqual([files.read, files.remaining, files.notFound, files.partial, files.truncated], [ids, [], [], false, false]);
  assert.deepEqual(files.items.map((item: any) => item.id), ids);
  const pageTwo = await results(app, collectid, session, "plans", "&offset=10&limit=10");
  assert.deepEqual([pageTwo.items.length, pageTwo.itemsTotal, pageTwo.itemsOffset, pageTwo.itemsMore, pageTwo.items[0].studentid], [10, 31, 10, true, ids[10]]);
  assert.deepEqual([pageTwo.available, pageTwo.validated, pageTwo.offset, pageTwo.total, pageTwo.read.length, pageTwo.remaining, pageTwo.partial], [true, false, 0, 31, 31, [], false]);
  assert.deepEqual(pageTwo.class, { id: "c:T06", name: "T06" });
  assert.equal(pageTwo.items[0].plans[0].comment, "Commentaire fictif du plan");
  assert.equal((await get(app, `/collect/${collectid}/results?block=plans&limit=41`, session)).statusCode, 400);
  const reportcards = await results(app, collectid, session, "reportcards");
  assert.deepEqual([reportcards.available, reportcards.source, reportcards.items.length, reportcards.read.length], [true, "reportcard", 31, 31]);
  const classlife = await results(app, collectid, session, "classlife");
  assert.deepEqual([classlife.available, classlife.items.length, classlife.items[30].official.summary.absences, classlife.include], [true, 31, 2, ["absences", "lateness"]]);
  const history = await results(app, collectid, session, "history");
  assert.deepEqual([history.items.length, history.items[5].years.map((year: any) => year.year), history.sources.livret.available], [31, ["2026-2027", "2025-2026"], true]);
  const absences = await results(app, collectid, session, "absences");
  assert.deepEqual([absences.available, absences.items.length, absences.items[0].events.length, absences.itemsTotal], [true, 31, 1, 31]);
  // Blocks without "items" come whole: the results of the class, the comments, the overview of the grades.
  const classResults = await results(app, collectid, session, "results");
  assert.deepEqual([classResults.available, classResults.students.length, classResults.subjects.length, classResults.itemsTotal], [true, 31, 2, undefined]);
  const comments = await results(app, collectid, session, "comments");
  assert.deepEqual([comments.available, comments.general.source, comments.students.length, comments.general.page.read.length, comments.general.page.remaining],
    [true, "reportcards", 31, 31, []]);
  assert.equal(comments.students[30].general, "Bilan de ELEVE31 Prénom");
  assert.equal(typeof (await results(app, collectid, session, "grades")), "object");
  assert.equal((await get(app, `/collect/${collectid}/results?block=autre`, session)).statusCode, 400);

  // Another session does not see the read; the same account does, whatever its session.
  const other = createSession(pronote(everything()), account());
  assert.equal((await get(app, `/collect/${collectid}`, other)).json().error, "collect_not_found");
  assert.equal((await get(app, "/collect/inconnue", session)).statusCode, 404);
  // DELETE forgets the results at once.
  const removed = await signed(app, "DELETE", `/collect/${collectid}`, session);
  assert.deepEqual(removed.json(), { collectid, cancelled: true });
  const gone = await get(app, `/collect/${collectid}`, session);
  assert.deepEqual([gone.statusCode, gone.json().error, gone.json().code], [404, "collect_not_found", "not_found"]);
  await app.close();

  // The logs: the routes of the read, never a size for the results, never the internal reads, never a value.
  const access = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual([...new Set(access.map((line) => line.route))].sort(), ["/collect", "/collect/:id", "/collect/:id/results"]);
  for (const line of access.filter((item) => item.route === "/collect/:id/results")) assert.equal(line.bytes, 0);
  const everythingLogged = `${readFileSync(file, "utf8")}\n${lines.join("\n")}`;
  for (const secret of ["PAP", "Commentaire fictif", "Temps majoré", "ELEVE01", "Prénom", "Bilan de"]) assert.equal(everythingLogged.includes(secret), false, secret);
});

test("a full queue in the middle of a block: the read waits retry_after and goes on at the first student not read", async () => {
  resetCollects();
  readCache.clear();
  const app = await buildApp({ logger: false });
  const fake = pronote(everything(), ALL_TABS, false);
  // 6 calls at once, then 20 tokens per second (a plan costs 2); an internal read waits 150 ms at most for its turn.
  const limiter = limiterOf(fake, { ratePerMinute: 1200, burst: 6, minSpacingMs: 0, maxWaitMs: 150 });
  const before = { waitMs: collectTiming.waitMs, secondMs: collectTiming.secondMs };
  // A second of retry_after lasts 40 ms here: long enough for the polls below to see the read wait.
  Object.assign(collectTiming, { waitMs: 150, secondMs: 40 });
  try {
    const session = createSession(fake, account());
    const { collectid } = (await post(app, "/collect", { resource: "c:T06", blocks: ["plans"] }, session)).json();
    let waited = false;
    const state = await until(app, collectid, session, (current) => {
      waited = waited || current.retry_after > 0;
      return ended(current);
    });
    assert.equal(state.status, "done", JSON.stringify(state));
    assert.deepEqual(state.blocks.plans, { status: "done", reason: "", validated: false, read: 31, total: 31, remaining: 0 });
    assert.ok(limiter.stats().refused >= 3, `the queue refused calls: ${limiter.stats().refused}`);
    assert.equal(waited, true, "retry_after was shown while the read waited");
    // Nothing lost, nothing read twice: one call per student, in roster order.
    const called = fake.calls.filter((call) => call.name === "DetailsPIEleve").map((call) => call.data?.eleve?.N);
    assert.deepEqual(called, students.map((student) => student.N));
    const plans = await results(app, collectid, session, "plans");
    assert.deepEqual(plans.items.map((item: any) => item.studentid), ids);
    assert.deepEqual([plans.read, plans.remaining, plans.partial, plans.retry_after], [ids, [], false, 0]);
  } finally {
    Object.assign(collectTiming, before);
    await app.close();
  }
});

test("one function fails, another is refused, a shape is unknown: their blocks say so, the others are done and readable", async () => {
  resetCollects();
  readCache.clear();
  const app = await buildApp({ logger: false });
  const fake = pronote({ ...everything(), DetailsPIEleve: () => denied, RecapAbsencesEleves: () => ({ Erreur: { Titre: "Erreur inattendue pour ELEVE01 Secret" } }),
    ResultatsClasses: () => ({ autre: { lignes: [{ nom: "ELEVE01 Secret" }] } }), LivretScolaire: () => ({ livretInconnu: { texte: "Livret secret" } }) });
  const session = createSession(fake, account());
  const { collectid } = (await post(app, "/collect", { resource: "c:T06", period: "p:Trimestre 1", blocks: ["plans", "absences", "results", "history", "files", "plans"] },
    session)).json();
  const state = await until(app, collectid, session, ended);
  assert.equal(state.status, "partial", "an error may be worth another read");
  assert.deepEqual(Object.keys(state.blocks), ["plans", "absences", "results", "history", "files"], "a block asked twice is read once");
  assert.deepEqual(Object.fromEntries(Object.entries(state.blocks).map(([name, block]: [string, any]) => [name, [block.status, block.reason, block.read]])), {
    plans: ["unavailable", "access_denied", 0], absences: ["failed", "pronote_error", 0], results: ["unavailable", "format_unknown", 0],
    history: ["done", "", 31], files: ["done", "", 31] });
  assert.deepEqual(state.progress, { done: 31 + 1 + 1 + 31 + 31, total: 31 + 1 + 1 + 31 + 31, block: null, student: 0 });
  // Refused: one call, nothing else asked; an error of Pronote: asked once more, no further.
  assert.deepEqual([count(fake, "DetailsPIEleve"), count(fake, "RecapAbsencesEleves"), count(fake, "LivretScolaire")], [1, 2, 1]);
  const plans = await results(app, collectid, session, "plans");
  assert.deepEqual([plans.available, plans.reason, plans.onglet, plans.items], [false, "access_denied", 105, []]);
  assert.deepEqual(await results(app, collectid, session, "absences"), { available: false, reason: "pronote_error", validated: false });
  const unknown = await results(app, collectid, session, "results");
  assert.deepEqual([unknown.available, unknown.reason, unknown.shape[0]], [false, "format_unknown", "autre: object"]);
  const history = await results(app, collectid, session, "history");
  assert.deepEqual([history.available, history.items.length, history.sources.livret.reason, history.sources.multiyear.available], [true, 31, "format_unknown", true]);
  assert.deepEqual(history.sources.livret.shape, ["livretInconnu: object", "livretInconnu.texte: string"]);
  assert.equal((await results(app, collectid, session, "files")).items.length, 31);
  assert.equal((await get(app, `/collect/${collectid}/results?block=grades`, session)).json().error, "collect_block_not_found");
  assert.equal(JSON.stringify([plans, unknown, history]).toLowerCase().includes("secret"), false);

  // Requests refused before any read: unknown block or include, a class the session does not know.
  assert.equal((await post(app, "/collect", { resource: "c:T06", blocks: ["autre"] }, session)).statusCode, 400);
  assert.equal((await post(app, "/collect", { resource: "c:T06", blocks: [] }, session)).statusCode, 400);
  assert.equal((await post(app, "/collect", { resource: "c:T06", blocks: ["files"], options: { files: { include: "sante" } } }, session)).json().error, "invalid_include:sante");
  assert.equal((await post(app, "/collect", { resource: "c:T06", blocks: ["classlife"], options: { classlife: { from: 10, to: 5 } } }, session)).json().error, "range_too_large");
  assert.equal((await post(app, "/collect", { resource: "c:INCONNUE", blocks: ["files"] }, session)).statusCode, 404);
  assert.equal((await post(app, "/collect", { resource: "c:T06", blocks: ["files"] }, "inconnue")).json().error, "session_expired");
  await app.close();
});

/** Mobile session without tab 105 (roster, files, plans) and its web session; "cut" closes the web session at a call. */
const twoSpaces = (cutAt = 0) => {
  const who = account();
  const mobile = pronote(everything(), ALL_TABS.filter((tab) => tab !== 105));
  let calls = 0;
  const web = pronote({ ...everything(), DetailsPIEleve: (data, call) => {
    calls++;
    return cutAt > 0 && calls >= cutAt ? { Erreur: { Titre: "Vous avez été déconnecté." } } : everything().DetailsPIEleve(data, call);
  } });
  const main = createSession(mobile, who, { space: "mobile" });
  const webId = createSession(web, who, { space: "web" });
  return { who, mobile, web, main, webId };
};

test("the web session closes during the read: waiting with reopen_required, then the read resumes where it stopped", async () => {
  resetCollects();
  readCache.clear();
  webLoginGuard.reset();
  const app = await buildApp({ logger: false });
  // The web session answers 25 plans, then Pronote closes it.
  const { who, mobile, web, main, webId } = twoSpaces(26);
  const info = (await signed(app, "GET", "/session/info", main, webId)).json();
  assert.deepEqual(info.state, { mobile: "open", web: "open", reason: "", retry_after: 0 });

  const created = await app.inject({ method: "POST", url: "/collect", payload: JSON.stringify({ resource: "c:T06", blocks: ["plans", "grades"] }),
    headers: { ...signedHeaders("POST", "/collect", JSON.stringify({ resource: "c:T06", blocks: ["plans", "grades"] }), main), "x-pronoteio-web-session": webId } });
  assert.equal(created.statusCode, 202, created.body);
  const { collectid } = created.json();
  const waiting = await until(app, collectid, main, (state) => state.status === "waiting" || ended(state));
  assert.equal(waiting.status, "waiting", JSON.stringify(waiting));
  assert.deepEqual(waiting.session, { mobile: "open", web: "reopen_required", reason: "web_session_expired" });
  // The first page (20 students) is kept; the block that needs no web session went on and is readable.
  assert.deepEqual(waiting.blocks.plans, { status: "pending", reason: "", validated: false, read: 20, total: 31, remaining: 11 });
  assert.equal(waiting.blocks.grades.status, "done");
  assert.deepEqual(waiting.progress, { done: 21, total: 32, block: null, student: 0 });
  assert.equal((await get(app, `/collect/${collectid}/results?block=grades`, main)).statusCode, 200);
  const early = await get(app, `/collect/${collectid}/results?block=plans`, main);
  assert.deepEqual([early.statusCode, early.json().error, early.json().code, early.json().collectid], [409, "collect_block_not_ready", "collect_running", collectid]);
  // The grades were read by the mobile session; the plans never were.
  assert.deepEqual([count(mobile, "DetailsPIEleve"), count(mobile, "ListeEleves"), count(mobile, "ListeServices") > 0], [0, 0, true]);
  assert.deepEqual((await get(app, "/session/info", main)).json().state, { mobile: "open", web: "reopen_required", reason: "web_session_expired", retry_after: 0 });

  // One grouped read per account: a second one is refused with the id of the read in progress.
  const second = await post(app, "/collect", { resource: "c:T06", blocks: ["grades"] }, main);
  assert.deepEqual([second.statusCode, second.json().error, second.json().code, second.json().collectid], [409, "collect_running", "collect_running", collectid]);
  assert.equal(typeof second.json().message, "string");

  // The teacher (or Moodle) opens the web session again: the read finds it by itself and resumes.
  const again = pronote(everything());
  createSession(again, who, { space: "web" });
  const state = await until(app, collectid, main, ended);
  assert.equal(state.status, "done", JSON.stringify(state));
  assert.deepEqual(state.blocks.plans, { status: "done", reason: "", validated: false, read: 31, total: 31, remaining: 0 });
  assert.deepEqual(state.session, { mobile: "open", web: "open", reason: "" });
  // The 20 students of the first page are not read again: the new session reads from the 21st.
  assert.deepEqual(again.calls.filter((call) => call.name === "DetailsPIEleve").map((call) => call.data?.eleve?.N), students.slice(20).map((student) => student.N));
  assert.equal(count(web, "DetailsPIEleve"), 26);
  const plans = await results(app, collectid, main, "plans");
  assert.deepEqual([plans.items.map((item: any) => item.studentid), plans.remaining], [ids, []]);
  // The read ended: another one may start.
  const next = await post(app, "/collect", { resource: "c:T06", blocks: ["grades"] }, main);
  assert.equal(next.statusCode, 202, next.body);
  await until(app, next.json().collectid, main, ended);
  await app.close();
});

test("the web session never comes back: the read ends partial, what was read stays readable", async () => {
  resetCollects();
  readCache.clear();
  webLoginGuard.reset();
  const app = await buildApp({ logger: false });
  const before = collectTiming.waitingMaxMs;
  collectTiming.waitingMaxMs = 120;
  try {
    const { main, webId } = twoSpaces(26);
    const body = JSON.stringify({ resource: "c:T06", blocks: ["plans", "history"] });
    const created = await app.inject({ method: "POST", url: "/collect", payload: body,
      headers: { ...signedHeaders("POST", "/collect", body, main), "x-pronoteio-web-session": webId } });
    const { collectid } = created.json();
    const state = await until(app, collectid, main, ended);
    assert.equal(state.status, "partial");
    // The plans stopped after a page; the history (roster on the web session too) was never read.
    assert.deepEqual(state.blocks.plans, { status: "partial", reason: "web_session_required", validated: false, read: 20, total: 31, remaining: 11 });
    assert.deepEqual(state.blocks.history, { status: "unavailable", reason: "web_session_required", validated: false, read: 0, total: 31, remaining: 31 });
    assert.equal(state.session.web, "reopen_required");
    const plans = await results(app, collectid, main, "plans");
    assert.deepEqual([plans.available, plans.reason, plans.items.length, plans.read, plans.remaining, plans.partial], [true, "web_session_required", 20, ids.slice(0, 20),
      ids.slice(20), true]);
    assert.deepEqual(await results(app, collectid, main, "history"), { available: false, reason: "web_session_required", validated: false });
  } finally {
    collectTiming.waitingMaxMs = before;
    await app.close();
  }
});

test("without web session for a function that needs one: the block waits, and DELETE cancels the read", async () => {
  resetCollects();
  readCache.clear();
  webLoginGuard.reset();
  const app = await buildApp({ logger: false });
  const who = account();
  const mobile = pronote(everything(), ALL_TABS.filter((tab) => tab !== 138));
  const main = createSession(mobile, who, { space: "mobile" });
  const body = JSON.stringify({ resource: "c:T06", blocks: ["absences"] });
  // The client says it can open a web session (X-Pronoteio-Web: 1) but has none: the call is not sent to the mobile session.
  const created = await app.inject({ method: "POST", url: "/collect", payload: body, headers: { ...signedHeaders("POST", "/collect", body, main), "x-pronoteio-web": "1" } });
  const { collectid } = created.json();
  const waiting = await until(app, collectid, main, (state) => state.status === "waiting" || ended(state));
  assert.deepEqual([waiting.status, waiting.session.web, waiting.blocks.absences.status], ["waiting", "closed", "pending"]);
  assert.equal(count(mobile, "RecapAbsencesEleves"), 0, "never sent to the session that lacks the tab");
  assert.deepEqual((await signed(app, "DELETE", `/collect/${collectid}`, main)).json(), { collectid, cancelled: true });
  assert.equal((await get(app, `/collect/${collectid}`, main)).statusCode, 404);
  // Cancelled: the account may start another read at once.
  const next = await post(app, "/collect", { resource: "c:T06", blocks: ["grades"] }, main);
  assert.equal(next.statusCode, 202, next.body);
  await until(app, next.json().collectid, main, ended);
  await app.close();
});

test("state of the sessions of an account: open, closed, reopen_required, pin_required, backoff", () => {
  webLoginGuard.reset();
  const who = account();
  const main = createSession(pronote(everything()), who, { space: "mobile" });
  const state = (web = "") => sessionState({ main, web }, who.key);
  assert.deepEqual(state(), { mobile: "open", web: "closed", reason: "", retry_after: 0 });
  assert.deepEqual(sessionState({ main, web: "" }, null).web, "closed", "a session without account knows nothing more");
  // The last web login needed the teacher (PIN): nothing to try without them.
  webLoginGuard.recordFailure(who.key, new HttpError(409, "pin_required"));
  assert.deepEqual(state(), { mobile: "open", web: "pin_required", reason: "pin_required", retry_after: 0 });
  // The teacher typed it: a web session is open, sent or not with the request.
  const web = createSession(pronote(everything()), who, { space: "web" });
  assert.deepEqual([state(web).web, state().web, state("inconnue").web], ["open", "open", "open"]);
  // Pronote closed it: a login without PIN may be sent (the failure is older than the session).
  forgetSession(sessionById(web));
  assert.deepEqual(state(web), { mobile: "open", web: "reopen_required", reason: "web_session_expired", retry_after: 0 });
  // A new login asks the PIN again, then Pronote refuses a login: back-off, with its delay.
  webLoginGuard.now = () => Date.now() + 5_000;
  webLoginGuard.recordFailure(who.key, new HttpError(409, "bad_pin"));
  assert.deepEqual([state().web, state().reason], ["pin_required", "bad_pin"]);
  webLoginGuard.recordFailure(who.key, new Error("refus de Pronote"));
  assert.deepEqual(state(), { mobile: "open", web: "backoff", reason: "web_login_backoff", retry_after: 60 });
  // The main session gone: said first, whatever the web session.
  forgetSession(sessionById(main));
  assert.deepEqual([state().mobile, state().reason, state().web], ["closed", "session_expired", "backoff"]);
  webLoginGuard.reset();
});
