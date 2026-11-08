import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { SessionHandle } from "pawnote";
import { findNews, libraryRowsOf, NEWS_REQUEST, news, newsResults, newsRowsOf, questionsOf, resultsFromAnswer } from "../src/teacher/news.js";
import { fakeSession } from "./fake-session.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const session = {
  information: { url: "https://demo.example/pronote", id: "sess1", aesKey: "0123456789abcdef", aesIV: "fedcba9876543210" },
} as unknown as SessionHandle;

/** Page of the demo with a received survey added to mode 0. */
const pageWithReceived = () => {
  const page = fixture("news-page");
  page.listeModesAff[0].listeActualites.V.push(fixture("news-received"));
  return page;
};

test("news scopes: received (0), sent (1), drafts (2), templates (3) with state, kind and audience summary", () => {
  const page = pageWithReceived();
  assert.equal(newsRowsOf(session, page, "drafts").length, 0);
  const sent = newsRowsOf(session, page, "sent").map((row) => row.item);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].kind, "information");
  assert.equal(sent[0].scope, "sent");
  assert.equal(sent[0].state, "past");
  assert.equal(sent[0].published, true);
  assert.equal(sent[0].locked, true);
  assert.equal(sent[0].mine, true);
  assert.equal(sent[0].publicSummary, "3A (Responsables > Un envoi par responsable)");
  assert.equal(sent[0].withoutAnswer, 41);
  assert.equal(sent[0].answeredPercent, 21);
  assert.equal(sent[1].kind, "survey");
  assert.deepEqual(sent[1].sharedWith, ["M. LACAZE H.", "M. PROFESSEUR M.", "Mme ALVAREZ S."]);
  const templates = newsRowsOf(session, page, "templates").map((row) => row.item);
  assert.equal(templates.length, 2);
  assert.equal(templates[0].state, "template");
  assert.ok(templates[0].id.startsWith("n:"));
  assert.ok(!JSON.stringify([...sent, ...templates]).includes("65#"), "no raw id");
});

test("questions of a received survey: kinds from genreReponse, choices, answers, attachments", () => {
  const [received] = newsRowsOf(session, pageWithReceived(), "received").map((row) => row.item);
  assert.equal(received.scope, "received");
  assert.equal(received.state, "published");
  assert.equal(received.read, false);
  assert.equal(received.questions.length, 3);
  assert.deepEqual(received.questions.map((question) => question.kind), ["ack", "single", "text"]);
  assert.deepEqual(received.questions.map((question) => question.id), ["q1", "q2", "q3"]);
  assert.equal(received.questions[0].answer, null);
  assert.deepEqual(received.questions[1].answer, { choices: [3], text: "Peut-être", acknowledged: false });
  assert.deepEqual(received.questions[1].choices, [{ rank: 1, label: "Oui", free: false }, { rank: 2, label: "Non", free: false }, { rank: 3, label: "Autre", free: true }]);
  assert.equal(received.questions[2].maxLength, 500);
  assert.match(received.text, /Merci d'accuser réception/);
  assert.equal(received.attachments.length, 1);
  assert.equal(received.attachments[0].name, "programme.pdf");
  assert.deepEqual(questionsOf([{ genreReponse: 4, texte: "x" }, { genreReponse: 5 }, { genreReponse: 3 }]).map((question) => question.kind), ["none", "noanswer", "multiple"]);
});

test("GET /news sends every mode as a { _T: 26 } set and reads the library with ListeSondagesDeBiblioEtablissement", async () => {
  const fake = fakeSession({
    PageActualites: (data) => {
      assert.deepEqual(data, { genreRequeteActualite: 0, modesAffActus: { _T: 26, V: "[0,1,2,3]" } });
      return pageWithReceived();
    },
    ListeSondagesDeBiblioEtablissement: (data) => {
      assert.deepEqual(data, { estCasSondage: true });
      return { listeSondages: { _T: 24, V: [{ L: "Modèle sortie", N: "65#x40", estSondage: true, listeQuestions: { _T: 24, V: [{ genreReponse: 2, texte: { _T: 21, V: "<p>Oui ?</p>" } }] } }] } };
    },
  });
  assert.deepEqual(NEWS_REQUEST.modesAffActus, { _T: 26, V: "[0,1,2,3]" });
  const received = await news(fake, "received", true);
  assert.equal(received.items.length, 1);
  assert.equal(received.disabled, true);
  const library = await news(fake, "library");
  assert.equal(library.items.length, 1);
  assert.equal(library.items[0].scope, "library");
  assert.equal(library.items[0].state, "template");
  assert.equal(library.items[0].questions[0].kind, "single");
  assert.deepEqual(libraryRowsOf(session, { autre: { _T: 24, V: [{ L: "x", N: "1#a" }] } }).map((row) => row.item.title), ["x"], "unknown list member");
});

test("results of a survey are aggregated per choice and free text, respondents only when nominative", () => {
  const page = pageWithReceived();
  const row = findNews(session, page, newsRowsOf(session, page, "received")[0].item.id);
  const anonymous = resultsFromAnswer(row, fixture("news-results"), false);
  assert.equal(anonymous.news.kind, "survey");
  assert.equal(anonymous.nominative, false);
  assert.equal(anonymous.questions.length, 2);
  assert.equal(anonymous.questions[0].kind, "single");
  assert.deepEqual(anonymous.questions[0].choices, [{ rank: 1, label: "Oui", count: 1 }, { rank: 2, label: "Non", count: 0 }, { rank: 3, label: "Autre", count: 1 }]);
  assert.equal(anonymous.questions[0].answered, 2);
  assert.deepEqual(anonymous.questions[0].texts, ["Peut-être"]);
  assert.deepEqual(anonymous.questions[0].respondents, []);
  assert.deepEqual(anonymous.questions[1].texts, ["Merci pour l'organisation"]);
  assert.ok(!JSON.stringify(anonymous).includes("PARENT"), "no name without nominative");
  const nominative = resultsFromAnswer(row, fixture("news-results"), true);
  assert.equal(nominative.questions[0].respondents.length, 2);
  assert.equal(nominative.questions[0].respondents[0].label, "M. PARENT F.");
  assert.equal(nominative.questions[0].respondents[0].class, "3A");
  assert.ok(nominative.questions[0].respondents[0].date! > 0);
  assert.deepEqual(nominative.questions[0].respondents[1].answer, { choices: [3], text: "Peut-être", acknowledged: false });
  assert.ok(!JSON.stringify(nominative).includes("68#"), "no raw id");
  assert.throws(() => findNews(session, page, "n:inconnu"), /news_not_found/);
});

test("GET /news/results sends the item as received to PageActualitesResultats", async () => {
  const page = pageWithReceived();
  const id = newsRowsOf(session, page, "received")[0].item.id;
  const fake = fakeSession({
    PageActualites: () => page,
    PageActualitesResultats: (data) => {
      assert.equal(data?.actualite?.N, "65#x30");
      assert.ok(data?.actualite?.listeQuestions, "the whole object, not a reduced { N, L, G }");
      return fixture("news-results");
    },
  });
  const results = await newsResults(fake, id, false);
  assert.equal(results.news.title, "Autorisation de sortie au musée");
});
