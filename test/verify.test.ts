import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { rememberUserData } from "../src/pronote/userdata.js";
import { fakeSession } from "./fake-session.js";
import { buildApp, createSession, signedHeaders } from "./helpers/app.js";

const { config } = await import("../src/config.js");
const { callPronote } = await import("../src/pronote/request.js");
const { requestContext, PRIORITY } = await import("../src/context.js");

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

const listsSession = () => {
  const session = fakeSession({
    ListeDiffusion: () => fixture("distribution-lists"),
    ListePublics: () => fixture("publics")["3"],
    SaisieListeDiffusion: () => ({}),
  });
  rememberUserData(session, { rights: { communication: { avecDiscussionAvancee: true } } });
  return session;
};

const write = async (body: unknown, headers: Record<string, string> = {}) => {
  const app = await buildApp({ logger: false });
  const session = listsSession();
  const id = createSession(session);
  const json = JSON.stringify(body);
  const answer = await app.inject({ method: "POST", url: "/lists", payload: json, headers: { ...signedHeaders("POST", "/lists", json, id), ...headers } });
  await app.close();
  return { answer, session };
};

const live = async <T>(run: () => Promise<T>): Promise<T> => {
  const mutable = config as unknown as { writeMode: string };
  const previous = mutable.writeMode;
  mutable.writeMode = "live";
  try {
    return await run();
  } finally {
    mutable.writeMode = previous;
  }
};

test("a write re-read without difference: verified true with the state read (after)", async () => {
  const { answer, session } = await live(() => write({ action: "update", id: "dl:Équipe 3A", public: true }));
  assert.equal(answer.statusCode, 200, answer.body);
  const body = answer.json();
  assert.equal(body.written, true);
  assert.equal(body.verified, true);
  assert.equal(body.after.label, "Équipe 3A");
  assert.ok(session.calls.some((call) => call.name === "SaisieListeDiffusion"));
});

test("a write re-read with a difference: 502 for a client of contract 1, verified false with the detail for contract 2", async () => {
  // The re-read list does not contain the created list (simulated difference).
  const legacy = await live(() => write({ action: "create", label: "Nouvelle", public: false, members: [{ kind: "teacher", label: "Mme Collegue A." }] }));
  assert.equal(legacy.answer.statusCode, 502);
  assert.equal(legacy.answer.json().error, "list_not_saved");
  const declared = await live(() => write({ action: "create", label: "Nouvelle", public: false, members: [{ kind: "teacher", label: "Mme Collegue A." }] },
    { "x-pronoteio-contract": "2" }));
  assert.equal(declared.answer.statusCode, 200, declared.answer.body);
  const body = declared.answer.json();
  assert.equal(body.written, true);
  assert.equal(body.verified, false);
  assert.deepEqual(body.differences, ["list_not_saved"]);
  const viaClient = await live(() => write({ action: "create", label: "Nouvelle", public: false, members: [{ kind: "teacher", label: "Mme Collegue A." }] },
    { "x-pronoteio-client": "local_pronoteio/2026112200; contract=2" }));
  assert.equal(viaClient.answer.json().verified, false);
});

test("dryrun (lower case, body or query): full resolution, what would be written, no write call to Pronote", async () => {
  const { answer, session } = await write({ action: "update", id: "dl:Équipe 3A", public: true, dryrun: true });
  assert.equal(answer.statusCode, 200, answer.body);
  const body = answer.json();
  assert.equal(body.dryRun, true);
  assert.equal(body.written, false);
  assert.equal(body.after.public, true);
  assert.ok(body.request, "the request that would be sent");
  assert.equal(session.calls.some((call) => /^Saisie/.test(call.name)), false);

  // Safety net: a write call during a simulation is never sent.
  const other = fakeSession({ SaisieNotes: () => ({}) });
  await assert.rejects(
    requestContext.run({ priority: PRIORITY.write, deadline: Date.now() + 5000, calls: 0, route: "/grades", dryRun: true },
      () => callPronote(other, { name: "SaisieNotes", data: {} })),
    /internal/,
  );
  assert.equal(other.calls.length, 0);
});
