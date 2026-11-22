/**
 * Answers of the sidecar used by the contracts (contracts/): built from the anonymised fixtures (fictitious names)
 * through the whole application. Used by test/contracts.test.ts (validation against the schemas) and by
 * tools/contracts-fixtures.ts (contracts/fixtures).
 */
import { readFileSync } from "node:fs";
import { rememberUserData } from "../../src/pronote/userdata.js";
import { fakeSession } from "../fake-session.js";
import { buildApp, createSession, get, post, signedHeaders } from "./app.js";

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
    // 0.16.0, class follow-up, fictitious values. Recorded shapes (docs/olutionsuivi/formes/): LigneCumul, the frame of
    // the school record (not filled), the multi-year page. Supposed shapes: the lines of absences by student, the plans.
    RecapAbsencesEleves: () => ({ ListeLignes: { _T: 24, V: [
      { eleve: { _T: 24, V: { N: "4#e1", L: "MARTIN Léa" } }, nbAbsences: 2, nbDJAbsence: 2, nbRetards: 1, nbHeures: "3h00",
        listeAbsences: { _T: 24, V: [{ G: 13, DateDebut: { _T: 7, V: "05/10/2026 08:00:00" }, DateFin: { _T: 7, V: "05/10/2026 09:55:00" }, justifie: false,
          NbrHeures: "2h00", listeMatieres: { _T: 24, V: [{ L: "MATHEMATIQUES" }] } }] },
        listeRetards: { _T: 24, V: [{ DateDebut: { _T: 7, V: "06/10/2026 08:00:00" }, Duree: 10, justifie: true, listeMatieres: { _T: 24, V: [{ L: "ANGLAIS LV1" }] } }] },
        listeMatieres: { _T: 24, V: [{ L: "MATHEMATIQUES", nbHeures: "2h00", nbRetards: 0 }] } },
      { eleve: { _T: 24, V: { N: "4#e2", L: "PETIT Hugo" } }, listeAbsences: { _T: 24, V: [] }, listeRetards: { _T: 24, V: [] } }] },
      LigneCumul: { nbClasses: 1, nbEleves: 2, nbAbsences: 2, dureeTotale: "3h00", motifRecevableOui: "", motifRecevableNon: "", nbAbsRepas: 0, nbAbsInternat: 0,
        nbRetardInternat: 0, nbRetards: 1, nbInfirmerie: 0, tauxAbsenteismeTotal: 1.5, minutesRetardTotal: 10 } }),
    DetailsPIEleve: (data) => ({ listeProjets: { _T: 24, V: data?.eleve?.N === "4#e1" ? [{ L: "PAP", motif: "Motif fictif", dateDebut: { _T: 7, V: "01/09/2026" },
      dateFin: { _T: 7, V: "03/07/2027" }, commentaire: "Commentaire fictif", listeAmenagements: { _T: 24, V: [{ L: "Temps majoré" }] }, avecAmenagementsExamen: true }] : [] } }),
    LivretScolaire: (data) => ({ classe: { L: "T06", N: "1#c1", nombrePeriodes: 3, listeLivret: [] },
      eleve: { L: data?.Eleve?.L, N: data?.Eleve?.N, P: 0, estRedoublant: false, listeLivret: [], libelleEnseignement: "" } }),
    PageSuiviPluriannuel: () => ({ avecMoyennesSaisies: true, listeDonnees: { _T: 24, V: [{ L: "2025-2026", identifiant: 1, strAnnee: "2025", strFinAnnee: "2026",
      bareme: { _T: 10, V: "20" }, strClasses: "1G4", moyenne: { _T: 10, V: "13,42" }, moyenneClasse: { _T: 10, V: "12,10" }, listeBulletins: { _T: 24, V: [] },
      listeSuivis: { _T: 24, V: [{ L: "MATHEMATIQUES", moyenne: { _T: 10, V: "14,50" }, moyenneClasse: { _T: 10, V: "11,20" }, appreciation: "Appréciation fictive",
        coefficient: { _T: 10, V: "2,00" }, facultatif: false, Bonus: false }] } }] }, listeAnnees: { _T: 24, V: [{ L: "2025-2026" }] } }),
  });
  Object.assign(session.instance, { firstMonday: new Date(2026, 8, 7), firstDate: new Date(2026, 8, 1), lastDate: new Date(2027, 6, 3) });
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
  // 0.16.0: class follow-up and grouped read of a class.
  samples["classlife-absences"] = await json(get(app, "/classlife/absences?resource=c%3AT06", id));
  samples["students-plans"] = await json(get(app, "/students/plans?resource=c%3AT06", id));
  samples["students-history"] = await json(get(app, "/students/history?resource=c%3AT06", id));
  const { collectTiming } = await import("../../src/collect.js");
  collectTiming.pauseMs = 0;
  const collectBody = { resource: "c:T06", blocks: ["absences", "plans", "history"] };
  const collect = await json(post(app, "/collect", collectBody, id));
  samples["collect-created"] = collect;
  samples["error-collect-running"] = await json(post(app, "/collect", collectBody, id));
  for (let i = 0; i < 1000; i++) {
    state = await json(get(app, `/collect/${collect.collectid}`, id));
    if (state.status === "done") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  samples["collect-done"] = state;
  samples["collect-results"] = await json(get(app, `/collect/${collect.collectid}/results?block=plans`, id));
  samples["session-login-reused"] = await json(post(app, "/session/login", { url: `${login.url}/professeur.html`, username: login.username,
    deviceuuid: login.deviceuuid, token: "jeton-fictif" }));
  setUpdateRunner((file) => setTimeout(() => {
    void import("node:fs").then(({ writeFileSync }) => writeFileSync(file, JSON.stringify({ at: "2026-11-17T18:00:00Z",
      old: { commit: "0000000000000000000000000000000000000000", version: "0.8.0" },
      new: { commit: "1111111111111111111111111111111111111111", version: "0.9.0" }, result: "ok", health: "0.9.0@1111111" })));
  }, 600));
  samples["admin-update"] = await json(post(app, "/admin/update", { timeout: 10 }));
  // 0.15.0: guard of the web logins. Pawnote's web login is replaced by a stub (never a connection to Pronote): a
  // login, the same session given back, then a refusal by Pronote for another account and the answers of its back-off.
  const pawnote = await import("pawnote");
  const { setWebLogin } = await import("../../src/routes/session.js");
  const { webLoginGuard } = await import("../../src/webLoginGuard.js");
  webLoginGuard.reset();
  let refuse = false;
  setWebLogin(async (handle) => {
    if (refuse) throw new pawnote.RateLimitedError();
    Object.assign(handle, fakeSession({}));
    Object.assign(handle.instance, { navigatorIdentifier: "nav-fictif-0001" });
    rememberUserData(handle, { resources: [classT06], tabs: [4, 12, 16, 56, 65, 105, 200] });
    return {} as Awaited<ReturnType<typeof pawnote.loginCredentials>>;
  });
  const webBody = { url: `${login.url}/professeur.html`, username: login.username, deviceuuid: login.deviceuuid, password: "MotDePasse-Fictif",
    space: "web" };
  samples["session-login-web"] = await json(post(app, "/session/login", webBody));
  samples["session-login-web-reused"] = await json(post(app, "/session/login", webBody));
  refuse = true;
  const refused = { ...login, username: "prof-contrats-refus" };
  const mobile = fakeSession({});
  rememberUserData(mobile, { resources: [classT06], tabs: [105, 16] });
  const mobileId = createSession(mobile, { key: accountKey(refused.url, refused.username, refused.deviceuuid), login: refused },
    { space: "mobile", loginMode: "token" });
  await post(app, "/session/login", { ...webBody, username: refused.username });
  samples["error-web-login-backoff"] = await json(post(app, "/session/login", { ...webBody, username: refused.username }));
  samples["error-web-session-required-backoff"] = await json(app.inject({ method: "GET", url: "/competencies",
    headers: { ...signedHeaders("GET", "/competencies", "", mobileId), "x-pronoteio-web": "1" } }));
  samples.health = await json(get(app, "/health"));
  setWebLogin(null);
  webLoginGuard.reset();
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
