import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { rememberUserData } from "../src/pronote/userdata.js";
import { forum, postsFromAnswer, topicsFromAnswer } from "../src/teacher/forum.js";
import { fakeSession } from "./fake-session.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const data = fixture("forum");

test("forum topics of fpcr_Sujets: title, author, subject, themes, counters", () => {
  const [row] = topicsFromAnswer(data.topics);
  assert.deepEqual(row.topic, {
    id: "ft:Exposés sur l'énergie|05/11/2026 10:15:00",
    title: "Exposés sur l'énergie",
    author: "M. PROFESSEUR M.",
    subject: "PHYSIQUE-CHIMIE",
    themes: ["Énergie"],
    state: "1",
    moderated: true,
    unread: 2,
    members: 28,
    toModerate: 1,
    excluded: 0,
    date: Math.floor(new Date(2026, 10, 5, 10, 15).getTime() / 1000),
  });
});

test("forum posts of fpcr_Posts: author, displayed date, HTML, importance", () => {
  const posts = postsFromAnswer(data.posts, "ft:x");
  assert.equal(posts.length, 2);
  assert.equal(posts[0].id, "ft:x|1");
  assert.equal(posts[0].author, "ELEVE Un");
  assert.equal(posts[0].date, Math.floor(new Date(2026, 10, 6, 14, 2).getTime() / 1000));
  assert.equal(posts[0].text, "<p>Bonjour, voici notre plan.</p>");
  assert.equal(posts[1].important, true);
  assert.equal(posts[1].state, "1");
});

test("GET /forum lists the topics, then the posts of one topic with the client's request; closed tab and refusal are relayed", async () => {
  const session = fakeSession({
    ForumPedagogique: (sent) => {
      if (sent?.type === "fpcr_Sujets") return data.topics;
      assert.deepEqual(sent, { type: "fpcr_Posts", sujet: { N: "170#f1" }, avecSujet: true, modeVisuMembre: false });
      return data.posts;
    },
  });
  const topics = await forum(session);
  assert.ok("topics" in topics && topics.topics.length === 1);
  const detail = await forum(session, "ft:Exposés sur l'énergie|05/11/2026 10:15:00");
  assert.ok("posts" in detail && detail.posts.length === 2);
  await assert.rejects(forum(session, "ft:absent|x"), /topic_not_found/);
  const closed = fakeSession({});
  rememberUserData(closed, { tabs: [131] });
  assert.deepEqual(await forum(closed), { available: false, reason: "tab_closed", topics: [] });
  assert.deepEqual(await forum(fakeSession({})), { available: false, reason: "access_denied", topics: [] });
});
