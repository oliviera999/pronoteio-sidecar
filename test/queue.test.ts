import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { PRIORITY, priorityOf, requestContext, type Priority } from "../src/context.js";
import { RateLimitedError } from "../src/errors.js";
import { callCost, Limiter, limiterOf, parseCosts, recentCalls } from "../src/pronote/limiter.js";
import { rememberUserData } from "../src/pronote/userdata.js";
import { studentFilesByIds } from "../src/teacher/students.js";
import { fakeSession } from "./fake-session.js";

/** Lets the resolved promises run between two ticks of the mocked clock. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

test("300 requests in 10 s: none lost under the maximum wait, writes served first", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    // 20 calls per second, 30 requests per second arriving: the queue grows, then drains.
    const limiter = new Limiter({ ratePerMinute: 1200, burst: 20, minSpacingMs: 0, maxWaitMs: 20_000 });
    const waits: { priority: Priority; wait: number }[] = [];
    let refused = 0;
    const pending: Promise<void>[] = [];
    for (let second = 0; second < 10; second++) {
      for (let i = 0; i < 30; i++) {
        const priority: Priority = i % 10 === 0 ? PRIORITY.write : i % 3 === 0 ? PRIORITY.bulk : PRIORITY.read;
        const asked = Date.now();
        pending.push(
          limiter.acquire(1, priority, asked + 20_000).then(
            () => void waits.push({ priority, wait: Date.now() - asked }),
            () => void refused++,
          ),
        );
      }
      for (let step = 0; step < 20; step++) {
        mock.timers.tick(50);
        await flush();
      }
    }
    for (let step = 0; step < 400 && waits.length + refused < 300; step++) {
      mock.timers.tick(50);
      await flush();
    }
    await Promise.all(pending);
    assert.equal(refused, 0);
    assert.equal(waits.length, 300);
    assert.ok(Math.max(...waits.map((item) => item.wait)) < 20_000);
    const average = (priority: Priority) => {
      const list = waits.filter((item) => item.priority === priority);
      return list.reduce((sum, item) => sum + item.wait, 0) / list.length;
    };
    assert.ok(average(PRIORITY.write) < average(PRIORITY.read));
    assert.ok(average(PRIORITY.read) < average(PRIORITY.bulk));
    assert.equal(limiter.stats().served, 300);
  } finally {
    mock.timers.reset();
  }
});

test("the queue serves writes, then unit reads, then bulk reads", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    const limiter = new Limiter({ ratePerMinute: 600, burst: 1, minSpacingMs: 0, maxWaitMs: 60_000 });
    await limiter.acquire(1, PRIORITY.read); // empties the bucket
    const order: string[] = [];
    const all = [
      ...[1, 2, 3].map((n) => limiter.acquire(1, PRIORITY.bulk).then(() => void order.push(`bulk${n}`))),
      ...[1, 2, 3].map((n) => limiter.acquire(1, PRIORITY.read).then(() => void order.push(`read${n}`))),
      ...[1, 2, 3].map((n) => limiter.acquire(1, PRIORITY.write).then(() => void order.push(`write${n}`))),
    ];
    for (let step = 0; step < 50 && order.length < 9; step++) {
      mock.timers.tick(100);
      await flush();
    }
    await Promise.all(all);
    assert.deepEqual(order, ["write1", "write2", "write3", "read1", "read2", "read3", "bulk1", "bulk2", "bulk3"]);
  } finally {
    mock.timers.reset();
  }
});

test("beyond the maximum wait: 429 rate_limited with a coherent retry_after", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    // One call per second, 5 s of wait at most: 6 calls fit, the others are refused at once.
    const limiter = new Limiter({ ratePerMinute: 60, burst: 1, minSpacingMs: 0, maxWaitMs: 5_000 });
    const results: (number | "ok")[] = [];
    const all = Array.from({ length: 10 }, () =>
      limiter.acquire(1, PRIORITY.read).then(
        () => void results.push("ok"),
        (error: unknown) => {
          assert.ok(error instanceof RateLimitedError);
          assert.equal(error.status, 429);
          assert.equal(error.code, "rate_limited");
          assert.equal(error.headers["retry-after"], String(error.extra.retry_after));
          results.push(Number(error.extra.retry_after));
        },
      ),
    );
    await flush();
    const refused = results.filter((item) => item !== "ok") as number[];
    assert.equal(refused.length, 4);
    // The queue ahead (5 calls waiting) drains in 5-6 s: retry after about 1 s to fit in the 5 s wait.
    for (const retry of refused) assert.ok(retry >= 1 && retry <= 2, String(retry));
    const retry = Math.max(...refused);
    mock.timers.tick(retry * 1000);
    await flush();
    // Retrying after retry_after: served within the wait, not refused.
    let late: string = "";
    const again = limiter.acquire(1, PRIORITY.read).then(() => void (late = "ok"), () => void (late = "refused"));
    for (let step = 0; step < 100 && late === ""; step++) {
      mock.timers.tick(100);
      await flush();
    }
    await Promise.all([...all, again]);
    assert.equal(late, "ok");
  } finally {
    mock.timers.reset();
  }
});

test("a call waiting past its deadline (overtaken by writes) is refused with retry_after", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    const limiter = new Limiter({ ratePerMinute: 60, burst: 1, minSpacingMs: 0, maxWaitMs: 3_000 });
    await limiter.acquire(1, PRIORITY.write);
    let outcome = "";
    const bulk = limiter.acquire(1, PRIORITY.bulk, Date.now() + 2_500).then(() => void (outcome = "ok"), (error) => void (outcome = error.code));
    const writes = [1, 2, 3].map(() => limiter.acquire(1, PRIORITY.write, Date.now() + 10_000));
    for (let step = 0; step < 40; step++) {
      mock.timers.tick(100);
      await flush();
    }
    await Promise.all([bulk, ...writes]);
    assert.equal(outcome, "rate_limited");
  } finally {
    mock.timers.reset();
  }
});

test("priorities and costs of the routes", () => {
  assert.equal(priorityOf("POST", "/grades"), PRIORITY.write);
  assert.equal(priorityOf("GET", "/timetable"), PRIORITY.read);
  assert.equal(priorityOf("GET", "/students/files", { resource: "c:T06" }), PRIORITY.bulk);
  assert.equal(priorityOf("GET", "/students/files", { resource: "c:T06", student: "e:A" }), PRIORITY.read);
  assert.equal(priorityOf("GET", "/students/files", { resource: "c:T06", ids: "e:A,e:B" }), PRIORITY.bulk);
  assert.equal(callCost("FicheEleve"), 2);
  assert.equal(callCost("ListeEleves"), 1);
  assert.deepEqual(parseCosts("FicheEleve=3, PageX=1.5,bad=0,=2").FicheEleve, 3);
  assert.equal(parseCosts("PageX=1.5").PageX, 1.5);
  assert.equal(parseCosts("bad=0").bad, undefined);
});

test("students/files?ids=…: partial results with the remaining ids when the deadline is reached", async () => {
  const students = Array.from({ length: 6 }, (_, i) => ({ N: `4#e${i}`, L: `ELEVE${i} Prénom`, G: 4 }));
  const session = fakeSession({
    ListeEleves: () => ({ listeEleves: { _T: 24, V: students } }),
    FicheEleve: (data) => ({ Eleve: { N: data?.Eleve?.N, L: data?.Eleve?.L, Sexe: "F" } }),
  });
  rememberUserData(session, { resources: [{ id: "1#c1", label: "T06", genre: 1 as const, taught: true, principal: false }], tabs: [105, 16] });
  // Roster (1 token) + 2 files (2 tokens each) in the bucket; then 1 token per 200 ms, 1 s of wait at most.
  limiterOf(session, { ratePerMinute: 300, burst: 5, minSpacingMs: 0, maxWaitMs: 1_000 });
  const ids = students.map((item) => `e:${item.L}`);
  const result = await requestContext.run(
    { priority: PRIORITY.bulk, deadline: Date.now() + 1_000, calls: 0, route: "/students/files" },
    () => studentFilesByIds(session, "c:T06", [], [...ids, "e:INCONNU Personne"]),
  );
  assert.equal(result.available, true);
  assert.equal(result.partial, true);
  assert.ok(result.read.length >= 2 && result.read.length < 6, String(result.read.length));
  assert.deepEqual([...result.read, ...result.remaining], ids);
  assert.deepEqual(result.notFound, ["e:INCONNU Personne"]);
  assert.ok(result.retry_after >= 1);
  assert.equal(result.items.length, result.read.length);
  assert.equal(recentCalls(session), 1 + result.read.length);

  // Remaining ids asked again later: complete.
  await new Promise((resolve) => setTimeout(resolve, result.retry_after * 1000));
  const rest = await requestContext.run(
    { priority: PRIORITY.bulk, deadline: Date.now() + 5_000, calls: 0, route: "/students/files" },
    () => studentFilesByIds(session, "c:T06", [], result.remaining),
  );
  assert.equal(rest.partial, false);
  assert.deepEqual(rest.read, result.remaining);
  assert.equal(rest.retry_after, 0);
});
