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
  ["gate: stop recording risky steps", "scripts/preflight.mjs",
    "if (RISKY_STEPS.has(name)) riskySteps.push(name);", ""],
  ["gate: allow an unknown step name through", "scripts/preflight.mjs",
    "} else if (!ALLOWED_STEPS.has(name)) {", "} else if (false) {"],
  ["verdict: drop risky_steps from the verdict", "scripts/assert.mjs",
    "risky_steps: Array.isArray(exp.riskySteps) ? exp.riskySteps : [],", "risky_steps: [],"],
  ["summary: hide the risky-step notice", "scripts/render-summary.mjs",
    "Array.isArray(verdict.risky_steps) && verdict.risky_steps.length", "false"],
  ["comment: hide the risky-step notice", "scripts/render-comment.mjs",
    "...(riskySteps.length", "...(false"],

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
  // preview link construction — each term stops the link booting other code
  ["preview: accept a branch ref instead of a commit", "scripts/build-preview.mjs",
    "if (!SHA_RE.test(String(headSha))) {", "if (false) {"],
  ["preview: stop banning {{REF}} placeholders in string VALUES",
    "scripts/preflight.mjs",
    'if (node.includes("{{") || node.includes("}}")) {', "if (false) {"],
  ["preview: drop ALL override-param screening (host query + finished URL)", "scripts/build-preview.mjs",
    "  if (url.search || url.hash) throw new Error(`playground host must carry no query: ${playgroundHost}`);",
    "  for (const p of FORBIDDEN_PARAMS) url.searchParams.delete(p);"],
  ["preview: drop ALL playground-origin screening (scheme + userinfo + allowlist)",
    "scripts/build-preview.mjs",
    '  if (url.protocol !== "https:") throw new Error(`playground host must be https: ${playgroundHost}`);',
    "  allowedOrigins = [url.origin];"],
  ["preview: require the moodle- prefix again", "scripts/build-preview.mjs",
    "/^(?:moodle-)?([a-z][a-z0-9]*)_([a-z][a-z0-9_]*)$/",
    "/^moodle-([a-z][a-z0-9]*)_([a-z][a-z0-9_]*)$/"],
  ["preview: accept an unknown plugin type", "scripts/build-preview.mjs",
    "if (!IDENT_RE.test(type) || !Object.hasOwn(PLUGIN_TYPE_DIRS, type)) {", "if (false) {"],
  ["preview: pre-add the activity instead of the add form", "scripts/build-preview.mjs",
    "      return `/course/modedit.php?add=${name}&course=${COURSE_ID}&section=1`;",
    "      return `/course/view.php?id=${COURSE_ID}`;"],
  ["preview: stop disabling the enrolment welcome mail", "scripts/build-preview.mjs",
    '        { name: "sendcoursewelcomemessage", value: "0", plugin: "enrol_manual" },', ""],

  ["preview: let the review course fall into Miscellaneous", "scripts/build-preview.mjs",
    '      category: "Review",\n', ""],
  ["preview: drop critical:true from the plugin install", "scripts/build-preview.mjs",
    "      // clean Moodle and the reviewer concludes the plugin does nothing.\n      critical: true,",
    "      // clean Moodle and the reviewer concludes the plugin does nothing."],
  ["preview: drop the top-level landingPage", "scripts/build-preview.mjs",
    "    landingPage,\n", ""],
  ["preview: allow an underscore in an activity module name", "scripts/build-preview.mjs",
    'if (type === "mod" && name.includes("_")) {', "if (false) {"],
  ["preview: skip our own step-gate on the preview blueprint", "scripts/build-preview.mjs",
    "  assertGated(blueprint, { dataHosts, requireSelfUrl });\n", ""],
  ["preview: drop the reviewer's brief label", "scripts/build-preview.mjs",
    '    step: "addModule",\n', ""],
  ["preview: stop applying a format plugin to the course", "scripts/build-preview.mjs",
    '      ...(type === "format" ? { format: name } : {}),\n', ""],
  ["preview: send qtype back to the param-hungry question page", "scripts/build-preview.mjs",
    '      return "/admin/qtypes.php";',
    '      return `/question/bank/editquestion/question.php?courseid=${COURSE_ID}`;'],
  ["comment: drop the malformed-URL refusal", "scripts/render-comment.mjs",
    "  if (!isPostablePreviewUrl(url, allowedOrigins)) {\n    throw new Error(`refusing to post a malformed preview URL`);\n  }", ""],
  ["comment: drop the head-sha validation", "scripts/render-comment.mjs",
    "  if (!SHA_RE.test(String(headSha))) throw new Error(`bad head sha: ${headSha}`);", ""],
  ["comment: drop the plugin-name validation", "scripts/render-comment.mjs",
    "  if (!COMPONENT_RE.test(String(plugin))) throw new Error(`bad plugin: ${plugin}`);", ""],
  ["comment: keep a stale link when the build failed", "scripts/render-comment.mjs",
    "  if (!url) {", "  if (false) {"],
  ["preview: let a reload half-apply the blueprint again", "scripts/build-preview.mjs",
    '    { step: "createCategory", name: "Review", critical: true },',
    '    { step: "createCategory", name: "Review" },'],
  ["preview: drop critical from createCourse", "scripts/build-preview.mjs",
    "      shortname: COURSE_SHORTNAME,\n      critical: true,",
    "      shortname: COURSE_SHORTNAME,"],
  ["preview: accept a non-numeric pr-number into the HTML label", "scripts/build-preview.mjs",
    "  if (prNumber !== \"\" && prNumber !== undefined && !PR_NUMBER_RE.test(String(prNumber))) {",
    "  if (false) {"],
  ["preview: stop escaping the label heading", "scripts/build-preview.mjs",
    "`<p><strong>${escapeHtml(label)}</strong></p>`", "`<p><strong>${label}</strong></p>`"],
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

  // plugin-version.mjs — the Moodle-compatibility refusal. Each mutant here
  // corresponds to a preview that boots a clean Moodle with no plugin in it.
  ["compat: accept a plugin needing a newer Moodle", "scripts/plugin-version.mjs",
    "if (requires > coreVersion) {", "if (false) {"],
  ["compat: off-by-one in the version comparison", "scripts/plugin-version.mjs",
    "requires > coreVersion", "requires > coreVersion + 1"],
  ["compat: silently pass an unknown branch with no note", "scripts/plugin-version.mjs",
    'return { ok: true, reason: `unknown Moodle branch "${branch}" — compatibility not checked` };',
    "return { ok: true };"],
  ["parse: ignore $module-> style declarations", "scripts/plugin-version.mjs",
    "`\\\\$(?:plugin|module)\\\\s*->\\\\s*${field}\\\\s*=\\\\s*'?([0-9]+)(?:\\\\.[0-9]+)?'?\\\\s*;`",
    "`\\\\$plugin\\\\s*->\\\\s*${field}\\\\s*=\\\\s*([0-9]+);`"],
  ["component: stop cross-checking the declared component", "scripts/plugin-version.mjs",
    "if (component !== expected) {", "if (false) {"],

  // preflight.mjs — capability checks on allowlisted step NAMES
  ["config: allow raw-HTML site settings through setConfig", "scripts/preflight.mjs",
    'if (RAW_HTML_CONFIGS.has(String(cfg?.name ?? "").toLowerCase())) {', "if (false) {"],
  ["config: make the raw-HTML check case-sensitive", "scripts/preflight.mjs",
    'String(cfg?.name ?? "").toLowerCase()', 'String(cfg?.name ?? "")'],
  ["config: only inspect setConfig, ignoring setConfigs arrays", "scripts/preflight.mjs",
    'if (step?.step === "setConfigs" && Array.isArray(step.configs)) return step.configs;',
    "return [];"],

  // build-preview.mjs — who the reviewer arrives as, and what a link may carry
  ["login: land the reviewer as admin everywhere (bypasses capability checks)",
    "scripts/build-preview.mjs",
    'return String(landing).startsWith("/admin/") ? "admin" : "teacher";',
    'return "admin";'],
  ["login: drop critical from the login step", "scripts/build-preview.mjs",
    'steps.push({ step: "login", username: loginUser, critical: true });',
    'steps.push({ step: "login", username: loginUser });'],
  ["output: admit line terminators (allow-list -> anything)",
    "scripts/build-preview.mjs",
    "const UNSAFE_OUTPUT_RE = /[\\u0000-\\u001f\\u007f\\u2028\\u2029]/;",
    "const UNSAFE_OUTPUT_RE = /(?!)/;"],
  ["output: forget the Unicode line terminators", "scripts/build-preview.mjs",
    "const UNSAFE_OUTPUT_RE = /[\\u0000-\\u001f\\u007f\\u2028\\u2029]/;",
    "const UNSAFE_OUTPUT_RE = /[\\u0000-\\u001f]/;"],
  ["output: drop the length cap", "scripts/build-preview.mjs",
    "  if (str.length > MAX_OUTPUT_CHARS) {", "  if (false) {"],
  ["output: write preview-url FIRST again", "scripts/build-preview.mjs",
    '  setOutput("risky-steps", risky.join(","));\n  setOutput("preview-url", url);',
    '  setOutput("preview-url", url);\n  setOutput("risky-steps", risky.join(","));'],
  ["url: allow runtime-override params to re-aim the Moodle version",
    "scripts/build-preview.mjs",
    '  "moodle", "moodleBranch", "php", "phpVersion",\n', ""],
  ["url: allow the proxy params, re-aiming the preview's network",
    "scripts/build-preview.mjs",
    '  "addonProxyUrl", "phpCorsProxyUrl",\n', ""],
  ["landing: send tiny subplugins back to the generic plugin list",
    "scripts/build-preview.mjs",
    'return "/admin/settings.php?section=editorsettingstiny";',
    'return "/admin/plugins.php";'],

  // render-comment.mjs — the last gate before a link is posted as the bot
  ["comment: post any URL that parses", "scripts/render-comment.mjs",
    "if (!isPostablePreviewUrl(url, allowedOrigins)) {", "if (false) {"],
  ["comment: drop the origin allowlist", "scripts/render-comment.mjs",
    "if (!allowedOrigins.includes(url.origin)) return false;", ""],
  ["comment: allow extra query params alongside the blueprint",
    "scripts/render-comment.mjs",
    'if (keys.length !== 1 || keys[0] !== "blueprint") return false;', ""],
  ["comment: allow userinfo in the posted link", "scripts/render-comment.mjs",
    "if (url.username || url.password) return false;", ""],

  // preflight.mjs — the commit under review must actually be installed
  ["self: accept a blueprint that never installs this commit", "scripts/preflight.mjs",
    "if (!installed.includes(opts.requireSelfUrl)) {", "if (false) {"],
  ["duplicate: allow two plugin steps to share a target directory",
    "scripts/preflight.mjs",
    "    if (targets.has(key)) {", "    if (false) {"],
  // Was: 'ignore installTheme's implied type'. That mutant targeted the old
  // `step.pluginType ?? "theme"` default. 1c FORCES "theme" here, and the
  // replacement mutant is "1c: honour installTheme's declared pluginType
  // again", which restores exactly the line Sandy broke.
  ["evidence: count extractions without requiring them distinct",
    "scripts/assert.mjs",
    "    new Set(parsed.extractions).size === parsed.extractions.length,", "    true,"],
  ["verdict: drop the installed archive URLs", "scripts/assert.mjs",
    "    plugin_sources: Array.isArray(exp.pluginSteps)\n      ? exp.pluginSteps.map((pl) => pl.url).filter((u) => typeof u === \"string\")\n      : [],",
    "    plugin_sources: [],"],
  ["self: only check the FIRST plugin step", "scripts/preflight.mjs",
    "const installed = steps\n      .filter((s) => PLUGIN_STEPS.has(s?.step))\n      .map((s) => s?.url);",
    "const installed = [steps.find((s) => PLUGIN_STEPS.has(s?.step))?.url];"],
  ["php: accept a PHP the branch does not offer (playground substitutes 8.3)",
    "scripts/build-preview.mjs",
    "  if (!allowed.includes(php)) {", "  if (false) {"],
  ["php: ignore the override and always use the branch default",
    "scripts/build-preview.mjs",
    "php: phpOverride || phpForBranch(moodleBranch)", "php: phpForBranch(moodleBranch)"],
  ["counts: ignore the student count", "scripts/build-preview.mjs",
    "...studentNames(students).map((u, i) => ({", "...studentNames(1).map((u, i) => ({"],
  ["counts: enrol only the first student", "scripts/build-preview.mjs",
    "        ...studentNames(students).map((u) => ({\n          username: u,\n          course: COURSE_SHORTNAME,\n          role: \"student\",\n        })),",
    '        { username: "student1", course: COURSE_SHORTNAME, role: "student" },'],
  ["counts: ignore the section count", "scripts/build-preview.mjs",
    "numsections: sections,", "numsections: 3,"],
  ["login: ignore the login-as override", "scripts/build-preview.mjs",
    "const loginUser = loginAs || previewUser(landing);", "const loginUser = previewUser(landing);"],
  ["counts: drop the clamp on studentNames", "scripts/build-preview.mjs",
    "Math.max(1, Math.min(20, Number(n) || 1))", "Number(n) || 1"],
  ["landing: skip validating the override entirely", "scripts/build-preview.mjs",
    "    const ok = checkLandingPath(landingOverride);\n    if (!ok.ok) {", "    const ok = { ok: true };\n    if (false) {"],
  ["landing: allow a traversal segment (walks out of the site)",
    "scripts/build-preview.mjs",
    "    if (TRAVERSAL_SEGMENT.test(seg)) {\n      return { ok: false, reason: `contains a \"${seg}\" segment, which walks out of the site` };\n    }",
    "    if (false) {\n      return { ok: false, reason: \"\" };\n    }"],
  ["landing: stop decoding before checking segments", "scripts/build-preview.mjs",
    "  if (decoded !== path) {", "  if (false) {"],
  ["landing: allow a protocol-relative path", "scripts/build-preview.mjs",
    '  if (v.startsWith("//")) {', "  if (false) {"],
  ["provenance: drop built-by from the review course name",
    "scripts/build-preview.mjs",
    "    builtBy || null,\n", ""],
  ["provenance: accept any text in built-by", "scripts/build-preview.mjs",
    "if (builtBy && !BUILT_BY_RE.test(builtBy)) {", "if (false) {"],
  ["parse: take the FIRST assignment, so a commented-out decoy wins",
    "scripts/plugin-version.mjs",
    "return all.length ? Number(all[all.length - 1][1]) : null;",
    "return all.length ? Number(all[0][1]) : null;"],
  ["parse: stop blanking comments", "scripts/plugin-version.mjs",
    "  const code = blankComments(text);", "  const code = text;"],
  ["parse: treat an unreadable assignment as absent", "scripts/plugin-version.mjs",
    "    if (value === null && assignmentsOf(code, field).length > 0) {", "    if (false) {"],
  ["parse: mistake a URL in a string for a comment", "scripts/plugin-version.mjs",
    '    if (c === "\'" || c === \'"\') {', "    if (false) {"],
  ["version: silently truncate an oversized version.php",
    "scripts/plugin-version.mjs",
    "  if (src.length > MAX_VERSION_PHP_BYTES) {", "  if (false) {"],
  ["compat: ignore $plugin->incompatible", "scripts/plugin-version.mjs",
    "  if (incompatible != null) {", "  if (false) {"],
  ["compat: off-by-one on the incompatible branch comparison",
    "scripts/plugin-version.mjs",
    "branchNumber >= incompatible", "branchNumber > incompatible"],
  ["main: continue on a version.php we could not parse",
    "scripts/build-preview.mjs",
    "  if (declared && declared.ok === false) {", "  if (false) {"],
  ["counts: report the raw input instead of the clamped value",
    "scripts/build-preview.mjs",
    "  const clamped = Math.max(min, Math.min(max, Math.trunc(n)));", "  const clamped = n;"],
  ["fetch: paste an absolute plugin-root into the URL (404s, silent no-op)",
    "scripts/plugin-version.mjs",
    'rel === "." || rel === "" || rel.startsWith("/") || /^[A-Za-z]:/.test(rel)',
    'rel === "."'],
  ["fetch: accept an HTML 404 page as a version.php", "scripts/plugin-version.mjs",
    "if (parsed.component == null && parsed.version == null && parsed.requires == null) return null;",
    ""],
  ["fetch: drop the repo/sha shape check before requesting",
    "scripts/plugin-version.mjs",
    'if (!/^[\\w.-]+\\/[\\w.-]+$/.test(String(headRepo)) || !/^[0-9a-f]{40}$/.test(String(headSha))) {',
    "if (false) {"],
  ["branch: pin the blueprint to a literal, not the checked branch",
    "scripts/build-preview.mjs",
    "moodle: moodleBranch },", 'moodle: "MOODLE_500_STABLE" },'],
  ["branch: default buildBlueprint to a literal instead of the shared constant",
    "scripts/build-preview.mjs",
    "  moodleBranch = DEFAULT_MOODLE_BRANCH,", '  moodleBranch = "MOODLE_404_STABLE",'],
  ["placeholders: stop sweeping foreign blueprints", "scripts/preflight.mjs",
    "  sweepPlaceholders(blueprint, unsafeStrings);\n", ""],
  ["placeholders: ignore them in object keys", "scripts/preflight.mjs",
    '      if (k.includes("{{") || k.includes("}}")) {', "      if (false) {"],
  ["hosts: ignore the configured data-hosts and always use the default",
    "scripts/build-preview.mjs",
    "const hosts = dataHosts.length ? dataHosts : DEFAULT_DATA_HOSTS;",
    "const hosts = DEFAULT_DATA_HOSTS;"],
  ["identity: ignore version.php, trust the repository name", "scripts/build-preview.mjs",
    "if ((!type || !name) && overrides.component) {", "if (false) {"],
  // 1e: the (default) sentinel and collect-all-errors
  ["1e: sentinel stops resolving to unset", "scripts/build-preview.mjs",
    'return v === DEFAULT_SENTINEL ? "" : v;', "return v;"],
  ["1e: sentinel swallows real values too", "scripts/build-preview.mjs",
    'return v === DEFAULT_SENTINEL ? "" : v;', 'return "";'],
  ["1e: sentinel is not trimmed before comparison", "scripts/build-preview.mjs",
    'const v = String(value ?? "").trim();', 'const v = String(value ?? "");'],
  ["1e: collect-all stops collecting failed verdicts", "scripts/build-preview.mjs",
    "if (verdict && verdict.ok === false) this.add(input, verdict.reason);", ""],
  ["1e: collect-all treats passing verdicts as failures", "scripts/build-preview.mjs",
    "if (verdict && verdict.ok === false) this.add(input, verdict.reason);",
    "if (verdict) this.add(input, verdict.reason);"],
  ["1e: problems are never thrown", "scripts/build-preview.mjs",
    "    problems.annotate();\n    throw problems.toError();", ""],
  ["1e: no annotation is emitted", "scripts/build-preview.mjs",
    "    problems.annotate();\n    throw problems.toError();",
    "    throw problems.toError();"],
  ["1e: annotation keeps embedded newlines", "scripts/build-preview.mjs",
    'sanitiseForLog(message).replace(/\\r?\\n/g, " ")', "sanitiseForLog(message)"],
  ["1e: annotation drops the input name", "scripts/build-preview.mjs",
    "`::error title=${sanitiseForLog(input)}::", "`::error::${\"\"}${"],
  ["1e: the refusal summary stops listing the inputs", "scripts/build-preview.mjs",
    "  const problemRows = problems.length", "  const problemRows = false"],
  ["1e: php-version failure no longer registers", "scripts/build-preview.mjs",
    'problems.check("php-version", phpOk);', ""],
  ["1e: landing-path failure no longer registers", "scripts/build-preview.mjs",
    'problems.add("landing-path", `${ok.reason}: ${JSON.stringify(landingOverride)}`);', ""],

  // Step 2: the .mbz reader
  ["mbz: accept an activity backup as a course", "scripts/mbz.mjs",
    'if (info.type !== "course") {', "if (false) {"],
  ["mbz: accept a course backup with no activities", "scripts/mbz.mjs",
    "if (!info.activityCount) {", "if (false) {"],
  ["mbz: count every <activity> tag again, leaf refs included", "scripts/mbz.mjs",
    "const activityCount = allModulenames.length;",
    "const activityCount = (xml.match(/<activity>/g) || []).length;"],
  ["mbz: stop de-duplicating module names", "scripts/mbz.mjs",
    "const modulenames = [...new Set(allModulenames)].sort();",
    "const modulenames = allModulenames;"],
  ["mbz: treat anything as an archive", "scripts/mbz.mjs",
    "    } else {\n      // A 404 page, an HTML error, an LFS pointer — all plausible at a URL.",
    "    } else if (false) {\n      // A 404 page, an HTML error, an LFS pointer — all plausible at a URL."],
  ["mbz: drop the tar size sanity check", "scripts/mbz.mjs",
    "if (!Number.isFinite(size) || size < 0) {", "if (false) {"],
  ["mbz: stop reporting what actually arrived", "scripts/mbz.mjs",
    'const head = bytes.subarray(0, 16).toString("utf8").replace(/[^\\x20-\\x7e]/g, ".");',
    'const head = "";'],
  ["mbz: zip reader ignores STORED entries", "scripts/mbz.mjs",
    "if (method === 0) return raw;", ""],
  ["mbz: missing manifest is not an error", "scripts/mbz.mjs",
    "  if (!manifest) {", "  if (false) {"],

  // Review round 2 (2026-08-08)
  ["rev2: foreign blueprint path stops passing the core list", "scripts/build-blueprint-preview.mjs",
    "    { coreComponents: core },\n", ""],
  ["rev2: verify half stops passing the core list", "scripts/preflight.mjs",
    "gateBlueprint(blueprint, dataHosts, { coreComponents: core });",
    "gateBlueprint(blueprint, dataHosts);"],
  ["rev2: message-less failures are dropped again", "scripts/build-preview.mjs",
    'this.list.push({ input, message: message || "refused, but the check gave no reason" });',
    "if (message) this.list.push({ input, message });"],
  ["rev2: table cells stop escaping pipes", "scripts/build-preview.mjs",
    'sanitiseForLog(String(v)).replace(/\\|/g, "\\\\|")', "sanitiseForLog(String(v))"],
  ["rev2: login-as reports the count error on a bad name too", "scripts/build-preview.mjs",
    "if (loginAsNameOk && loginAs.startsWith(\"student\")", 'if (loginAs.startsWith("student")'],
  ["rev2: reference waiver slides back below the checks", "scripts/order-rules.mjs",
    "    if (i > opaqueFrom) continue;\n\n", ""],

  // Review fixes (2026-08-08)
  ["rev: allow anything before installMoodle again", "scripts/order-rules.mjs",
    '    except: ["restoreDatabase"],\n    why: "nothing exists before Moodle is installed",',
    '    why: "nothing exists before Moodle is installed",'],
  ["rev: stop checking addModule names a real module", "scripts/order-rules.mjs",
    "      if (!isCore && !mods.has(step.module)) {", "      if (false) {"],
  ["rev: treat every module as core", "scripts/order-rules.mjs",
    "const isCore = coreComponents.standard.has(`mod_${step.module}`);", "const isCore = true;"],
  ["rev: forget mods installed by an earlier step", "scripts/order-rules.mjs",
    'if (name === "installMoodlePlugin" && step.pluginType === "mod") mods.add(step.pluginName);', ""],
  ["rev: stop catching the late welcome-message config", "scripts/order-rules.mjs",
    'if (c?.name === "sendcoursewelcomemessage") {', "if (false) {"],
  ["rev: flag the welcome message even before any course", "scripts/order-rules.mjs",
    '(name === "setConfig" || name === "setConfigs") && coursesCreatedAt >= 0',
    '(name === "setConfig" || name === "setConfigs")'],
  ["rev: expectations honour installTheme's declared type again", "scripts/preflight.mjs",
    'pluginType: s.step === "installTheme" ? "theme" : s.pluginType,',
    'pluginType: s.step === "installTheme" ? (s.pluginType ?? "theme") : s.pluginType,'],
  ["rev: identifier check honours installTheme's declared type again", "scripts/preflight.mjs",
    '      const type = name === "installTheme" ? "theme" : step.pluginType;',
    '      const type = name === "installTheme" ? (step.pluginType ?? "theme") : step.pluginType;'],
  ["rev: free-text landing-path swallows the sentinel again", "scripts/build-preview.mjs",
    '  const landingOverride = (process.env.LANDING_PATH || "").trim();',
    "  const landingOverride = opt(process.env.LANDING_PATH);"],

  // 1b: referential integrity
  ["1b: forget that installMoodle creates the admin", "scripts/order-rules.mjs",
    'if (name === "installMoodle") users.add(step.username || "admin");', ""],
  ["1b: honour a renamed admin no longer", "scripts/order-rules.mjs",
    'users.add(step.username || "admin");', 'users.add("admin");'],
  ["1b: forget themes installed via installMoodlePlugin", "scripts/order-rules.mjs",
    'if (name === "installMoodlePlugin" && step.pluginType === "theme") themes.add(step.pluginName);', ""],
  ["1b: refuse a core theme that needs no install", "scripts/order-rules.mjs",
    "const isCore = coreComponents?.ok && coreComponents.standard.has(`theme_${step.name}`);",
    "const isCore = false;"],
  ["1b: guess at themes when the core list failed to load", "scripts/order-rules.mjs",
    "if (!isCore && !themes.has(step.name) && coreComponents?.ok) {",
    "if (!isCore && !themes.has(step.name)) {"],
  ["1b: stop waiving references after a restore", "scripts/order-rules.mjs",
    "if (i > opaqueFrom) continue;", ""],
  ["1b: waive references BEFORE the restore too", "scripts/order-rules.mjs",
    "let opaqueFrom = steps.findIndex((s) => OPAQUE_SOURCES.has(s?.step));",
    "let opaqueFrom = -1;"],
  ["1b: stop checking login usernames", "scripts/order-rules.mjs",
    'if (name === "login" && step.username && !users.has(step.username)) {', "if (false) {"],
  ["1b: stop checking enrolment courses", "scripts/order-rules.mjs",
    "if (e?.course && !courses.has(e.course)) {", "if (false) {"],
  ["1b: stop checking enrolment usernames", "scripts/order-rules.mjs",
    "if (e?.username && !users.has(e.username)) {", "if (false) {"],
  // The ordering engine itself. Per-RULE mutants are generated below.
  ["1b: ordering check reports nothing", "scripts/order-rules.mjs",
    "  const names = steps.map((s) => s?.step);\n  const errors = [];",
    "  const names = [];\n  const errors = [];"],
  ["1b: gate stops consuming the ordering rules", "scripts/preflight.mjs",
    "bindErrors.push(...checkOrder(steps));", ""],
  ["1b: gate stops consuming the reference rules", "scripts/preflight.mjs",
    "bindErrors.push(...checkReferences(steps, opts.coreComponents));", ""],
  ["1b: wildcard ignores its except list", "scripts/order-rules.mjs",
    "const except = new Set(rule.except || []);", "const except = new Set();"],
  ["1b: restoreDatabase is no longer reported as risky", "scripts/preflight.mjs",
    '  "restoreDatabase", "restoreCourse",\n  "runPhpCode"', '  "runPhpCode"'],

  // 1c: the bundle's own plugins as collision targets
  ["1c: gate stops refusing core components", "scripts/preflight.mjs",
    "if (!core.ok) bindErrors.push(`step[${i}] ${step.step}: ${core.reason}`);", ""],
  ["1c: gate ignores the core list entirely", "scripts/preflight.mjs",
    "if (opts.coreComponents) {", "if (false) {"],
  ["1c: allow installing over a core component", "scripts/plugin-version.mjs",
    "if (core.standard.has(component)) {", "if (false) {"],
  ["1c: allow a plugin type core deleted", "scripts/plugin-version.mjs",
    "if (core.removedTypes.has(String(type))) {", "if (false) {"],
  // Sandy's divergence: the handler always installs to theme/, so honouring a
  // supplied pluginType lets a step evade both the collision map and the core
  // list while still landing on theme_boost.
  ["1c: honour installTheme's declared pluginType again", "scripts/preflight.mjs",
    'const type = step.step === "installTheme" ? "theme" : step.pluginType;',
    'const type = step.step === "installTheme" ? (step.pluginType ?? "theme") : step.pluginType;'],
  // A failed fetch must fail OPEN but be reported; treating it as a pass-with-
  // empty-set would silently disable the check for every branch.
  ["1c: treat a failed core fetch as an empty core", "scripts/plugin-version.mjs",
    "if (!core?.ok) return { ok: true };", "if (false) return { ok: true };"],
  ["1c: accept an empty standard list as success", "scripts/plugin-version.mjs",
    "result = standard.size", "result = true"],
  ["1c: drop the branch-name check before fetching", "scripts/plugin-version.mjs",
    'if (!/^[A-Za-z0-9_]+$/.test(key)) {', "if (false) {"],
  // NOT mutated individually: the builder's own checkNotCoreComponent call is
  // deliberately redundant with the gate's. Measured 2026-08-07 by deleting it
  // and running the builder with PLUGIN_COMPONENT=mod_assign — the gate still
  // refused, only with the less direct "a blueprint our own gate rejects"
  // wording. Per the redundant-guard policy above, mutating it alone would
  // demand a test for redundancy rather than for behaviour. The gate side is
  // covered by "1c: gate stops refusing core components".
];

// One mutation per ORDER_RULES entry, sliced out of the source file: deleting
// any single rule must break a test, or that rule is decoration. Generated
// rather than hand-listed so a rule added later cannot arrive without a
// mutant. (The per-rule TESTS are hand-written for the opposite reason — a
// generated test would vanish along with the rule it covers.)
const ORDER_SRC = readFileSync(join(ROOT, "scripts/order-rules.mjs"), "utf8");
for (const block of ORDER_SRC.match(/ {2}\{\n {4}id: "[^"]+",[\s\S]*?\n {2}\},\n/g) || []) {
  const id = /id: "([^"]+)"/.exec(block)[1];
  MUTATIONS.push([`1b: drop ordering rule ${id}`, "scripts/order-rules.mjs", block, ""]);
}

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
        "test/pipeline.test.mjs", "test/contract.test.mjs",
        "test/build-preview.test.mjs", "test/preview-snapshot.test.mjs",
        "test/render-comment.test.mjs", "test/plugin-version.test.mjs"], {
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
