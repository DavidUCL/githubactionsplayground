// End-to-end pipeline tests that run the real scripts as subprocesses in a
// temp OUT_DIR. These cover the wiring the unit tests can't: who writes
// verdict.json, what happens to pre-placed files, and how a rejection
// propagates to the outputs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(ROOT, "test", "fixtures");

/** Runs a script; returns stdout+stderr combined (diagnostics go to stderr). */
function runScript(name, dir, env = {}) {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", name)], {
    env: { ...process.env, OUT_DIR: dir, ...env },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `${name} exited ${r.status}: ${r.stderr}`);
  return `${r.stdout}${r.stderr}`;
}

/** A dir prepared as if a real capture had happened (golden = passing). */
function stagedCapture() {
  const dir = mkdtempSync(join(tmpdir(), "bv-pipe-"));
  for (const [src, dest] of [
    ["golden-boot-log.txt", "boot-log.txt"],
    ["golden-console.txt", "console.txt"],
    ["golden-expectations.json", "expectations.json"],
    ["golden-meta.json", "meta.json"],
    ["blueprint-nodb.json", "blueprint.json"],
  ]) {
    copyFileSync(join(FIXTURES, src), join(dir, dest));
  }
  const sha = JSON.parse(readFileSync(join(dir, "expectations.json"), "utf8")).blueprintSha256;
  writeFileSync(
    join(dir, "preflight.json"),
    JSON.stringify({ outcome: "ok", error_class: "none", blueprintSha256: sha }),
  );
  return dir;
}

test("assert.mjs writes the verdict for a staged passing capture", () => {
  const dir = stagedCapture();
  runScript("assert.mjs", dir, { ACCEPTED_ORIGINS: "https://ateeducacion.github.io" });
  const v = JSON.parse(readFileSync(join(dir, "verdict.json"), "utf8"));
  assert.equal(v.status, "pass");
});

test("a pre-placed verdict.json cannot survive assessment", () => {
  const dir = stagedCapture();
  const forged = {
    schema: 1, status: "pass", error_class: "none", head_sha: "", blueprint_sha256: "", risky_steps: [],
    boot_ms: 1, steps_ok: 99, steps_failed: 0, assertions: [{ id: "forged", ok: true }],
  };
  writeFileSync(join(dir, "verdict.json"), JSON.stringify(forged));
  runScript("assert.mjs", dir, { ACCEPTED_ORIGINS: "https://ateeducacion.github.io" });
  const v = JSON.parse(readFileSync(join(dir, "verdict.json"), "utf8"));
  // Overwritten by the real assessment, not trusted.
  assert.notEqual(v.steps_ok, 99);
  assert.equal(v.assertions.some((a) => a.id === "forged"), false);
});

test("a pre-placed verdict.json cannot skip the boot", () => {
  const dir = mkdtempSync(join(tmpdir(), "bv-pipe-"));
  writeFileSync(
    join(dir, "verdict.json"),
    JSON.stringify({ schema: 1, status: "pass", error_class: "none" }),
  );
  // No preflight.json → boot-capture must refuse to treat this as decided.
  const out = runScript("boot-capture.mjs", dir, { BLUEPRINT_URL: "https://raw.githubusercontent.com/a/b.json" });
  assert.match(out, /preflight did not run/);
  assert.equal(existsSync(join(dir, "meta.json")), false);
});

test("assert.mjs reports infra_fail when preflight never ran", () => {
  const dir = mkdtempSync(join(tmpdir(), "bv-pipe-"));
  writeFileSync(
    join(dir, "verdict.json"),
    JSON.stringify({ schema: 1, status: "pass", error_class: "none" }),
  );
  runScript("assert.mjs", dir);
  const v = JSON.parse(readFileSync(join(dir, "verdict.json"), "utf8"));
  assert.equal(v.status, "infra_fail");
});

test("preflight clears stale artifacts before it runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "bv-pipe-"));
  for (const f of ["verdict.json", "meta.json", "boot-log.txt", "console.txt"]) {
    writeFileSync(join(dir, f), "stale");
  }
  // An off-allowlist URL rejects immediately — the clearing happens first.
  runScript("preflight.mjs", dir, { BLUEPRINT_URL: "https://evil.example/b.json" });
  for (const f of ["verdict.json", "meta.json", "boot-log.txt", "console.txt"]) {
    assert.equal(existsSync(join(dir, f)), false, `${f} not cleared`);
  }
  const p = JSON.parse(readFileSync(join(dir, "preflight.json"), "utf8"));
  assert.equal(p.outcome, "rejected");
  assert.equal(p.error_class, "blueprint_host_denied");
});

test("preflight clears the WHOLE artifacts dir, not a list of names", () => {
  const dir = mkdtempSync(join(tmpdir(), "bv-pipe-"));
  // Files an attacker would plant to sit beside genuine evidence in the
  // uploaded artifact — none of them are on any allowlist of known names.
  for (const f of ["screenshot.png", "final-2.png", "summary.txt", "boot-log.txt.bak"]) {
    writeFileSync(join(dir, f), "planted");
  }
  runScript("preflight.mjs", dir, { BLUEPRINT_URL: "https://evil.example/b.json" });
  for (const f of ["screenshot.png", "final-2.png", "summary.txt", "boot-log.txt.bak"]) {
    assert.equal(existsSync(join(dir, f)), false, `${f} survived`);
  }
});

test("a planted DIRECTORY does not crash preflight", () => {
  const dir = mkdtempSync(join(tmpdir(), "bv-pipe-"));
  mkdirSync(join(dir, "verdict.json"), { recursive: true });
  mkdirSync(join(dir, "meta.json"), { recursive: true });
  // Must still produce a clean rejection rather than an unlink error.
  runScript("preflight.mjs", dir, { BLUEPRINT_URL: "https://evil.example/b.json" });
  const p = JSON.parse(readFileSync(join(dir, "preflight.json"), "utf8"));
  assert.equal(p.outcome, "rejected");
});

test("a rejected blueprint becomes a rejected verdict and a rejected output", () => {
  const dir = mkdtempSync(join(tmpdir(), "bv-pipe-"));
  runScript("preflight.mjs", dir, { BLUEPRINT_URL: "https://evil.example/b.json" });
  runScript("boot-capture.mjs", dir, { BLUEPRINT_URL: "https://evil.example/b.json" });
  assert.equal(existsSync(join(dir, "meta.json")), false, "no boot should have happened");
  runScript("assert.mjs", dir);
  const v = JSON.parse(readFileSync(join(dir, "verdict.json"), "utf8"));
  assert.equal(v.status, "rejected");
  assert.equal(v.error_class, "blueprint_host_denied");

  const outFile = join(dir, "gh-output");
  writeFileSync(outFile, "");
  runScript("render-summary.mjs", dir, { GITHUB_OUTPUT: outFile });
  const output = readFileSync(outFile, "utf8");
  assert.match(output, /^status=rejected$/m);
  assert.match(output, /^error-class=blueprint_host_denied$/m);
});
