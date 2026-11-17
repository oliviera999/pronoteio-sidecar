// Prints the lesson "jeudi 12/11/2026 17:10" (AP T06) as normalised by the sidecar, for test/time.test.ts which runs
// this file with another host time zone (TZ=Europe/Paris): the result must not depend on the host.
import type { SessionHandle } from "pawnote";
import { lessonFromPage } from "../../src/teacher/timetable.js";
import { HOST_TIMEZONE, legacySeconds, parseLocal, timeInfo } from "../../src/time.js";

const session = {
  user: { name: "Prof", resources: [{ id: "1#p", name: "Prof" }] },
  instance: { firstMonday: new Date(2026, 8, 7), endings: [], blocksPerDay: 0, version: [2026, 2, 8] },
} as unknown as SessionHandle;
const cours = {
  N: "29#ap", place: 9, duree: 1, DateDuCours: { _T: 7, V: "12/11/2026 17:10:00" }, DateDuCoursFin: { _T: 7, V: "12/11/2026 18:05:00" },
  ListeContenus: { _T: 24, V: [{ N: "1", G: 16, L: "AP" }, { N: "2", G: 2, L: "T06" }] },
};
const ref = lessonFromPage(session, cours, 10)!;
process.stdout.write(JSON.stringify({ lesson: ref.lesson, host: HOST_TIMEZONE, legacy: legacySeconds(parseLocal("2026-11-12 17:10")!), info: timeInfo() }));
