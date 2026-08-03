// The compatibility check exists because of a failure with no error surface:
// a plugin that needs a newer Moodle than the bundle installs "successfully"
// (installMoodlePlugin swallows php.run errors), the blueprint carries on, and
// the reviewer gets a clean Moodle with no plugin in it.
//
// The real case: mod_attendance master declares `requires = 2025100600`
// ("Requires 5.1") against a 5.0.8 bundle. Every test below that names a
// number uses one taken from a real version.php, not an invented one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseVersionPhp,
  readPluginVersion,
  checkMoodleCompatibility,
  checkComponent,
  checkPluginTypeSupported,
  MOODLE_BRANCH_VERSIONS,
  DEFAULT_MOODLE_BRANCH,
} from "../scripts/plugin-version.mjs";
import { derivePlugin } from "../scripts/build-preview.mjs";

// Verbatim from danmarsden/moodle-mod_attendance@master.
const ATTENDANCE_MASTER = `<?php
$plugin->version  = 2026042100;
$plugin->release = 2026042100;
$plugin->requires = 2025100600; // Requires 5.1.
$plugin->component = 'mod_attendance';
`;
// Verbatim from the commit this repo dogfoods, which is fine on 5.0.
const ATTENDANCE_PINNED = `<?php
$plugin->version  = 2025122102;
$plugin->requires = 2025031100; // Requires 5.0.
$plugin->component = 'mod_attendance';
`;

const tmpPlugin = (source) => {
  const dir = mkdtempSync(join(tmpdir(), "plugin-version-"));
  writeFileSync(join(dir, "version.php"), source);
  return dir;
};

test("parses the fields a preview depends on", () => {
  const p = parseVersionPhp(ATTENDANCE_MASTER);
  assert.equal(p.component, "mod_attendance");
  assert.equal(p.version, 2026042100);
  assert.equal(p.requires, 2025100600);
});

test("accepts $module-> as well as $plugin->, and odd spacing", () => {
  const p = parseVersionPhp(`<?php\n$module   ->requires=2024100700 ;\n$module->component = "mod_old";`);
  assert.equal(p.requires, 2024100700);
  assert.equal(p.component, "mod_old");
});

test("truncates core's fractional version form to the integer part", () => {
  // core's own version.php reads `$version = 2025041400.00`
  assert.equal(parseVersionPhp("$plugin->requires = 2025041400.00;").requires, 2025041400);
});

test("missing fields are null, not zero — zero would compare as satisfiable", () => {
  const p = parseVersionPhp("<?php\n// nothing here\n");
  assert.equal(p.requires, null);
  assert.equal(p.component, null);
  assert.equal(p.version, null);
});

test("REFUSES the real failing case: attendance master on the 5.0 bundle", () => {
  const p = parseVersionPhp(ATTENDANCE_MASTER);
  const r = checkMoodleCompatibility(p, "MOODLE_500_STABLE");
  assert.equal(r.ok, false);
  assert.match(r.reason, /2025100600/);
  assert.match(r.reason, /MOODLE_500_STABLE/);
});

test("allows the real passing case: the pinned commit on the 5.0 bundle", () => {
  assert.equal(checkMoodleCompatibility(parseVersionPhp(ATTENDANCE_PINNED), "MOODLE_500_STABLE").ok, true);
});

test("boundary: requires exactly equal to core version is allowed", () => {
  const core = MOODLE_BRANCH_VERSIONS.MOODLE_500_STABLE;
  assert.equal(checkMoodleCompatibility({ requires: core }, "MOODLE_500_STABLE").ok, true);
  assert.equal(checkMoodleCompatibility({ requires: core + 1 }, "MOODLE_500_STABLE").ok, false);
});

test("a plugin that declares no requirement is not refused", () => {
  assert.equal(checkMoodleCompatibility({ requires: null }, "MOODLE_500_STABLE").ok, true);
});

test("an older branch refuses what a newer one allows", () => {
  const p = { requires: MOODLE_BRANCH_VERSIONS.MOODLE_500_STABLE };
  assert.equal(checkMoodleCompatibility(p, "MOODLE_500_STABLE").ok, true);
  assert.equal(checkMoodleCompatibility(p, "MOODLE_405_STABLE").ok, false);
});

test("an unknown branch passes but SAYS the check was skipped", () => {
  const r = checkMoodleCompatibility({ requires: 9999999999 }, "MOODLE_999_STABLE");
  assert.equal(r.ok, true);
  assert.match(r.reason, /not checked/i);
});

test("the default branch is one the table actually knows", () => {
  assert.ok(Object.hasOwn(MOODLE_BRANCH_VERSIONS, DEFAULT_MOODLE_BRANCH));
});

test("reads version.php from disk, and returns null when absent", () => {
  const dir = tmpPlugin(ATTENDANCE_PINNED);
  assert.equal(readPluginVersion(dir).component, "mod_attendance");
  assert.equal(readPluginVersion(join(dir, "nope")), null);
});

test("component mismatch is refused — it extracts to a directory Moodle skips", () => {
  const r = checkComponent("mod_attendance", "mod", "somethingelse");
  assert.equal(r.ok, false);
  assert.match(r.reason, /mod_attendance/);
  assert.equal(checkComponent("mod_attendance", "mod", "attendance").ok, true);
});

test("no declared component is not a mismatch", () => {
  assert.equal(checkComponent(null, "mod", "attendance").ok, true);
});

test("version.php identity beats a misleading repository name", () => {
  // The repo says theme_x; the plugin itself says local_realname. Believe the
  // plugin, or the ZIP extracts to a directory Moodle never reads.
  const { type, name } = derivePlugin("someone/moodle-theme_x", { component: "local_realname" });
  assert.equal(type, "local");
  assert.equal(name, "realname");
});

test("an explicit override still beats version.php", () => {
  const { type, name } = derivePlugin("someone/moodle-theme_x", {
    component: "local_realname",
    type: "block",
    name: "chosen",
  });
  assert.equal(type, "block");
  assert.equal(name, "chosen");
});

test("a junk component falls back to repo-name inference rather than throwing", () => {
  const { type, name } = derivePlugin("someone/moodle-mod_quiz2", { component: "not a component" });
  assert.equal(type, "mod");
  assert.equal(name, "quiz2");
});

test("an oversized version.php is truncated, not read whole", () => {
  const dir = mkdtempSync(join(tmpdir(), "plugin-big-"));
  // Field beyond the 256 KB cap must not be found — proves the cap applies.
  writeFileSync(join(dir, "version.php"), "// " + "x".repeat(300000) + "\n$plugin->requires = 2025100600;");
  assert.equal(readPluginVersion(dir).requires, null);
});

test("readPluginVersion tolerates a directory path with no trailing slash", () => {
  const parent = mkdtempSync(join(tmpdir(), "plugin-nested-"));
  const dir = join(parent, "sub");
  mkdirSync(dir);
  writeFileSync(join(dir, "version.php"), ATTENDANCE_PINNED);
  assert.equal(readPluginVersion(dir).requires, 2025031100);
});

// The newline guard on $GITHUB_OUTPUT is defence in depth: today every value
// reaching it is already validated (checkComponent refuses any component that
// is not exactly `type_name`). It is tested directly because it is the
// defence that has to hold on the day a NEW file-derived value is emitted —
// which is precisely how this class of bug arrives.
test("setOutput refuses a value carrying a newline", async () => {
  const { setOutput } = await import("../scripts/build-preview.mjs");
  const dir = mkdtempSync(join(tmpdir(), "gh-output-"));
  const file = join(dir, "out.txt");
  writeFileSync(file, "");
  const prev = process.env.GITHUB_OUTPUT;
  process.env.GITHUB_OUTPUT = file;
  try {
    setOutput("plugin-component", "mod_attendance");
    assert.throws(
      () => setOutput("plugin-component", "safe\ncomment-body=pwned"),
      /refusing to emit unsafe output/,
    );
    const written = readFileSync(file, "utf8");
    assert.equal(written, "plugin-component=mod_attendance\n");
    assert.ok(!written.includes("comment-body"));
  } finally {
    if (prev === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = prev;
  }
});

// Atto was removed in Moodle 5.0 (lib/editor/atto/version.php is present on
// MOODLE_405_STABLE and 404s on MOODLE_500_STABLE, checked 2026-08-03). An
// atto_* plugin on a 5.0 bundle cannot install, and without this the reviewer
// gets the usual clean-Moodle-with-nothing-in-it.
test("refuses an atto subplugin on a Moodle that removed Atto", () => {
  const r = checkPluginTypeSupported("atto", "MOODLE_500_STABLE");
  assert.equal(r.ok, false);
  assert.match(r.reason, /removed in Moodle 5\.0/);
  assert.match(r.reason, /tiny/);
});

test("allows an atto subplugin on a Moodle that still has Atto", () => {
  assert.equal(checkPluginTypeSupported("atto", "MOODLE_405_STABLE").ok, true);
});

test("plugin types core still ships are untouched", () => {
  for (const t of ["mod", "block", "theme", "tiny", "qtype"]) {
    assert.equal(checkPluginTypeSupported(t, "MOODLE_500_STABLE").ok, true, t);
  }
});

test("an unknown branch does not refuse a removed type on a guess", () => {
  assert.equal(checkPluginTypeSupported("atto", "MOODLE_999_STABLE").ok, true);
});
