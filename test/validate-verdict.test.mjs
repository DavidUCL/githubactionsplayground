import { test } from "node:test";
import assert from "node:assert/strict";
import { validateVerdict, ERROR_CLASSES, STATUSES } from "../scripts/validate-verdict.mjs";

const good = () => ({
  schema: 1,
  status: "pass",
  error_class: "none",
  head_sha: "a".repeat(40),
  blueprint_sha256: "b".repeat(64),
  boot_ms: 12241,
  steps_ok: 6,
  steps_failed: 0,
  assertions: [{ id: "a1_nav", ok: true }],
  risky_steps: [],
});

test("valid verdict has no problems", () => {
  assert.deepEqual(validateVerdict(good()), []);
});

test("empty shas are allowed", () => {
  const v = { ...good(), head_sha: "", blueprint_sha256: "" };
  assert.deepEqual(validateVerdict(v), []);
});

test("unknown top-level key rejected (closed schema)", () => {
  const v = { ...good(), log_excerpt: "echo pwned" };
  assert.match(validateVerdict(v).join(";"), /unknown key: log_excerpt/);
});

test("missing key rejected", () => {
  const v = good();
  delete v.boot_ms;
  assert.match(validateVerdict(v).join(";"), /missing key: boot_ms/);
});

test("status outside enum rejected", () => {
  assert.match(validateVerdict({ ...good(), status: "PASSED" }).join(";"), /invalid status/);
});

test("error_class/status pairing enforced", () => {
  const v = { ...good(), status: "pass", error_class: "step_failed" };
  assert.match(validateVerdict(v).join(";"), /does not belong to status/);
});

test("non-integer counters rejected", () => {
  assert.notDeepEqual(validateVerdict({ ...good(), boot_ms: "12241" }), []);
  assert.notDeepEqual(validateVerdict({ ...good(), steps_ok: -1 }), []);
});

test("assertion entries are closed too", () => {
  const v = { ...good(), assertions: [{ id: "a1", ok: true, note: "<script>" }] };
  assert.match(validateVerdict(v).join(";"), /keys must be exactly id, ok/);
});

test("every error_class maps to a real status", () => {
  for (const status of Object.values(ERROR_CLASSES)) {
    assert.equal(STATUSES.includes(status), true, status);
  }
});
