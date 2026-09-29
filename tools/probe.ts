/**
 * Discovery tool: logs in with a teacher account and sends one Pronote function call.
 *
 * Usage (credentials only in the local .env, never on the command line):
 *   npx tsx --env-file=.env tools/probe.ts <FunctionName> [onglet] [data.json] [--write]
 *
 * .env keys: PROBE_URL, PROBE_USERNAME, PROBE_PASSWORD, PROBE_PIN (double authentication).
 * Function names containing "Saisie" (writes) are refused unless --write is given.
 * The decoded answer is printed as JSON; the refreshed token is kept in .probe-token (see probe-login.ts).
 */
import { readFileSync } from "node:fs";
import { callPronote } from "../src/pronote/request.js";
import { probeLogin } from "./probe-login.js";

const [name, ongletArg, dataFile, ...flags] = process.argv.slice(2);
if (!name) {
  console.error("Usage: tools/probe.ts <FunctionName> [onglet|-] [data.json|-] [--write]");
  process.exit(2);
}
if (/saisie/i.test(name) && !flags.includes("--write")) {
  console.error(`Refusing to call "${name}" without --write (it may modify Pronote data).`);
  process.exit(2);
}

const session = await probeLogin();

console.error(`Logged in as ${session.user.name} (PRONOTE ${session.instance.version.join(".")})`);
console.error("Resources:", session.user.resources.map((r) => `${r.id}:${r.name}`).join(", "));

const onglet = ongletArg && ongletArg !== "-" ? Number(ongletArg) : undefined;
const data = dataFile && dataFile !== "-" ? JSON.parse(readFileSync(dataFile, "utf8")) : undefined;

const answer = await callPronote(session, {
  name,
  data,
  signature: onglet !== undefined ? { onglet } : undefined,
});
console.log(JSON.stringify(answer, null, 2));
