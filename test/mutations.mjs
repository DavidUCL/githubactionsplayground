// Mutation harness: the answer to "are the tests pinning anything, or do
// they pass by accident?" Each entry deletes or weakens ONE assertion term
// in the production code; the suite MUST fail for every one. A surviving
// mutant is a vacuous test, reported as a failure of this script.
//
// Run: node test/mutations.mjs   (called by verify.sh as a gate check)
//
// Policy on deliberately redundant guards: where two checks overlap by design
// (verified so — either alone rejects every hostile input), mutating one
// individually would demand a test for redundancy rather than for behaviour.
// Those are mutated as a GROUP instead — e.g. "revert off-origin screening to
// the naive prefix test" reverts the backslash guard and the sentinel-base
// origin test together, and "disable the depth cap" covers all three sweeps.

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// [label, file, find, replace] — `find` must appear exactly once.
const MUTATIONS = [
  // assert.mjs — every term of every assertion
  ["a0: drop served-counter requirement", "scripts/assert.mjs",
    "meta.loopback_served >= 1", "true"],
  ["a0: drop hash comparison", "scripts/assert.mjs",
    "meta.loopback_sha256 === exp.blueprintSha256", "true"],
  ["a1: accept any final origin", "scripts/assert.mjs",
    "Boolean(meta.nav_ok) && originOk && !meta.page_crashed", "Boolean(meta.nav_ok)"],
  ["a1: ignore page crash", "scripts/assert.mjs",
    "&& !meta.page_crashed", ""],
  ["a2: accept missing boot anchor", "scripts/assert.mjs",
    "parsed.bootMs !== null", "true"],
  ["a3: drop resolver-line requirement", "scripts/assert.mjs",
    'check("a3_resolver_line", resolverOk,', 'check("a3_resolver_line", true,'],
  ["a3: drop fallback-marker check", "scripts/assert.mjs",
    'check("a3_no_fallback", !fellBack,', 'check("a3_no_fallback", true,'],
  ["a3: drop step-name comparison", "scripts/assert.mjs",
    "parsed.steps.every((s, i) => s.name === exp.stepNames[i])", "true"],
  ["a4: drop step-count equality", "scripts/assert.mjs",
    "declaredN === exp.stepCount &&", ""],
  ["a4: drop contiguity requirement", "scripts/assert.mjs",
    "contiguous === exp.stepCount &&", ""],
  ["a4: drop consistent-N requirement", "scripts/assert.mjs",
    "parsed.steps.every((s) => s.n === declaredN)", "true"],
  ["a4: ignore step failures", "scripts/assert.mjs",
    "parsed.failLines === 0", "true"],
  ["a5: ignore upgrade soft-failures", "scripts/assert.mjs",
    "parsed.upgradeSoftFails === 0", "true"],
  ["a6: ignore missing downloads", "scripts/assert.mjs",
    "plugins.every((p) => p.url && downloadedUrls.has(p.url))", "true"],
  ["a6: ignore extraction count", "scripts/assert.mjs",
    "parsed.extractions.length === plugins.length", "true"],
  ["a6: allow addon proxy", "scripts/assert.mjs",
    "parsed.downloads.every((d) => !d.viaProxy)", "true"],
  ["a6: ignore the exact extraction path", "scripts/assert.mjs",
    "    plugins.every((p) =>\n      parsed.extractions.includes(\n        `/www/moodle/${PLUGIN_TYPE_DIRS[p.pluginType]}/${p.pluginName}`,\n      ),\n    ),",
    "    true,"],
  ["a1: accept any origin (drop the allowlist set)", "scripts/assert.mjs",
    "return ok.has(new URL(meta.final_url).origin);", "return true;"],
  ["a2_complete: treat a truncated timed-out run as assessable", "scripts/assert.mjs",
    'check("a2_complete", Boolean(anchorOk && sequenceComplete), "timeout");',
    'check("a2_complete", true, "timeout");'],
  ["a5: miss the 'failed' upgrade wording", "scripts/assert.mjs",
    "Plugin upgrade (?:crashed|errors|failed): ", "Plugin upgrade (?:crashed|errors): "],
  ["precedence: let step_failed outrank resolver_fallback", "scripts/assert.mjs",
    '  "resolver_fallback",\n  "step_failed",', '  "step_failed",\n  "resolver_fallback",'],
  ["parser: un-anchor the log-message prefix", "scripts/assert.mjs",
    'const BM = String.raw`^Bootstrapping Moodle: (?:\\[\\d+ms\\] )?`',
    'const BM = String.raw`Bootstrapping Moodle: (?:\\[\\d+ms\\] )?`'],
  ["parser: drop the addon-proxy capture group", "scripts/assert.mjs",
    "( via addon proxy)?$", "$"],

  // preflight.mjs — every gate term
  ["gate: accept control characters in URLs", "scripts/preflight.mjs",
    "if (CONTROL_CHARS_RE.test(raw)) return", "if (false) return"],
  ["gate: accept query strings", "scripts/preflight.mjs",
    "if (url.search || url.hash) return", "if (false) return"],
  ["gate: accept userinfo", "scripts/preflight.mjs",
    "if (url.username || url.password) return", "if (false) return"],
  ["gate: accept non-https", "scripts/preflight.mjs",
    'if (url.protocol !== "https:") return', "if (false) return"],
  ["gate: skip host allowlist", "scripts/preflight.mjs",
    "if (!allowedHosts.includes(url.hostname)) {", "if (false) {"],
  ["gate: allow proxy override keys", "scripts/preflight.mjs",
    "if (/proxy/i.test(key)) {", "if (false) {"],
  ["gate: allow banned steps", "scripts/preflight.mjs",
    "} else if (BANNED_STEPS.has(name)) {", "} else if (false) {"],
  ["gate: allow unknown steps", "scripts/preflight.mjs",
    "} else if (!ALLOWED_STEPS.has(name)) {", "} else if (false) {"],
  ["gate: skip nested step names", "scripts/preflight.mjs",
    "sweepNestedStepNames(step, stepErrors, `step[${i}]`);", ""],
  ["gate: skip unsafe-string sweep", "scripts/preflight.mjs",
    "sweepUnsafeStrings(blueprint, unsafeStrings);", ""],
  ["gate: allow unbindable plugin steps", "scripts/preflight.mjs",
    "if (PLUGIN_STEPS.has(name)) {", "if (false) {"],
  ["gate: revert off-origin screening to the naive prefix test", "scripts/preflight.mjs",
    '  const stripped = s.replace(new RegExp(CONTROL_CHARS_RE.source, "gu"), "");',
    '  return /^https?:\\/\\//i.test(s);\n  const stripped = s.replace(new RegExp(CONTROL_CHARS_RE.source, "gu"), "");'],
  ["gate: disable the depth cap entirely", "scripts/preflight.mjs",
    "const MAX_DEPTH = 32;", "const MAX_DEPTH = Infinity;"],

  ["gate: accept an explicit port", "scripts/preflight.mjs",
    "if (url.port) return `URL specifies a port: ${raw}`;", ""],
  ["gate: go back to a name allowlist when clearing OUT_DIR", "scripts/preflight.mjs",
    '  rmSync(outDir, { recursive: true, force: true });\n  mkdirSync(outDir, { recursive: true });',
    '  rmSync(join(outDir, "verdict.json"), { force: true });'],
  ["a3: match the resolver line anywhere in a console message", "scripts/assert.mjs",
    "const resolverOk = messages.includes(RESOLVER_OK_LINE);",
    "const resolverOk = consoleText.includes(RESOLVER_OK_LINE);"],
  ["a3: match fallback markers anywhere in a console message", "scripts/assert.mjs",
    "  const fellBack = messages.some((m) =>\n    RESOLVER_FALLBACK_MARKERS.some((marker) => m.startsWith(marker)),\n  );",
    "  const fellBack = RESOLVER_FALLBACK_MARKERS.some((marker) => consoleText.includes(marker));"],
  ["capture: stop escaping newlines in console messages", "scripts/boot-capture.mjs",
    'return String(s).replace(/\\r?\\n/g, "\\\\n");', "return String(s);"],
  // pipeline wiring
  ["pipeline: trust a pre-placed verdict.json in assert", "scripts/assert.mjs",
    "  const preflightPath = join(outDir, \"preflight.json\");",
    "  if (existsSync(join(outDir, \"verdict.json\"))) return;\n  const preflightPath = join(outDir, \"preflight.json\");"],
  ["pipeline: trust a pre-placed verdict.json in boot-capture", "scripts/boot-capture.mjs",
    "  // Only preflight's own outcome file may short-circuit the boot — never a",
    "  if (existsSync(join(outDir, \"verdict.json\"))) return;\n  // Only preflight's own outcome file may short-circuit the boot — never a"],
  ["pipeline: stop clearing OUT_DIR entirely", "scripts/preflight.mjs",
    "  rmSync(outDir, { recursive: true, force: true });\n  mkdirSync(outDir, { recursive: true });",
    ""],
  ["pipeline: drop the navigation reset of the served counter", "scripts/boot-capture.mjs",
    "  meta.loopback_served = 0;\n  return meta;", "  return meta;"],

  // validate-verdict.mjs — the trust boundary
  ["schema: allow unknown top-level keys", "scripts/validate-verdict.mjs",
    "if (!TOP_KEYS.includes(key)) problems.push(`unknown key: ${key}`);", ""],
  ["schema: skip error_class/status pairing", "scripts/validate-verdict.mjs",
    "ERROR_CLASSES[v.error_class] !== v.status", "false"],
  ["schema: allow loose assertion objects", "scripts/validate-verdict.mjs",
    'if (keys !== "id,ok")', "if (false)"],
];

const survivors = [];
let killed = 0;

for (const [label, file, find, replace] of MUTATIONS) {
  const dir = mkdtempSync(join(tmpdir(), "bv-mut-"));
  try {
    for (const d of ["scripts", "test"]) {
      cpSync(join(ROOT, d), join(dir, d), { recursive: true });
    }
    const target = join(dir, file);
    const src = readFileSync(target, "utf8");
    const occurrences = src.split(find).length - 1;
    if (occurrences !== 1) {
      survivors.push(`${label} — MUTATION STALE: pattern found ${occurrences}× in ${file}`);
      continue;
    }
    writeFileSync(target, src.replace(find, replace));
    let testsFailed = false;
    try {
      execFileSync(process.execPath, ["--test", "test/assert.test.mjs", "test/preflight.test.mjs",
        "test/validate-verdict.test.mjs", "test/render-summary.test.mjs",
        "test/pipeline.test.mjs", "test/contract.test.mjs"], {
        cwd: dir, stdio: "pipe",
      });
    } catch {
      testsFailed = true; // the suite noticed — good
    }
    if (testsFailed) killed += 1;
    else survivors.push(`${label} (${file})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`mutations: ${killed}/${MUTATIONS.length} killed`);
if (survivors.length) {
  console.error("SURVIVING MUTANTS (vacuous or unpinned assertions):");
  for (const s of survivors) console.error(`  - ${s}`);
  process.exit(1);
}
console.log("no surviving mutants — every assertion term is pinned by a test");
