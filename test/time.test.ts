import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionHandle } from "pawnote";
import { applyLocalTimes } from "../src/localInput.js";
import { lessonFromPage } from "../src/teacher/timetable.js";
import {
  epochToWall,
  inputSeconds,
  localString,
  parseLocal,
  resetTimeEngine,
  timeInfo,
  tzVersionRank,
  wallToEpoch,
  zoneOffset,
} from "../src/time.js";

const session = {
  user: { name: "Prof", resources: [{ id: "1#p", name: "Prof" }] },
  instance: { firstMonday: new Date(2026, 8, 7), endings: [], blocksPerDay: 0, version: [2026, 2, 8] },
} as unknown as SessionHandle;

/** AP T06 of Thursday 12/11/2026 at 17:10 (constat du 12/11: it came out at 16:10). */
const apT06 = {
  N: "29#ap",
  place: 9,
  duree: 1,
  DateDuCours: { _T: 7, V: "12/11/2026 17:10:00" },
  DateDuCoursFin: { _T: 7, V: "12/11/2026 18:05:00" },
  ListeContenus: { _T: 24, V: [{ N: "1", G: 16, L: "AP" }, { N: "2", G: 2, L: "T06" }] },
};

const utc = (y: number, m: number, d: number, h: number, i: number) => Date.UTC(y, m - 1, d, h, i) / 1000;

test("the process runs in UTC whatever the host", () => {
  assert.equal(process.env.TZ, "UTC");
  assert.equal(new Date(2026, 10, 12, 17, 10).getTime(), Date.UTC(2026, 10, 12, 17, 10));
});

test("a 17:10 lesson: local is the wall-clock time, the timestamp is 17:10 UTC (Casablanca in UTC+0)", () => {
  const ref = lessonFromPage(session, apT06, 10)!;
  assert.equal(ref.lesson.id, "l:2026-11-12 17:10|T06|AP");
  assert.deepEqual(ref.lesson.local, { start: "2026-11-12 17:10", end: "2026-11-12 18:05" });
  assert.equal(ref.lesson.start, utc(2026, 11, 12, 17, 10));
  assert.equal(ref.lesson.end, utc(2026, 11, 12, 18, 5));
});

test("both databases agree: Morocco back to GMT since 20/09/2026, UTC+1 before (outside Ramadan)", () => {
  for (const source of ["node", "tzdata"]) {
    process.env.PRONOTEIO_TZ_SOURCE = source;
    resetTimeEngine();
    // Node's database must know the change for this check (Node 22.23 here: tz 2026e); tzdata 2026f always does.
    if (source === "node" && tzVersionRank(process.versions.tz) < tzVersionRank("2026e")) continue;
    assert.equal(timeInfo().source, source);
    assert.equal(wallToEpoch(parseLocal("2026-11-12 17:10")!), utc(2026, 11, 12, 17, 10), source);
    assert.equal(wallToEpoch(parseLocal("2026-11-16 10:00")!), utc(2026, 11, 16, 10, 0), source);
    assert.equal(wallToEpoch(parseLocal("2026-07-01 12:00")!), utc(2026, 7, 1, 11, 0), source);
    assert.equal(zoneOffset(Date.UTC(2026, 10, 12)), 0, source);
    assert.equal(zoneOffset(Date.UTC(2026, 6, 1)), 60, source);
  }
  delete process.env.PRONOTEIO_TZ_SOURCE;
  resetTimeEngine();
});

test("the newest database is chosen and reported in the health information", () => {
  assert.ok(tzVersionRank("2026f") > tzVersionRank("2026e"));
  assert.ok(tzVersionRank("2026a") > tzVersionRank("2025z"));
  assert.equal(tzVersionRank(undefined), 0);
  const info = timeInfo(Date.UTC(2026, 10, 12, 17, 10));
  assert.equal(info.timezone, "Africa/Casablanca");
  assert.equal(info.offsetMinutes, 0);
  assert.equal(info.localNow, "2026-11-12 17:10");
  assert.ok(["node", "tzdata"].includes(info.source));
  assert.match(String(info.embeddedTzVersion), /^\d{4}[a-z]$/);
  assert.equal(info.tzVersion, info.source === "node" ? info.nodeTzVersion : info.embeddedTzVersion);
});

test("a host in Europe/Paris gives the same lesson (the bug of 0.8.0 was the host's zone)", () => {
  const helper = new URL("./helpers/lesson-in-host-zone.ts", import.meta.url).pathname;
  const run = spawnSync(process.execPath, ["--import", "tsx", helper], {
    env: { ...process.env, TZ: "Europe/Paris" },
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.host, "Europe/Paris");
  assert.equal(result.lesson.start, utc(2026, 11, 12, 17, 10));
  assert.equal(result.lesson.local.start, "2026-11-12 17:10");
  // The timestamp of 0.8.0 (host zone), kept only inside the competency ids: one hour too early.
  assert.equal(result.legacy, utc(2026, 11, 12, 16, 10));
});

test("wall-clock conversions are inverse and parseLocal is strict", () => {
  const wall = parseLocal("2026-11-12 17:10")!;
  assert.equal(localString(epochToWall(wallToEpoch(wall))), "2026-11-12 17:10");
  assert.equal(localString(parseLocal("2026-11-12T08:05:00")!), "2026-11-12 08:05");
  assert.equal(localString(parseLocal("2026-11-12")!), "2026-11-12 00:00");
  assert.equal(parseLocal("2026-02-30 10:00"), null);
  assert.equal(parseLocal("12/11/2026 17:10"), null);
  assert.equal(parseLocal(1794503400), null);
});

test("writes: the wall-clock time is preferred to the timestamp", () => {
  assert.equal(inputSeconds(1, "2026-11-12 17:10"), utc(2026, 11, 12, 17, 10));
  assert.equal(inputSeconds(1, undefined), 1);
  assert.equal(inputSeconds(null, undefined), null);
  const body: any = {
    assessment: { title: "DS", date: 1, local: { date: "2026-11-12 08:00", publication: "2026-11-20 18:00" } },
    homework: [{ description: "x", local: { due: "2026-11-19" } }],
  };
  applyLocalTimes(body);
  assert.equal(body.assessment.date, utc(2026, 11, 12, 8, 0));
  assert.equal(body.assessment.publication, utc(2026, 11, 20, 18, 0));
  assert.equal(body.assessment.local, undefined);
  assert.equal(body.homework[0].due, utc(2026, 11, 19, 0, 0));
  assert.throws(() => applyLocalTimes({ local: { date: "demain" } }), /validation_failed:local\.date/);
});

test("no time zone offset is written in the code", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".ts")) files.push(path);
    }
  };
  walk(new URL("../src", import.meta.url).pathname);
  for (const file of files) {
    const code = readFileSync(file, "utf8");
    assert.doesNotMatch(code, /getTimezoneOffset/, file);
    assert.doesNotMatch(code, /["'`](?:UTC|GMT)?[+-]0?1(?::?00)?["'`]/, file);
    assert.doesNotMatch(code, /Europe\/Paris/, file);
    assert.doesNotMatch(code, /offset\w*\s*[=:]\s*-?(?:60|3600)\b/i, file);
  }
});
