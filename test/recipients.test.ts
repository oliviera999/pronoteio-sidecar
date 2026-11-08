import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { SessionHandle } from "pawnote";
import { rememberUserData } from "../src/pronote/userdata.js";
import { filterRecipients, publicsOf, recipients, RECIPIENT_GENRES } from "../src/teacher/recipients.js";
import { fakeSession } from "./fake-session.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const publics = fixture("publics");
const bare = { information: { url: "https://demo.example/pronote", id: "sess1" } } as unknown as SessionHandle;

const all = () => {
  const session = bare;
  rememberUserData(session, { resources: [{ id: "23#c3", label: "1G3", genre: 1, taught: true, principal: false }] });
  return (["class", "group", "teacher", "student", "parent", "staff"] as const).flatMap((kind) =>
    publicsOf(session, kind, publics[String(RECIPIENT_GENRES[kind])]).map((item) => item.recipient),
  );
};

test("recipients are minimised: label, nature, classes, children and roles only, no Pronote id nor support plan", () => {
  const items = all();
  const serialised = JSON.stringify(items);
  for (const forbidden of ["listeProjetsAcc", "regimeEleve", "niveauResponsabilite", "PAP", "Demi-pensionnaire", "46#", "128#", "109#", "23#"]) {
    assert.ok(!serialised.includes(forbidden), `${forbidden} must not leak`);
  }
  const student = items.find((item) => item.label === "ELEVE Un")!;
  assert.deepEqual(student, { id: "r:student|ELEVE Un", kind: "student", label: "ELEVE Un", classes: ["3A"], refuses: false, children: [], role: "", taught: true });
  assert.equal(items.find((item) => item.label === "ELEVE Deux")?.refuses, true);
  const parent = items.find((item) => item.label === "M. PARENT F.")!;
  assert.deepEqual(parent.children, [{ label: "ELEVE Un", class: "3A" }]);
  assert.equal(items.find((item) => item.label === "Mme PARENT G.")?.refuses, true, "refusMess");
  assert.equal(items.find((item) => item.label === "M. PROFESSEUR M.")?.role, "main");
  assert.equal(items.find((item) => item.label === "Mme COLLEGUE A.")?.role, "tutor");
  assert.equal(items.find((item) => item.label === "Mme DIRECTION H.")?.role, "Proviseur");
  assert.equal(items.find((item) => item.label === "3A")?.taught, true, "enseigne");
  assert.equal(items.find((item) => item.label === "1G3")?.taught, true, "taught class of the login data");
  assert.equal(items.find((item) => item.label === "3B")?.taught, false);
});

test("filters: class keeps the class, its students and their parents; student keeps the student, his classes and parents; query matches labels", () => {
  const items = all();
  const byClass = filterRecipients(items, { class: "3a" }).map((item) => item.label);
  assert.deepEqual(byClass, ["3A", "M. PROFESSEUR M.", "Mme COLLEGUE A.", "M. AUTRE B.", "ELEVE Un", "ELEVE Deux", "M. PARENT F.", "Mme DIRECTION H."]);
  const byStudent = filterRecipients(items, { student: "eleve un" }).map((item) => item.label);
  assert.deepEqual(byStudent, ["3A", "ELEVE Un", "M. PARENT F."]);
  assert.deepEqual(filterRecipients(items, { query: "parent" }).map((item) => item.label), ["M. PARENT F.", "Mme PARENT G."]);
  assert.deepEqual(filterRecipients(items, { query: "eleve trois" }).map((item) => item.label), ["ELEVE Trois", "Mme PARENT G."], "a parent matches through the child");
});

test("GET /messages/recipients reads ListeMessagerie for the disabled flag and ListePublics per kind with a { _T: 26 } set", async () => {
  const session = fakeSession({
    ListeMessagerie: () => ({ listeMessagerie: { _T: 24, V: [] }, messagerieDesactivee: true }),
    ListePublics: (data) => {
      assert.deepEqual(Object.keys(data ?? {}).sort(), ["avecFonctionPersonnel", "genres", "pourMessagerie", "sansFiltreSurEleve"]);
      const genre = String(data!.genres.V).replace(/[[\]]/g, "");
      assert.equal(data!.genres._T, 26);
      return publics[genre];
    },
  });
  rememberUserData(session, { rights: { communication: { avecDiscussionAvancee: true } } });
  const result = await recipients(session, ["student", "parent"], { class: "3A", limit: 2 });
  assert.equal(result.available, true);
  assert.equal(result.disabled, true);
  assert.equal(result.total, 3);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.items.map((item) => item.label), ["ELEVE Un", "ELEVE Deux"]);
  assert.deepEqual(session.calls.map((call) => call.name), ["ListeMessagerie", "ListePublics", "ListePublics"]);
});

test("without the advanced messaging right, ListeRessourcesPourCommunication is tried and an empty answer gives recipients_unavailable", async () => {
  const session = fakeSession({
    ListeMessagerie: () => ({ listeMessagerie: { _T: 24, V: [] }, messagerieDesactivee: false }),
    ListeRessourcesPourCommunication: (data) => {
      assert.deepEqual(data, { onglet: { N: 0, G: 4 } });
      return { listeRessources: { _T: 24, V: [] } };
    },
  });
  rememberUserData(session, { rights: { Communication: { AvecDiscussionAvancee: false } } });
  const result = await recipients(session, ["student"]);
  assert.deepEqual(result, { available: false, reason: "recipients_unavailable", disabled: false, items: [], total: 0, truncated: false });
  assert.ok(!session.calls.some((call) => call.name === "ListePublics"));
});
