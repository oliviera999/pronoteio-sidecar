import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { Ajv } from "ajv";
import "./helpers/app.js";

const { contractSamples } = await import("./helpers/contract-samples.js");
const { requestContracts } = await import("./helpers/request-contracts.js");

const dir = new URL("../contracts/", import.meta.url);
const read = (path: string) => JSON.parse(readFileSync(new URL(path, dir), "utf8"));

/** Validators of the response schemas of contracts/routes (strict: no member not described, required members). */
const loadValidators = () => {
  const ajv = new Ajv({ allErrors: true, strict: false });
  ajv.addSchema(read("common.schema.json"));
  const files = readdirSync(new URL("routes/", dir)).filter((name) => name.endsWith(".schema.json"));
  for (const file of files) ajv.addSchema(read(`routes/${file}`));
  const validators = new Map<string, (data: unknown) => string[]>();
  for (const file of files) {
    const name = file.replace(/\.schema\.json$/, "");
    const validate = ajv.compile({ $ref: `${file}#/properties/response` });
    validators.set(name, (data) => (validate(data) ? [] : (validate.errors ?? []).map((error: { instancePath: string; message?: string; params: unknown }) => `${error.instancePath} ${error.message} ${JSON.stringify(error.params)}`)));
  }
  return { validators, files };
};

/** Answer of the sidecar → contract that describes it. */
const CONTRACT_OF: Record<string, string> = {
  "health-public": "health-public",
  errors: "errors",
  roster: "roster",
  "students-files": "students-files",
  "students-files-ids": "students-files",
  "error-validation": "error",
  "error-session": "error",
  "jobs-created": "jobs-create",
  "jobs-done": "jobs-get",
  "session-login-reused": "session-login",
  "session-login-web": "session-login",
  "session-login-web-reused": "session-login",
  "error-web-login-backoff": "error",
  "error-web-session-required-backoff": "error",
  "admin-update": "admin-update",
  health: "health",
  "classlife-absences": "classlife-absences",
  "students-plans": "students-plans",
  "students-history": "students-history",
  "collect-created": "collect-create",
  "collect-done": "collect-get",
  "collect-results": "collect-results",
  "error-collect-running": "error",
  timetable: "timetable",
  homework: "homework",
  "reports-periods": "reports-periods",
  "reports-grid": "reports-grid",
  "reports-positioning": "reports-positioning",
  "error-lsu-out-of-range": "error",
};

test("every answer of the sidecar matches its contract (live answers and contracts/fixtures)", async () => {
  const { validators } = loadValidators();
  const samples = await contractSamples();
  for (const [name, body] of Object.entries(samples)) {
    const contract = CONTRACT_OF[name];
    assert.ok(contract, `answer ${name} without contract`);
    assert.deepEqual(validators.get(contract)!(body), [], `live ${name}`);
    assert.deepEqual(validators.get(contract)!(read(`fixtures/${name}.json`)), [], `fixture ${name}`);
  }
});

test("a member not described or a required member missing fails the contract", () => {
  const { validators } = loadValidators();
  const timetable = read("fixtures/timetable.json");
  const extra = structuredClone(timetable);
  extra.items[0].nouveauChamp = 1;
  assert.notDeepEqual(validators.get("timetable")!(extra), []);
  const missing = structuredClone(timetable);
  delete missing.items[0].start;
  assert.notDeepEqual(validators.get("timetable")!(missing), []);
  const badLocal = structuredClone(timetable);
  badLocal.items[0].local.start = "12/11/2026 17:10";
  assert.notDeepEqual(validators.get("timetable")!(badLocal), []);
  const error = read("fixtures/error-session.json");
  assert.notDeepEqual(validators.get("error")!({ ...error, code: "autre" }), []);
  assert.notDeepEqual(validators.get("error")!({ error: "x" }), []);
});

test("contracts/requests.json is up to date with the routes", async () => {
  const current = JSON.parse(JSON.stringify(await requestContracts()));
  assert.deepEqual(read("requests.json"), current, "run: npm run contracts:requests");
});

test("every contract names a fixture that exists", () => {
  const { files } = loadValidators();
  for (const file of files) {
    const schema = read(`routes/${file}`);
    for (const fixture of [schema.fixture].flat()) assert.ok(readFileSync(new URL(fixture, dir)), `${file}: ${fixture}`);
  }
});
