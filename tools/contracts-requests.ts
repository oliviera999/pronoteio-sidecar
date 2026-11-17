/**
 * Writes contracts/requests.json: the request schemas (querystring, body, params) of every route of the sidecar, read
 * from the routes themselves. test/contracts.test.ts fails when the file is not up to date: run
 * "npm run contracts:requests" after changing a route.
 */
import { writeFileSync } from "node:fs";

process.env.PRONOTEIO_SECRET ??= "contracts-secret-0123456789abcdef";
process.env.PRONOTEIO_LOG_FILE = "off";
process.env.PRONOTEIO_STATE_FILE = "off";

const { requestContracts } = await import("../test/helpers/request-contracts.js");
const file = new URL("../contracts/requests.json", import.meta.url).pathname;
writeFileSync(file, `${JSON.stringify(await requestContracts(), null, 2)}\n`);
console.log(`written ${file}`);
