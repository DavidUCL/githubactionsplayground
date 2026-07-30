// Re-capture the golden and fallback test fixtures from a live playground.
//
// Run this when a playground deploy changes a log string (the canary reports
// error_class=anchor_drift) or when the meta contract changes. Doing it by
// hand means reconstructing four files per case with a matching sha256 —
// which is how stale fixtures sneak in.
//
//   npm run capture-fixtures            # both cases
//   npm run capture-fixtures -- golden  # one case
//
// Local prerequisite (WSL/no sudo): NSS_LIBS=<dir of NSS symlinks> — see
// README "Development". The script passes it through to the browser.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gateBlueprint } from "./preflight.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(ROOT, "test", "fixtures");

const CASES = {
  // A blueprint the deployed playground accepts → expected verdict: pass.
  // Its URL deliberately 404s publicly, so a pass PROVES the loopback served
  // our bytes. Keep that property (SPEC §4a).
  golden: {
    localBlueprint: join(FIXTURES, "blueprint-nodb.json"),
    url: "https://raw.githubusercontent.com/DavidUCL/mchef-urls/integrationtest/blueprints/integration-test-nodb.json",
    expect: "pass",
  },
  // A blueprint the DEPLOYED playground's schema rejects: it silently boots
  // its own starter blueprint → expected verdict: verify_fail/resolver_fallback.
  // This is the false-green detector; if this case ever passes, the deployed
  // playground has caught up and the fixture needs a new rejected blueprint.
  fallback: {
    fetchFrom: "https://raw.githubusercontent.com/DavidUCL/mchef-urls/integrationtest/blueprints/integration-test.json",
    url: "https://raw.githubusercontent.com/DavidUCL/mchef-urls/integrationtest/blueprints/integration-test.json",
    expect: "verify_fail",
  },
};

const wanted = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const names = wanted.length ? wanted : Object.keys(CASES);

for (const name of names) {
  const spec = CASES[name];
  if (!spec) throw new Error(`unknown fixture case: ${name}`);
  const dir = mkdtempSync(join(tmpdir(), `bv-fixture-${name}-`));
  console.log(`\n=== ${name} ===\n${dir}`);

  let bytes;
  if (spec.localBlueprint) {
    bytes = readFileSync(spec.localBlueprint);
  } else {
    const res = await fetch(spec.fetchFrom);
    if (!res.ok) throw new Error(`fetch ${spec.fetchFrom}: HTTP ${res.status}`);
    bytes = Buffer.from(await res.arrayBuffer());
  }
  const sha = createHash("sha256").update(bytes).digest("hex");
  const gate = gateBlueprint(JSON.parse(bytes.toString("utf8")), ["raw.githubusercontent.com"]);
  if (!gate.expectations) {
    throw new Error(`blueprint fails the gate: ${JSON.stringify(gate, null, 2)}`);
  }
  writeFileSync(join(dir, "blueprint.json"), bytes);
  writeFileSync(
    join(dir, "expectations.json"),
    JSON.stringify({ blueprintUrl: spec.url, blueprintSha256: sha, ...gate.expectations }, null, 2),
  );
  writeFileSync(
    join(dir, "preflight.json"),
    JSON.stringify({ outcome: "ok", error_class: "none", blueprintSha256: sha }, null, 2),
  );

  const env = { ...process.env, OUT_DIR: dir, BLUEPRINT_URL: spec.url };
  if (process.env.NSS_LIBS) env.LD_LIBRARY_PATH = process.env.NSS_LIBS;
  execFileSync(process.execPath, [join(ROOT, "scripts", "boot-capture.mjs")], { env, stdio: "inherit" });
  execFileSync(process.execPath, [join(ROOT, "scripts", "assert.mjs")], {
    env: { ...env, ACCEPTED_ORIGINS: "https://ateeducacion.github.io" },
    stdio: "inherit",
  });

  const verdict = JSON.parse(readFileSync(join(dir, "verdict.json"), "utf8"));
  if (verdict.status !== spec.expect) {
    console.error(
      `\nREFUSING to install fixtures: expected status=${spec.expect}, got ` +
        `${verdict.status}/${verdict.error_class}. Investigate before overwriting — ` +
        `a fixture captured from an unexpected outcome bakes that outcome into the gate.`,
    );
    process.exitCode = 1;
    continue;
  }
  for (const [src, dest] of [
    ["boot-log.txt", `${name}-boot-log.txt`],
    ["console.txt", `${name}-console.txt`],
    ["expectations.json", `${name}-expectations.json`],
    ["meta.json", `${name}-meta.json`],
  ]) {
    cpSync(join(dir, src), join(FIXTURES, dest));
  }
  console.log(`installed ${name}-* fixtures (${verdict.status}/${verdict.error_class})`);
  rmSync(dir, { recursive: true, force: true });
}

console.log("\nRe-run ./verify.sh (and LIVE=1 ./verify.sh) after re-capturing.");
