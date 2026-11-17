/**
 * Regenerates contracts/fixtures/*.json: answers of the sidecar to the anonymised fixtures of test/fixtures (fictitious
 * names, no real student), through the whole application (signed requests, fake Pronote session). Run with
 * "npm run contracts:fixtures" after a change of format, then check the diff and the schemas of contracts/routes.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

process.env.PRONOTEIO_SECRET ??= "contracts-secret-0123456789abcdef";
process.env.PRONOTEIO_LOG_FILE = "off";
process.env.PRONOTEIO_STATE_FILE = "off";
process.env.PRONOTEIO_LOCK_FILE = "off";

const root = new URL("..", import.meta.url).pathname;
const { contractSamples } = await import("../test/helpers/contract-samples.js");
const samples = await contractSamples();
const dir = join(root, "contracts", "fixtures");
mkdirSync(dir, { recursive: true });
for (const [name, body] of Object.entries(samples)) {
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(body, null, 2)}\n`);
}
void readFileSync;
console.log(`${Object.keys(samples).length} fixtures written in contracts/fixtures`);
