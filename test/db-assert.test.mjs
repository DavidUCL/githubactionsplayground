// The post-restore-database assertion: what it checks, and what it refuses to
// build. See scripts/db-assert.mjs for why each branch exists — every one of
// them is a state `restoreDatabase` reports as a SUCCESSFUL step.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDatabaseAssertion,
  explainDatabaseAssertionExit,
  DB_ASSERT_CODES,
} from "../scripts/db-assert.mjs";
import { gateBlueprint } from "../scripts/preflight.mjs";

const ok = {
  identity: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
  branch: "500",
  loginAs: "admin",
};

test("the assertion is a single-line runPhpCode step the gate accepts", () => {
  const step = buildDatabaseAssertion(ok);
  assert.equal(step.step, "runPhpCode");
  assert.equal(step.code.split("\n").length, 1);
  const bp = {
    version: 1,
    steps: [{ step: "restoreDatabase", url: "https://raw.githubusercontent.com/o/r/c/db.sq3" }, step],
  };
  const g = gateBlueprint(bp, ["raw.githubusercontent.com"]);
  assert.deepEqual([...g.stepErrors, ...g.urlErrors, ...g.unsafeStrings, ...g.bindErrors], []);
  assert.ok(g.riskySteps.includes("runPhpCode"), "the assertion must be reported as risky");
});

// Without CLI_SCRIPT, Moodle swallows the exit code and the step reports
// SUCCESS. This one line is what makes the assertion capable of failing.
test("the PHP defines CLI_SCRIPT before loading Moodle", () => {
  const { code } = buildDatabaseAssertion(ok);
  // `indexOf` returns -1 when absent and -1 < n is TRUE, so the obvious
  // ordering assertion passes when CLI_SCRIPT is missing altogether. Presence
  // first, then order.
  const cli = code.indexOf("CLI_SCRIPT");
  const cfg = code.indexOf("config.php");
  assert.ok(cli >= 0, "CLI_SCRIPT is absent; without it Moodle swallows the exit code");
  assert.ok(cfg >= 0, "config.php is never required");
  assert.ok(cli < cfg, "CLI_SCRIPT must be defined BEFORE config.php");
  assert.match(code, /exit\(0\);$/);
});

test("the step is marked critical, because one host would otherwise skip past it", () => {
  // The action's default host aborts the blueprint on any step failure, but
  // ateeducacion's executor honours `critical` and CONTINUES past a
  // non-critical one — publishing a link to the very site this assertion just
  // refused. Measured 2026-08-17.
  assert.equal(buildDatabaseAssertion(ok).critical, true);
});

test("every value is read with raw $DB, never get_config()", () => {
  const { code } = buildDatabaseAssertion(ok);
  // get_config() answers from the MUC cache, which the restore step purges and
  // re-seeds around the swap. An assertion reading a cache seeded before the
  // restore would compare the pre-restore value with itself and pass.
  assert.ok(!/get_config\s*\(/.test(code), "get_config() would read a cache, not the database");
  assert.match(code, /\$DB->get_field\('config','value'/);
});

test("refuses to build an assertion that would compare nothing", () => {
  // A short or absent siteidentifier is the vacuity that matters most here:
  // "" === "" passes against any database, including one that never restored.
  assert.throws(() => buildDatabaseAssertion({ ...ok, identity: "" }), /unusable siteidentifier/);
  assert.throws(() => buildDatabaseAssertion({ ...ok, identity: "abc" }), /unusable siteidentifier/);
  assert.throws(
    () => buildDatabaseAssertion({ ...ok, identity: "a".repeat(19) }),
    /unusable siteidentifier/,
  );
  // ...and one character longer is fine, so the boundary is the stated one.
  assert.ok(buildDatabaseAssertion({ ...ok, identity: "a".repeat(20) }).code);
});

test("refuses values that would not survive being embedded", () => {
  assert.throws(
    () => buildDatabaseAssertion({ ...ok, identity: `a'.exit(0).'${"b".repeat(20)}` }),
    /unusable siteidentifier/,
  );
  assert.throws(() => buildDatabaseAssertion({ ...ok, branch: "5.0" }), /unusable Moodle branch/);
  assert.throws(() => buildDatabaseAssertion({ ...ok, branch: "" }), /unusable Moodle branch/);
  assert.throws(() => buildDatabaseAssertion({ ...ok, loginAs: "ad'min" }), /unusable username/);
  assert.throws(() => buildDatabaseAssertion({ ...ok, loginAs: "Admin" }), /unusable username/);
});

test("the expected identity is the one that ends up in the program", () => {
  const identity = "0123456789abcdef0123456789abcdef";
  const { code } = buildDatabaseAssertion({ ...ok, identity });
  assert.ok(code.includes(`!== '${identity}'`), "the snapshot's identity must be compared by value");
  // And a DIFFERENT identity produces a different program, so the value is
  // genuinely carried through rather than hard-coded.
  const other = buildDatabaseAssertion({ ...ok, identity: "f".repeat(32) }).code;
  assert.notEqual(code, other);
});

test("the login account is checked, and excludes deleted users", () => {
  const { code } = buildDatabaseAssertion({ ...ok, loginAs: "teacher" });
  assert.match(code, /record_exists\('user',array\('username'=>'teacher','deleted'=>0\)\)/);
  // A deleted user still has a row. `login` does a MUST_EXIST lookup that
  // would not find it, so counting one would be a false pass.
  assert.ok(code.includes("'deleted'=>0"), "a deleted row must not count as the account existing");
});

// The trap this guard exists for: if version.php did not set $branch and the
// config row were absent too, `(string)null !== (string)false` compares "" with
// "" and PASSES — reporting a matching Moodle having read neither value.
test("the version comparison is guarded on both sides before it is made", () => {
  const { code } = buildDatabaseAssertion(ok);
  const guard = code.indexOf("$branch === null || $dbbranch === false");
  const compare = code.indexOf("(string)$branch !== (string)$dbbranch");
  assert.ok(guard >= 0, "neither side of the version comparison is checked for absence");
  assert.ok(compare >= 0, "the version comparison is missing");
  assert.ok(guard < compare, "the absence guard must run BEFORE the comparison");
  // An absent value is 'could not read' (76), not 'mismatch' (74) — different
  // facts, and conflating them would misname the failure in the boot log.
  assert.ok(code.includes("$dbbranch === '') exit(76)"));
});

test("a missing version.php is a named exit, not a PHP fatal", () => {
  // A fatal's exit status under CLI_SCRIPT has never been measured here, so
  // the program must not depend on the answer.
  const { code } = buildDatabaseAssertion(ok);
  const check = code.indexOf("is_readable('/www/moodle/version.php')");
  const req = code.indexOf("require('/www/moodle/version.php')");
  assert.ok(check >= 0, "version.php is required without checking it is there");
  assert.ok(check < req, "the readability check must come before the require");
});

test("the checks run in an order where each one can fail for its own reason", () => {
  const { code } = buildDatabaseAssertion(ok);
  const at = (n) => code.indexOf(`exit(${n})`);
  // Identity before wwwroot: a preview where the restore never happened at all
  // has THIS site's wwwroot in the database and would sail past 73. Only the
  // identity check can tell that case apart.
  assert.ok(at(71) < at(72), "the empty-identity check must precede the mismatch check");
  assert.ok(at(72) < at(73), "the identity check must precede the wwwroot check");
  assert.ok(at(73) < at(74), "the wwwroot check must precede the version check");
});

test("each exit code means one thing, and they are all explained", () => {
  const { code } = buildDatabaseAssertion(ok);
  for (const n of [71, 72, 73, 74, 75, 76]) {
    assert.match(code, new RegExp(`exit\\(${n}\\)`), `code ${n} is never emitted`);
    assert.ok(DB_ASSERT_CODES[n], `code ${n} has no explanation`);
    assert.ok(!/no meaning/.test(explainDatabaseAssertionExit(n)), `code ${n} is unexplained`);
  }
  assert.match(explainDatabaseAssertionExit(99), /no meaning/);
  // Every code the map explains must actually be reachable, or the map is
  // documenting a branch that no longer exists.
  for (const n of Object.keys(DB_ASSERT_CODES)) {
    if (n === "0") continue;
    assert.match(code, new RegExp(`exit\\(${n}\\)`), `${n} is explained but never emitted`);
  }
});

test("the generated program is one line with no // comment in it", () => {
  const { code } = buildDatabaseAssertion(ok);
  // Every generator collapses its program onto one physical line, so a single
  // `//` comments out everything after it — including the exits.
  assert.ok(!code.includes("//"), "a // on a one-line program hides the rest of it");
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[\x00-\x1f\x7f]/.test(code), "preflight refuses control characters in a blueprint");
});
