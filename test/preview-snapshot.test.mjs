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

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBlueprint, landingPath } from "../scripts/build-preview.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "preview");
const SHA = "d0638b39df1c28fd93c27778ae2cbada7cc1660f";

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
    const golden = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));
    assert.deepEqual(buildBlueprint(opts), golden);
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

test("Moodle is installed and logged into before anything depends on it", () => {
  const order = buildBlueprint(CASES.mod).steps.map((s) => s.step);
  assert.equal(order[0], "installMoodle");
  assert.equal(order[1], "login");
  assert.equal(order.indexOf("installMoodlePlugin") > order.indexOf("login"), true);
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
