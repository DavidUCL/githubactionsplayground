// The summary renderer is the only code that writes into privileged runner
// channels ($GITHUB_OUTPUT / $GITHUB_STEP_SUMMARY). These tests run it as a
// subprocess with those channels pointed at temp files and assert nothing
// but validated enum/int/hex data ever lands there.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function run(verdict) {
  const dir = mkdtempSync(join(tmpdir(), "bv-render-"));
  if (verdict !== undefined) {
    writeFileSync(join(dir, "verdict.json"), JSON.stringify(verdict));
  }
  const outFile = join(dir, "gh-output");
  const sumFile = join(dir, "gh-summary");
  writeFileSync(outFile, "");
  writeFileSync(sumFile, "");
  execFileSync(process.execPath, [join(ROOT, "scripts", "render-summary.mjs")], {
    env: { ...process.env, OUT_DIR: dir, GITHUB_OUTPUT: outFile, GITHUB_STEP_SUMMARY: sumFile },
    stdio: "pipe",
  });
  return { output: readFileSync(outFile, "utf8"), summary: readFileSync(sumFile, "utf8") };
}

const good = {
  schema: 1,
  status: "pass",
  error_class: "none",
  head_sha: "a".repeat(40),
  blueprint_sha256: "b".repeat(64),
  boot_ms: 9813,
  steps_ok: 6,
  steps_failed: 0,
  assertions: [{ id: "a0_loopback_binding", ok: true }],
  risky_steps: [],
};

test("valid verdict yields exactly the three expected outputs", () => {
  const { output, summary } = run(good);
  const names = output.trim().split("\n").map((l) => l.split("=")[0]);
  assert.deepEqual(names, ["status", "error-class", "verdict-path"]);
  assert.match(output, /^status=pass$/m);
  assert.match(summary, /## Boot verify: ✅ PASS/);
});

test("missing verdict degrades to infra_fail, never pass", () => {
  const { output } = run(undefined);
  assert.match(output, /^status=infra_fail$/m);
});

test("invalid verdict (extra key) degrades to infra_fail", () => {
  const { output } = run({ ...good, log_excerpt: "whatever" });
  assert.match(output, /^status=infra_fail$/m);
});

test("a newline-bearing value cannot inject a second output line", () => {
  // Only schema-valid verdicts get this far, so the attack has to come via
  // a field the schema permits — assert the writer refuses regardless.
  const { output } = run({ ...good, status: "pass\nstatus=forged" });
  const lines = output.trim().split("\n");
  assert.equal(lines.filter((l) => l.startsWith("status=")).length, 1);
  assert.match(output, /^status=infra_fail$/m);
});

test("a rejected verdict names what was refused", () => {
  // "blueprint_host_denied" with no indication of WHICH host leaves the
  // operator nothing to act on; the detail comes from preflight.json so the
  // verdict envelope stays closed.
  const dir = mkdtempSync(join(tmpdir(), "bv-render-"));
  const rejected = {
    ...good,
    status: "rejected",
    error_class: "blueprint_host_denied",
    assertions: [{ id: "preflight_blueprint_host_denied", ok: false }],
  };
  writeFileSync(join(dir, "verdict.json"), JSON.stringify(rejected));
  writeFileSync(
    join(dir, "preflight.json"),
    JSON.stringify({
      outcome: "rejected",
      error_class: "blueprint_host_denied",
      blueprintSha256: "",
      detail: "host not in allowlist: github.com",
    }),
  );
  const sumFile = join(dir, "gh-summary");
  const outFile = join(dir, "gh-output");
  writeFileSync(sumFile, "");
  writeFileSync(outFile, "");
  execFileSync(process.execPath, [join(ROOT, "scripts", "render-summary.mjs")], {
    env: { ...process.env, OUT_DIR: dir, GITHUB_OUTPUT: outFile, GITHUB_STEP_SUMMARY: sumFile },
    stdio: "pipe",
  });
  const summary = readFileSync(sumFile, "utf8");
  assert.match(summary, /Refused because:.*github\.com/);
  // ...and it still never leaves via an output variable.
  assert.equal(readFileSync(outFile, "utf8").includes("github.com"), false);
});

test("no workflow commands are emitted into the summary", () => {
  const { summary } = run({ ...good, status: "verify_fail", error_class: "resolver_fallback" });
  assert.equal(summary.includes("::"), false);
  assert.match(summary, /VERIFY FAIL/);
});
