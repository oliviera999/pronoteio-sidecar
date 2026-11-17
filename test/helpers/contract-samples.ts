/**
 * Answers of the sidecar used by the contracts (contracts/): built from the anonymised fixtures (fictitious names)
 * through the whole application. Used by test/contracts.test.ts (validation against the schemas) and by
 * tools/contracts-fixtures.ts (contracts/fixtures).
 */
import { readFileSync } from "node:fs";
import { rememberUserData } from "../../src/pronote/userdata.js";
import { fakeSession } from "../fake-session.js";
import { buildApp, createSession, get, post } from "./app.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));

export const contractSamples = async (): Promise<Record<string, unknown>> => {
  const { readCache } = await import("../../src/cache.js");
  const { lessonFromPawnote, homeworkFromPawnote } = await import("../../src/normalise.js");
  const { accountKey } = await import("../../src/tokenStore.js");
  const { setUpdateRunner } = await import("../../src/admin.js");
  readCache.clear();
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  process.env.PRONOTEIO_UPDATE_RESULT = `${mkdtempSync(`${tmpdir()}/sidecar-contracts-`)}/update-result.json`;
  const app = await buildApp({ logger: false });
  const classT06 = { id: "1#c1", label: "T06", genre: 1 as const, taught: true, principal: false };
  const session = fakeSession({
    ListeEleves: () => ({ listeEleves: { _T: 24, V: [{ N: "4#e1", L: "MARTIN Léa", G: 4 }, { N: "4#e2", L: "PETIT Hugo", G: 4 }] } }),
    FicheEleve: (data) => (data?.Eleve?.N === "4#e1" ? fixture("student-file") : { Eleve: { N: "4#e2", L: "PETIT Hugo", Sexe: "M" } }),
  });
  rememberUserData(session, { resources: [classT06], tabs: [105, 16] });
  const login = { url: "https://demo.example/pronote", username: "prof-contrats", deviceuuid: "device-contrats" };
  const id = createSession(session, { key: accountKey(login.url, login.username, login.deviceuuid), login });
  const json = async (promise: Promise<{ body: string }>) => JSON.parse((await promise).body);

  const samples: Record<string, unknown> = {};
  samples["health-public"] = await json(app.inject({ method: "GET", url: "/health/public" }));
  samples.errors = await json(app.inject({ method: "GET", url: "/errors" }));
  samples.roster = await json(get(app, "/roster?resource=c%3AT06", id));
  samples["students-files"] = await json(get(app, "/students/files?resource=c%3AT06&include=imagerights,guardians,photo", id));
  samples["students-files-ids"] = await json(get(app, `/students/files?resource=c%3AT06&ids=${encodeURIComponent("e:MARTIN Léa,e:PETIT Hugo,e:INCONNU Élève")}`, id));
  samples["error-validation"] = await json(get(app, "/roster", id));
  samples["error-session"] = await json(get(app, "/roster?resource=c%3AT06", "inconnue"));
  const job = await json(post(app, "/jobs", { requests: [{ url: "/roster?resource=c%3AT06" }] }, id));
  samples["jobs-created"] = job;
  let state: any = null;
  for (let i = 0; i < 100; i++) {
    state = await json(get(app, `/jobs/${job.jobid}`, id));
    if (state.status === "done") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  samples["jobs-done"] = state;
  samples["session-login-reused"] = await json(post(app, "/session/login", { url: `${login.url}/professeur.html`, username: login.username,
    deviceuuid: login.deviceuuid, token: "jeton-fictif" }));
  setUpdateRunner((file) => setTimeout(() => {
    void import("node:fs").then(({ writeFileSync }) => writeFileSync(file, JSON.stringify({ at: "2026-11-17T18:00:00Z",
      old: { commit: "0000000000000000000000000000000000000000", version: "0.8.0" },
      new: { commit: "1111111111111111111111111111111111111111", version: "0.9.0" }, result: "ok", health: "0.9.0@1111111" })));
  }, 600));
  samples["admin-update"] = await json(post(app, "/admin/update", { timeout: 10 }));
  samples.health = await json(get(app, "/health"));
  // Routes read through Pawnote (not answerable by the fake session): the normalisers of their items.
  const start = new Date(2026, 10, 12, 17, 10);
  const end = new Date(2026, 10, 12, 18, 5);
  samples.timetable = { items: [lessonFromPawnote({ is: "lesson", id: "29#ap", subject: { name: "AP" }, teacherNames: ["PROFESSEUR M."],
    classrooms: ["B12"], groupNames: ["T06"], startDate: start, endDate: end, canceled: false, status: undefined } as any)] };
  samples.homework = { items: [homeworkFromPawnote({ id: "50#h1", subject: { name: "SVT" }, description: "<p>Exercice 3</p>",
    deadline: new Date(2026, 10, 19), attachments: [{ name: "fiche.pdf", url: "https://demo.example/fiche.pdf" }] } as any)] };
  await app.close();
  return samples;
};
