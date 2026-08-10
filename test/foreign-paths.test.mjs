// The two paths that accept a STRANGER'S blueprint must run the
// core-component check.
//
// A review found both calling `gateBlueprint(blueprint, dataHosts)` with no
// third argument, so `opts.coreComponents` was undefined and the whole check
// was skipped — on the least-trusted input in the system. Measured then:
// a supplied blueprint declaring `pluginType: mod, pluginName: assign` was
// ACCEPTED. It was fixed, and a mutant restoring the two-argument call then
// SURVIVED, because every unit test passes `coreComponents` itself and so
// nothing observed whether these callers do.
//
// WHY THIS IS A SOURCE-LEVEL TEST AND NOT AN END-TO-END ONE. I tried to boot
// both scripts against a local blueprint server. The gate refuses `http://`
// (correctly), and refuses an `https://` URL that carries a PORT (also
// correctly) — so a local server can never reach the code under test without
// binding :443 as root. The behavioural half is covered by preflight.test.mjs,
// which proves the gate refuses a core overwrite WHEN GIVEN the list; this
// covers the other half, that these two callers give it.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every gateBlueprint(...) call in a file, with its argument text. */
function gateCalls(src) {
  const calls = [];
  const needle = "gateBlueprint(";
  let i = src.indexOf(needle);
  while (i >= 0) {
    let depth = 0;
    let j = i + needle.length - 1;
    for (; j < src.length; j++) {
      if (src[j] === "(") depth += 1;
      else if (src[j] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    calls.push(src.slice(i, j + 1));
    i = src.indexOf(needle, j);
  }
  return calls;
}

for (const file of ["scripts/build-blueprint-preview.mjs", "scripts/preflight.mjs"]) {
  test(`${file} passes the core-component list to every gateBlueprint call`, () => {
    const src = readFileSync(join(ROOT, file), "utf8");
    // preflight.mjs also DEFINES gateBlueprint; only calls that pass a
    // blueprint variable are call sites, and the definition has no arguments
    // of that shape.
    const calls = gateCalls(src).filter((c) => !c.startsWith("gateBlueprint(blueprint, dataHosts, opts"));
    const invoking = calls.filter((c) => /gateBlueprint\(\s*blueprint/.test(c));
    assert.ok(invoking.length > 0, `no gateBlueprint call found in ${file}`);
    for (const call of invoking) {
      assert.match(
        call,
        /coreComponents/,
        `${file} calls gateBlueprint without coreComponents — the core-component ` +
          `check is then SKIPPED on a caller-supplied blueprint:\n${call}`,
      );
    }
  });
}

test("the callers actually fetch a core list to pass", () => {
  for (const file of ["scripts/build-blueprint-preview.mjs", "scripts/preflight.mjs"]) {
    const src = readFileSync(join(ROOT, file), "utf8");
    assert.match(src, /fetchCoreComponents\(/, `${file} never fetches a core list`);
  }
});
