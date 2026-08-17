// Snapshot the WHOLE blueprint, not just properties of it.
//
// The first round of preview tests asserted membership ("a setConfigs step
// exists", "setTheme comes after install") and left 21 constructible mutants
// alive: the course id could change, the enrolment could point at a course
// that does not exist, the Moodle branch could move, login could be dropped,
// the plugin type/name could vanish from the install step — all with a green
// suite. Comparing the decoded blueprint byte-for-byte against a golden file
// kills every content mutation at once.
//
// When a change here is intentional: run
//   node -e "…buildBlueprint…" > test/fixtures/preview/<case>.json
// and review the diff as carefully as you would review the link itself.

import { RISKY_STEPS } from "../scripts/preflight.mjs";
import { PHP_FOR_BRANCH } from "../scripts/build-preview.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBlueprint, landingPath } from "../scripts/build-preview.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "preview");
const SHA = "d0638b39df1c28fd93c27778ae2cbada7cc1660f";
// A real boost_union commit. Full length, because coordinateZipUrl refuses
// anything shorter and a 7-character prefix is not a pin.
const THEME_SHA = "1cf4a2e39ab1b46b1e0c1e0b64a0e19f6f0f7a21";

const CASES = {
  mod: {
    headRepo: "DavidUCL/moodle-mod_attendance",
    headSha: SHA,
    prNumber: "42",
    type: "mod",
    name: "attendance",
  },
  theme: {
    headRepo: "DavidUCL/moodle-theme_boost_union",
    headSha: SHA,
    prNumber: "7",
    type: "theme",
    name: "boost_union",
  },
  // The `theme` control: a theme installed from its own coordinate and made
  // active, on a pull request that is NOT itself a theme. This is the only
  // place that pins setTheme's name to the plugin NAME (never the component),
  // that there is exactly one setTheme, and where the warm-up sits relative to
  // login — none of which a membership assertion would hold.
  "theme-control": {
    headRepo: "DavidUCL/moodle-mod_attendance",
    headSha: SHA,
    prNumber: "42",
    type: "mod",
    name: "attendance",
    themeName: "boost_union",
    installs: [
      {
        url: `https://github.com/moodle-an-hochschulen/moodle-theme_boost_union/archive/${THEME_SHA}.zip`,
        pluginType: "theme",
        pluginName: "boost_union",
      },
      {
        url: `https://github.com/DavidUCL/moodle-mod_attendance/archive/${SHA}.zip`,
        pluginType: "mod",
        pluginName: "attendance",
        isSelf: true,
      },
    ],
  },
  // A course-format plugin previewing ITSELF. The only case pinning three
  // things at once: the format is the plugin's own name (not the box, not
  // topics), the format assertion rides along because that name is not the
  // default, and the landing page is the course rather than an admin page.
  // Nothing covered this before — the `type === "format"` branch was pinned by
  // one mutant and no snapshot.
  format: {
    headRepo: "DavidUCL/moodle-format_tiles",
    headSha: SHA,
    prNumber: "9",
    type: "format",
    name: "tiles",
  },
  // The `course-format` BOX, on an ordinary plugin. Pins that a non-default
  // format brings the assertion with it, and that singleactivity moves the
  // landing page — the format that hides the review brief.
  "course-format": {
    headRepo: "DavidUCL/moodle-mod_attendance",
    headSha: SHA,
    prNumber: "11",
    type: "mod",
    name: "attendance",
    courseFormat: "singleactivity",
  },
  // Language packs. The ONLY case that reaches `lang-assert.mjs`, which matters
  // beyond this control: the "no // comment in generated PHP" guard below walks
  // these CASES, so a generator no case exercises is not checked by it at all.
  // Measured — a `//` planted in this generator left the whole suite green
  // before this case existed.
  "language-packs": {
    headRepo: "DavidUCL/moodle-mod_attendance",
    headSha: SHA,
    prNumber: "13",
    type: "mod",
    name: "attendance",
    languagePacks: ["es", "ar"],
  },
  unknown: {
    headRepo: "DavidUCL/local_myplugin",
    headSha: SHA,
    prNumber: "",
    type: "local",
    name: "myplugin",
  },
};

for (const [name, opts] of Object.entries(CASES)) {
  test(`blueprint for a ${name} plugin matches its golden snapshot exactly`, () => {
    const goldenText = readFileSync(join(FIXTURES, `${name}.json`), "utf8");
    const built = buildBlueprint(opts);
    // deepEqual FIRST, because it is the assertion that explains itself: it
    // prints the differing field, where a string comparison prints two walls of
    // JSON. The serialisation check below is the one that is actually load-bearing.
    assert.deepEqual(built, JSON.parse(goldenText));
    // KEY ORDER IS PART OF THE CONTRACT, and deepEqual does not see it. The
    // link is `gzipSync(JSON.stringify(blueprint))`, so swapping two properties
    // of a user object changes every URL this action has ever produced while
    // deepEqual, all 30 gate checks and the mutation harness stay green. That
    // is not hypothetical: hoisting user construction into a helper is exactly
    // the kind of tidy-up that reorders keys, and one is landing next.
    assert.equal(
      JSON.stringify(built, null, 2) + "\n",
      goldenText,
      `${name}: the blueprint's JSON text differs from the golden file. If only ` +
        `the ORDER of keys moved, deepEqual above passed — and every preview URL ` +
        `just changed.`,
    );
  });
}

// Cross-field invariants a snapshot alone would not explain to a reader.

test("the enrolment targets the course that is actually created", () => {
  const bp = buildBlueprint(CASES.mod);
  const shortname = bp.steps.find((s) => s.step === "createCourse").shortname;
  for (const e of bp.steps.find((s) => s.step === "enrolUsers").enrolments) {
    // enrolUsers looks the course up by shortname; a mismatch aborts the boot
    // at step 8 and the reviewer gets a Moodle with no review course.
    assert.equal(e.course, shortname);
  }
});

test("the landing page points at the course the blueprint creates", () => {
  // createCourse makes exactly one course, so it is id 2 (site course is 1).
  // If that ever stops being true, every landing page 404s.
  const bp = buildBlueprint(CASES.mod);
  assert.equal(bp.steps.filter((s) => s.step === "createCourse").length, 1);
  assert.match(bp.steps.find((s) => s.step === "setLandingPage").path, /course=2\b/);
});

test("the install step keeps carrying the plugin identity explicitly", () => {
  // Without these the playground re-derives identity from the URL path — the
  // exact failure this file's header says the design exists to prevent.
  const install = buildBlueprint(CASES.mod).steps.find(
    (s) => s.step === "installMoodlePlugin",
  );
  assert.equal(install.pluginType, "mod");
  assert.equal(install.pluginName, "attendance");
});

test("a theme preview activates THAT theme, not some other one", () => {
  const bp = buildBlueprint(CASES.theme);
  assert.equal(bp.steps.find((s) => s.step === "setTheme").name, "boost_union");
});

test("step order is load-bearing: install first, log in last", () => {
  const order = buildBlueprint(CASES.mod).steps.map((s) => s.step);
  assert.equal(order[0], "installMoodle");
  // phpLogin does a MUST_EXIST lookup on the username, so logging in before
  // createUsers would abort the blueprint on any non-admin user.
  assert.ok(order.indexOf("login") > order.indexOf("createUsers"),
    "login must come after createUsers");
  // The session must exist before the reviewer is sent to the landing page.
  assert.ok(order.indexOf("login") < order.indexOf("setLandingPage"),
    "login must come before setLandingPage");
  assert.equal(order.at(-1), "setLandingPage");
  // Provisioning still happens against an installed Moodle.
  assert.ok(order.indexOf("installMoodlePlugin") > order.indexOf("installMoodle"));
});

test("the reviewer arrives as a teacher, not admin, wherever that is possible", () => {
  // admin bypasses capability checks, so a capability-fix PR would preview
  // identically fixed or broken. Only admin-page landings need an admin.
  const login = (c) => buildBlueprint(c).steps.find((s) => s.step === "login");
  assert.equal(login(CASES.mod).username, "teacher");
  assert.equal(login(CASES.theme).username, "teacher");
  assert.equal(login(CASES.unknown).username, "admin"); // lands on /admin/plugins.php
});

test("the login step is critical — a failed login must not land a stranger", () => {
  assert.equal(buildBlueprint(CASES.mod).steps.find((s) => s.step === "login").critical, true);
});

test("the Moodle branch is pinned, so previews do not drift between reviewers", () => {
  assert.equal(buildBlueprint(CASES.mod).preferredVersions.moodle, "MOODLE_500_STABLE");
  assert.equal(buildBlueprint(CASES.mod).preferredVersions.php, "8.3");
});

test("landing pages take no required params, so none can error at the reviewer", () => {
  // An earlier qtype guess pointed at question.php, which needs a `cmid` and
  // would have shown a Moodle error reading as "your plugin is broken".
  assert.match(landingPath("mod", "attendance"), /modedit\.php\?add=attendance/);
  assert.match(landingPath("theme", "boost_union"), /course\/view/);
  assert.match(landingPath("format", "tiles"), /course\/view/);
  assert.equal(landingPath("qtype", "essay"), "/admin/qtypes.php");
  assert.equal(landingPath("block", "x"), "/admin/blocks.php");
  assert.equal(landingPath("filter", "x"), "/admin/filters.php");
  assert.equal(landingPath("local", "x"), "/admin/localplugins.php");
  assert.equal(landingPath("report", "x"), "/admin/reports.php");
  // Anything not source-verified still falls back rather than guessing.
  for (const type of ["tool", "qbehaviour", "repository", "media"]) {
    assert.equal(landingPath(type, "x"), "/admin/plugins.php", `${type} should fall back`);
  }
});

test("every provisioning step is critical, so a reload cannot half-apply", () => {
  // Reloading the same link re-runs the blueprint against the existing DB.
  // Without this, createCourse fails as a duplicate while addModule still
  // succeeds — two review briefs and a "found more than one record" box.
  // Observed live; the local playground checkout cannot reproduce it.
  const bp = buildBlueprint(CASES.mod);
  for (const name of ["installMoodlePlugin", "createCategory", "createCourse",
                      "createUsers", "enrolUsers", "addModule"]) {
    assert.equal(bp.steps.find((s) => s.step === name).critical, true, `${name} must be critical`);
  }
  // The install step above all: without it a failed download boots a clean
  // Moodle and the reviewer concludes the plugin does nothing.
  const install = bp.steps.find((s) => s.step === "installMoodlePlugin");
  assert.equal(install.critical, true);
  assert.equal(Object.keys(install).includes("critical"), true);
});

test("a pull request number that is not a number is refused", () => {
  // It lands in a FORMAT_HTML label, so anything else is live HTML on the
  // reviewer's page, same-origin with the playground.
  for (const bad of ['1<img src=x onerror=alert(1)>', "1'", "<b>2</b>", "1 OR 1"]) {
    assert.throws(() => buildBlueprint({ ...CASES.mod, prNumber: bad }), /pr-number must be digits/);
  }
  // Absent is fine — manual runs have no PR.
  assert.doesNotThrow(() => buildBlueprint({ ...CASES.mod, prNumber: "" }));
});

test("the review brief escapes what it interpolates", () => {
  // Defence in depth: pr-number is digits-only and plugin names are
  // [a-z0-9_], so nothing escapable reaches the label through a valid path
  // today. This pins the escaping so a future field added to the heading
  // cannot silently become live HTML on the reviewer's page.
  const intro = buildBlueprint(CASES.mod).steps.find((s) => s.step === "addModule").intro;
  assert.equal(intro.includes("<script"), false);
  // The heading text is escaped rather than interpolated raw.
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "build-preview.mjs"),
    "utf8",
  );
  assert.match(src, /<p><strong>\$\{escapeHtml\(label\)\}<\/strong><\/p>/);
});

test("a format plugin is applied to the review course", () => {
  const bp = buildBlueprint({ ...CASES.mod, type: "format", name: "tiles" });
  assert.equal(bp.steps.find((s) => s.step === "createCourse").format, "tiles");
});

test("the reviewer gets a brief on the course page", () => {
  // Without it the reviewer does not know the logins, or that the yellow
  // debug boxes are deliberate rather than their plugin crashing.
  const label = buildBlueprint(CASES.mod).steps.find((s) => s.step === "addModule");
  assert.equal(label.module, "label");
  assert.equal(label.course, "REVIEW");
  assert.match(label.intro, /password/);
  assert.match(label.intro, /deprecation notices, not crashes/);
  assert.match(label.intro, /d0638b3/);
  // Blueprint strings may not contain newlines — preflight rejects them.
  assert.equal(label.intro.includes("\n"), false);
});

test("a tiny subplugin lands on the TinyMCE settings page, not the plugin list", () => {
  // Previously fell through to /admin/plugins.php, which proves registration
  // and nothing else. The section is defined in lib/editor/tiny/settings.php.
  assert.equal(landingPath("tiny", "myplug"), "/admin/settings.php?section=editorsettingstiny");
});

// NARROWED, deliberately, and not deleted. The original read "no risky steps at
// all", which stopped being true the moment the builder started generating its
// own PHP. Two steps do that, both of them written in this repository and both
// reviewable here:
//
//   restore-assert.mjs   proves the restored course is not empty
//   theme-assert.mjs     proves the theme is really active, and builds its CSS
//
// Neither rewrites Moodle; they are in RISKY_STEPS because `runPhpCode` as a
// STEP TYPE can. What the test still forbids is the thing it was written for: a
// risky step the builder did not generate itself — restoreDatabase, an
// arbitrary runPhpCode from an input, anything that makes the preview's own
// result unprovable.
const BUILDER_GENERATED_PHP = new Set(["runPhpCode"]);

test("the action's own blueprint uses no risky step it did not generate itself", () => {
  for (const [name, c] of Object.entries(CASES)) {
    const steps = buildBlueprint(c).steps;
    const risky = steps.filter((s) => RISKY_STEPS.has(s.step));
    const foreign = risky.filter((s) => !BUILDER_GENERATED_PHP.has(s.step));
    assert.deepEqual(foreign.map((s) => s.step), [], name);
    // ...and every one that IS allowed must be ours: our PHP is one line and
    // starts with the CLI_SCRIPT define, without which the step cannot report
    // failure at all. An input-supplied runPhpCode would not look like this.
    for (const s of risky) {
      assert.match(s.code, /^<\?php define\('CLI_SCRIPT',true\);/, `${name}: ${s.step}`);
      assert.equal(s.code.includes("\n"), false, `${name}: ${s.step} is multi-line`);
      // ...and NO `//` COMMENT, which is only safe to say because of the line
      // above. Every generator collapses its PHP onto one physical line, so a
      // `//` comment silently swallows the entire rest of the program.
      //
      // SCOPE, stated honestly: this walks the snapshot CASES, so it covers a
      // generator only where some CASE reaches it. A generator no CASE exercises
      // is NOT checked here — measured, by planting a `//` in one and watching
      // the whole suite stay green. Every generator therefore needs a CASE, and
      // `build-preview.test.mjs` checks the generators directly as well. Written
      // and shipped: a draft of the course-format assertion commented out its
      // own startdate fix, its comparison and both of its failing exits, and
      // would have exited 0 on every boot including the broken ones. It looked
      // completely ordinary in the source.
      assert.equal(
        s.code.includes("//"), false,
        `${name}: ${s.step} carries a // comment, which on one line comments out everything after it`,
      );
    }
  }
});

// The blueprint's version pin MUST be the branch the compatibility checks ran
// against. It was the literal "MOODLE_500_STABLE" while `moodle-branch` fed
// only the checks, so setting that input validated against one Moodle and
// booted another. Invisible because the input's default equalled the literal.
test("the blueprint pins the Moodle branch it was checked against", () => {
  for (const branch of ["MOODLE_404_STABLE", "MOODLE_405_STABLE", "MOODLE_500_STABLE"]) {
    const bp = buildBlueprint({ ...CASES.mod, moodleBranch: branch });
    assert.equal(bp.preferredVersions.moodle, branch, branch);
  }
});

test("PHP is derived from the branch, not fixed", () => {
  // Every known branch takes 8.3 today, so this asserts the derivation exists
  // rather than a second literal: the playground answers an invalid pair by
  // silently substituting 8.3, so a wrong value here would never surface.
  for (const branch of Object.keys(PHP_FOR_BRANCH)) {
    assert.equal(buildBlueprint({ ...CASES.mod, moodleBranch: branch }).preferredVersions.php,
      PHP_FOR_BRANCH[branch]);
  }
});

test("an unknown branch still yields a usable pin", () => {
  const bp = buildBlueprint({ ...CASES.mod, moodleBranch: "MOODLE_999_STABLE" });
  assert.equal(bp.preferredVersions.moodle, "MOODLE_999_STABLE");
  assert.equal(bp.preferredVersions.php, "8.3");
});
