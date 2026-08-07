// Turn capture evidence (meta.json + boot-log.txt + console.txt) plus
// expectations.json into verdict.json. Single source of the verdict; the
// anchors are ground-truthed in SPEC.md §4 and pinned by
// test/fixtures/golden-boot-log.txt.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ERROR_CLASSES } from "./validate-verdict.mjs";

// Shell log lines are `[<ISO8601>] <message>`; strip the timestamp.
const LOG_LINE_RE = /^\[[^\]]*\] (.*)$/;
// php-worker.js: title "Boot timing summary", detail joined with ": ".
const BOOT_ANCHOR_RE =
  /^Boot timing summary: Config: \d+ms \| PHP refresh: \d+ms \| Bootstrap: \d+ms(?: \| Bundle wait \(post-refresh\): \d+ms)? \| Total: (\d+)ms$/;
// executor.js:52 via publish title "Bootstrapping Moodle". The shell's
// progress renderer prefixes the detail with elapsed time — `[24ms] ` —
// (observed live 2026-07-30), hence the optional prefix group.
const BM = String.raw`^Bootstrapping Moodle: (?:\[\d+ms\] )?`;
const STEP_RE = new RegExp(BM + String.raw`Blueprint step (\d+)\/(\d+): (.+)$`);
const FAIL_RES = [
  new RegExp(BM + String.raw`Blueprint step .+ failed: `),
  new RegExp(BM + String.raw`Blueprint failed at step `),
  new RegExp(BM + String.raw`Blueprint execution error: `),
];
// All THREE non-fatal upgrade outcomes the runtime can publish
// (moodle-plugins.js:333 crashed / :341 errors / :344 failed). `failed` is
// the primary one — it fires when the PHP returns `"ok":false`, i.e. the
// plugin's files installed but the upgrade never registered them — and it
// returns success to the blueprint executor, so nothing else catches it.
const UPGRADE_SOFT_FAIL_RE = new RegExp(BM + String.raw`Plugin upgrade (?:crashed|errors|failed): `);
const DOWNLOAD_RE = new RegExp(BM + String.raw`Downloading plugin ZIP from (\S+?)( via addon proxy)?$`);
const EXTRACT_RE = new RegExp(BM + String.raw`Extracting plugin to (\S+)$`);
const RESOLVER_OK_LINE = "[blueprint] Resolved from ?blueprint-url= param.";
const RESOLVER_FALLBACK_MARKERS = [
  "[blueprint] Resolved from defaultBlueprintUrl.",
  "[blueprint] Resolved from ?blueprint= param (inline).",
  // Deployed-playground schema rejection ("playground too old for this
  // blueprint") logs this warning before falling back (observed live).
  "[blueprint] Failed to fetch ?blueprint-url=",
];

export function parseBootLog(raw) {
  const messages = [];
  for (const line of raw.split("\n")) {
    const m = LOG_LINE_RE.exec(line);
    if (m) messages.push(m[1]);
  }
  const steps = [];
  let bootMs = null;
  let failLines = 0;
  let upgradeSoftFails = 0;
  const downloads = [];
  const extractions = [];
  let weakBootSignal = false;
  for (const msg of messages) {
    let m;
    if ((m = BOOT_ANCHOR_RE.exec(msg))) bootMs = Number(m[1]);
    else if ((m = STEP_RE.exec(msg))) {
      steps.push({ k: Number(m[1]), n: Number(m[2]), name: m[3] });
    } else if ((m = DOWNLOAD_RE.exec(msg))) {
      downloads.push({ url: m[1], viaProxy: Boolean(m[2]) });
    } else if ((m = EXTRACT_RE.exec(msg))) extractions.push(m[1]);
    else if (FAIL_RES.some((re) => re.test(msg))) failLines += 1;
    else if (UPGRADE_SOFT_FAIL_RE.test(msg)) upgradeSoftFails += 1;
    if (/Total:\s*\d+ms/.test(msg) || msg.includes("Blueprint step")) {
      weakBootSignal = true;
    }
  }
  return { messages, steps, bootMs, failLines, upgradeSoftFails, downloads, extractions, weakBootSignal };
}

// Mirrors PLUGIN_TYPE_DIRS in moodle-playground
// src/blueprint/steps/moodle-plugins.js (copied 2026-07-29). Needed because
// the extraction path is `/www/moodle/<dir>/<name>` and <dir> is not the
// plugin type for nested types. A type missing here fails a6 rather than
// passing on a guessed path.
export const PLUGIN_TYPE_DIRS = {
  mod: "mod", block: "blocks", local: "local", theme: "theme", auth: "auth",
  enrol: "enrol", filter: "filter", format: "course/format", report: "report",
  tool: "admin/tool", editor: "lib/editor", atto: "lib/editor/atto/plugins",
  tiny: "lib/editor/tiny/plugins", qtype: "question/type",
  qbehaviour: "question/behaviour", gradeexport: "grade/export",
  gradeimport: "grade/import", gradereport: "grade/report",
  repository: "repository", plagiarism: "plagiarism",
  availability: "availability/condition", calendartype: "calendar/type",
  message: "message/output", profilefield: "user/profile/field",
  datafield: "mod/data/field", assignsubmission: "mod/assign/submission",
  assignfeedback: "mod/assign/feedback", booktool: "mod/book/tool",
  quizaccess: "mod/quiz/accessrule", ltisource: "mod/lti/source",
  workshopform: "mod/workshop/form", workshopallocation: "mod/workshop/allocation",
  workshopeval: "mod/workshop/eval", contenttype: "contentbank/contenttype",
  customfield: "customfield/field", media: "media/player",
  paygw: "payment/gateway", qbank: "question/bank", search: "search/engine",
  aiprovider: "ai/provider", aiplacement: "ai/placement",
};

// Which failure names the verdict when several are true. Harness/infra
// classes come first (they make the rest unassessable), then identity —
// "was this even our blueprint?" must outrank failures observed inside
// whatever DID run, or the author hunts a step they never wrote.
const PRECEDENCE = [
  "browser_launch_failed",
  "nav_fail",
  "logs_panel_missing",
  "timeout",
  "anchor_drift",
  "resolver_fallback",
  "step_failed",
  "upgrade_soft_fail",
  "step_count_mismatch",
  "plugin_binding_mismatch",
];

/**
 * Assess one capture. EVERY check runs and is recorded in `assertions`
 * (SPEC §3: nothing hidden by precedence); the reported error_class is the
 * highest-precedence failure among them.
 * @returns {object} verdict (schema 1)
 */
export function assess({ expectations, meta, bootLog, consoleLog, headSha = "", acceptedOrigins = [] }) {
  const assertions = [];
  const failures = new Set();
  /** record a check; `ok===null` means "could not be evaluated" */
  const check = (id, ok, errorClass) => {
    if (ok === null) return null;
    assertions.push({ id, ok: Boolean(ok) });
    if (!ok) failures.add(errorClass);
    return Boolean(ok);
  };

  const parsed = parseBootLog(bootLog || "");
  const consoleText = consoleLog || "";
  const exp = expectations || {};

  // --- harness integrity -------------------------------------------------
  const launched = check("a1_browser", Boolean(meta?.browser_launched), "browser_launch_failed");
  if (launched) {
    // The production host redirects (moodle-playground.com →
    // ateeducacion.github.io, observed live), so accept the configured host
    // or an explicitly listed origin — never anywhere else.
    const originOk = (() => {
      try {
        const ok = new Set(
          [meta.playground_host, ...acceptedOrigins].filter(Boolean).map((o) => new URL(o).origin),
        );
        return ok.has(new URL(meta.final_url).origin);
      } catch {
        return false;
      }
    })();
    check("a1_nav", Boolean(meta.nav_ok) && originOk && !meta.page_crashed, "nav_fail");
    check("a1_logs_panel", Boolean(meta.logs_panel_found), "logs_panel_missing");

    // Mandatory loopback: the browser must have been SERVED the gated bytes.
    // The hash alone proves nothing (it is the same local file both sides) —
    // what matters is that the interception fired.
    check(
      "a0_loopback_binding",
      Boolean(exp.blueprintSha256) &&
        meta.loopback_sha256 === exp.blueprintSha256 &&
        meta.loopback_served >= 1,
      "nav_fail",
    );
  }

  // --- boot completion ---------------------------------------------------
  const anchorOk = check("a2_boot_anchor", parsed.bootMs !== null, parsed.weakBootSignal ? "anchor_drift" : "timeout");

  // Step accounting (needed to judge whether a timed-out run is assessable).
  const seen = new Set(parsed.steps.map((s) => s.k));
  let contiguous = 0;
  while (seen.has(contiguous + 1)) contiguous += 1;
  const declaredN = parsed.steps[0]?.n;
  const sequenceComplete =
    typeof exp.stepCount === "number" &&
    parsed.steps.length > 0 &&
    declaredN === exp.stepCount &&
    contiguous === exp.stepCount &&
    parsed.steps.every((s) => s.n === declaredN);

  // A wall-clock expiry only invalidates the evidence if the run was still
  // unfinished. A complete boot whose page kept chattering is assessable
  // — otherwise good runs become infra_fail and poison the
  // canary's flake metric.
  if (meta?.timed_out) {
    check("a2_complete", Boolean(anchorOk && sequenceComplete), "timeout");
  }

  // --- identity: did OUR blueprint run? ----------------------------------
  // Line-anchored against the capture's own `[console:<type>] ` prefix, so a
  // plugin printing the resolver text mid-message cannot forge or negate it.
  const consoleLines = consoleText.split("\n");
  const consoleMessage = (line) => {
    const m = /^\[(?:console:[a-z]+|pageerror|harness)\] (.*)$/.exec(line);
    return m ? m[1] : null;
  };
  const messages = consoleLines.map(consoleMessage).filter((m) => m !== null);
  const resolverOk = messages.includes(RESOLVER_OK_LINE);
  const fellBack = messages.some((m) =>
    RESOLVER_FALLBACK_MARKERS.some((marker) => m.startsWith(marker)),
  );
  check("a3_resolver_line", resolverOk, "resolver_fallback");
  check("a3_no_fallback", !fellBack, "resolver_fallback");
  // Executed step NAMES must equal the gated blueprint's. Counting alone
  // cannot tell our 6-step blueprint from the starter blueprint's 6 steps
  // — and `stepNames` was already being parsed and ignored.
  const namesMatch =
    Array.isArray(exp.stepNames) &&
    parsed.steps.length === exp.stepNames.length &&
    parsed.steps.every((s, i) => s.name === exp.stepNames[i]);
  check("a3_step_names", namesMatch, "resolver_fallback");

  // --- step outcomes -----------------------------------------------------
  check("a4_no_step_failures", parsed.failLines === 0, "step_failed");
  check("a5_no_upgrade_soft_fail", parsed.upgradeSoftFails === 0, "upgrade_soft_fail");
  check("a4_step_count", sequenceComplete, "step_count_mismatch");

  // --- per-plugin binding ------------------------------------------------
  const plugins = Array.isArray(exp.pluginSteps) ? exp.pluginSteps : [];
  const downloadedUrls = new Set(parsed.downloads.map((d) => d.url));
  check(
    "a6_urls_downloaded",
    plugins.every((p) => p.url && downloadedUrls.has(p.url)),
    "plugin_binding_mismatch",
  );
  // Exact extraction path per plugin, derived from type+name (both are
  // mandatory at preflight, so this can never be vacuously true).
  // A missing type/name or a type absent from the directory map yields a
  // path like `/www/moodle/undefined/x`, which no extraction line matches —
  // so the path comparison alone is sufficient, no presence pre-check needed.
  check(
    "a6_extraction_paths",
    plugins.every((p) =>
      parsed.extractions.includes(
        `/www/moodle/${PLUGIN_TYPE_DIRS[p.pluginType]}/${p.pluginName}`,
      ),
    ),
    "plugin_binding_mismatch",
  );
  check("a6_extraction_count", parsed.extractions.length === plugins.length, "plugin_binding_mismatch");
  // A BIJECTION, not a count. Two plugin steps resolving to the same directory
  // produce two extraction lines for one target, which `includes` plus a count
  // reads as two successful installs — while the second archive has silently
  // overwritten the first. Pre-flight now refuses that blueprint; this is the
  // second lock, on the evidence side, so a collision cannot pass unnoticed
  // even if it arrives some other way.
  check(
    "a6_extraction_distinct",
    new Set(parsed.extractions).size === parsed.extractions.length,
    "plugin_binding_mismatch",
  );
  // A regression back to the third-party addon proxy must be visible: with
  // host-allowlisted URLs the playground fetches direct.
  check("a6_no_addon_proxy", parsed.downloads.every((d) => !d.viaProxy), "plugin_binding_mismatch");

  // --- verdict -----------------------------------------------------------
  const errorClass = PRECEDENCE.find((ec) => failures.has(ec)) ?? "none";
  const status = errorClass === "none" ? "pass" : ERROR_CLASSES[errorClass];
  return {
    schema: 1,
    status,
    error_class: errorClass,
    head_sha: headSha,
    blueprint_sha256: exp.blueprintSha256 || "",
    boot_ms: parsed.bootMs ?? 0,
    steps_ok: parsed.failLines > 0 ? Math.max(0, contiguous - 1) : contiguous,
    steps_failed: parsed.failLines,
    assertions,
    // Carried through from pre-flight so the verdict is honest about its own
    // limits: with any of these present the STRUCTURAL assertions describe the
    // end state, not what produced it — code installed for real can be
    // overwritten afterwards without touching the database, the boot log or
    // any assertion.
    risky_steps: Array.isArray(exp.riskySteps) ? exp.riskySteps : [],
    // WHICH archives were installed, not merely how many. Without this a
    // reader who suspects a substitution has no record to check against; the
    // list was already computed at pre-flight and thrown away.
    plugin_sources: Array.isArray(exp.pluginSteps)
      ? exp.pluginSteps.map((pl) => pl.url).filter((u) => typeof u === "string")
      : [],
  };
}

function readIf(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** Verdict for a blueprint preflight refused — no boot happened. */
export function rejectedVerdict(errorClass, blueprintSha256, headSha) {
  return {
    schema: 1,
    status: "rejected",
    error_class: errorClass,
    head_sha: headSha,
    blueprint_sha256: blueprintSha256 || "",
    boot_ms: 0,
    steps_ok: 0,
    steps_failed: 0,
    assertions: [{ id: `preflight_${errorClass}`, ok: false }],
    // Nothing booted, so nothing risky ran and nothing was installed.
    risky_steps: [],
    plugin_sources: [],
  };
}

function main() {
  const outDir = process.env.OUT_DIR || "boot-verify-out";
  const headSha = process.env.HEAD_SHA || "";
  // This is the ONLY writer of verdict.json. Trusting a pre-existing one
  // would let a PR commit its own pass into the workspace.
  const preflightPath = join(outDir, "preflight.json");
  const preflight = existsSync(preflightPath)
    ? JSON.parse(readFileSync(preflightPath, "utf8"))
    : null;

  let v;
  const setupFailed =
    process.env.SETUP_FAILED_FILE && existsSync(process.env.SETUP_FAILED_FILE);
  if (setupFailed) {
    // npm/browser install failed: an infrastructure verdict, not a red job.
    v = {
      ...rejectedVerdict("blueprint_fetch_failed", "", headSha),
      status: "infra_fail",
      error_class: "browser_launch_failed",
      assertions: [{ id: "setup_failed", ok: false }],
    };
  } else if (!preflight) {
    v = {
      ...rejectedVerdict("blueprint_fetch_failed", "", headSha),
      status: "infra_fail",
      error_class: "browser_launch_failed",
      assertions: [{ id: "preflight_missing", ok: false }],
    };
  } else if (preflight.outcome !== "ok") {
    v = rejectedVerdict(preflight.error_class, preflight.blueprintSha256, headSha);
  } else {
    const expectationsPath = join(outDir, "expectations.json");
    const metaPath = join(outDir, "meta.json");
    v = assess({
      expectations: existsSync(expectationsPath)
        ? JSON.parse(readFileSync(expectationsPath, "utf8"))
        : null,
      meta: existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : null,
      bootLog: readIf(join(outDir, "boot-log.txt")),
      consoleLog: readIf(join(outDir, "console.txt")),
      headSha,
      acceptedOrigins: (process.env.ACCEPTED_ORIGINS || "")
        .split(",").map((s) => s.trim()).filter(Boolean),
    });
    // The verdict may only certify the hash preflight gated.
    if (v.blueprint_sha256 !== (preflight.blueprintSha256 || "")) {
      throw new Error("internal: verdict hash does not match the gated blueprint");
    }
  }
  if (!Object.hasOwn(ERROR_CLASSES, v.error_class)) {
    throw new Error(`internal: produced unknown error_class ${v.error_class}`);
  }
  writeFileSync(join(outDir, "verdict.json"), JSON.stringify(v, null, 2));
  console.log(
    `verdict: ${v.status} (${v.error_class}) boot=${v.boot_ms}ms steps=${v.steps_ok} ok/${v.steps_failed} failed`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
