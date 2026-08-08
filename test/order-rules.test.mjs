// Ordering and referential integrity.
//
// The cases below are written out BY HAND rather than generated from
// ORDER_RULES. A generated case would disappear along with the rule it covers,
// so deleting a rule would leave the suite green — the table would be marking
// its own homework. Instead: a fixed case per rule id, plus a coverage test
// that fails if the table and the case list stop matching in either direction.

import test from "node:test";
import assert from "node:assert/strict";
import { ORDER_RULES, STEP_GROUPS, checkOrder, checkReferences } from "../scripts/order-rules.mjs";

const ZIP = `https://raw.githubusercontent.com/a/b/${"a".repeat(40)}/p.zip`;
const s = (step, extra = {}) => ({ step, ...extra });

/** One BAD ordering per rule id: the two steps in the wrong order. */
const CASES = {
  "install-moodle-first": [s("createUsers", { users: [{ username: "u" }] }), s("installMoodle")],
  "restore-database-early": [
    s("installMoodle"),
    s("createUsers", { users: [{ username: "u" }] }),
    s("restoreDatabase", { url: ZIP }),
  ],
  "install-theme-before-set-theme": [
    s("installMoodle"),
    s("setTheme", { name: "boost_union" }),
    s("installTheme", { url: ZIP, pluginName: "boost_union" }),
  ],
  "users-before-enrol": [
    s("installMoodle"),
    s("enrolUsers", { enrolments: [{ username: "u", course: "C" }] }),
    s("createUsers", { users: [{ username: "u" }] }),
  ],
  "users-before-login": [
    s("installMoodle"),
    s("login", { username: "u" }),
    s("createUsers", { users: [{ username: "u" }] }),
  ],
  "course-before-enrol": [
    s("installMoodle"),
    s("enrolUsers", { enrolments: [{ username: "u", course: "C" }] }),
    s("createCourse", { shortname: "C" }),
  ],
  "landing-page-last": [
    s("installMoodle"),
    s("setLandingPage", { path: "/my/" }),
    s("createCourse", { shortname: "C" }),
  ],
};

test("every rule has a case and every case has a rule", () => {
  const ids = ORDER_RULES.map((r) => r.id);
  assert.deepEqual([...ids].sort(), Object.keys(CASES).sort());
  assert.equal(new Set(ids).size, ids.length, "duplicate rule id");
});

for (const [id, steps] of Object.entries(CASES)) {
  test(`ordering rule "${id}" refuses its bad case`, () => {
    const errors = checkOrder(steps);
    assert.ok(errors.length > 0, `accepted a blueprint violating ${id}`);
    // The message has to carry the reason, not just "wrong order" — the reason
    // is the only thing that tells the author what actually breaks.
    const rule = ORDER_RULES.find((r) => r.id === id);
    assert.ok(
      errors.some((e) => e.includes(rule.why)),
      `no error explained ${id}: ${errors.join(" | ")}`,
    );
  });

  test(`ordering rule "${id}" accepts the same steps in the right order`, () => {
    // Every case above is a straight swap of the last two steps, so undoing it
    // must be clean. This is the half that catches a rule which refuses
    // everything — an always-refuse rule passes the test above.
    const fixed = [...steps];
    const last = fixed.pop();
    fixed.splice(fixed.length - 1, 0, last);
    assert.deepEqual(checkOrder(fixed), []);
  });
}

// ---------------------------------------------------------------------------
// Differential test against an independent oracle.
//
// The oracle is deliberately the stupid O(n²) reading of the rule — "no A may
// appear after any B" — written from the rule table without looking at
// checkOrder's wildcard/except handling. Agreement across thousands of random
// permutations is what catches a bug in the clever version. A property test
// that called checkOrder as its own oracle would be worth nothing.

function oracleViolates(steps) {
  const names = steps.map((x) => x?.step);
  const inGroup = (n, spec, other, except) => {
    if (spec !== "*") return (STEP_GROUPS[spec] || []).includes(n);
    return Boolean(n) && !(STEP_GROUPS[other] || []).includes(n) && !except.includes(n);
  };
  for (const rule of ORDER_RULES) {
    const except = rule.except || [];
    for (let i = 0; i < names.length; i++) {
      for (let j = 0; j < i; j++) {
        // names[i] is a `before` step sitting after names[j], an `after` step.
        if (
          inGroup(names[i], rule.before, rule.after, except) &&
          inGroup(names[j], rule.after, rule.before, except)
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

/** Deterministic PRNG — Math.random would make a failure unreproducible. */
function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("checkOrder agrees with an independent oracle on 2000 permutations", () => {
  const maximal = [
    s("installMoodle"),
    s("restoreDatabase", { url: ZIP }),
    s("installMoodlePlugin", { url: ZIP, pluginType: "mod", pluginName: "attendance" }),
    s("installTheme", { url: ZIP, pluginName: "boost_union" }),
    s("setConfigs", { configs: [{ name: "x", value: "1" }] }),
    s("createCourse", { shortname: "C" }),
    s("createUsers", { users: [{ username: "u" }] }),
    s("enrolUsers", { enrolments: [{ username: "u", course: "C" }] }),
    s("addModule", { module: "attendance", course: "C" }),
    s("setTheme", { name: "boost_union" }),
    s("login", { username: "u" }),
    s("setLandingPage", { path: "/my/" }),
  ];
  const rand = mulberry32(20260807);
  let refused = 0;
  const N = 2000;
  for (let n = 0; n < N; n++) {
    const p = [...maximal];
    if (n % 2 === 0) {
      // SMALL perturbations of the canonical order. A full shuffle of 12 steps
      // against 9 rules is refused essentially every time — measured 2000/2000
      // — which makes "the two implementations agree" trivially true. Swapping
      // one or two adjacent pairs lands on both sides of the line, because many
      // adjacent steps are independent of each other.
      const swaps = 1 + Math.floor(rand() * 2);
      for (let k = 0; k < swaps; k++) {
        const i = Math.floor(rand() * (p.length - 1));
        [p[i], p[i + 1]] = [p[i + 1], p[i]];
      }
    } else {
      for (let i = p.length - 1; i > 0; i--) {
        const k = Math.floor(rand() * (i + 1));
        [p[i], p[k]] = [p[k], p[i]];
      }
    }
    const got = checkOrder(p).length > 0;
    const want = oracleViolates(p);
    assert.equal(got, want, `disagreed on: ${p.map((x) => x.step).join(",")}`);
    if (got) refused++;
  }
  // Both directions must actually occur, or the agreement above proves nothing.
  assert.ok(refused > N * 0.05, `degenerate: only ${refused}/${N} refused`);
  assert.ok(refused < N * 0.95, `degenerate: ${refused}/${N} refused — nothing accepted`);
});

test("the maximal blueprint in canonical order is accepted", () => {
  const maximal = [
    s("installMoodle"),
    s("restoreDatabase", { url: ZIP }),
    s("installMoodlePlugin", { url: ZIP, pluginType: "mod", pluginName: "attendance" }),
    s("installTheme", { url: ZIP, pluginName: "boost_union" }),
    s("setConfigs", { configs: [{ name: "x", value: "1" }] }),
    s("createCourse", { shortname: "C" }),
    s("createUsers", { users: [{ username: "u" }] }),
    s("enrolUsers", { enrolments: [{ username: "u", course: "C" }] }),
    s("addModule", { module: "attendance", course: "C" }),
    s("setTheme", { name: "boost_union" }),
    s("login", { username: "u" }),
    s("setLandingPage", { path: "/my/" }),
  ];
  assert.deepEqual(checkOrder(maximal), []);
});

// ---------------------------------------------------------------------------
// Referential integrity

const CORE = { ok: true, standard: new Set(["theme_boost", "theme_classic"]) };

test("login names a user nobody creates", () => {
  const e = checkReferences([s("installMoodle"), s("login", { username: "ghost" })], CORE);
  assert.match(e.join(";"), /no earlier step creates the user "ghost"/);
});

// installMoodle creates the admin (moodle-install.js:35). Without this the rule
// refuses the real vendored blueprint in test/fixtures, which logs in as admin.
test("login as admin needs no createUsers", () => {
  assert.deepEqual(checkReferences([s("installMoodle"), s("login", { username: "admin" })], CORE), []);
});

test("a renamed admin is honoured", () => {
  const steps = [s("installMoodle", { username: "root" }), s("login", { username: "root" })];
  assert.deepEqual(checkReferences(steps, CORE), []);
});

test("enrolment names a user and a course nobody creates", () => {
  const e = checkReferences(
    [s("installMoodle"), s("enrolUsers", { enrolments: [{ username: "u", course: "C" }] })],
    CORE,
  );
  assert.match(e.join(";"), /creates the user "u"/);
  assert.match(e.join(";"), /creates the course "C"/);
});

// A core theme needs no install step. The panel's rule as written ("must match
// some installed theme") would refuse `setTheme: boost`, which is valid.
test("setTheme naming a CORE theme is accepted with no install", () => {
  assert.deepEqual(checkReferences([s("installMoodle"), s("setTheme", { name: "boost" })], CORE), []);
});

test("setTheme naming a theme nobody installed is refused", () => {
  const e = checkReferences([s("installMoodle"), s("setTheme", { name: "boost_union" })], CORE);
  assert.match(e.join(";"), /neither a core theme nor installed/);
});

// mchef emits themes as installMoodlePlugin with pluginType "theme" — the real
// vendored fixture installs theme_boost_union that way and then activates it.
test("a theme installed via installMoodlePlugin satisfies setTheme", () => {
  const steps = [
    s("installMoodle"),
    s("installMoodlePlugin", { url: ZIP, pluginType: "theme", pluginName: "boost_union" }),
    s("setTheme", { name: "boost_union" }),
  ];
  assert.deepEqual(checkReferences(steps, CORE), []);
});

test("without a core list the theme rule is skipped, not guessed", () => {
  const steps = [s("installMoodle"), s("setTheme", { name: "boost_union" })];
  assert.deepEqual(checkReferences(steps, undefined), []);
  assert.deepEqual(checkReferences(steps, { ok: false, standard: new Set() }), []);
});

// restoreDatabase brings in users and courses this gate cannot enumerate.
// Enforcing the name rules past it would refuse every blueprint step 6 of the
// build plan is meant to produce.
test("references are waived after a restore", () => {
  const steps = [
    s("installMoodle"),
    s("restoreDatabase", { url: ZIP }),
    s("enrolUsers", { enrolments: [{ username: "fromdb", course: "FROMDB" }] }),
    s("login", { username: "fromdb" }),
  ];
  assert.deepEqual(checkReferences(steps, CORE), []);
});

test("references BEFORE the restore are still checked", () => {
  const steps = [
    s("installMoodle"),
    s("login", { username: "ghost" }),
    s("restoreDatabase", { url: ZIP }),
  ];
  assert.match(checkReferences(steps, CORE).join(";"), /"ghost"/);
});

// ---------------------------------------------------------------------------
// Regression: the published canary blueprint.
//
// A code review caught this and it was a genuine HIGH. mchef emits
// restoreDatabase FIRST (BlueprintConverter.php:62 array_unshift) — the swap
// happens inside PHP before config.php loads, so it does not need an installed
// Moodle. The first version of install-moodle-first had no `except`, so the
// gate refused the project's own nightly canary and every blueprint mchef
// publishes. Neither the maximal blueprint nor the differential oracle caught
// it, because both put installMoodle at index 0.
test("the canary's restoreDatabase-first order is accepted", () => {
  const canary = [
    s("restoreDatabase", { url: ZIP }),
    s("installMoodle"),
    s("login", { username: "admin" }),
    s("installMoodlePlugin", { url: ZIP, pluginType: "theme", pluginName: "boost_union" }),
    s("installMoodlePlugin", { url: ZIP, pluginType: "mod", pluginName: "attendance" }),
    s("setTheme", { name: "boost_union" }),
  ];
  assert.deepEqual(checkOrder(canary), []);
  assert.deepEqual(checkReferences(canary, CORE), []);
});

// The exception is narrow: restoreDatabase may precede installMoodle, nothing
// else may.
test("only restoreDatabase may precede installMoodle", () => {
  for (const first of ["createUsers", "login", "setConfigs", "installMoodlePlugin"]) {
    const steps = [s(first), s("installMoodle")];
    assert.ok(checkOrder(steps).length > 0, `${first} was allowed before installMoodle`);
  }
});

// Replaces a blanket rule that refused an unrelated plugin installed after an
// addModule — an ordering with no nameable breakage.
test("an unrelated plugin may be installed after addModule", () => {
  const steps = [
    s("installMoodle"),
    s("installMoodlePlugin", { url: ZIP, pluginType: "mod", pluginName: "attendance" }),
    s("createCourse", { shortname: "C" }),
    s("addModule", { module: "attendance", course: "C" }),
    s("installLanguagePack", { code: "de" }),
  ];
  assert.deepEqual(checkOrder(steps), []);
  assert.deepEqual(checkReferences(steps, { ...CORE, standard: new Set(["theme_boost"]) }), []);
});

test("adding an instance of a module nobody installed is refused", () => {
  const steps = [s("installMoodle"), s("createCourse", { shortname: "C" }),
    s("addModule", { module: "ghostmod", course: "C" })];
  assert.match(checkReferences(steps, CORE).join(";"), /neither a core activity nor/);
});

test("a CORE activity needs no install step", () => {
  const core = { ok: true, standard: new Set(["mod_label"]) };
  const steps = [s("installMoodle"), s("createCourse", { shortname: "C" }),
    s("addModule", { module: "label", course: "C" })];
  assert.deepEqual(checkReferences(steps, core), []);
});

// Replaces a blanket "no setConfig after createCourse" rule. Only THIS setting
// is copied into the course at creation time.
test("an ordinary config after a course is fine; the welcome message is not", () => {
  const ok = [s("installMoodle"), s("createCourse", { shortname: "C" }),
    s("setConfig", { name: "somepluginsetting", value: "1" })];
  assert.deepEqual(checkReferences(ok, CORE), []);
  const bad = [s("installMoodle"), s("createCourse", { shortname: "C" }),
    s("setConfig", { name: "sendcoursewelcomemessage", value: "1" })];
  assert.match(checkReferences(bad, CORE).join(";"), /reaches no existing course/);
  // Before any course exists it is the correct place to set it.
  const fine = [s("installMoodle"), s("setConfig", { name: "sendcoursewelcomemessage", value: "1" }),
    s("createCourse", { shortname: "C" })];
  assert.deepEqual(checkReferences(fine, CORE), []);
});
