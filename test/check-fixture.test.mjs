// The fixture checker — the honesty proof for make-fixture.
//
// It matters that this is strict: it is the only thing standing between "the
// seed script ran" and "the seed script produced what it was asked to". The
// PR it opens cannot be trusted to check itself — GitHub puts approval-required
// checks on a PR created with GITHUB_TOKEN, and a reviewer can merge past them.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkFixture } from "../scripts/check-fixture.mjs";
import { tarGz } from "./helpers/archive.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC = JSON.parse(readFileSync(join(HERE, "..", "fixtures", "fixture-spec.json"), "utf8"));
const mbz = (f) => readFileSync(join(HERE, "fixtures", "mbz", f));

test("the spec itself is coherent", () => {
  // A spec naming REVIEW would guarantee the restored content lands in a course
  // called something else.
  assert.notEqual(SPEC.shortname, "REVIEW");
  assert.equal(SPEC.includesUsers, false);
  assert.ok(SPEC.modules.length > 0);
  assert.equal(new Set(SPEC.modules).size, SPEC.modules.length, "duplicate module in the spec");
  // chat and survey are gone from 5.0, the default branch, and would be dropped
  // silently on restore.
  for (const banned of ["chat", "survey"]) {
    assert.ok(!SPEC.modules.includes(banned), `${banned} does not exist on 5.0`);
  }
});

test("a backup that does not match the spec is refused, and says how", () => {
  const r = checkFixture(mbz("backup.mbz"), SPEC);
  assert.equal(r.ok, false);
  const joined = r.problems.join("; ");
  assert.match(joined, /activities do not match/);
  assert.match(joined, /missing assign/);
});

// The failure that was actually measured: a fixture carrying student1 restored
// fine, the assertion passed, then createUsers died five steps in.
test("a fixture carrying users is refused when the spec says it must not", () => {
  const r = checkFixture(mbz("legacy_course_completion.mbz"), SPEC);
  assert.equal(r.ok, false);
  assert.match(r.problems.join("; "), /carries user\(s\) student1/);
});

test("an activity backup is refused", () => {
  const r = checkFixture(mbz("moodle_311_quiz.mbz"), SPEC);
  assert.equal(r.ok, false);
  assert.match(r.problems.join("; "), /not a course backup/);
});

// A fixture that owns REVIEW leaves the restored content in a course named
// something else, because phpRestoreCourse only takes a FREE shortname. Needs a
// backup that really is called REVIEW, so it is built rather than borrowed.
test("a fixture owning REVIEW is refused even when it otherwise matches", () => {
  const manifest = `
<moodle_backup><information>
<original_course_shortname>REVIEW</original_course_shortname>
<details><detail><type>course</type></detail></details>
<contents><activities>
<activity><moduleid>1</moduleid><modulename>glossary</modulename></activity>
</activities></contents>
<settings><setting><name>users</name><value>0</value></setting></settings>
</information></moodle_backup>`;
  const spec = { shortname: "REVIEW", modules: ["glossary"], includesUsers: false };
  const r = checkFixture(tarGz([["moodle_backup.xml", manifest]]), spec);
  assert.equal(r.ok, false, "a REVIEW-named fixture must be refused");
  assert.match(r.problems.join("; "), /needs to be free/);
});

// Names alone are not enough: two of one module and none of another satisfies a
// name-only check.
test("the activity COUNT is checked, not just the names", () => {
  const spec = { ...SPEC, shortname: "CI", modules: ["glossary", "glossary"], includesUsers: false };
  const r = checkFixture(mbz("backup.mbz"), spec);
  assert.equal(r.ok, false);
  assert.match(r.problems.join("; "), /declares 1 activities, the spec declares 2/);
});

test("a matching backup passes", () => {
  // backup.mbz really is one glossary, no users, shortname CI.
  const spec = { shortname: "CI", modules: ["glossary"], includesUsers: false };
  const r = checkFixture(mbz("backup.mbz"), spec);
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
});

test("unreadable input is refused rather than crashing", () => {
  assert.equal(checkFixture(Buffer.from("<!DOCTYPE html>"), SPEC).ok, false);
  assert.equal(checkFixture(Buffer.alloc(0), SPEC).ok, false);
});
