import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { rememberUserData } from "../src/pronote/userdata.js";
import { distributionLists, findList, listRequest, listsFromAnswer, writeDistributionList } from "../src/teacher/lists.js";
import { fakeSession } from "./fake-session.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

test("distribution lists of ListeDiffusion: label, visibility, author, members as participants", () => {
  const rows = listsFromAnswer(fixture("distribution-lists"));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].list, {
    id: "dl:Équipe 3A",
    label: "Équipe 3A",
    public: false,
    mine: true,
    author: "M. PROFESSEUR M.",
    members: [{ label: "Mme COLLEGUE A.", kind: "teacher" }, { label: "Mme DIRECTION H.", kind: "staff" }],
    count: 2,
  });
  assert.equal(rows[1].list.mine, false);
  assert.ok(!JSON.stringify(rows.map((row) => row.list)).includes("#"), "no raw id");
  assert.equal(findList(rows, "équipe 3a").list.id, "dl:Équipe 3A");
  assert.throws(() => findList(rows, "dl:absente"), /list_not_found/);
});

test("GET /lists answers tab_closed without a call when tab 158 is missing, access_denied on a refusal", async () => {
  const closed = fakeSession({});
  rememberUserData(closed, { tabs: [8, 131] });
  assert.deepEqual(await distributionLists(closed), { available: false, reason: "tab_closed", items: [] });
  assert.equal(closed.calls.length, 0);
  const refused = fakeSession({});
  assert.deepEqual(await distributionLists(refused), { available: false, reason: "access_denied", items: [] });
});

test("SaisieListeDiffusion requests: create with N 0 and E 1, update E 2, delete E 3; another author's list is refused", async () => {
  assert.deepEqual(listRequest(1, 0, "Nouvelle", true, [{ N: "109#t2", G: 3 }]), {
    liste: [{ N: 0, L: "Nouvelle", E: 1, estPublique: true, listePublicIndividu: [{ N: "109#t2", G: 3 }] }],
  });
  const session = fakeSession({
    ListeDiffusion: () => fixture("distribution-lists"),
    ListePublics: () => fixture("publics")["3"],
  });
  rememberUserData(session, { rights: { communication: { avecDiscussionAvancee: true } } });
  const created = await writeDistributionList(session, { action: "create", label: "Nouvelle", public: false, members: [{ kind: "teacher", label: "Mme Collegue A." }] }, true);
  assert.equal(created.written, false);
  assert.equal(created.validated, false);
  assert.deepEqual(created.request, { liste: [{ N: 0, L: "Nouvelle", E: 1, estPublique: false, listePublicIndividu: [{ N: "109#t2", G: 3 }] }] });
  assert.deepEqual(created.after?.members, [{ label: "Mme Collegue A.", kind: "teacher" }]);
  const updated = await writeDistributionList(session, { action: "update", id: "dl:Équipe 3A", public: true }, true);
  assert.deepEqual(updated.request, { liste: [{ N: "140#l1", L: "Équipe 3A", E: 2, estPublique: true, listePublicIndividu: [{ N: "109#t2", G: 3 }, { N: "106#s1", G: 34 }] }] });
  const deleted = await writeDistributionList(session, { action: "delete", id: "dl:Équipe 3A" }, true);
  assert.equal((deleted.request.liste as any[])[0].E, 3);
  assert.equal(deleted.after, null);
  await assert.rejects(writeDistributionList(session, { action: "delete", id: "dl:Parents délégués" }, true), /list_not_mine/);
  await assert.rejects(writeDistributionList(session, { action: "update", id: "dl:absente" }, true), /list_not_found/);
  assert.ok(session.calls.every((call) => call.name !== "SaisieListeDiffusion"), "dryRun writes nothing");
});
