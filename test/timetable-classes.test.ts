import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";

/*
 * 0.11.1, case of 20/11/2026: lessons of a whole class (enseignement scientifique of T06 and T11) came from GET
 * /timetable with no group, Pawnote keeping only the groups (G 2) of a lesson. tools/patch-pawnote.mjs (postinstall)
 * sends the classes (G 1) and parts of classes (G 57) to groupNames, like src/teacher/timetable.ts.
 */
test("patched Pawnote: the lesson decoder keeps classes and parts of classes in groupNames", () => {
  const dist = dirname(createRequire(import.meta.url).resolve("pawnote"));
  for (const file of ["index.js", "index.mjs"]) {
    const source = readFileSync(join(dist, file), "utf8");
    assert.match(source, /case 1:case 57:case 2:\w\.push\(s\.L\)\/\*pronoteio-lesson-classes\*\//, file);
    assert.equal(source.split("/*pronoteio-lesson-classes*/").length, 2, `${file}: patched once`);
  }
});
