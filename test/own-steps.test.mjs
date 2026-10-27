import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBlueprint, assertGated } from "../scripts/build-preview.mjs";
import { buildWarningBannerStep } from "../scripts/warning-banner.mjs";
import { ownStep, isOwnStep } from "../scripts/own-steps.mjs";

// The "This preview modifies Moodle itself" warning names risky steps. The
// action's own assertions and banner are runPhpCode, so before own-steps.mjs
// every ordinary preview carried it. These hold both halves: our own steps are
// not named, and anyone else's still are.

const SHA = "d0638b39df1c28fd93c27778ae2cbada7cc1660f";
const THEME = { headRepo: "DavidUCL/moodle-theme_boost_union", headSha: SHA, prNumber: "7", type: "theme", name: "boost_union" };
const SNAPSHOT = {
  url: "https://raw.githubusercontent.com/DavidUCL/mchef-urls/deadbeef/db.sq3",
  sha256: "a".repeat(64),
  facts: { identity: "b".repeat(32), branch: "500", adminUsername: "admin" },
};

/** A theme preview with the banner: the most runPhpCode steps of our own. */
function ordinaryPreview() {
  const bp = buildBlueprint(THEME);
  const at = bp.steps.findIndex((st) => st.step === "login");
  bp.steps.splice(at, 0, buildWarningBannerStep(["a warning"]));
  return bp;
}

const FOREIGN_PHP = { step: "runPhpCode", code: "<?php echo 1;" };

test("an ordinary preview names no risky step, though it runs our own PHP", () => {
  const bp = ordinaryPreview();
  const ours = bp.steps.filter((st) => st.step === "runPhpCode");
  assert.ok(ours.length >= 3, "the case must really contain our own PHP: theme assertion, warm-up, banner");
  assert.ok(ours.every(isOwnStep));
  assert.deepEqual(assertGated(bp), []);
});

test("a runPhpCode step the action did not write is still named", () => {
  const bp = ordinaryPreview();
  bp.steps.splice(1, 0, { ...FOREIGN_PHP });
  assert.deepEqual(assertGated(bp), ["runPhpCode"]);
});

test("a copy of one of our steps is not ours, so it cannot hide from the warning", () => {
  const bp = ordinaryPreview();
  const mine = bp.steps.find((st) => st.step === "runPhpCode");
  // A spread copy and a JSON round trip are what a blueprint author could do.
  for (const copy of [{ ...mine }, JSON.parse(JSON.stringify(mine))]) {
    assert.equal(isOwnStep(copy), false);
    const withCopy = { ...bp, steps: [bp.steps[0], copy, ...bp.steps.slice(1)] };
    assert.deepEqual(assertGated(withCopy), ["runPhpCode"]);
  }
});

test("a restored database is still named: it is risky data, not our code", () => {
  const bp = buildBlueprint({ ...THEME, dbSnapshot: SNAPSHOT });
  assert.ok(bp.steps.some((st) => st.step === "runPhpCode" && isOwnStep(st)), "the case runs the database assertion");
  assert.deepEqual(assertGated(bp), ["restoreDatabase"]);
});

test("ownStep marks only the object it is given", () => {
  const s = ownStep({ step: "runPhpCode", code: "x" });
  assert.equal(isOwnStep(s), true);
  assert.equal(isOwnStep({ step: "runPhpCode", code: "x" }), false);
  assert.equal(isOwnStep(null), false);
  assert.equal(isOwnStep("runPhpCode"), false);
});
