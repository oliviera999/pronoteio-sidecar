import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as pawnote from "pawnote";
import { rememberUserData } from "../src/pronote/userdata.js";
import { fakeSession, type FakeCall } from "./fake-session.js";
import { buildApp, createSession, signedHeaders } from "./helpers/app.js";

const { readCache } = await import("../src/cache.js");
const { accountKey } = await import("../src/tokenStore.js");
const { gridFrom } = await import("../src/teacher/subjectReferential.js");
const { webFetcher, WEB_USER_AGENT } = await import("../src/pronote/compat.js");

/*
 * Mobile space or web Espace Professeurs (0.10.0). Case of 18/11/2026: a token login opens the mobile space (38 tabs),
 * without the skills tabs (55, 56, 65, 199, 200), the report cards (4, 13, 25, 27) nor the transcript (12) of the web
 * Espace Professeurs (158 tabs). Tabs of test/fixtures/session-tabs.json; generated names; Pronote answered by
 * fake-session.ts. NOT VALIDATED on a real server.
 */
const tabs = JSON.parse(readFileSync(new URL("./fixtures/session-tabs.json", import.meta.url), "utf8")) as { mobile: number[]; web: number[] };
const login = { url: "https://demo.example/pronote", username: "prof", deviceuuid: "device-0001" };
const account = accountKey(login.url, login.username, login.deviceuuid);

const period = { N: "1#t1", L: "Trimestre 1", G: 2 };
const subject = (label: string) => ({ _T: 24, V: { N: `9#${label}`, L: label } });
const grp = (n: string, label: string) => ({ _T: 24, V: { N: n, L: label, G: 2 } });
const cls = (n: string, label: string) => ({ _T: 24, V: { N: n, L: label, G: 1 } });
const resources = [
  { id: "2#t06", label: "T06", genre: 1 as const, taught: true, principal: false },
  { id: "3#g3", label: "6-SC-603", genre: 2 as const, taught: true, principal: false },
];

/** Answers of a teacher of T06 (grades, tab 23) and of 6-SC-603 (skills only, tab 65). */
const handlers = (calls: string[] = []) => ({
  ListePeriodes: () => ({ listePeriodes: { _T: 24, V: [period] }, periodeParDefaut: { _T: 24, V: period } }),
  "ListeServices@23": () => ({ services: { _T: 24, V: [{ N: "5#est06", matiere: subject("ES"), classe: cls("2#t06", "T06") }] } }),
  "ListeServices@65": () => ({ services: { _T: 24, V: [{ N: "5#st3", matiere: subject("SCIENCES ET TECHNOLOGIE"), groupe: grp("3#g3", "6-SC-603") }] } }),
  PageNotes: () => ({ listeDevoirs: { _T: 24, V: [] }, listeEleves: { _T: 24, V: [] } }),
  ListeEvaluations: (data: Record<string, any> | undefined) => {
    calls.push(String(data?.service?.N ?? ""));
    return String(data?.service?.N ?? "") === "5#st3"
      ? { listeEvaluations: { _T: 24, V: [{ N: "13#e3", L: "Se connecter et accéder à olution", dateValidation: { _T: 7, V: "17/11/2026" }, listeCompetences: { _T: 24, V: [] } }] } }
      : { listeEvaluations: { _T: 24, V: [] } };
  },
  PageCompetencesParEvaluation: () => ({ ListeElevesCompetences: { _T: 24, V: [] } }),
  PageEmploiDuTemps: () => ({ ListeCours: { _T: 24, V: [] } }),
  listeQCM: () => ({ listeQCM: { _T: 24, V: [] } }),
});

const sessionWith = (space: "mobile" | "web", sessionTabs: number[], extra: Record<string, (data: any, call: FakeCall) => any> = {}) => {
  const session = fakeSession({ ...handlers(), ...extra });
  Object.assign(session.instance, { firstMonday: new Date(2026, 8, 7), blocksPerDay: 10,
    endings: ["8h55", "9h55", "10h55", "11h55", "12h55", "13h55", "14h55", "15h55", "16h55", "17h55"] });
  rememberUserData(session, { resources, tabs: sessionTabs });
  return session;
};

/** Mobile session (38 tabs) and web session (158 tabs) of the same account. */
const pair = (webExtra: Record<string, (data: any, call: FakeCall) => any> = {}, webTabs = tabs.web) => {
  const mobile = sessionWith("mobile", tabs.mobile);
  const web = sessionWith("web", webTabs, webExtra);
  const mobileId = createSession(mobile, { key: account, login }, { space: "mobile", loginMode: "token" });
  const webId = createSession(web, { key: account, login }, { space: "web", loginMode: "credentials" });
  return { mobile, web, mobileId, webId };
};

type App = Awaited<ReturnType<typeof buildApp>>;

/** Signed request as local_pronoteio 0.18.0 sends it: main session, web session when given, X-Pronoteio-Web: 1. */
const send = (app: App, method: "GET" | "POST", url: string, sessions: { main: string; web?: string; announce?: boolean }, body?: unknown) => {
  const json = body === undefined ? "" : JSON.stringify(body);
  return app.inject({
    method,
    url,
    ...(json !== "" ? { payload: json } : {}),
    headers: {
      ...signedHeaders(method, url, json, sessions.main),
      ...(sessions.announce === false ? {} : { "x-pronoteio-web": "1" }),
      ...(sessions.web ? { "x-pronoteio-web-session": sessions.web } : {}),
    },
  });
};

test("a function of the skills tabs asks for the web session before any call to Pronote", async () => {
  readCache.clear();
  const app = await buildApp({ logger: false });
  const { mobile, mobileId } = pair();
  const answer = await send(app, "GET", "/competencies", { main: mobileId });
  assert.equal(answer.statusCode, 409, answer.body);
  assert.equal(answer.json().error, "web_session_required");
  assert.equal(answer.json().code, "web_session_required");
  // 0.13.0: the list of a service is the one of "Saisie des évaluations" (tab 56).
  assert.equal(answer.json().onglet, 56);
  assert.equal(answer.json().function, "ListeEvaluations");
  assert.equal(mobile.calls.length, 0, "no call sent to Pronote");
  // A write too: refused before any call, so the client may send it again with the web session.
  const write = await send(app, "POST", "/competencies", { main: mobileId },
    { service: "s:SCIENCES ET TECHNOLOGIE|6-SC-603", period: "p:Trimestre 1", title: "T", date: 1795000000, dryRun: true });
  assert.equal(write.statusCode, 409, write.body);
  assert.equal(mobile.calls.length, 0);
  await app.close();
});

test("with the web session, a skills read runs entirely on it; the timetable stays on the mobile session", async () => {
  readCache.clear();
  const app = await buildApp({ logger: false });
  const { mobile, web, mobileId, webId } = pair();
  const answer = await send(app, "GET", "/competencies", { main: mobileId, web: webId });
  assert.equal(answer.statusCode, 200, answer.body);
  const body = answer.json();
  assert.equal(body.available, true);
  // The group of 6e assessed by skills only (tab 65) is listed: it is only visible in the web space.
  const sixth = body.services.find((item: any) => item.name === "SCIENCES ET TECHNOLOGIE - 6-SC-603");
  assert.deepEqual(sixth?.kinds, ["competencies"]);
  assert.equal(body.items[0].title, "Se connecter et accéder à olution");
  assert.equal(mobile.calls.length, 0, "nothing on the mobile session");
  assert.ok(web.calls.some((call) => call.name === "ListeServices" && call.onglet === 65));
  assert.ok(web.calls.some((call) => call.name === "ListeEvaluations"));

  const before = web.calls.length;
  const timetable = await send(app, "GET", "/notebook?from=1795000000&to=1795600000", { main: mobileId, web: webId });
  assert.equal(timetable.statusCode, 200, timetable.body);
  assert.ok(mobile.calls.some((call) => call.name === "PageEmploiDuTemps" && call.onglet === 16));
  assert.equal(web.calls.length, before, "tab 16 open in the mobile session: no web call");
  await app.close();
});

test("a client that announces nothing keeps the 0.9.0 behaviour; the grades overview never asks for the web session", async () => {
  readCache.clear();
  const app = await buildApp({ logger: false });
  const { mobile, mobileId } = pair();
  // local_pronoteio older than 0.18.0: the call is sent on the mobile session, Pronote's refusal is relayed.
  const old = await send(app, "GET", "/competencies", { main: mobileId, announce: false });
  assert.equal(old.statusCode, 200, old.body);
  assert.ok(mobile.calls.some((call) => call.name === "ListeEvaluations"));
  // Grades overview: the services of tab 65 are an enrichment, skipped on the mobile session (no 409).
  readCache.clear();
  mobile.calls.length = 0;
  const grades = await send(app, "GET", "/grades/overview", { main: mobileId });
  assert.equal(grades.statusCode, 200, grades.body);
  assert.ok(!mobile.calls.some((call) => call.onglet === 65), "tab 65 not called on the mobile session");
  await app.close();
});

test("tab missing from both spaces: refusal with the space; functions known to answer without their tab stay mobile", async () => {
  readCache.clear();
  const app = await buildApp({ logger: false });
  const { web, mobileId, webId } = pair({}, tabs.web.filter((tab) => tab !== 200));
  const answer = await send(app, "GET", "/competencies/referential/subjects", { main: mobileId, web: webId });
  assert.equal(answer.statusCode, 200, answer.body);
  assert.deepEqual([answer.json().available, answer.json().reason, answer.json().onglet, answer.json().space],
    [false, "access_denied", 200, "web"]);
  assert.equal(web.calls.length, 0);

  // listeQCM (tab 86) answers in the mobile session although tab 86 is not listed (PRONOTEIO_MOBILE_WITHOUT_TAB).
  const mobile = sessionWith("mobile", tabs.mobile.filter((tab) => tab !== 86));
  const id = createSession(mobile, { key: `${account}-2`, login }, { space: "mobile" });
  const quizzes = await send(app, "GET", "/quizzes", { main: id });
  assert.equal(quizzes.statusCode, 200, quizzes.body);
  assert.ok(mobile.calls.some((call) => call.name === "listeQCM"));
  await app.close();
});

test("expired web session: web_session_expired, the main session is kept", async () => {
  readCache.clear();
  const app = await buildApp({ logger: false });
  const { mobileId } = pair();
  const answer = await send(app, "GET", "/competencies", { main: mobileId, web: "session-web-inconnue" });
  assert.equal(answer.statusCode, 401, answer.body);
  assert.equal(answer.json().error, "web_session_expired");
  assert.equal(answer.json().code, "web_session_expired");
  const timetable = await send(app, "GET", "/notebook?from=1795000000&to=1795600000", { main: mobileId });
  assert.equal(timetable.statusCode, 200, "main session still open");
  await app.close();
});

test("session information: space, login mode and tabs of the web session", async () => {
  readCache.clear();
  const app = await buildApp({ logger: false });
  const { mobileId, webId } = pair();
  const info = await send(app, "GET", "/session/info", { main: mobileId, web: webId });
  assert.equal(info.statusCode, 200, info.body);
  assert.equal(info.json().space, "mobile");
  assert.equal(info.json().login, "token");
  assert.equal(info.json().tabs.length, 38);
  assert.equal(info.json().webtabs.length, 158);
  assert.equal(info.json().functions.competencySubjectReferential.onglet, 200);
  const alone = await send(app, "GET", "/session/info", { main: webId });
  assert.equal(alone.json().space, "web");
  assert.equal(alone.json().login, "credentials");
  assert.equal(alone.json().webtabs, undefined);
  await app.close();
});

test("web login: the token is refused without any call, the password goes to professeur.html as a desktop browser", async () => {
  const lines: string[] = [];
  const app = await buildApp({ logStream: { write: (line: string) => void lines.push(line) } });
  const body = { ...login, space: "web", token: "JetonMobile-Fictif" };
  const json = JSON.stringify(body);
  const refused = await app.inject({ method: "POST", url: "/session/login", payload: json, headers: signedHeaders("POST", "/session/login", json) });
  assert.equal(refused.statusCode, 401, refused.body);
  assert.equal(refused.json().error, "web_token_refused");
  assert.equal(refused.json().code, "login_failed");
  assert.doesNotMatch(refused.body, /JetonMobile/);
  await app.close();
  assert.ok(lines.length > 0, "the request was logged");
  assert.doesNotMatch(lines.join("\n"), /JetonMobile|MotDePasse/, "no credential in the logs");

  // Patched Pawnote (tools/patch-pawnote.mjs): web page without bydlg nor mobile cookie, desktop user agent.
  const loginWeb = (pawnote as any).pronoteioLoginWeb as (handle: any, options: any) => Promise<unknown>;
  assert.equal(typeof loginWeb, "function");
  const seen: { url: URL; headers: any }[] = [];
  const handle = pawnote.createSessionHandle(webFetcher(async (request) => {
    seen.push({ url: request.url, headers: request.headers });
    return { content: "<html>Le site n'est pas disponible</html>", headers: new Headers(), status: 200 };
  }));
  await assert.rejects(loginWeb(handle, { url: login.url, username: "prof", kind: pawnote.AccountKind.TEACHER,
    deviceUUID: login.deviceuuid, password: "MotDePasse-Fictif" }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url.pathname, "/pronote/professeur.html");
  assert.equal(seen[0].url.searchParams.get("bydlg"), null);
  assert.equal(seen[0].url.searchParams.get("login"), "true");
  const agent = seen[0].headers instanceof Headers ? seen[0].headers.get("User-Agent") : seen[0].headers["User-Agent"];
  assert.equal(agent, WEB_USER_AGENT);
  const cookie = seen[0].headers instanceof Headers ? seen[0].headers.get("Cookie") : seen[0].headers.Cookie;
  assert.ok(!String(cookie ?? "").includes("appliMobile"));

  // The mobile login still opens mobile.professeur.html.
  const mobileSeen: URL[] = [];
  const mobileHandle = pawnote.createSessionHandle(async (request) => {
    mobileSeen.push(request.url);
    return { content: "<html>Le site n'est pas disponible</html>", headers: new Headers(), status: 200 };
  });
  await assert.rejects(pawnote.loginCredentials(mobileHandle, { url: login.url, username: "prof", kind: pawnote.AccountKind.TEACHER,
    deviceUUID: login.deviceuuid, password: "MotDePasse-Fictif" }));
  assert.equal(mobileSeen[0].pathname, "/pronote/mobile.professeur.html");
});

/** Grid of "SCIENCES ET TECHNOLOGIE", cycle 3: 14 significant elements, 74 items, flat list with "pere" (generated). */
const gridAnswer = () => {
  const counts = [6, 5, 5, 6, 5, 5, 5, 6, 5, 6, 5, 5, 5, 5];
  const list: Record<string, any>[] = [];
  counts.forEach((count, index) => {
    const element = `20#e${index + 1}`;
    list.push({ N: element, L: `Élément signifiant ${index + 1}`, libelleBulletin: `Bilan ${index + 1}`,
      listeDomaines: { _T: 24, V: [{ N: `16#d${index}`, L: index === 3 ? "D1.1 Comprendre, s'exprimer en utilisant la langue française" : "D4 Les systèmes naturels et les systèmes techniques" }] } });
    for (let item = 1; item <= count; item++) {
      list.push({ N: `21#i${index + 1}-${item}`, L: `Item ${index + 1}.${item}`, pere: { _T: 24, V: { N: element } },
        evaluable: !(index === 9 && item === 1), listeRestrictionsNiveaux: { _T: 24, V: [{ L: "6e" }] } });
    }
  });
  (list.find((node) => node.N === "21#i3-3") as Record<string, any>).L = ""; // Element 3, item 3: no label.
  const seventh = list.findIndex((node) => node.N === "20#e7");
  list[seventh + 1].L = "Situer l'espace étudié dans un repère";
  list[seventh + 2].L = "Situer l’espace étudié dans un repère";
  return { listeElementsCompetences: { _T: 24, V: list }, listeClasses: { _T: 24, V: [{ L: "6-SC-601-602" }, { L: "6-SC-603" }] } };
};

test("referential of a subject for a cycle (tab 200), read in Pronote's order on the web session", async () => {
  readCache.clear();
  const app = await buildApp({ logger: false });
  const cycles = { listePaliers: { _T: 24, V: [{ N: "30#c3", L: "Cycle 3" }, { N: "30#c4", L: "Cycle 4" }] } };
  const piliers = { listePiliers: { _T: 24, V: [
    { N: "31#st", L: "SCIENCES ET TECHNOLOGIE", palier: { _T: 24, V: { N: "30#c3" } } },
    { N: "31#svt", L: "SCIENCES DE LA VIE ET DE LA TERRE", palier: { _T: 24, V: { N: "30#c4" } } },
  ] } };
  const grids: Record<string, any>[] = [];
  const { mobile, web, mobileId, webId } = pair({
    ListePaliers: () => cycles,
    ListeTousPiliersDeCompetence: () => piliers,
    CompetencesGrilles: (data) => {
      grids.push(data);
      return String(data?.pilier?.N) === "31#st" ? gridAnswer() : { listeElementsCompetences: { _T: 24, V: [] } };
    },
  });
  const url = `/competencies/referential/subjects?cycle=${encodeURIComponent("Cycle 3")}&subject=${encodeURIComponent("sciences et technologie")}`;
  const answer = await send(app, "GET", url, { main: mobileId, web: webId });
  assert.equal(answer.statusCode, 200, answer.body);
  const body = answer.json();
  assert.equal(body.available, true);
  assert.equal(body.validated, false);
  assert.equal(body.cycle, "Cycle 3");
  assert.equal(body.subject, "SCIENCES ET TECHNOLOGIE");
  assert.equal(body.elements.length, 14);
  assert.equal(body.elements.reduce((sum: number, element: any) => sum + element.items.length, 0), 74);
  assert.equal(body.elements[0].id, "rs:Cycle 3|SCIENCES ET TECHNOLOGIE|1");
  assert.equal(body.elements[0].items[0].id, "ri:Cycle 3|SCIENCES ET TECHNOLOGIE|1|1");
  assert.equal(body.elements[2].items[2].name, "");
  assert.notEqual(body.elements[6].items[0].name, body.elements[6].items[1].name);
  assert.equal(body.elements[9].items[0].evaluable, false);
  assert.deepEqual(body.elements[3].domains[0], { code: "D1.1", name: "Comprendre, s'exprimer en utilisant la langue française" });
  assert.equal(body.elements[0].reportElement, "Bilan 1");
  assert.deepEqual(body.elements[0].items[0].levels, ["6e"]);
  assert.deepEqual(grids[0].palier, { N: "30#c3", L: "Cycle 3" });
  assert.deepEqual(grids[0].pilier, { N: "31#st", L: "SCIENCES ET TECHNOLOGIE" });
  assert.equal(mobile.calls.length, 0, "tab 200 is missing from the mobile session");
  assert.ok(web.calls.every((call) => call.onglet === 200 || call.name !== "CompetencesGrilles"));

  // Without a subject: the subjects of each cycle, with their counts and the classes assessed.
  readCache.clear();
  const list = await send(app, "GET", "/competencies/referential/subjects", { main: mobileId, web: webId });
  assert.equal(list.statusCode, 200, list.body);
  assert.deepEqual(list.json().subjects, [
    { cycle: "Cycle 3", name: "SCIENCES ET TECHNOLOGIE", elements: 14, items: 74, classes: ["6-SC-601-602", "6-SC-603"] },
    { cycle: "Cycle 4", name: "SCIENCES DE LA VIE ET DE LA TERRE", elements: 0, items: 0, classes: [] },
  ]);
  // Unknown subject, unknown answer shape.
  readCache.clear();
  const missing = await send(app, "GET", `/competencies/referential/subjects?cycle=Cycle%203&subject=MUSIQUE`, { main: mobileId, web: webId });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error, "subject_not_found");
  assert.equal(gridFrom({ autre: { _T: 24, V: [] } }, "Cycle 3", "X"), null);
  await app.close();
});

test("web login (0.11.1): the navigator identifier is read from the session and checked in the request", async () => {
  const { navigatorOf } = await import("../src/routes/session.js");
  assert.equal(navigatorOf({ instance: { navigatorIdentifier: "nav-1A2b3C" } } as any), "nav-1A2b3C");
  assert.equal(navigatorOf({ instance: { navigatorIdentifier: null } } as any), null);
  assert.equal(navigatorOf({ instance: { navigatorIdentifier: "a b" } } as any), null);
  assert.equal(navigatorOf({ instance: { navigatorIdentifier: "x".repeat(201) } } as any), null);
  assert.equal(navigatorOf({} as any), null);

  const app = await buildApp();
  const json = JSON.stringify({ ...login, space: "web", password: "MotDePasse-Fictif", navigator: "a b" });
  const refused = await app.inject({ method: "POST", url: "/session/login", payload: json, headers: signedHeaders("POST", "/session/login", json) });
  assert.equal(refused.statusCode, 400, refused.body);
  assert.doesNotMatch(refused.body, /MotDePasse/);
  await app.close();
});

test("0.11.2: read without the web session, no service of the skills tab is a refusal of tab 65, not an empty list", async () => {
  readCache.clear();
  const app = await buildApp({ logger: false });
  // Mobile session as Pronote answers it: tab 65 closed, its ListeServices refused (empty answer).
  const mobile = sessionWith("mobile", tabs.mobile, { "ListeServices@65": () => ({}) });
  const id = createSession(mobile, { key: `${account}-pin`, login }, { space: "mobile", loginMode: "token" });
  const answer = await send(app, "GET", "/competencies?classes=6-SC-603", { main: id, announce: false });
  assert.equal(answer.statusCode, 200, answer.body);
  assert.deepEqual([answer.json().available, answer.json().reason, answer.json().onglet, answer.json().space],
    [false, "access_denied", 65, "mobile"]);
  // A class with grade services (tab 23, open in the mobile session) is still read there.
  readCache.clear();
  const t06 = await send(app, "GET", "/competencies?classes=T06", { main: id, announce: false });
  assert.equal(t06.statusCode, 200, t06.body);
  assert.equal(t06.json().services.length, 1);
  await app.close();
});

test("0.11.3: an unexpected error of a web login gives its kind and step in the access log, never its message", async () => {
  const entries: Record<string, unknown>[] = [];
  const app = await buildApp({ logger: false, accessLog: { write: (entry: Record<string, unknown>) => void entries.push(entry) } as any });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("<html>Le site n'est pas disponible</html>", { status: 200 })) as typeof fetch;
  try {
    const json = JSON.stringify({ ...login, space: "web", password: "MotDePasse-Fictif", pin: "1234" });
    const answer = await app.inject({ method: "POST", url: "/session/login", payload: json, headers: signedHeaders("POST", "/session/login", json) });
    assert.equal(answer.statusCode, 502, answer.body);
    assert.doesNotMatch(answer.body, /MotDePasse|1234/);
  } finally {
    globalThis.fetch = realFetch;
    await app.close();
  }
  const line = entries.find((entry) => entry.route === "/session/login");
  assert.ok(line, "login logged");
  assert.equal(line.step, "web:login");
  assert.equal(typeof line.kind, "string");
  assert.match(String(line.kind), /^[\w.-]+$/);
  assert.doesNotMatch(JSON.stringify(line), /MotDePasse|1234|disponible/);
});

test("0.11.4: user rebuilt from ParametresUtilisateur when Pawnote's decoder fails, TypeError detail without data", async () => {
  const { tolerantUser, typeErrorDetail } = await import("../src/routes/session.js");
  const handle = fakeSession({});
  rememberUserData(handle, { resources, tabs: tabs.web, identity: null });
  assert.equal(tolerantUser(handle), false, "nothing captured: the error is kept");
  rememberUserData(handle, { resources, tabs: tabs.web,
    identity: { id: "3#prof", kind: 3, name: "M. PROF Fictif", establishment: "Lycée fictif" } });
  assert.equal(tolerantUser(handle), true);
  assert.equal((handle as any).user.name, "M. PROF Fictif");
  assert.equal((handle as any).user.resources[0].id, "3#prof");
  assert.equal((handle as any).user.resources[0].establishmentName, "Lycée fictif");

  let caught: unknown;
  try {
    (undefined as any).V.L;
  } catch (error) {
    caught = error;
  }
  assert.equal(typeErrorDetail(caught), "reading:V");
  assert.equal(typeErrorDetail(new TypeError("x is not a function: ELEVE Un")), "type_error");
  assert.equal(typeErrorDetail(new Error("other")), null);
});

/* 0.16.2, real case of 23/11/2026: report card comments of a 6e group (skills only, no tab 23 service). The service is
   looked for in tabs 25 and 65, missing from the mobile session: the request must be replayed on the web session
   instead of answering service_not_found. */
test("comments of a skills-only group: replayed on the web session, service found in the comments tab", async () => {
  readCache.clear();
  const app = await buildApp({ logger: false });
  const grid = { listeLignes: { _T: 24, V: [{ eleve: { _T: 24, V: { N: "46#x1", G: 4, L: "ELEVE Un" } },
    classe: cls("2#c603", "603"), service: { _T: 24, V: { N: "5#st3", L: "SCIENCES ET TECHNOLOGIE" } },
    appA: { _T: 24, V: { G: 1, estEditable: true } } }] },
    appreciationClasse: { _T: 24, V: { G: 1, titre: "Appréciation", appreciation: "", editable: true, cloture: false } } };
  const seen: string[] = [];
  const { mobile, web, mobileId, webId } = pair({
    "ListeServices@25": (data: any) => {
      seen.push(String(data?.Ressource?.N ?? ""));
      return { services: { _T: 24, V: [{ N: "5#st3", matiere: subject("SCIENCES ET TECHNOLOGIE"), groupe: grp("3#g3", "6-SC-603") }] } };
    },
    PageApprBulletin: () => grid,
  });
  const answer = await send(app, "GET", "/reports/comments?resource=c%3A6-SC-603&period=p%3ATrimestre%201", { main: mobileId, web: webId });
  assert.equal(answer.statusCode, 200, answer.body);
  const body = answer.json();
  assert.equal(body.class.name, "6-SC-603");
  assert.equal(body.service.name, "SCIENCES ET TECHNOLOGIE - 6-SC-603");
  assert.deepEqual(seen, ["3#g3"]);
  assert.equal(body.students[0].student, "ELEVE Un");
  assert.ok(web.calls.some((call) => call.name === "PageApprBulletin"));
  assert.ok(!mobile.calls.some((call) => call.name === "PageApprBulletin"));
  await app.close();
});
