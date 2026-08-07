// Pre-flight: fetch the blueprint, enforce the host allowlists and the
// step-gate (SPEC.md §5), and derive the expectations the assertions will
// check against (verify.sh check-4 discipline: expectations always come
// from parsing the blueprint in the runner, never from caller inputs).
//
// Always exits 0: on rejection it writes verdict.json directly and later
// steps short-circuit on its presence (the CALLER gates on the status
// output, after artifacts are uploaded — see action.yml).

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { sanitiseForLog } from "./sanitise.mjs";

// Full registry of playground step names (moodle-playground
// src/blueprint/steps/*, enumerated 2026-07-29). Steps not listed here are
// unknown → banned (default deny). Banned = anything that writes arbitrary
// files, runs arbitrary PHP, or makes arbitrary requests from inside the
// boot — the step registry is an RCE surface (design §5).
export const ALLOWED_STEPS = new Set([
  "installMoodle", "login", "setAdminAccount", "setTheme", "setLandingPage",
  "installMoodlePlugin", "installTheme", "installLanguagePack",
  "restoreDatabase", "restoreCourse",
  "createCategory", "createCategories", "createCourse", "createCourses",
  "createSection", "createSections", "createUser", "createUsers",
  "createRole", "createRoles", "createScale", "createScales",
  "createCohort", "createCohorts", "enrolUser", "enrolUsers", "addModule",
  "importRoles", "importRolePreset", "setConfig", "setConfigs",
  "purgeMoodleCaches",
  // Risky but permitted; see RISKY_STEPS. Unknown names are still refused,
  // because a typo'd step is skipped in silence and boots a plugin-free Moodle.
  "runPhpCode", "runPhpScript", "writeFile", "writeFiles", "unzip",
  "applyPrOverlay", "request", "copyFile", "moveFile", "deleteFile",
  "deleteFiles", "mkdir", "rmdir", "setConfigFile", "setConfigFiles",
]);

/**
 * Steps that can change Moodle ITSELF after the plugin is installed — arbitrary
 * PHP, filesystem writes, core overlays. They are ALLOWED, and reported.
 *
 * They are worth reporting because they change what a result means rather than
 * whether it succeeds. The risk is SUBSTITUTION, not fabrication: after the
 * plugin has genuinely installed, `writeFile` can overwrite its files. The
 * database registration is untouched, the admin page still lists the plugin,
 * the boot log gains no line, and every assertion still passes — so a reviewer
 * reads one diff while different code runs, with nothing on the page or in the
 * verdict that differs. Measured against the deployed build 2026-08-07.
 *
 * NOT what an earlier version of this comment claimed. `writeFile` cannot
 * fabricate a plugin: it emits no `Extracting plugin to …` line (which is what
 * assert.mjs parses), and a bare `version.php` never registers, because the
 * playground pins `alternative_component_cache` (config-template.js:124) and
 * only `installMoodlePlugin` registers a component in it, via
 * `playground_refresh_installed_plugin_cache` (moodle-plugins.js:303). Writing
 * `/www/moodle/mod/fake/version.php` leaves `/admin/plugins.php` unchanged.
 * Defending against fabrication would be effort spent on something that does
 * not happen.
 *
 * Previously these were refused outright. Blocking them also blocked
 * legitimate uses — installing a dependency, preparing fixture files — so the
 * gate now reports instead of refusing.
 */
export const RISKY_STEPS = new Set([
  "runPhpCode", "runPhpScript", "writeFile", "writeFiles", "unzip",
  "applyPrOverlay", "request", "copyFile", "moveFile", "deleteFile",
  "deleteFiles", "mkdir", "rmdir", "setConfigFile", "setConfigFiles",
]);

// Config names whose values Moodle renders as RAW HTML on every page
// (PARAM_RAW, emitted by core_renderer). `setConfig` is allowlisted by NAME,
// so without this the gate passes a blueprint that injects a <script> tag
// into an unsandboxed iframe, same-origin with the playground — every URL
// sweep misses it, because the payload need not look like a URL at all.
// This is the "allowlist names, not capabilities" gap.
export const RAW_HTML_CONFIGS = new Set([
  "additionalhtmlhead",
  "additionalhtmlfooter",
  "additionalhtmltopofbody",
]);

/** Collect the {name, value} pairs a setConfig/setConfigs step would apply. */
function configPairs(step) {
  if (step?.step === "setConfig") return [{ name: step.name, value: step.value }];
  if (step?.step === "setConfigs" && Array.isArray(step.configs)) return step.configs;
  return [];
}

// Anything that could possibly be fetched. Deliberately far wider than
// "starts with https://": the URL parser and fetch() both strip leading /
// trailing / embedded C0 whitespace, so " https://evil/x" and
// "ht\ttps://evil/x" resolve to evil while a naive prefix test says
// "not a URL" and skips the allowlist.
const CONTROL_CHARS_RE =
  /[\x00-\x20\x7f-\xa0\u1680\u2000-\u200f\u2028-\u202f\u205f-\u2060\u3000\ufeff]/u;
const SCHEME_ISH_RE = /^[a-z][a-z0-9+.-]*:/i;
// One depth policy for every sweep; exceeding it is a rejection, never a
// silent skip (a value below the cap would otherwise be ungated).
const MAX_DEPTH = 32;
// A blueprint is a small JSON document; anything larger is either a mistake
// or an attempt to exhaust the runner.
const MAX_BLUEPRINT_BYTES = 1_000_000;

/** Read a fetch response body, aborting past `limit` bytes. */
async function readCapped(res, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > limit) throw new Error(`blueprint larger than ${limit} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** @returns {string|null} problem description, or null if the URL is acceptable */
export function checkUrl(raw, allowedHosts) {
  if (typeof raw !== "string") return "non-string URL";
  // Reject before normalising: a string that only becomes a URL after the
  // browser strips whitespace is hostile by construction.
  if (CONTROL_CHARS_RE.test(raw)) return `URL contains control/space chars: ${JSON.stringify(raw)}`;
  // Never legitimate in an https URL, and the parser treats it as `/`.
  if (raw.includes("\\")) return `URL contains a backslash: ${JSON.stringify(raw)}`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return `unparseable URL: ${raw}`;
  }
  if (url.protocol !== "https:") return `non-https URL: ${raw}`;
  if (url.username || url.password) return `URL with userinfo: ${raw}`;
  if (!allowedHosts.includes(url.hostname)) {
    return `host not in allowlist: ${url.hostname}`;
  }
  // Content-addressed raw URLs need neither; a query string is how a
  // credential would ride along into the evidence artifact.
  if (url.search || url.hash) return `URL carries query/fragment: ${raw}`;
  // An explicit port is never needed for the hosts we allow, and pinning it
  // keeps the allowlist about one endpoint rather than a whole host.
  if (url.port) return `URL specifies a port: ${raw}`;
  return null;
}

/**
 * Does this string need to clear the allowlist? True for anything with a
 * URL-ish scheme, anything scheme-relative (`//host/x`), and anything
 * carrying control characters (which cannot be legitimate and may become a
 * URL once stripped).
 */
export function looksFetchable(s) {
  if (typeof s !== "string") return false;
  const stripped = s.replace(new RegExp(CONTROL_CHARS_RE.source, "gu"), "");
  if (SCHEME_ISH_RE.test(stripped) || stripped.startsWith("//")) return true;
  // Backslashes: the URL parser folds `\` to `/`, so "\\evil/p.zip" resolves
  // against the page to https://evil/p.zip — a real off-allowlist fetch that
  // neither a scheme test nor a "//" test notices.
  if (stripped.includes("\\")) return true;
  // Last line of defence: resolve against a sentinel base and see whether
  // the string is capable of leaving that origin on its own.
  try {
    return new URL(stripped, "https://base.invalid/x/").hostname !== "base.invalid";
  } catch {
    return false;
  }
}

/**
 * Placeholder syntax anywhere in a blueprint is refused.
 *
 * The playground's substituteConstants() rewrites EVERY string using
 * {{REPO}}/{{REF}}/{{OWNER}}/{{BRANCH}}, and URL params feed those constants
 * with the highest precedence — so a blueprint carrying placeholders passes
 * the host allowlist, hashes identically, and installs whatever the link says.
 * That is the reason FORBIDDEN_PARAMS exists; this is the other half of it.
 *
 * This lived in build-preview.mjs and so applied only to blueprints the action
 * WROTE — never to the foreign ones the verify half fetches from a URL, which
 * is the half that handles untrusted input. Moved here so both halves get it.
 */
/** Throwing form, for callers that build a blueprint and want to fail fast. */
export function assertNoPlaceholders(blueprint) {
  const problems = [];
  sweepPlaceholders(blueprint, problems);
  if (problems.length) throw new Error(problems[0]);
}

function sweepPlaceholders(node, problems, path = "$", depth = 0) {
  if (depth > MAX_DEPTH) return;
  if (typeof node === "string") {
    if (node.includes("{{") || node.includes("}}")) {
      problems.push(
        `${path}: placeholder syntax is banned — the playground substitutes ` +
          `{{REPO}}/{{REF}} from the link's own query string, so this would ` +
          `install whatever the link says while hashing identically`,
      );
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => sweepPlaceholders(v, problems, `${path}[${i}]`, depth + 1));
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k.includes("{{") || k.includes("}}")) {
        problems.push(`${path}.${k}: placeholder syntax is banned in a key`);
      }
      sweepPlaceholders(v, problems, `${path}.${k}`, depth + 1);
    }
  }
}

/**
 * Walk every string value in the blueprint; any that parses as an http(s)
 * URL must pass the data-host allowlist. This subsumes per-step URL checks
 * and neutralises proxy/host overrides hidden in unexpected keys.
 */
function sweepUrls(node, dataHosts, problems, path = "$", depth = 0) {
  if (depth > MAX_DEPTH) {
    problems.push(`${path}: blueprint nested deeper than ${MAX_DEPTH}`);
    return;
  }
  if (typeof node === "string") {
    if (looksFetchable(node)) {
      const problem = checkUrl(node, dataHosts);
      if (problem) problems.push(`${path}: ${problem}`);
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => sweepUrls(v, dataHosts, problems, `${path}[${i}]`, depth + 1));
    return;
  }
  if (typeof node === "object" && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      if (/proxy/i.test(key)) {
        problems.push(`${path}.${key}: proxy override keys are banned`);
        continue;
      }
      sweepUrls(value, dataHosts, problems, `${path}.${key}`, depth + 1);
    }
  }
}

/**
 * Every string in the blueprint ends up somewhere — a log line, a path, a
 * URL. A newline inside one turns ONE runtime log message into TWO lines,
 * which is enough to forge an `Extracting plugin to …` record and satisfy
 * the binding assertion (demonstrated). Blueprint values are
 * identifiers and URLs, so refusing control characters outright costs
 * nothing legitimate.
 */
function sweepUnsafeStrings(node, problems, path = "$", depth = 0) {
  // Both sweeps share MAX_DEPTH and both REJECT on exceeding it. Silently
  // returning would let a hostile value hide below the cap, and an
  // asymmetric cap between the two sweeps is the same bug.
  if (depth > MAX_DEPTH) {
    problems.push(`${path}: blueprint nested deeper than ${MAX_DEPTH}`);
    return;
  }
  if (typeof node === "string") {
    if (CONTROL_CHARS_RE.test(node)) {
      // Space is legitimate inside human-readable values (course names), so
      // only flag it when the string also looks URL-ish; everything else in
      // the class (newlines, tabs, zero-width, separators) is never valid.
      const withoutPlainSpace = node.replace(/ /g, "");
      if (CONTROL_CHARS_RE.test(withoutPlainSpace) || looksFetchable(node)) {
        problems.push(`${path}: string contains control characters: ${JSON.stringify(node.slice(0, 80))}`);
      }
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => sweepUnsafeStrings(v, problems, `${path}[${i}]`, depth + 1));
    return;
  }
  if (typeof node === "object" && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      sweepUnsafeStrings(value, problems, `${path}.${key}`, depth + 1);
    }
  }
}

/** Reject a banned step name appearing under any nested `step` key. */
function sweepNestedStepNames(node, problems, path, depth = 0) {
  if (node === null || typeof node !== "object") return;
  if (depth > MAX_DEPTH) {
    problems.push(`${path}: blueprint nested deeper than ${MAX_DEPTH}`);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => sweepNestedStepNames(v, problems, `${path}[${i}]`, depth + 1));
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (depth > 0 && key === "step" && typeof value === "string" && !ALLOWED_STEPS.has(value)) {
      problems.push(`${path}.${key}: nested step '${value}' not allowed`);
    }
    sweepNestedStepNames(value, problems, `${path}.${key}`, depth + 1);
  }
}

const PLUGIN_STEPS = new Set(["installMoodlePlugin", "installTheme"]);
const IDENTIFIER_RE = /^[a-z][a-z0-9_]*$/;

/**
 * @returns {{stepErrors: string[], urlErrors: string[], unsafeStrings: string[],
 *            bindErrors: string[], expectations: object|null}}
 */
/**
 * @param {object} blueprint
 * @param {string[]} dataHosts — hosts any URL in the blueprint may point at.
 * @param {{requireSelfUrl?: string}} [opts] — when given, at least ONE plugin
 *   install step must fetch exactly this URL. The blueprint may install any
 *   number of OTHER plugins (dependencies, third-party plugins the reviewer
 *   needs); what it may not do is omit the commit under review.
 *
 *   SCOPE, honestly. Today this is a REGRESSION GUARD, not a live control.
 *   The only caller that passes it is build-preview.mjs, which derives both
 *   the install URL and this value from the same `pluginZipUrl(headRepo,
 *   headSha)` call — so they cannot disagree at runtime, and it fires only if
 *   someone later edits one side. The verify half never passes it: that action
 *   takes a foreign `blueprint-url` and has no notion of a commit under
 *   review. It becomes a real control the moment a blueprint arrives from
 *   outside — an inline-JSON dispatch input, or a committed
 *   `.github/preview.blueprint.json` — and the plumbing is kept and tested so
 *   that day needs no new code.
 *
 *   What it does NOT defend against is substitution, which is the attack that
 *   was actually found: this checks that your plugin is in the list, not that
 *   it is the last writer to its directory. The duplicate-target check above
 *   is what carries that weight, and unlike this it runs on both halves.
 */
export function gateBlueprint(blueprint, dataHosts, opts = {}) {
  const stepErrors = [];
  const urlErrors = [];
  const unsafeStrings = [];
  const bindErrors = [];
  const riskySteps = [];
  const empty = { stepErrors, urlErrors, unsafeStrings, bindErrors, riskySteps, expectations: null };
  const steps = blueprint?.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    stepErrors.push("blueprint has no steps array");
    return empty;
  }
  for (const [i, step] of steps.entries()) {
    const name = step?.step;
    if (typeof name !== "string") {
      stepErrors.push(`step[${i}] has no step name`);
    } else if (!ALLOWED_STEPS.has(name)) {
      stepErrors.push(`step[${i}] ${name}: unknown step (default deny)`);
    }
    // A banned name nested anywhere under a step (a future step gaining a
    // sub-step list, an aliased `steps:` array) would sail past the loop
    // above, which only reads `step.step`.
    if (RISKY_STEPS.has(name)) riskySteps.push(name);
    sweepNestedStepNames(step, stepErrors, `step[${i}]`);

    // Binding requirement: CI can only prove "this plugin installed" by
    // matching the extraction path, which needs the type and name stated.
    // URL-derived detection happens inside the browser where we cannot see
    // it, so an unstated name makes a pass unfalsifiable.
    for (const cfg of configPairs(step)) {
      if (RAW_HTML_CONFIGS.has(String(cfg?.name ?? "").toLowerCase())) {
        stepErrors.push(
          `step[${i}] ${name}: refuses to set "${cfg.name}" — Moodle renders it ` +
            `as raw HTML on every page, same-origin with the playground`,
        );
      }
    }

    if (PLUGIN_STEPS.has(name)) {
      const type = name === "installTheme" ? (step.pluginType ?? "theme") : step.pluginType;
      if (!IDENTIFIER_RE.test(String(step.pluginName ?? ""))) {
        bindErrors.push(`step[${i}] ${name}: explicit pluginName required (got ${JSON.stringify(step.pluginName ?? null)})`);
      }
      if (!IDENTIFIER_RE.test(String(type ?? ""))) {
        bindErrors.push(`step[${i}] ${name}: explicit pluginType required (got ${JSON.stringify(step.pluginType ?? null)})`);
      }
      if (typeof step.url !== "string") {
        bindErrors.push(`step[${i}] ${name}: url required`);
      }
    }
  }
  // The commit under review must actually be installed. Checked across ALL
  // plugin steps, not just the first: dependencies and other people's plugins
  // are legitimate, missing your own is not.
  // Two plugin steps that resolve to the SAME directory silently merge, and
  // the second archive wins file by file: installViaZipDownload never clears
  // the target (`moodle-plugins.js:198-262`). Moodle then reads exactly one
  // file — version.php — to decide what the plugin is, keeps no manifest and
  // no checksum, and reports a clean install. The reviewer gets a page headed
  // with THIS commit while running someone else's code, and every signal is
  // green: requireSelfUrl passes (your plugin IS in the list), risky_steps is
  // empty (installMoodlePlugin was never risky), and a6_extraction_count sees
  // two extractions for two steps.
  //
  // Rejecting the collision is also what everything else does, Moodle's own
  // installer included ("Target location already exists"). Installing the same
  // plugin twice to exercise an upgrade path cannot work here anyway — the
  // second extraction merges rather than replaces, so it would test a chimera.
  const targets = new Map();
  for (const [i, step] of steps.entries()) {
    if (!PLUGIN_STEPS.has(step?.step)) continue;
    const type = step.step === "installTheme" ? (step.pluginType ?? "theme") : step.pluginType;
    const key = `${type}_${step.pluginName}`;
    if (targets.has(key)) {
      bindErrors.push(
        `step[${i}] ${step.step}: ${key} is already installed by step[${targets.get(key)}] — ` +
          `both extract to the same directory and the second would overwrite the first ` +
          `file by file, with nothing reporting it`,
      );
      continue;
    }
    targets.set(key, i);
  }

  if (opts.requireSelfUrl) {
    const installed = steps
      .filter((s) => PLUGIN_STEPS.has(s?.step))
      .map((s) => s?.url);
    if (!installed.includes(opts.requireSelfUrl)) {
      bindErrors.push(
        `no plugin step installs the commit under review (${opts.requireSelfUrl}); ` +
          `got ${installed.length ? installed.join(", ") : "no plugin steps at all"}`,
      );
    }
  }

  sweepPlaceholders(blueprint, unsafeStrings);
  sweepUrls(blueprint, dataHosts, urlErrors);
  sweepUnsafeStrings(blueprint, unsafeStrings);
  if (stepErrors.length || urlErrors.length || unsafeStrings.length || bindErrors.length) {
    return empty;
  }
  const risky = [...new Set(riskySteps)].sort();

  const pluginSteps = steps
    .filter((s) => PLUGIN_STEPS.has(s.step))
    .map((s) => ({
      url: s.url,
      pluginType: s.step === "installTheme" ? (s.pluginType ?? "theme") : s.pluginType,
      pluginName: s.pluginName,
    }));
  return {
    stepErrors,
    urlErrors,
    unsafeStrings,
    bindErrors,
    riskySteps: risky,
    expectations: {
      stepCount: steps.length,
      stepNames: steps.map((s) => s.step),
      pluginSteps,
    },
  };
}


async function main() {
  const blueprintUrl = process.env.BLUEPRINT_URL;
  const outDir = process.env.OUT_DIR || "boot-verify-out";
  const blueprintHosts = (process.env.BLUEPRINT_HOSTS || "raw.githubusercontent.com")
    .split(",").map((h) => h.trim()).filter(Boolean);
  const dataHosts = (process.env.DATA_HOSTS || "raw.githubusercontent.com")
    .split(",").map((h) => h.trim()).filter(Boolean);
  mkdirSync(outDir, { recursive: true });

  // OUT_DIR sits inside the workspace, so a PR can commit files there. Clear
  // the WHOLE directory, not a list of known names: a name allowlist leaves
  // planted extras (screenshot.png, boot-log.txt.bak) to be uploaded beside
  // genuine evidence, and a planted *directory* with an expected name makes
  // rmSync throw so the step dies with no verdict at all.
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const reject = (errorClass, detail, sha = "") => {
    const safe = sanitiseForLog(detail);
    console.error(`preflight REJECTED (${errorClass}): ${safe}`);
    // NOTE: preflight must never write verdict.json — assert.mjs is the sole
    // writer. A pre-placed verdict.json in the workspace would otherwise be
    // read as "already decided" — a pass with no boot at all.
    //
    // `detail` is recorded so the job summary can say WHICH host or step was
    // refused. It is safe to surface for a rejection specifically: nothing
    // has booted, so the text comes from the caller's own inputs, not from
    // plugin-controlled boot output. It is sanitised and length-capped all
    // the same, and never reaches an output variable.
    writeFileSync(
      join(outDir, "preflight.json"),
      JSON.stringify(
        { outcome: "rejected", error_class: errorClass, blueprintSha256: sha, detail: safe },
        null,
        2,
      ),
    );
    process.exit(0);
  };

  // Dependencies or the browser never installed: there is nothing to gate,
  // and assert.mjs turns the marker into infra_fail. Don't fetch anything.
  if (process.env.SETUP_FAILED_FILE && existsSync(process.env.SETUP_FAILED_FILE)) {
    console.error("setup failed earlier — skipping preflight");
    return;
  }

  if (!blueprintUrl) reject("blueprint_fetch_failed", "BLUEPRINT_URL not set");
  const urlProblem = checkUrl(blueprintUrl, blueprintHosts);
  if (urlProblem) reject("blueprint_host_denied", urlProblem);

  let bytes;
  try {
    const res = await fetch(blueprintUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Redirect pinning: the FINAL url must also satisfy the allowlist.
    const finalProblem = checkUrl(res.url, blueprintHosts);
    if (finalProblem) reject("blueprint_host_denied", `after redirect: ${finalProblem}`);
    // Stream with a hard cap: any public repo can host a multi-GB file, and
    // buffering the whole body would OOM the runner.
    bytes = await readCapped(res, MAX_BLUEPRINT_BYTES);
  } catch (err) {
    reject("blueprint_fetch_failed", err.message);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  let blueprint;
  try {
    blueprint = JSON.parse(bytes.toString("utf8"));
  } catch (err) {
    reject("blueprint_fetch_failed", `not JSON: ${err.message}`, sha256);
  }

  const { stepErrors, urlErrors, unsafeStrings, bindErrors, riskySteps, expectations } =
    gateBlueprint(blueprint, dataHosts);
  if (stepErrors.length) {
    reject("blueprint_step_banned", stepErrors.join("; "), sha256);
  } else if (unsafeStrings.length) {
    reject("blueprint_unsafe_string", unsafeStrings.join("; "), sha256);
  } else if (urlErrors.length) {
    reject("blueprint_host_denied", urlErrors.join("; "), sha256);
  } else if (bindErrors.length) {
    reject("blueprint_unbindable", bindErrors.join("; "), sha256);
  }

  writeFileSync(join(outDir, "blueprint.json"), bytes);
  writeFileSync(
    join(outDir, "expectations.json"),
    JSON.stringify({ blueprintUrl, blueprintSha256: sha256, riskySteps, ...expectations }, null, 2),
  );
  writeFileSync(
    join(outDir, "preflight.json"),
    JSON.stringify(
      { outcome: "ok", error_class: "none", blueprintSha256: sha256, riskySteps },
      null,
      2,
    ),
  );
  console.log(
    `preflight OK: ${expectations.stepCount} steps ` +
    `(${expectations.pluginSteps.length} plugin/theme installs), sha256=${sha256}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
