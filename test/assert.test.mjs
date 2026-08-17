import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBootLog, assess } from "../scripts/assert.mjs";
import { validateVerdict } from "../scripts/validate-verdict.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const read = (name) => readFileSync(join(FIXTURES, name), "utf8");
const readJson = (name) => JSON.parse(read(name));

const golden = {
  expectations: readJson("golden-expectations.json"),
  meta: readJson("golden-meta.json"),
  bootLog: read("golden-boot-log.txt"),
  consoleLog: read("golden-console.txt"),
  acceptedOrigins: ["https://ateeducacion.github.io"],
};
const fallback = {
  expectations: readJson("fallback-expectations.json"),
  meta: readJson("fallback-meta.json"),
  bootLog: read("fallback-boot-log.txt"),
  consoleLog: read("fallback-console.txt"),
  acceptedOrigins: ["https://ateeducacion.github.io"],
};

// ---- parser pinned against the live-captured golden log ------------------

test("parses the golden log's anchors (drift detector)", () => {
  const p = parseBootLog(golden.bootLog);
  assert.equal(p.bootMs !== null, true, "strict boot anchor must parse");
  assert.equal(p.steps.length, 6);
  assert.deepEqual(p.steps.map((s) => s.k), [1, 2, 3, 4, 5, 6]);
  assert.equal(p.downloads.length, 3);
  assert.equal(p.downloads.every((d) => !d.viaProxy), true);
  assert.deepEqual(p.extractions, [
    "/www/moodle/theme/boost_union",
    "/www/moodle/mod/attendance",
    "/www/moodle/filter/multilang2",
  ]);
  assert.equal(p.failLines, 0);
  assert.equal(p.upgradeSoftFails, 0);
});

test("golden capture assesses to pass and validates", () => {
  const v = assess(golden);
  assert.equal(v.status, "pass");
  assert.equal(v.error_class, "none");
  assert.equal(v.steps_ok, 6);
  assert.deepEqual(validateVerdict(v), []);
});

// ---- the silent starter-blueprint fallback (observed live) ---------------

test("deployed-playground fallback boot is verify_fail/resolver_fallback", () => {
  const v = assess(fallback);
  assert.equal(v.status, "verify_fail");
  assert.equal(v.error_class, "resolver_fallback");
  assert.deepEqual(validateVerdict(v), []);
});

// ---- synthetic failure modes ---------------------------------------------

const mutate = (base, fn) => {
  const c = {
    ...base,
    expectations: structuredClone(base.expectations),
    meta: structuredClone(base.meta),
  };
  fn(c);
  return c;
};

test("browser never launched → infra_fail/browser_launch_failed", () => {
  const v = assess(mutate(golden, (c) => (c.meta.browser_launched = false)));
  assert.equal(v.error_class, "browser_launch_failed");
});

test("unexpected final origin → infra_fail/nav_fail", () => {
  const v = assess(mutate(golden, (c) => (c.meta.final_url = "https://evil.example/")));
  assert.equal(v.error_class, "nav_fail");
});

test("missing logs panel → infra_fail/logs_panel_missing", () => {
  const v = assess(mutate(golden, (c) => (c.meta.logs_panel_found = false)));
  assert.equal(v.error_class, "logs_panel_missing");
});

test("no boot anchor, no weak signals → infra_fail/timeout", () => {
  const v = assess(mutate(golden, (c) => (c.bootLog = "[t] nothing here\n")));
  assert.equal(v.error_class, "timeout");
});

test("weak signals but drifted anchor → infra_fail/anchor_drift", () => {
  const drifted = golden.bootLog.replace(
    /Boot timing summary: Config:/,
    "Boot timing summary!! Config:",
  );
  const v = assess(mutate(golden, (c) => (c.bootLog = drifted)));
  assert.equal(v.error_class, "anchor_drift");
});

// A wall-clock expiry only invalidates INCOMPLETE evidence. A
// finished boot whose page kept logging service-worker chatter is a pass,
// not an infra_fail — otherwise good runs poison the canary's flake metric.
test("timed out but boot complete → still assessable (pass)", () => {
  const v = assess(mutate(golden, (c) => (c.meta.timed_out = true)));
  assert.equal(v.status, "pass");
});

test("timed out with incomplete step sequence → infra_fail/timeout", () => {
  const truncated = golden.bootLog
    .split("\n")
    .filter((l) => !/Blueprint step 6\/6/.test(l))
    .join("\n");
  const v = assess(
    mutate(golden, (c) => {
      c.meta.timed_out = true;
      c.bootLog = truncated;
    }),
  );
  assert.equal(v.error_class, "timeout");
});

test("page crash → infra_fail/nav_fail", () => {
  const v = assess(mutate(golden, (c) => (c.meta.page_crashed = true)));
  assert.equal(v.status, "infra_fail");
  assert.equal(v.error_class, "nav_fail");
});

test("step failure line → verify_fail/step_failed", () => {
  const log =
    golden.bootLog +
    "[2026-07-30T10:00:00.000Z] Bootstrapping Moodle: [9999ms] Blueprint step installMoodlePlugin failed: boom\n";
  const v = assess(mutate(golden, (c) => (c.bootLog = log)));
  assert.equal(v.error_class, "step_failed");
});

test("upgrade soft-failure → verify_fail/upgrade_soft_fail", () => {
  const log =
    golden.bootLog +
    "[2026-07-30T10:00:00.000Z] Bootstrapping Moodle: [9999ms] Plugin upgrade errors: Exception in upgrade.php\n";
  const v = assess(mutate(golden, (c) => (c.bootLog = log)));
  assert.equal(v.error_class, "upgrade_soft_fail");
});

test("forged pass: plugin echoes Total line but steps missing → not pass", () => {
  const forged =
    "[t] Bootstrapping Moodle: [1ms] Blueprint step 1/1: installMoodlePlugin\n" +
    "[t] Boot timing summary: Config: 1ms | PHP refresh: 1ms | Bootstrap: 1ms | Total: 1ms\n";
  const v = assess(mutate(golden, (c) => (c.bootLog = forged)));
  assert.notEqual(v.status, "pass");
});

test("step count mismatch vs expectations → verify_fail/step_count_mismatch", () => {
  const v = assess(mutate(golden, (c) => (c.expectations.stepCount = 7)));
  assert.equal(v.error_class, "step_count_mismatch");
});

test("missing plugin download → verify_fail/plugin_binding_mismatch", () => {
  const v = assess(
    mutate(golden, (c) => {
      c.expectations.pluginSteps[0].url = "https://raw.githubusercontent.com/x/y/z/other.zip";
    }),
  );
  assert.equal(v.error_class, "plugin_binding_mismatch");
});

// --- the boot must be bound to the gated bytes ---------------------------

test("hash match but route never fired cannot pass", () => {
  // The hash compares two views of the same local file, so only the served
  // counter proves the browser actually got the gated bytes.
  const v = assess(mutate(golden, (c) => (c.meta.loopback_served = 0)));
  assert.equal(v.status, "infra_fail");
  assert.equal(v.assertions.find((a) => a.id === "a0_loopback_binding").ok, false);
});

test("starter-blueprint boot with matching step COUNT cannot pass", () => {
  // Same number of steps, entirely different step names, no plugins — the
  // shape of the real silent-fallback false green.
  const starterNames = ["installMoodle", "login", "createCategory", "createCourse", "enrolUser", "setLandingPage"];
  const log = starterNames
    .map((n, i) => `[t] Bootstrapping Moodle: [${i}ms] Blueprint step ${i + 1}/6: ${n}`)
    .concat("[t] Boot timing summary: Config: 1ms | PHP refresh: 1ms | Bootstrap: 1ms | Total: 99ms")
    .join("\n");
  const v = assess(
    mutate(golden, (c) => {
      c.bootLog = log;
      // Pretend the resolver line was present: identity must still fail on names.
      c.consoleLog = "[console:log] [blueprint] Resolved from ?blueprint-url= param.";
    }),
  );
  assert.notEqual(v.status, "pass");
  assert.equal(v.assertions.find((a) => a.id === "a3_step_names").ok, false);
});

test("fallback plus a failure inside the starter blueprint reports the fallback", () => {
  const log = golden.bootLog + "\n[t] Bootstrapping Moodle: [9ms] Blueprint step createCourse failed: boom";
  const v = assess(
    mutate(golden, (c) => {
      c.bootLog = log;
      c.consoleLog = "[console:log] [blueprint] Resolved from defaultBlueprintUrl.";
    }),
  );
  // Identity outranks step outcomes: don't send the author hunting a step
  // their blueprint never ran.
  assert.equal(v.error_class, "resolver_fallback");
  // ...but the step failure is still recorded, not hidden by precedence.
  assert.equal(v.assertions.find((a) => a.id === "a4_no_step_failures").ok, false);
});

test("every assertion is recorded even when an early one fails (SPEC §3)", () => {
  const v = assess(mutate(golden, (c) => (c.meta.logs_panel_found = false)));
  const ids = v.assertions.map((a) => a.id);
  for (const id of ["a3_step_names", "a4_step_count", "a6_extraction_paths", "a6_no_addon_proxy"]) {
    assert.equal(ids.includes(id), true, `missing ${id}`);
  }
});

test("addon-proxy regression is caught", () => {
  const proxied = golden.bootLog.replace(
    /(Downloading plugin ZIP from \S+)/,
    "$1 via addon proxy",
  );
  const v = assess(mutate(golden, (c) => (c.bootLog = proxied)));
  assert.equal(v.assertions.find((a) => a.id === "a6_no_addon_proxy").ok, false);
  assert.equal(v.error_class, "plugin_binding_mismatch");
});

test("absent expectations do not throw", () => {
  const v = assess({ ...golden, expectations: null });
  assert.equal(v.status !== "pass", true);
});

test("extraction path must match type+name exactly, not just end in the name", () => {
  // Right name, wrong directory (the URL-detection bug class that escaped
  // the vendoring loop): /www/moodle/local/attendance is not /mod/attendance.
  const wrongDir = golden.bootLog.replace(
    "/www/moodle/mod/attendance",
    "/www/moodle/local/attendance",
  );
  const v = assess(mutate(golden, (c) => (c.bootLog = wrongDir)));
  assert.equal(v.assertions.find((a) => a.id === "a6_extraction_paths").ok, false);
});

// --- upgrade-failure and reload regressions ------------------------------

test("a failed plugin upgrade cannot pass", () => {
  // moodle-plugins.js:344 — fires when the upgrade PHP returns "ok":false,
  // i.e. files installed but never registered. It returns SUCCESS to the
  // executor, so no other check sees it.
  const log =
    golden.bootLog +
    '\n[t] Bootstrapping Moodle: [9ms] Plugin upgrade failed: {"ok":false,"error":"upgrade aborted"}';
  const v = assess(mutate(golden, (c) => (c.bootLog = log)));
  assert.equal(v.error_class, "upgrade_soft_fail");
});

test("all three upgrade failure wordings are caught", () => {
  for (const wording of ["crashed", "errors", "failed"]) {
    const log = golden.bootLog + `\n[t] Bootstrapping Moodle: [9ms] Plugin upgrade ${wording}: detail`;
    const v = assess(mutate(golden, (c) => (c.bootLog = log)));
    assert.equal(
      v.assertions.find((a) => a.id === "a5_no_upgrade_soft_fail").ok,
      false,
      `wording not caught: ${wording}`,
    );
  }
});

test("a reload that re-fetched from the network cannot pass", () => {
  // loopback_served is reset on each main-frame navigation, so load 1's
  // interception can no longer vouch for load 2's network fetch.
  const v = assess(
    mutate(golden, (c) => {
      c.meta.navigations = 2;
      c.meta.loopback_served = 0;
    }),
  );
  assert.equal(v.status, "infra_fail");
  assert.equal(v.assertions.find((a) => a.id === "a0_loopback_binding").ok, false);
});

// --- one test per assertion TERM, so no term can be deleted silently -----
// (each of these was a surviving mutant in test/mutations.mjs)

test("resolver text mid-message cannot forge identity", () => {
  // A plugin (or any page code) logging the resolver sentence inside a longer
  // console message must not satisfy the check — it is line-anchored to the
  // capture's own `[console:<type>] ` prefix.
  const v = assess(
    mutate(
      golden,
      (c) =>
        (c.consoleLog =
          "[console:log] plugin says: [blueprint] Resolved from ?blueprint-url= param.\n"),
    ),
  );
  assert.equal(v.assertions.find((a) => a.id === "a3_resolver_line").ok, false);
});

test("a fallback marker mid-message does not forge a false failure", () => {
  const v = assess(
    mutate(
      golden,
      (c) =>
        (c.consoleLog =
          golden.consoleLog +
          "[console:log] plugin says: [blueprint] Resolved from defaultBlueprintUrl.\n"),
    ),
  );
  assert.equal(v.assertions.find((a) => a.id === "a3_no_fallback").ok, true);
  assert.equal(v.status, "pass");
});

test("term a3_resolver_line: console with neither resolver line cannot pass", () => {
  const v = assess(mutate(golden, (c) => (c.consoleLog = "[console:log] nothing relevant\n")));
  assert.equal(v.error_class, "resolver_fallback");
  assert.equal(v.assertions.find((a) => a.id === "a3_resolver_line").ok, false);
});

test("term a3_no_fallback: both resolver AND fallback lines present cannot pass", () => {
  const v = assess(
    mutate(
      golden,
      (c) =>
        (c.consoleLog =
          "[console:log] [blueprint] Resolved from ?blueprint-url= param.\n" +
          "[console:log] [blueprint] Resolved from defaultBlueprintUrl.\n"),
    ),
  );
  assert.notEqual(v.status, "pass");
  assert.equal(v.assertions.find((a) => a.id === "a3_no_fallback").ok, false);
});

test("term a4 declaredN: log declaring a different total cannot pass", () => {
  const v = assess(mutate(golden, (c) => (c.bootLog = golden.bootLog.replaceAll("/6:", "/7:"))));
  assert.equal(v.error_class, "step_count_mismatch");
});

test("term a4 consistent-N: one step declaring a different total cannot pass", () => {
  const v = assess(
    mutate(golden, (c) => (c.bootLog = golden.bootLog.replace("Blueprint step 3/6:", "Blueprint step 3/5:"))),
  );
  assert.equal(v.error_class, "step_count_mismatch");
});

test("term a6_extraction_count: a surplus extraction cannot pass", () => {
  const extra =
    golden.bootLog +
    "\n[t] Bootstrapping Moodle: [1ms] Extracting plugin to /www/moodle/local/sneaky";
  const v = assess(mutate(golden, (c) => (c.bootLog = extra)));
  assert.equal(v.assertions.find((a) => a.id === "a6_extraction_count").ok, false);
  assert.equal(v.error_class, "plugin_binding_mismatch");
});

test("term BM anchor: a log record embedded mid-message is not counted", () => {
  // Drop a genuine extraction and offer a forged one that is not at the
  // start of its message. Anchored parsing ignores the forgery (count 2/3);
  // un-anchored parsing would accept it and pass.
  const forged = golden.bootLog
    .replace(/^.*Extracting plugin to \/www\/moodle\/filter\/multilang2.*$/m, "")
    .concat(
      "\n[t] Bootstrapping Moodle: [1ms] Plugin note: Bootstrapping Moodle: [1ms] Extracting plugin to /www/moodle/filter/multilang2",
    );
  const v = assess(mutate(golden, (c) => (c.bootLog = forged)));
  assert.notEqual(v.status, "pass");
  assert.equal(v.assertions.find((a) => a.id === "a6_extraction_count").ok, false);
});

test("missing loopback binding cannot pass", () => {
  const v = assess(mutate(golden, (c) => (c.meta.loopback_sha256 = "")));
  assert.equal(v.status, "infra_fail");
  assert.equal(v.assertions.find((a) => a.id === "a0_loopback_binding").ok, false);
});

test("loopback hash different from the gated hash cannot pass", () => {
  const v = assess(mutate(golden, (c) => (c.meta.loopback_sha256 = "f".repeat(64))));
  assert.notEqual(v.status, "pass");
});

test("gated hash absent from expectations cannot pass", () => {
  const v = assess(mutate(golden, (c) => (c.expectations.blueprintSha256 = "")));
  assert.notEqual(v.status, "pass");
});

test("wrong extraction name → verify_fail/plugin_binding_mismatch", () => {
  const v = assess(
    mutate(golden, (c) => (c.expectations.pluginSteps[1].pluginName = "not_attendance")),
  );
  assert.equal(v.error_class, "plugin_binding_mismatch");
});

// ---- the exit-code maps must not collide ---------------------------------

test("no two assertion generators claim the same exit code", async () => {
  const { ASSERT_CODES } = await import("../scripts/restore-assert.mjs");
  const { THEME_CODES } = await import("../scripts/theme-assert.mjs");
  const { COURSE_CODES } = await import("../scripts/course-assert.mjs");
  // `assert.mjs` merges these with object spread, so a code defined twice is
  // silently won by whichever map is spread last — and the boot log would then
  // explain a failure as the wrong thing entirely, which is worse than the
  // "99 is not ours" silence the explainer is careful about elsewhere.
  // Nothing checked this; a planted duplicate key left the whole suite green.
  const maps = [
    ["restore-assert.mjs", ASSERT_CODES],
    ["theme-assert.mjs", THEME_CODES],
    ["course-assert.mjs", COURSE_CODES],
  ];
  const owner = new Map();
  for (const [module, codes] of maps) {
    for (const code of Object.keys(codes)) {
      // 0 is SUCCESS in every generator and is legitimately defined by more
      // than one. It is the only shared code, and it is shared by meaning
      // rather than by accident — every other number identifies one specific
      // failure in one specific generator.
      if (code === "0") continue;
      const already = owner.get(code);
      assert.equal(
        already, undefined,
        `exit code ${code} is claimed by BOTH ${already} and ${module} — ` +
          `assert.mjs spreads them, so one silently wins and the boot log ` +
          `would explain the failure as the wrong thing`,
      );
      owner.set(code, module);
    }
  }
  // ...and a sanity floor, so deleting a whole map does not read as "disjoint".
  assert.ok(owner.size >= 10, `expected every generator's failure codes, saw ${owner.size}`);
  // Every generator numbers its failures in its own block of ten, so a new one
  // starts at the next free block rather than picking numbers at random. This
  // is what keeps the disjointness above easy to hold rather than lucky.
  const blocks = new Map();
  for (const [code, module] of owner) {
    const block = Math.floor(Number(code) / 10);
    const already = blocks.get(block);
    assert.ok(
      already === undefined || already === module,
      `exit codes ${block}0-${block}9 are split between ${already} and ${module} — ` +
        `keep one block per generator so the next one has an obvious free block`,
    );
    blocks.set(block, module);
  }
});
