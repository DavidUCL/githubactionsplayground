// The post-restore assertion.
//
// Its PHP SEMANTICS cannot be proven here — no mock of Moodle's DB would tell
// us whether `deletioninprogress=0` or `get_fieldset_sql` behave. Those are
// proven by booting, and pinned permanently by LIVE check 6. What IS proven
// here is everything around the PHP: that it refuses to generate an assertion
// that could not fail, and that what it generates survives our own gate.

import test from "node:test";
import assert from "node:assert/strict";
import { buildRestoreAssertion, explainAssertionExit, ASSERT_CODES } from "../scripts/restore-assert.mjs";
import { gateBlueprint } from "../scripts/preflight.mjs";

const ok = { shortname: "REVIEW", modulenames: ["assign"], activityCount: 1 };

test("the generated step is one line and passes our own gate", () => {
  const step = buildRestoreAssertion(ok);
  assert.equal(step.step, "runPhpCode");
  assert.ok(!/[\r\n]/.test(step.code), "a control character would be refused by preflight");
  const ZIP = `https://raw.githubusercontent.com/a/b/${"a".repeat(40)}/p.zip`;
  const bp = {
    steps: [
      { step: "installMoodle" },
      { step: "restoreCourse", url: ZIP, shortname: "REVIEW" },
      step,
      { step: "setLandingPage", path: "/course/view.php?name=REVIEW" },
    ],
  };
  const g = gateBlueprint(bp, ["raw.githubusercontent.com"]);
  assert.deepEqual([...g.stepErrors, ...g.urlErrors, ...g.unsafeStrings, ...g.bindErrors], []);
  assert.ok(g.riskySteps.includes("runPhpCode"), "the assertion must be reported as risky");
});

// Measured: without CLI_SCRIPT, Moodle swallows exit codes AND fatal errors AND
// uncaught exceptions, and the step reports SUCCESS. This is the single line
// that makes the assertion capable of failing at all.
test("the PHP defines CLI_SCRIPT before loading Moodle", () => {
  const code = buildRestoreAssertion(ok).code;
  // `indexOf` returns -1 when absent, and -1 < n is TRUE — so the obvious
  // ordering assertion PASSES when CLI_SCRIPT is missing entirely, which is
  // exactly the mutant it exists to catch. Assert presence first.
  const cli = code.indexOf("CLI_SCRIPT");
  const cfg = code.indexOf("config.php");
  assert.ok(cli >= 0, "CLI_SCRIPT is absent; without it Moodle swallows the exit code");
  assert.ok(cfg >= 0, "config.php is never required");
  assert.ok(cli < cfg, "CLI_SCRIPT must be defined BEFORE config.php");
  assert.match(code, /exit\(0\);$/);
});

// An assertion that passes on an empty course is worse than no assertion.
test("refuses to build an assertion that cannot fail", () => {
  assert.throws(() => buildRestoreAssertion({ ...ok, activityCount: 0 }), /worse than no assertion/);
  assert.throws(() => buildRestoreAssertion({ ...ok, activityCount: -1 }), /worse than no assertion/);
  assert.throws(() => buildRestoreAssertion({ ...ok, modulenames: [] }), /refusing to assert nothing/);
});

test("refuses values that would not survive being embedded", () => {
  assert.throws(() => buildRestoreAssertion({ ...ok, shortname: "RE'VIEW" }), /unusable course shortname/);
  assert.throws(() => buildRestoreAssertion({ ...ok, shortname: "" }), /unusable course shortname/);
  assert.throws(() => buildRestoreAssertion({ ...ok, modulenames: ["as'sign"] }), /unusable module name/);
  assert.throws(() => buildRestoreAssertion({ ...ok, modulenames: ["Assign"] }), /unusable module name/);
});

// deletioninprogress: a module queued for async deletion still has a
// course_modules row, and would inflate the count into a false pass.
test("the count excludes modules queued for deletion", () => {
  assert.match(buildRestoreAssertion(ok).code, /deletioninprogress=0/);
});

test("every declared module name is required by name", () => {
  const code = buildRestoreAssertion({ ...ok, modulenames: ["assign", "quiz"], activityCount: 2 }).code;
  assert.match(code, /'assign','quiz'/);
  assert.match(code, /exit\(23\)/);
});

test("each exit code means one thing, and they are all explained", () => {
  const code = buildRestoreAssertion(ok).code;
  for (const n of [21, 22, 23, 24]) {
    assert.match(code, new RegExp(`exit\\(${n}\\)`), `code ${n} is never emitted`);
    assert.ok(ASSERT_CODES[n], `code ${n} has no explanation`);
    assert.ok(!/no meaning/.test(explainAssertionExit(n)), `code ${n} is unexplained`);
  }
  assert.match(explainAssertionExit(99), /no meaning/);
});
