// First import: switches the process to UTC before any date is built (wall-clock times of Pronote, see time.ts).
import "./time.js";
import { buildApp } from "./app.js";
import { assertSecret, config } from "./config.js";

assertSecret();

const app = await buildApp();

// Under Phusion Passenger (cPanel "Setup Node.js App") the server must listen on the socket given by
// Passenger: its documented way is listen("passenger"), which Fastify's listen() cannot express.
if ("PhusionPassenger" in globalThis) {
  await app.ready();
  app.server.listen("passenger");
} else {
  await app.listen({ host: config.host, port: config.port });
}
