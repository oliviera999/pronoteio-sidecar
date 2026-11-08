import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { SessionHandle } from "pawnote";
import { rememberUserData } from "../src/pronote/userdata.js";
import { newsRowsOf } from "../src/teacher/news.js";
import { audienceMembers, isSurveyClosed, newsResponseRequest, newsSaveRequest, newsStateRequest, questionMember, writeNews, writeNewsResponse } from "../src/teacher/newsWrite.js";
import { fakeSession } from "./fake-session.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const session = {
  information: { url: "https://demo.example/pronote", id: "sess1", aesKey: "0123456789abcdef", aesIV: "fedcba9876543210" },
} as unknown as SessionHandle;

const pageWithReceived = () => {
  const page = fixture("news-page");
  page.listeModesAff[0].listeActualites.V.push(fixture("news-received"));
  return page;
};
const receivedRow = () => newsRowsOf(session, pageWithReceived(), "received")[0];

test("a survey answer follows Pawnote's newsSurveySend: ranks as { _T: 8 }, free text, acknowledgement as an empty text", () => {
  const request = newsResponseRequest(receivedRow(), { acknowledge: true, answers: [{ question: "q2", choices: [1] }, { question: "q3", text: "RAS" }] });
  assert.equal(request.saisieActualite, false);
  const [item] = request.listeActualites as any[];
  assert.equal(item.N, "65#x30");
  assert.equal(item.genrePublic, 3);
  assert.deepEqual(item.public, { L: "M. PROFESSEUR M.", N: "109#x14", G: 3 });
  assert.equal(item.validationDirecte, true);
  assert.equal(item.marqueLueSeulement, false);
  assert.equal(item.lue, true);
  assert.equal(item.supprimee, false);
  assert.equal(item.listeQuestions.length, 3);
  assert.deepEqual(item.listeQuestions[0].reponse, { N: 0, Actif: true, valeurReponse: "", avecReponse: true, estReponseAttendue: true, _validationSaisie: true });
  assert.deepEqual(item.listeQuestions[1].reponse, { N: "68#a2", Actif: true, valeurReponse: { _T: 8, V: "[1]" }, valeurReponseLibre: "", avecReponse: true, estReponseAttendue: true, _validationSaisie: true });
  assert.equal(item.listeQuestions[1].genreReponse, 2);
  assert.equal(item.listeQuestions[2].reponse.valeurReponse, "RAS");
  assert.equal(item.listeQuestions[2].reponse.estReponseAttendue, false);
});

test("read only and removal send no question; a closed survey refuses an answer", () => {
  const read = newsResponseRequest(receivedRow(), { read: true });
  const [item] = read.listeActualites as any[];
  assert.deepEqual(item.listeQuestions, []);
  assert.equal(item.marqueLueSeulement, true);
  assert.equal(item.lue, true);
  const removed = (newsResponseRequest(receivedRow(), { remove: true }).listeActualites as any[])[0];
  assert.equal(removed.supprimee, true);
  assert.equal(removed.lue, false);
  const row = receivedRow();
  assert.equal(isSurveyClosed(row.item, new Date(2026, 10, 10)), false);
  assert.equal(isSurveyClosed(row.item, new Date(2026, 11, 10)), true, "dateFin past");
  assert.equal(isSurveyClosed({ ...row.item, locked: true }, new Date(2026, 10, 10)), true);
});

test("POST /news/response (dryRun) plans the answer and flags acknowledge and remove as irreversible", async () => {
  const fake = fakeSession({ PageActualites: () => pageWithReceived() });
  const id = receivedRow().item.id;
  const result = await writeNewsResponse(fake, id, { answers: [{ question: "q2", choices: [2] }] }, true);
  assert.equal(result.written, false);
  assert.equal(result.irreversible, false);
  assert.equal(result.validated, false);
  assert.deepEqual(result.after.questions[1].answer, { choices: [2], text: "", acknowledged: false });
  assert.equal((await writeNewsResponse(fake, id, { acknowledge: true }, true)).irreversible, true);
  assert.equal((await writeNewsResponse(fake, id, { remove: true }, true)).irreversible, true);
  await assert.rejects(writeNewsResponse(fake, id, { answers: [{ question: "q9", text: "x" }] }, true), /question_not_found/);
  await assert.rejects(writeNewsResponse(fake, "n:absente", { read: true }, true), /news_not_found/);
  const locked = fakeSession({ PageActualites: () => {
    const page = pageWithReceived();
    page.listeModesAff[0].listeActualites.V[0].estVerrouille = true;
    return page;
  } });
  await assert.rejects(writeNewsResponse(locked, id, { acknowledge: true }, true), /survey_closed/);
  assert.equal((await writeNewsResponse(locked, id, { read: true }, true)).written, false, "reading a closed survey stays possible");
  assert.ok(fake.calls.every((call) => call.name !== "SaisieActualites"));
});

test("creating an information: SaisieActualites saisieActualite true, publie always false, audience flags, one 'none' question", () => {
  const audience = { entities: [{ N: "23#c1", G: 1 }], individuals: [{ N: "109#t2", G: 3 }] };
  const request = newsSaveRequest(
    { mode: "create", kind: "information", title: "Sortie", text: "<p>Le 12/12</p>", start: new Date(2026, 10, 10).getTime() / 1000, end: null, audience: { classes: ["3A"], parents: "one", students: true } },
    null,
    { N: "70#x1", L: "Sorties" },
    audience,
  );
  assert.equal(request.saisieActualite, true);
  const [item] = request.listeActualites as any[];
  assert.equal(item.N, 0);
  assert.equal(item.E, 1);
  assert.equal(item.publie, false, "never published by create");
  assert.equal(item.estInformation, true);
  assert.equal(item.estSondage, false);
  assert.deepEqual(item.nature, { N: "70#x1", L: "Sorties" });
  assert.deepEqual(item.dateDebut, { _T: 7, V: "10/11/2026 0:0:0" });
  assert.equal(item.dateFin, null);
  assert.equal(item.avecEleve, true);
  assert.equal(item.avecResp1, true);
  assert.equal(item.avecResp2, false);
  assert.deepEqual(item.listePublicEntite, [{ N: "23#c1", G: 1 }]);
  assert.deepEqual(item.listePublicIndividu, [{ N: "109#t2", G: 3 }]);
  assert.deepEqual(item.genresPublicEntite, { _T: 26, V: "[1]" });
  assert.equal(item.listeQuestions.length, 1);
  assert.equal(item.listeQuestions[0].genreReponse, 4);
  assert.deepEqual(item.listeQuestions[0].texte, { _T: 21, V: "<p>Le 12/12</p>" });
  assert.equal(audienceMembers({ mode: "create", audience: { parents: "all" } }, { entities: [], individuals: [] }).avecResp2, true);
});

test("survey questions, attachments and the publish / unpublish / delete toggles", () => {
  const member = questionMember({ text: "<p>Présent ?</p>", kind: "single", choices: [{ label: "Oui" }, { label: "Autre", free: true }], maxLength: 100 }, 1, [{ name: "a.pdf", fileId: "reqUpl_2_2" }, { name: "Site", url: "https://example.org" }]);
  assert.equal(member.genreReponse, 2);
  assert.equal(member.tailleReponse, 100);
  assert.deepEqual(member.listeChoix, [{ rang: 1, L: "Oui", estReponseLibre: false }, { rang: 2, L: "Autre", estReponseLibre: true }]);
  assert.deepEqual(member.listePiecesJointes, [{ L: "a.pdf", G: 1, E: 1, IDFichier: "reqUpl_2_2" }, { L: "Site", G: 0, E: 1, url: "https://example.org" }]);
  const existing = newsRowsOf(session, fixture("news-page"), "sent")[0].raw;
  const published = (newsStateRequest(existing, "publish").listeActualites as any[])[0];
  assert.equal(published.E, 2);
  assert.equal(published.publie, true);
  assert.equal(published.N, "65#x13");
  assert.equal((newsStateRequest(existing, "unpublish").listeActualites as any[])[0].publie, false);
  assert.equal((newsStateRequest(existing, "delete").listeActualites as any[])[0].E, 3);
});

test("POST /news (dryRun): DonneesEditionInformation gives the limits, an empty audience is refused, a locked item too", async () => {
  const fake = fakeSession({
    PageActualites: () => fixture("news-page"),
    DonneesEditionInformation: (data) => {
      if (data?.init) return { tailleMaxTitre: 200, tailleMaxReponse: 500, listeCategories: { _T: 24, V: [] } };
      return { nbResponsables: 42 };
    },
    ListePublics: (data) => fixture("publics")[String(data!.genres.V).replace(/[[\]]/g, "")],
  });
  rememberUserData(fake, { rights: { communication: { avecDiscussionAvancee: true } } });
  const created = await writeNews(fake, { mode: "create", kind: "information", title: "Sortie musée", text: "<p>Info</p>", start: 1_800_000_000, category: "Sorties", audience: { classes: ["3A"], parents: "all" } }, true);
  assert.equal(created.written, false);
  assert.equal(created.validated, false);
  assert.equal(created.irreversible, false);
  assert.deepEqual(created.limits, { maxTitle: 200, maxAnswer: 500 });
  assert.deepEqual(created.audienceCount, { parents: 42, mainTeachers: null, tutors: null });
  assert.equal(created.after?.published, false);
  assert.equal((created.request.listeActualites as any[])[0].nature.L, "Sorties");
  await assert.rejects(writeNews(fake, { mode: "create", kind: "information", title: "x", text: "y", start: 1 }, true), /audience_required/);
  await assert.rejects(writeNews(fake, { mode: "create", kind: "survey", title: "x", start: 1, audience: { classes: ["3A"] } }, true), /content_required/);
  const sentId = newsRowsOf(session, fixture("news-page"), "sent")[0].item.id;
  await assert.rejects(writeNews(fake, { mode: "publish", id: sentId }, true), /news_locked/);
  await assert.rejects(writeNews(fake, { mode: "delete", id: "n:absente" }, true), /news_not_found/);
  assert.ok(fake.calls.every((call) => call.name !== "SaisieActualites"));
});
