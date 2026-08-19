// Can the playground we are about to link to run the blueprint we built?
//
// The network is stubbed here on purpose. The two real hosts are checked by a
// NETWORK check in verify.sh instead, because the file being read is a third
// party's source: freezing it as a fixture would test our copy of their code
// rather than their code, and the whole point of the check is that they differ
// and can change.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchHostSteps,
  stepsHostCannotRun,
  explainMissingSteps,
} from "../scripts/host-steps.mjs";

const HOST = "https://example.invalid/moodle-playground";

/** A schema.js in the shape both deployed playgrounds publish. */
const schemaJs = (names) =>
  `const KNOWN_STEP_NAMES = new Set([\n${names.map((n) => `  "${n}",`).join("\n")}\n]);\n` +
  `export function validate() {}\n`;

const MANY = [
  "installMoodle", "setAdminAccount", "login", "setConfig", "setConfigs",
  "setTheme", "setLandingPage", "createUser", "createUsers", "createCategory",
  "createCourse", "restoreCourse",
];

const serve = (body, status = 200) => async () => new Response(body, { status });

test("reads the step list a playground publishes", async () => {
  const out = await fetchHostSteps(HOST, {
    fetchImpl: serve(schemaJs([...MANY, "restoreDatabase"])),
  });
  assert.ok(out.known, out.unknown);
  assert.equal(out.known.size, MANY.length + 1);
  assert.ok(out.known.has("restoreDatabase"));
});

test("a host without the step is a REFUSAL, naming the step", async () => {
  const hostSteps = await fetchHostSteps(HOST, { fetchImpl: serve(schemaJs(MANY)) });
  const verdict = stepsHostCannotRun(
    [{ step: "installMoodle" }, { step: "restoreDatabase" }, { step: "login" }],
    hostSteps,
  );
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.missing, ["restoreDatabase"]);
  const why = explainMissingSteps(HOST, verdict.missing);
  // The message has to carry the surprising part, or it reads as a nitpick:
  // the step is not skipped, the WHOLE blueprint is discarded.
  assert.match(why, /restoreDatabase/);
  assert.match(why, /WHOLE blueprint/);
  assert.match(why, /starter site/);
});

test("a host that implements everything is accepted", async () => {
  const hostSteps = await fetchHostSteps(HOST, {
    fetchImpl: serve(schemaJs([...MANY, "restoreDatabase"])),
  });
  const verdict = stepsHostCannotRun(
    [{ step: "installMoodle" }, { step: "restoreDatabase" }],
    hostSteps,
  );
  assert.deepEqual(verdict, { ok: true });
});

test("every unreadable case is INCONCLUSIVE, never a refusal", async () => {
  // The list lives at a path we do not control. Refusing on any of these would
  // break every run the day the playground is restructured — and each one says
  // nothing about whether the host implements the step.
  const cases = [
    ["a runner with no egress", async () => { throw new Error("ENOTFOUND"); }],
    ["a moved file", serve("not found", 404)],
    ["a reorganised source", serve("export const STEPS = ['installMoodle'];")],
    ["a bundled build", serve("(()=>{var a=1})();")],
  ];
  for (const [label, fetchImpl] of cases) {
    const hostSteps = await fetchHostSteps(HOST, { fetchImpl });
    assert.ok(hostSteps.unknown, `${label} should be inconclusive`);
    const verdict = stepsHostCannotRun([{ step: "restoreDatabase" }], hostSteps);
    assert.equal(verdict.ok, true, `${label} must not refuse`);
    // ...and it must SAY it could not check. A check that goes quiet when it
    // stops working is worse than no check.
    assert.equal(verdict.unknown, hostSteps.unknown);
  }
});

test("a parse that yields almost nothing is inconclusive, not a wall of refusals", async () => {
  // Every real deployment lists dozens. A regex that started matching the
  // wrong thing would otherwise refuse every step in every blueprint, which
  // reads as "the playground is broken" rather than "this check is".
  const hostSteps = await fetchHostSteps(HOST, {
    fetchImpl: serve(schemaJs(["installMoodle", "login"])),
  });
  assert.ok(hostSteps.unknown);
  assert.match(hostSteps.unknown, /only 2 step name\(s\)/);
});

test("the host may be given with or without a trailing slash", async () => {
  // `new URL(path, base)` drops the last segment without one, which would ask
  // for github.io/src/... and 404 a host that is perfectly fine.
  const seen = [];
  const spy = async (u) => {
    seen.push(u);
    return new Response(schemaJs([...MANY, "restoreDatabase"]), { status: 200 });
  };
  await fetchHostSteps("https://example.invalid/moodle-playground", { fetchImpl: spy });
  await fetchHostSteps("https://example.invalid/moodle-playground/", { fetchImpl: spy });
  assert.deepEqual(seen, [
    "https://example.invalid/moodle-playground/src/blueprint/schema.js",
    "https://example.invalid/moodle-playground/src/blueprint/schema.js",
  ]);
});

test("every distinct step is checked, and each is reported once", async () => {
  const hostSteps = await fetchHostSteps(HOST, { fetchImpl: serve(schemaJs(MANY)) });
  const verdict = stepsHostCannotRun(
    [
      { step: "restoreDatabase" }, { step: "restoreDatabase" },
      { step: "installLanguagePack" }, { step: "installMoodle" }, {},
    ],
    hostSteps,
  );
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.missing, ["installLanguagePack", "restoreDatabase"]);
});
