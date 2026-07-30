// Standalone closed-schema validator for verdict.json (SPEC.md §3).
//
// This is the trust boundary: anything that renders or acts on a verdict —
// including a future workflow_run consumer handling fork artifacts — MUST
// validate through this exact module first. It depends on nothing but
// node:fs so it can be lifted into a privileged workflow unchanged.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const STATUSES = ["pass", "verify_fail", "infra_fail", "rejected"];

export const ERROR_CLASSES = {
  none: "pass",
  blueprint_fetch_failed: "rejected",
  blueprint_host_denied: "rejected",
  blueprint_step_banned: "rejected",
  // A string in the blueprint carries control characters — it would forge
  // log lines once echoed into the boot log.
  blueprint_unsafe_string: "rejected",
  // A plugin step lacks the explicit pluginType/pluginName the extraction
  // binding needs, so a pass could not be distinguished from installing the
  // wrong thing.
  blueprint_unbindable: "rejected",
  browser_launch_failed: "infra_fail",
  nav_fail: "infra_fail",
  logs_panel_missing: "infra_fail",
  timeout: "infra_fail",
  anchor_drift: "infra_fail",
  resolver_fallback: "verify_fail",
  step_failed: "verify_fail",
  // Step sequence mismatch: count, ordering, OR executed step names differ
  // from the gated blueprint's.
  step_count_mismatch: "verify_fail",
  upgrade_soft_fail: "verify_fail",
  plugin_binding_mismatch: "verify_fail",
};

const TOP_KEYS = [
  "schema",
  "status",
  "error_class",
  "head_sha",
  "blueprint_sha256",
  "boot_ms",
  "steps_ok",
  "steps_failed",
  "assertions",
];

const SHA1_RE = /^([0-9a-f]{40})?$/;
const SHA256_RE = /^([0-9a-f]{64})?$/;
const ASSERTION_ID_RE = /^[a-z0-9_-]{1,40}$/;

/**
 * Validate a parsed verdict object against schema 1.
 * @returns {string[]} problems — empty array means valid.
 */
export function validateVerdict(v) {
  const problems = [];
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return ["verdict is not an object"];
  }
  for (const key of Object.keys(v)) {
    if (!TOP_KEYS.includes(key)) problems.push(`unknown key: ${key}`);
  }
  for (const key of TOP_KEYS) {
    if (!(key in v)) problems.push(`missing key: ${key}`);
  }
  if (v.schema !== 1) problems.push(`schema must be 1, got ${v.schema}`);
  if (!STATUSES.includes(v.status)) problems.push(`invalid status: ${v.status}`);
  // Object.hasOwn, not `in`: `"toString" in ERROR_CLASSES` is true.
  if (!Object.hasOwn(ERROR_CLASSES, v.error_class)) {
    problems.push(`invalid error_class: ${v.error_class}`);
  } else if (
    STATUSES.includes(v.status) &&
    ERROR_CLASSES[v.error_class] !== v.status
  ) {
    problems.push(
      `error_class ${v.error_class} does not belong to status ${v.status}`,
    );
  }
  if (typeof v.head_sha !== "string" || !SHA1_RE.test(v.head_sha)) {
    problems.push("head_sha must be a 40-hex string or empty");
  }
  if (
    typeof v.blueprint_sha256 !== "string" ||
    !SHA256_RE.test(v.blueprint_sha256)
  ) {
    problems.push("blueprint_sha256 must be a 64-hex string or empty");
  }
  for (const key of ["boot_ms", "steps_ok", "steps_failed"]) {
    if (!Number.isInteger(v[key]) || v[key] < 0 || v[key] > 100_000_000) {
      problems.push(`${key} must be a non-negative integer`);
    }
  }
  if (!Array.isArray(v.assertions) || v.assertions.length > 64) {
    problems.push("assertions must be an array (max 64)");
  } else {
    v.assertions.forEach((a, i) => {
      if (typeof a !== "object" || a === null || Array.isArray(a)) {
        problems.push(`assertions[${i}] is not an object`);
        return;
      }
      const keys = Object.keys(a).sort().join(",");
      if (keys !== "id,ok") problems.push(`assertions[${i}] keys must be exactly id, ok`);
      if (typeof a.id !== "string" || !ASSERTION_ID_RE.test(a.id)) {
        problems.push(`assertions[${i}].id invalid`);
      }
      if (typeof a.ok !== "boolean") problems.push(`assertions[${i}].ok must be boolean`);
    });
  }
  return problems;
}

function main() {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: validate-verdict.mjs <verdict.json>");
    process.exit(2);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`verdict unreadable: ${err.message}`);
    process.exit(1);
  }
  const problems = validateVerdict(parsed);
  if (problems.length) {
    console.error("verdict INVALID:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`verdict valid: status=${parsed.status} error_class=${parsed.error_class}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
