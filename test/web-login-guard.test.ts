import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as pawnote from "pawnote";
import { rememberUserData } from "../src/pronote/userdata.js";
import { fakeSession } from "./fake-session.js";
import { buildApp, createSession, signedHeaders } from "./helpers/app.js";

const { readCache } = await import("../src/cache.js");
const { accountKey } = await import("../src/tokenStore.js");
const { setWebLogin } = await import("../src/routes/session.js");
const { keepAlive, setPresenceSender } = await import("../src/session.js");
const { StateStore } = await import("../src/state.js");
const { accountTag, BACKOFF_STEPS, failureKind, isRefusal, WebLoginGuard, webLoginGuard } = await import("../src/webLoginGuard.js");
const { HttpError } = await import("../src/errors.js");

/*
 * Guard of the web logins (0.15.0). Case of 21/11/2026: GET /health, GET /session/info, GET /pp/check (409
 * web_session_required), POST /session/login (web, refused by Pronote: RateLimitedError), every 3 to 4 seconds.
 * Pawnote's web login is replaced by a stub (setWebLogin): nothing ever connects to Pronote. Generated names.
 */
const tabs = JSON.parse(readFileSync(new URL("./fixtures/session-tabs.json", import.meta.url), "utf8")) as { mobile: number[]; web: number[] };
const URL_BASE = "https://demo.example/pronote";
const PASSWORD = "MotDePasse-Fictif";

type App = Awaited<ReturnType<typeof buildApp>>;
type Entry = Record<string, unknown>;

let serial = 0;
/** A fresh account for each test (the guard is keyed by account). */
const freshAccount = () => {
  const login = { url: URL_BASE, username: `prof-garde-${++serial}`, deviceuuid: "device-garde-0001" };
  return { login, account: accountKey(login.url, login.username, login.deviceuuid) };
};

/** Stub of Pawnote's web login: counts the attempts, fails with `failure()` when set, else opens a fake web session. */
const stubLogin = (options: { delay?: number } = {}) => {
  const state = {
    attempts: 0,
    running: 0,
    maxRunning: 0,
    failure: null as (() => unknown) | null,
    /** Answers of the web sessions opened: "expired" makes every call of them find the Pronote session gone. */
    expired: false,
    handles: [] as pawnote.SessionHandle[],
  };
  setWebLogin(async (handle) => {
    state.attempts++;
    state.running++;
    state.maxRunning = Math.max(state.maxRunning, state.running);
    try {
      await new Promise((resolve) => setTimeout(resolve, options.delay ?? 25));
      if (state.failure) throw state.failure();
      const fake = fakeSession({ ListePeriodes: () => ({ listePeriodes: { _T: 24, V: [] } }) });
      Object.assign(handle, fake);
      Object.assign(handle.instance, { navigatorIdentifier: `nav-${state.attempts}` });
      if (state.expired) (handle as any).fetcher = async () => ({ content: "<html>La page a expiré</html>", headers: {}, status: 200 });
      rememberUserData(handle, { resources: [], tabs: tabs.web });
      state.handles.push(handle);
      return {} as pawnote.RefreshInformation;
    } finally {
      state.running--;
    }
  });
  return state;
};

/** Mobile session of the account (38 tabs, no skills tab): GET /competencies needs the web session. */
const mobileSession = (account: string, login: { url: string; username: string; deviceuuid: string }) => {
  const session = fakeSession({});
  rememberUserData(session, { resources: [], tabs: tabs.mobile });
  return { session, id: createSession(session, { key: account, login }, { space: "mobile", loginMode: "token" }) };
};

type SendOptions = { session?: string; web?: string; origin?: string; account?: string; body?: unknown; headers?: Record<string, string> };

/** Signed request as local_pronoteio sends it (fresh nonce and signature), with the origin and account tags. */
const send = (app: App, method: "GET" | "POST", url: string, options: SendOptions = {}) => {
  const json = options.body === undefined ? "" : JSON.stringify(options.body);
  return app.inject({
    method,
    url,
    ...(json !== "" ? { payload: json } : {}),
    headers: {
      ...signedHeaders(method, url, json, options.session),
      "x-pronoteio-web": "1",
      ...(options.web ? { "x-pronoteio-web-session": options.web } : {}),
      ...(options.origin !== undefined ? { "x-pronoteio-origin": options.origin } : {}),
      ...(options.account !== undefined ? { "x-pronoteio-account": options.account } : {}),
      ...(options.headers ?? {}),
    },
  });
};

const webLogin = (app: App, login: Record<string, string>, options: SendOptions & { pin?: string; password?: string } = {}) =>
  send(app, "POST", "/session/login", { ...options,
    body: { ...login, space: "web", password: options.password ?? PASSWORD, ...(options.pin ? { pin: options.pin } : {}) } });

const start = async () => {
  readCache.clear();
  webLoginGuard.reset();
  const entries: Entry[] = [];
  const app = await buildApp({ logger: false, accessLog: { write: (entry: Entry) => void entries.push(entry) } as any });
  return { app, entries };
};

const finish = async (app: App) => {
  setWebLogin(null);
  setPresenceSender(null);
  webLoginGuard.reset();
  await app.close();
};

test("20 concurrent web logins of one account: one login reaches Pronote, the same session for all", async () => {
  const { app, entries } = await start();
  const stub = stubLogin({ delay: 60 });
  const { login } = freshAccount();
  const answers = await Promise.all(Array.from({ length: 20 }, (_, index) =>
    webLogin(app, login, { origin: `task:caller_${index}`, account: "0123456789abcdef" })));
  assert.equal(stub.attempts, 1, "exactly one login attempt");
  for (const answer of answers) assert.equal(answer.statusCode, 200, answer.body);
  const ids = new Set(answers.map((answer) => answer.json().sessionid));
  assert.equal(ids.size, 1, "the same session for the 20 requests");
  assert.deepEqual(Object.keys(answers[0].json()).sort(), ["displayname", "login", "navigator", "sessionid", "space", "tabs", "version"]);
  assert.equal(answers[0].json().space, "web");
  assert.equal(answers[0].json().tabs.length, 158);
  const lines = entries.filter((entry) => entry.route === "/session/login");
  assert.equal(lines.length, 20);
  assert.equal(new Set(lines.map((line) => line.origin)).size, 20, "each line names its caller");
  assert.ok(lines.every((line) => line.account === "0123456789abcdef"));
  assert.doesNotMatch(JSON.stringify(entries), /MotDePasse|prof-garde|demo\.example/);
  await finish(app);
});

test("20 concurrent requests to a web-only route without web session: 409 for all, no login by the sidecar", async () => {
  const { app } = await start();
  const stub = stubLogin();
  const { login, account } = freshAccount();
  const mobile = mobileSession(account, login);
  const answers = await Promise.all(Array.from({ length: 20 }, (_, index) =>
    send(app, "GET", `/competencies?n=${index}`, { session: mobile.id, origin: "mcp:get_pronote_competencies" })));
  for (const answer of answers) {
    assert.equal(answer.statusCode, 409, answer.body);
    assert.equal(answer.json().error, "web_session_required");
    assert.equal(answer.json().code, "web_session_required");
    assert.equal(answer.json().retry_after, undefined, "no back-off: answer unchanged");
    assert.equal(answer.json().backoff_until, undefined);
  }
  assert.equal(stub.attempts, 0, "the sidecar never logs in by itself");
  assert.equal(mobile.session.calls.length, 0);
  await finish(app);
});

test("refusal by Pronote: 429 web_login_backoff for every caller, no attempt before the delay, ladder 60/120/300/900/900", async () => {
  const { app, entries } = await start();
  const stub = stubLogin({ delay: 1 });
  const { login, account } = freshAccount();
  const mobile = mobileSession(account, login);
  let now = Date.now();
  webLoginGuard.now = () => now;
  stub.failure = () => new pawnote.RateLimitedError();

  const expected = [60, 120, 300, 900, 900];
  assert.deepEqual([...BACKOFF_STEPS], [60, 120, 300, 900]);
  for (const [index, delay] of expected.entries()) {
    const refused = await webLogin(app, login, { origin: "mcp:get_pronote_health" });
    assert.equal(refused.statusCode, 502, refused.body);
    assert.equal(refused.json().code, "pronote_unavailable");
    assert.equal(stub.attempts, index + 1);

    // Other callers, fresh signatures: answered by the guard, the stub is not called.
    for (const origin of ["task:sync_task", "page:local/pronoteio/push.php", "mcp:get_pronote_health"]) {
      const blocked = await webLogin(app, login, { origin });
      assert.equal(blocked.statusCode, 429, blocked.body);
      assert.deepEqual(blocked.json(), {
        error: "web_login_backoff",
        retry_after: delay,
        backoff_until: Math.ceil((now + delay * 1000) / 1000),
        code: "web_login_backoff",
        message: blocked.json().message,
      });
      assert.equal(blocked.headers["retry-after"], String(delay));
      assert.match(blocked.json().message, /Espace Professeurs web/);
    }
    assert.equal(stub.attempts, index + 1, "no attempt during the back-off");

    // A web-only route of the account says not to log in now.
    const required = await send(app, "GET", `/competencies?step=${index}`, { session: mobile.id });
    assert.equal(required.statusCode, 409, required.body);
    assert.equal(required.json().error, "web_session_required");
    assert.equal(required.json().retry_after, delay);
    assert.equal(required.json().backoff_until, Math.ceil((now + delay * 1000) / 1000));
    assert.equal(typeof required.json().onglet, "number");

    // One second before the end: still refused; at the end: one attempt is allowed.
    now += (delay - 1) * 1000;
    const late = await webLogin(app, login, { origin: "task:sync_task" });
    assert.equal(late.statusCode, 429, late.body);
    assert.equal(late.json().retry_after, 1);
    assert.equal(stub.attempts, index + 1);
    now += 1000;
  }

  // The delay is over: the login is sent, succeeds, and clears the back-off.
  stub.failure = null;
  const opened = await webLogin(app, login, { origin: "page:local/pronoteio/account.php" });
  assert.equal(opened.statusCode, 200, opened.body);
  assert.equal(stub.attempts, expected.length + 1);
  assert.deepEqual(webLoginGuard.status(account), { failures: 0, recentFailures: 0, backoffUntil: null, retryAfter: 0,
    lastFailureAt: Math.floor((now - 900_000) / 1000), lastKind: "RateLimitedError" });
  assert.equal(webLoginGuard.retryAfter(account), 0);

  // After a success the ladder starts again at its first step.
  stub.failure = () => new pawnote.SuspendedIPError();
  const again = await webLogin(app, login, { pin: "1234" });
  assert.equal(again.statusCode, 502, again.body);
  assert.equal(webLoginGuard.retryAfter(account), 60);
  assert.equal(webLoginGuard.status(account).lastKind, "SuspendedIPError");

  // Access log: the refused logins carry the kind and the step, the guarded ones the stable code; never a message.
  const lines = entries.filter((entry) => entry.route === "/session/login");
  assert.ok(lines.some((line) => line.status === 502 && line.kind === "RateLimitedError" && line.step === "web:login"));
  assert.ok(lines.some((line) => line.status === 429 && line.code === "web_login_backoff" && line.origin === "task:sync_task"));
  assert.ok(lines.every((line) => /^[0-9a-f]{12}$/.test(String(line.account))), "account tag derived by the sidecar");
  assert.ok(lines.every((line) => line.account === accountTag(account)));
  await finish(app);
});

test("interactive outcomes start no back-off; a login with a PIN goes through the back-off and extends it when refused", async () => {
  const { app } = await start();
  const stub = stubLogin({ delay: 1 });
  const { login, account } = freshAccount();
  let now = Date.now();
  webLoginGuard.now = () => now;

  // bad_credentials (401), then a token sent to the web space (401, no call): counted, never delayed.
  stub.failure = () => new pawnote.BadCredentialsError();
  for (let index = 0; index < 3; index++) {
    const bad = await webLogin(app, login);
    assert.equal(bad.statusCode, 401, bad.body);
    assert.equal(bad.json().error, "bad_credentials");
  }
  assert.equal(stub.attempts, 3, "every try reaches Pronote: no back-off on an interactive outcome");
  const token = await send(app, "POST", "/session/login", { body: { ...login, space: "web", token: "JetonMobile-Fictif" } });
  assert.equal(token.json().error, "web_token_refused");
  assert.equal(stub.attempts, 3);
  assert.deepEqual(webLoginGuard.status(account), { failures: 0, recentFailures: 4, backoffUntil: null, retryAfter: 0,
    lastFailureAt: Math.floor(now / 1000), lastKind: "web_token_refused" });
  for (const code of ["pin_required", "bad_pin", "security_setup_required", "double_auth_required", "web_token_refused", "bad_credentials"]) {
    assert.equal(isRefusal(new HttpError(code === "pin_required" ? 409 : 401, code)), false, code);
  }
  assert.equal(isRefusal(new pawnote.BadCredentialsError()), false);
  for (const error of [new pawnote.RateLimitedError(), new pawnote.SuspendedIPError(), new pawnote.PageUnavailableError(),
    new pawnote.BusyPageError(), new pawnote.AccessDeniedError(), new pawnote.AccountDisabledError(), new TypeError("x"), new Error("réseau")]) {
    assert.equal(isRefusal(error), true, (error as Error).name);
  }
  assert.equal(failureKind(new Error("message de Pronote : MARTIN Léa")), "Error");
  assert.equal(failureKind(new HttpError(409, "pin_required")), "pin_required");

  // Refusal: back-off of 60 s. A login with a PIN is still sent; refused too, it extends the back-off (120 s).
  stub.failure = () => new pawnote.RateLimitedError();
  assert.equal((await webLogin(app, login)).statusCode, 502);
  assert.equal(stub.attempts, 4);
  assert.equal((await webLogin(app, login)).statusCode, 429);
  now += 10_000;
  const pin = await webLogin(app, login, { pin: "123456" });
  assert.equal(pin.statusCode, 502, pin.body);
  assert.equal(stub.attempts, 5, "the login with a PIN reached Pronote during the back-off");
  assert.equal(webLoginGuard.retryAfter(account), 120);
  assert.equal(webLoginGuard.status(account).failures, 2);

  // Ten minutes later the recent failures are forgotten, the consecutive refusals are not.
  now += 601_000;
  assert.equal(webLoginGuard.status(account).recentFailures, 0);
  assert.equal(webLoginGuard.status(account).failures, 2);
  assert.equal(webLoginGuard.status(account).backoffUntil, null);
  await finish(app);
});

test("reuse: a second web login without PIN gets the open web session back; with a PIN, a real login", async () => {
  const { app } = await start();
  const stub = stubLogin({ delay: 40 });
  const { login } = freshAccount();
  const first = await webLogin(app, login);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().reused, undefined);
  const second = await webLogin(app, login, { origin: "task:sync_task" });
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(stub.attempts, 1, "no second login sent to Pronote");
  assert.deepEqual(second.json(), { ...first.json(), reused: true });

  // A login with a PIN is never merged with one without, nor reused: it runs after it, as a real login.
  const [plain, pinned] = await Promise.all([webLogin(app, login), webLogin(app, login, { pin: "1234" })]);
  assert.equal(plain.json().reused, true);
  assert.equal(pinned.statusCode, 200, pinned.body);
  assert.equal(pinned.json().reused, undefined);
  assert.notEqual(pinned.json().sessionid, first.json().sessionid);
  assert.equal(stub.attempts, 2);
  // The session opened with the PIN replaced the previous one: it is the one given back now.
  const third = await webLogin(app, login);
  assert.equal(third.json().sessionid, pinned.json().sessionid);
  assert.equal(third.json().reused, true);
  assert.equal(stub.attempts, 2);
  // Another password is never answered with the open session: Pronote checks it (here it refuses it).
  stub.failure = () => new pawnote.BadCredentialsError();
  const wrong = await webLogin(app, login, { password: "AutreMotDePasse-Fictif" });
  assert.equal(wrong.statusCode, 401, wrong.body);
  assert.equal(wrong.json().error, "bad_credentials");
  assert.equal(stub.attempts, 3);
  // The session is still there for the password that opened it.
  assert.equal((await webLogin(app, login)).json().sessionid, pinned.json().sessionid);
  assert.equal(stub.attempts, 3);
  await finish(app);
});

test("a login with a PIN waits for the login without PIN in flight (serialized), each one reaches Pronote once", async () => {
  const { app } = await start();
  const stub = stubLogin({ delay: 50 });
  const { login } = freshAccount();
  stub.failure = () => new pawnote.BadCredentialsError();
  const answers = await Promise.all([
    ...Array.from({ length: 5 }, () => webLogin(app, login)),
    ...Array.from({ length: 5 }, () => webLogin(app, login, { pin: "1234" })),
    // Another password is another login: not merged with the first five.
    webLogin(app, login, { password: "AutreMotDePasse-Fictif" }),
  ]);
  assert.ok(answers.every((answer) => answer.statusCode === 401), "the same error for the merged requests");
  assert.equal(stub.attempts, 3, "one login per distinct request");
  assert.equal(stub.maxRunning, 1, "never two logins of one account at the same time");
  await finish(app);
});

test("a web session reported lost by Pronote is forgotten: the next web login is a real one", async () => {
  const { app } = await start();
  const stub = stubLogin({ delay: 1 });
  const { login, account } = freshAccount();
  const mobile = mobileSession(account, login);
  stub.expired = true;
  const opened = await webLogin(app, login);
  assert.equal(opened.statusCode, 200, opened.body);
  // The request is replayed on the web session, whose Pronote session is gone.
  const lost = await send(app, "GET", "/competencies", { session: mobile.id, web: opened.json().sessionid });
  assert.equal(lost.statusCode, 401, lost.body);
  assert.equal(lost.json().error, "web_session_expired");
  stub.expired = false;
  const next = await webLogin(app, login);
  assert.equal(next.statusCode, 200, next.body);
  assert.equal(next.json().reused, undefined, "not the dead session");
  assert.notEqual(next.json().sessionid, opened.json().sessionid);
  assert.equal(stub.attempts, 2);

  // Sent as the main session and found gone: forgotten too.
  (stub.handles[1] as any).fetcher = async () => ({ content: "<html>La page a expiré</html>", headers: {}, status: 200 });
  const main = await send(app, "GET", "/grades/context", { session: next.json().sessionid });
  assert.equal(main.statusCode, 401, main.body);
  assert.equal((await webLogin(app, login)).json().reused, undefined);
  assert.equal(stub.attempts, 3);

  // Keep-alive: the presence finds the web session gone, it is forgotten (never reconnected).
  setPresenceSender(async (handle) => {
    if (handle === stub.handles[2]) throw new pawnote.SessionExpiredError();
  });
  await keepAlive(Date.now() + 10 * 60_000 - 1);
  const afterPresence = await webLogin(app, login);
  assert.equal(afterPresence.json().reused, undefined);
  assert.equal(stub.attempts, 4);
  await finish(app);
});

test("access log: origin and account on every line, valid headers kept, invalid ones dropped", async () => {
  const { app, entries } = await start();
  stubLogin({ delay: 1 });
  const { login, account } = freshAccount();
  const mobile = mobileSession(account, login);
  const lineOf = async (options: SendOptions, method: "GET" | "POST" = "GET", url = "/session/info") => {
    const before = entries.length;
    await send(app, method, url, { session: mobile.id, ...options });
    assert.equal(entries.length, before + 1);
    return entries[before];
  };

  const valid = await lineOf({ origin: "mcp:get_pronote_health", account: "9f86d081884c7d65" });
  assert.equal(valid.route, "/session/info");
  assert.equal(valid.origin, "mcp:get_pronote_health");
  assert.equal(valid.account, "9f86d081884c7d65");
  for (const origin of ["task:sync_task", "page:local/pronoteio/push.php", "a", `a${"b".repeat(79)}`]) {
    assert.equal((await lineOf({ origin })).origin, origin);
  }
  for (const origin of ["", "MCP:get_pronote_health", "mcp get", "élève:MARTIN Léa", ":mcp", "mcp?x=1", `a${"b".repeat(80)}`, 'x"}{"route":"y']) {
    const line = await lineOf({ origin, account: "9f86d081884c7d65" });
    assert.equal("origin" in line, false, `origin ${origin} dropped`);
    assert.equal(line.account, "9f86d081884c7d65");
  }
  // Invalid or absent account header: never logged; the tag derived from the account of the session takes its place.
  for (const value of ["", "MARTIN", "9F86D081884C7D65", "9f86d08", "9".repeat(33), "9f86d081 884c7d65"]) {
    const line = await lineOf({ origin: "task:sync_task", account: value });
    assert.equal(line.account, accountTag(account), `account ${value} dropped`);
    assert.equal(line.origin, "task:sync_task");
  }
  const none = await lineOf({});
  assert.equal("origin" in none, false);
  assert.equal(none.account, accountTag(account));
  // No header, no account known (session opened without account, unknown session, unsigned health): no tag at all.
  const anonymous = await lineOf({ session: createSession(fakeSession({})), account: "MARTIN", origin: "MARTIN Léa" });
  assert.deepEqual([anonymous.status, "origin" in anonymous, "account" in anonymous], [200, false, false]);
  const unknown = await lineOf({ session: "session-inconnue" });
  assert.deepEqual([unknown.status, "origin" in unknown, "account" in unknown], [401, false, false]);

  // Every route: the signed health report, an error, a login (account tag derived when the header is absent).
  assert.equal((await lineOf({ origin: "mcp:get_pronote_health", account: "0123456789abcdef" }, "GET", "/health")).origin, "mcp:get_pronote_health");
  const failed = await lineOf({ origin: "mcp:get_pronote_competencies", account: "0123456789abcdef" }, "GET", "/competencies");
  assert.deepEqual([failed.status, failed.code, failed.origin, failed.account], [409, "web_session_required", "mcp:get_pronote_competencies", "0123456789abcdef"]);
  const body = { ...login, space: "web", password: PASSWORD };
  const withHeader = await lineOf({ origin: "page:local/pronoteio/account.php", account: "0123456789abcdef", body }, "POST", "/session/login");
  assert.deepEqual([withHeader.route, withHeader.status, withHeader.origin, withHeader.account],
    ["/session/login", 200, "page:local/pronoteio/account.php", "0123456789abcdef"]);
  const derived = await lineOf({ origin: "task:sync_task", body }, "POST", "/session/login");
  assert.equal(derived.account, accountTag(account));
  assert.match(String(derived.account), /^[0-9a-f]{12}$/);
  const invalid = await lineOf({ origin: "task:sync_task", account: "MARTIN", body }, "POST", "/session/login");
  assert.equal(invalid.account, accountTag(account), "invalid header: the derived tag");

  // The same signed request delivered twice by the web server: both lines carry the tags.
  const json = JSON.stringify(body);
  const headers = { ...signedHeaders("POST", "/session/login", json), "x-pronoteio-origin": "task:sync_task", "x-pronoteio-account": "abcdef0123456789" };
  const before = entries.length;
  await Promise.all([0, 1].map(() => app.inject({ method: "POST", url: "/session/login", payload: json, headers })));
  const pair = entries.slice(before);
  assert.equal(pair.length, 2);
  assert.equal(pair.filter((line) => line.duplicate === true).length, 1);
  assert.ok(pair.every((line) => line.origin === "task:sync_task" && line.account === "abcdef0123456789"));

  assert.doesNotMatch(JSON.stringify(entries), /MotDePasse|prof-garde|demo\.example|MARTIN|device-garde/);
  await finish(app);
});

test("GET /session/info (weblogin) and the signed GET /health (webLogin) expose the state of the guard", async () => {
  const { app } = await start();
  const stub = stubLogin({ delay: 1 });
  const { login, account } = freshAccount();
  const other = freshAccount();
  const mobile = mobileSession(account, login);
  let now = Date.now();
  webLoginGuard.now = () => now;

  const quiet = await send(app, "GET", "/session/info", { session: mobile.id });
  assert.equal(quiet.statusCode, 200, quiet.body);
  assert.deepEqual(quiet.json().weblogin, { failures: 0, recentFailures: 0, backoffUntil: null, retryAfter: 0, lastFailureAt: null, lastKind: null });
  assert.deepEqual((await send(app, "GET", "/health")).json().webLogin, { accountsInBackoff: 0, failuresLast10Min: 0 });

  stub.failure = () => new pawnote.BadCredentialsError();
  await webLogin(app, other.login);
  stub.failure = () => new pawnote.RateLimitedError();
  await webLogin(app, login);
  now += 5000;
  const info = await send(app, "GET", "/session/info", { session: mobile.id });
  assert.deepEqual(info.json().weblogin, {
    failures: 1,
    recentFailures: 1,
    backoffUntil: Math.ceil((now - 5000 + 60_000) / 1000),
    retryAfter: 55,
    lastFailureAt: Math.floor((now - 5000) / 1000),
    lastKind: "RateLimitedError",
  });
  const health = (await send(app, "GET", "/health")).json();
  assert.deepEqual(health.webLogin, { accountsInBackoff: 1, failuresLast10Min: 2 });
  assert.doesNotMatch(JSON.stringify(health.webLogin), /prof-garde/);
  // A session without account (older tests, jobs): the member is there, empty.
  const anonymous = createSession(fakeSession({}));
  assert.equal((await send(app, "GET", "/session/info", { session: anonymous })).json().weblogin.failures, 0);
  await finish(app);
});

test("10 quick health-check sequences with Pronote refusing every login: at most one login attempt", async () => {
  const { app, entries } = await start();
  const stub = stubLogin({ delay: 5 });
  stub.failure = () => new pawnote.RateLimitedError();
  const { login, account } = freshAccount();
  const mobile = mobileSession(account, login);
  const origin = "mcp:get_pronote_health";
  const statuses: number[][] = [];
  for (let round = 0; round < 10; round++) {
    const health = await send(app, "GET", "/health", { origin });
    const info = await send(app, "GET", "/session/info", { session: mobile.id, origin });
    const check = await send(app, "GET", `/competencies?round=${round}`, { session: mobile.id, origin });
    const relogin = await webLogin(app, login, { origin });
    statuses.push([health.statusCode, info.statusCode, check.statusCode, relogin.statusCode]);
    if (round > 0) {
      assert.equal(info.json().weblogin.retryAfter > 0, true);
      assert.equal(check.json().retry_after > 0, true, "the 409 says not to log in");
      assert.equal(relogin.json().error, "web_login_backoff");
    }
  }
  assert.deepEqual(statuses[0], [200, 200, 409, 502]);
  for (const round of statuses.slice(1)) assert.deepEqual(round, [200, 200, 409, 429]);
  assert.equal(stub.attempts, 1, "one login attempt for the ten sequences");
  assert.ok(entries.every((entry) => entry.origin === origin), "every line names the caller");
  await finish(app);
});

test("restart: the back-off is found again in the state file, which holds no account identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "sidecar-weblogin-"));
  const file = join(dir, "state.json");
  const { account, login } = freshAccount();
  let now = Date.parse("2026-11-21T08:24:20Z");
  const first = new WebLoginGuard(() => now, new StateStore(file));
  first.recordFailure(account, new pawnote.RateLimitedError());
  first.recordFailure(account, new pawnote.RateLimitedError());
  first.recordFailure(account, new pawnote.RateLimitedError());
  assert.equal(first.retryAfter(account), 300);

  // Written at once (no stop, no timer): the process is killed and started again 20 seconds later.
  const raw = readFileSync(file, "utf8");
  assert.equal(raw.includes(account), false, "the account key itself is not written");
  assert.equal(raw.includes(login.username), false);
  assert.doesNotMatch(raw, /demo\.example|device-garde/);
  const stored = JSON.parse(raw).webLogin as Record<string, Record<string, unknown>>;
  assert.equal(Object.keys(stored).length, 1);
  assert.match(Object.keys(stored)[0], /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(Object.values(stored)[0]).sort(), ["backoffUntil", "failures", "lastFailureAt", "lastKind", "recent"]);
  now += 20_000;
  const second = new WebLoginGuard(() => now, new StateStore(file));
  assert.equal(second.retryAfter(account), 280);
  assert.deepEqual(second.status(account), { failures: 3, recentFailures: 3, backoffUntil: Math.ceil((now + 280_000) / 1000),
    retryAfter: 280, lastFailureAt: Math.floor((now - 20_000) / 1000), lastKind: "RateLimitedError" });
  assert.deepEqual(second.stats(), { accountsInBackoff: 1, failuresLast10Min: 3 });
  // The next refusal after the restart continues the ladder (15 minutes), a success clears it in the file too.
  now += 280_000;
  assert.equal(second.retryAfter(account), 0);
  second.recordFailure(account, new pawnote.RateLimitedError());
  assert.equal(second.retryAfter(account), 900);
  second.recordSuccess(account);
  assert.equal(new WebLoginGuard(() => now, new StateStore(file)).retryAfter(account), 0);

  // A damaged or altered file injects nothing: unknown keys, wrong types and messages are dropped.
  writeFileSync(file, JSON.stringify({ webLogin: {
    "prof-garde": { failures: 3, backoffUntil: now + 60_000 },
    ["a".repeat(64)]: { failures: "x", backoffUntil: now + 60_000, lastFailureAt: now, lastKind: "Erreur de MARTIN Léa", recent: [now, "x", -1], autre: 1 },
  } }));
  const altered = new StateStore(file).state.webLogin;
  assert.deepEqual(altered, { ["a".repeat(64)]: { failures: 0, backoffUntil: now + 60_000, lastFailureAt: now, lastKind: null, recent: [now] } });
  // An account without failure for a day is forgotten when another failure is recorded.
  const third = new WebLoginGuard(() => now, new StateStore(file));
  now += 25 * 3600 * 1000;
  third.recordFailure(account, new pawnote.BadCredentialsError());
  assert.deepEqual(third.stats(), { accountsInBackoff: 0, failuresLast10Min: 1 });
  assert.equal(third.status(account).lastKind, "bad_credentials");
  rmSync(dir, { recursive: true });
});
