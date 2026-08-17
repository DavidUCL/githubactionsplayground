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
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
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

  ["preview: let the RESTORED course fall into Miscellaneous", "scripts/build-preview.mjs",
    '          shortname: COURSE_SHORTNAME,\n          category: "Review",\n          critical: true,\n        }\n      : {',
    '          shortname: COURSE_SHORTNAME,\n          critical: true,\n        }\n      : {'],
  ["preview: let the CREATED course fall into Miscellaneous", "scripts/build-preview.mjs",
    '          category: "Review",\n          // ALWAYS emitted', "          // ALWAYS emitted"],
  ["preview: drop critical:true from the plugin install", "scripts/build-preview.mjs",
    "      pluginName: p.pluginName,\n      critical: true,", "      pluginName: p.pluginName,"],
  ["preview: build a link whose install list lost the commit under review", "scripts/build-preview.mjs",
    "if (!pluginInstalls.some((p) => p.url === selfUrl)) {", "if (false) {"],
  ["preview: drop the top-level landingPage", "scripts/build-preview.mjs",
    "    landingPage,\n", ""],
  ["preview: allow an underscore in an activity module name", "scripts/build-preview.mjs",
    'if (type === "mod" && name.includes("_")) {', "if (false) {"],
  ["preview: skip our own step-gate on the preview blueprint", "scripts/build-preview.mjs",
    "  assertGated(blueprint, { dataHosts, requireSelfUrl });\n", ""],
  ["preview: drop the reviewer's brief label", "scripts/build-preview.mjs",
    '    step: "addModule",\n', ""],
  // NAMED FOR WHAT IT DOES: the course keeps its format, the ASSERTION checks a
  // different one, so the boot fails at exit 41 on a correct preview. The
  // course-side branch moved into activeFormat and has its own mutant above.
  ["format: assert a different format from the one the course was created in",
    "scripts/build-preview.mjs",
    "buildCourseAssertion({ format: activeFormat, shortname: COURSE_SHORTNAME })",
    "buildCourseAssertion({ format: DEFAULT_COURSE_FORMAT, shortname: COURSE_SHORTNAME })"],
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
    "          shortname: COURSE_SHORTNAME,\n          critical: true,\n          // Without this",
    "          shortname: COURSE_SHORTNAME,\n          // Without this"],
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
    '  if (String(landing).startsWith("/admin/")) return "admin";',
    '  if (true) return "admin";'],
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
    "preferredVersions: { php: phpOverride || phpForBranch(moodleBranch), moodle: moodleBranch }",
    "preferredVersions: { php: phpForBranch(moodleBranch), moodle: moodleBranch }"],
  ["counts: ignore the student count", "scripts/build-preview.mjs",
    "...studentNames(students).map((u, i) => ({", "...studentNames(1).map((u, i) => ({"],
  ["counts: enrol only the first student", "scripts/build-preview.mjs",
    "        ...studentNames(students).map((u) => ({\n          username: u,\n          course: COURSE_SHORTNAME,\n          role: \"student\",\n        })),",
    '        { username: "student1", course: COURSE_SHORTNAME, role: "student" },'],
  ["counts: ignore the section count", "scripts/build-preview.mjs",
    "numsections: sections,", "numsections: 3,"],
  ["login: ignore the login-as override", "scripts/build-preview.mjs",
    "const loginUser = loginAs || previewUser(landing, teachers);",
    "const loginUser = previewUser(landing, teachers);"],
  ["counts: drop the clamp on studentNames", "scripts/build-preview.mjs",
    "  const count = Math.max(min, Math.min(max, Number(n) || min));\n  return Array.from({ length: count }, (_, i) => `student${i + 1}`);",
    "  const count = Number(n) || min;\n  return Array.from({ length: count }, (_, i) => `student${i + 1}`);"],
  // [1, 30], not [1, 20] — a literal that AGREES with the table is behaviourally
  // identical and no test could ever kill it, which would have made this a
  // permanent KNOWN_SURVIVOR bought for nothing.
  ["counts: read the student bounds from a literal again", "scripts/build-preview.mjs",
    "  const { min, max } = COUNT_INPUTS.students;", "  const [min, max] = [1, 30];"],
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
    "  const clamped = Math.max(min, Math.min(max, truncated));", "  const clamped = n;"],
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
  // NOT mutated: the newline strip in annotate() is redundant — sanitiseForLog
  // already removes newlines (measured: "line one\nline two" -> "line one line
  // two"). Kept as defence in depth against that shared helper changing, but a
  // mutant here only proves the redundancy.
  ["1e: annotation drops the input name", "scripts/build-preview.mjs",
    "`::error title=${sanitiseForLog(input)}::", "`::error::${\"\"}${"],
  ["1e: the refusal summary stops listing the inputs", "scripts/build-preview.mjs",
    "  const problemRows = problems.length", "  const problemRows = false"],
  ["1e: php-version failure no longer registers", "scripts/build-preview.mjs",
    'problems.check("php-version", phpOk);', ""],
  ["1e: landing-path failure no longer registers", "scripts/build-preview.mjs",
    'problems.add("landing-path", `${ok.reason}: ${JSON.stringify(landingOverride)}`);', ""],

  ["restore: allow a backup whose users collide with ours", "scripts/build-preview.mjs",
    "              if (clash.length) {", "              if (false) {"],
  ["restore: only look for a collision with admin", "scripts/build-preview.mjs",
    "const mine = accountNames(COUNT_INPUTS.students.max, COUNT_INPUTS.teachers.max);",
    'const mine = ["admin"];'],
  // The one count table, and the one account list derived from it. Both
  // replaced hand-copies that nothing compared, so both need mutants or the
  // duplication would simply come back unnoticed.
  ["counts: let the action.yml default and the JS fallback disagree",
    "scripts/build-preview.mjs",
    'students: { env: "STUDENTS", fallback: 1, min: 1, max: 20 },',
    'students: { env: "STUDENTS", fallback: 0, min: 0, max: 20 },'],
  ["accounts: forget the teachers in the account list", "scripts/build-preview.mjs",
    'return ["admin", ...teacherNames(teachers), ...studentNames(students)];',
    'return ["admin", ...studentNames(students)];'],
  ["accounts: name the first teacher teacher1 (breaks every shared link)",
    "scripts/build-preview.mjs",
    'return Array.from({ length: count }, (_, i) => (i === 0 ? "teacher" : `teacher${i + 1}`));',
    'return Array.from({ length: count }, (_, i) => `teacher${i + 1}`);'],
  ["counts: echo the raw value into the runner log", "scripts/build-preview.mjs",
    'console.log(`note: ${JSON.stringify(sanitiseForLog(s).slice(0, 40))} is not a number — using ${fallback}`);',
    'console.log(`note: "${s}" is not a number — using ${fallback}`);'],
  // --- the teachers control ---
  ["teachers: ignore the count and always build one", "scripts/build-preview.mjs",
    "        ...teacherNames(teachers).map((u, i) => ({",
    "        ...teacherNames(1).map((u, i) => ({"],
  ["teachers: enrol only the first teacher", "scripts/build-preview.mjs",
    '        ...teacherNames(teachers).map((u) => ({\n          username: u,\n          course: COURSE_SHORTNAME,\n          role: "editingteacher",\n        })),',
    '        { username: "teacher", course: COURSE_SHORTNAME, role: "editingteacher" },'],
  ["teachers: make the second teacher non-editing", "scripts/build-preview.mjs",
    '          role: "editingteacher",\n        })),',
    '          role: u === "teacher" ? "editingteacher" : "teacher",\n        })),'],
  // NAMED FOR WHAT IT DOES. It was called "append after the students" while
  // replacing the list with [], which DELETES them — the same bug as "ignore
  // the count" above, so the list claimed coverage of the ordering decision it
  // did not have. The genuine append is covered by the unit test asserting the
  // full roster order, and by the probe row; this pins the order WITHIN the
  // teachers, which is what decides whether users[1] is teacher2.
  ["teachers: reorder the teachers within the roster",
    "scripts/build-preview.mjs",
    "        ...teacherNames(teachers).map((u, i) => ({\n          username: u,\n          firstname: \"Teacher\",",
    "        ...teacherNames(teachers).slice().reverse().map((u, i) => ({\n          username: u,\n          firstname: \"Teacher\","],
  ["teachers: keep sending the reviewer to a teacher that does not exist",
    "scripts/build-preview.mjs",
    "  if (Number(teachers) === 0) return \"admin\";", "  if (false) return \"admin\";"],
  ["teachers: drop the count when deriving the login", "scripts/build-preview.mjs",
    "  const loginUser = loginAs || previewUser(landing, teachers);",
    "  const loginUser = loginAs || previewUser(landing);"],
  ["teachers: hardcode the review brief's logins again", "scripts/build-preview.mjs",
    '      `<ul><li>Logins: ${roster.map((u) => `<code>${escapeHtml(u)}</code>`).join(", ")}` +',
    '      `<ul><li>Logins: <code>admin</code>, <code>teacher</code>, <code>student1</code>` +'],
  ["teachers: drop the no-teacher caveat from the review brief", "scripts/build-preview.mjs",
    '      (teachers === 0 && loginUser === "admin"', "      (false"],
  ["teachers: warn about admin on every preview whose landing needs one",
    "scripts/build-preview.mjs",
    '    ...(teachers === 0 && signedInAs === "admin"', '    ...(signedInAs === "admin"'],
  ["teachers: stop refusing a login the counts cannot create", "scripts/build-preview.mjs",
    '  if (loginAs.startsWith("teacher") && !teacherNames(teachers).includes(loginAs)) {',
    "  if (false) {"],
  ["teachers: stop refusing a student login the count cannot create",
    "scripts/build-preview.mjs",
    '  if (loginAs.startsWith("student") && !studentNames(students).includes(loginAs)) {',
    "  if (false) {"],
  ["teachers: leave the count out of the summary", "scripts/build-preview.mjs",
    "        : `${teachers} teacher(s), ${students} student(s), ${sections} section(s), ` +\n          `${courseFormat} format`,",
    "        : `${students} student(s), ${sections} section(s), ` +\n          `${courseFormat} format`,"],
  ["teachers: let the summary name a different account from the link",
    "scripts/build-preview.mjs",
    '  const login = blueprint.steps.find((s) => s.step === "login");',
    '  const login = { username: "teacher" };'],
  ["comment: enumerate accounts that may not exist", "scripts/render-comment.mjs",
    "`The link logs you in as **\\`${user}\\`**. The review brief on the course`,",
    "`The link logs you in as **\\`${user}\\`**. \\`admin\\`, \\`teacher\\` and \\`student1\\` all exist,`,"],
  ["comment: drop the admin caveat again", "scripts/render-comment.mjs",
    '    ...(user === "admin"\n      ? [', '    ...(false\n      ? ['],
  // --- the course-format control ---
  ["format: stop stating the format in the blueprint", "scripts/build-preview.mjs",
    "          format: activeFormat,", ""],
  ["format: ignore the box and always use the default", "scripts/build-preview.mjs",
    '  const activeFormat = courseFormat || (type === "format" ? name : DEFAULT_COURSE_FORMAT);',
    "  const activeFormat = DEFAULT_COURSE_FORMAT;"],
  ["format: stop letting a format plugin preview itself", "scripts/build-preview.mjs",
    '  const activeFormat = courseFormat || (type === "format" ? name : DEFAULT_COURSE_FORMAT);',
    "  const activeFormat = courseFormat || DEFAULT_COURSE_FORMAT;"],
  ["format: drop the assertion entirely", "scripts/build-preview.mjs",
    "    ...(!restore && activeFormat !== DEFAULT_COURSE_FORMAT\n      ? [buildCourseAssertion({ format: activeFormat, shortname: COURSE_SHORTNAME })]\n      : []),",
    ""],
  ["format: emit the assertion even at the default (inert)", "scripts/build-preview.mjs",
    "    ...(!restore && activeFormat !== DEFAULT_COURSE_FORMAT",
    "    ...(!restore"],
  // THE mutant for this control. Reading the column back is the assertion
  // everyone writes first, and it passes in BOTH the working and the broken
  // case because Moodle stores the bogus value verbatim.
  ["format: assert on the DB column instead of the resolved format",
    "scripts/course-assert.mjs",
    "    try { $got = course_get_format($c)->get_format(); }\n    catch (Throwable $e) { exit(44); }",
    "    $got = $c->format;"],
  // Protects LIVE 8b's measurement: 8b asserts 41 SPECIFICALLY, and 41-not-43
  // is what records that the column keeps the bogus value.
  ["format: collapse exit 43 into 41", "scripts/course-assert.mjs",
    "    exit($c->format === $want ? 41 : 43);", "    exit(41);"],
  ["format: stop fixing the 1970 start date", "scripts/course-assert.mjs",
    "      $DB->set_field('course', 'startdate', usergetmidnight(time()), array('id' => $c->id));", ""],
  ["format: build an assertion from an untrusted name", "scripts/course-assert.mjs",
    "  if (!FORMAT_NAME.test(String(format))) {", "  if (false) {"],
  ["format: let the course be missing and still pass", "scripts/course-assert.mjs",
    "    if (!$c) { exit(42); }", ""],
  ["format: accept a format Moodle would silently ignore", "scripts/build-preview.mjs",
    "  if (!COURSE_FORMATS.includes(courseFormat)) {", "  if (false) {"],
  ["format: allow the box to override a format plugin under review",
    "scripts/build-preview.mjs",
    '  if (type === "format") {', "  if (false) {"],
  ["format: silently drop the box alongside a restore", "scripts/build-preview.mjs",
    "  if (restoreUrl) {\n    reasons.push(", "  if (false) {\n    reasons.push("],
  ["format: send singleactivity to the page it redirects away from",
    "scripts/build-preview.mjs",
    '    fmt === "singleactivity"\n      ? `/course/view.php?id=${COURSE_ID}&section=1`\n      : `/course/view.php?id=${COURSE_ID}`;',
    "    `/course/view.php?id=${COURSE_ID}`;"],
  ["format: leave the format out of the summary", "scripts/build-preview.mjs",
    "        : `${teachers} teacher(s), ${students} student(s), ${sections} section(s), ` +\n          `${courseFormat} format`,",
    "        : `${teachers} teacher(s), ${students} student(s), ${sections} section(s)`,"],
  ["format: drop the singleactivity caveat", "scripts/build-preview.mjs",
    '    ...(courseFormat === "singleactivity"', "    ...(false"],
  // --- the language-packs control ---
  ["lang: drop the assertion, leaving a step that cannot fail",
    "scripts/build-preview.mjs",
    "          buildLangAssertion({ codes: languagePacks }),\n", ""],
  ["lang: install the packs but never select one", "scripts/build-preview.mjs",
    "            setDefault: true,", "            setDefault: false,"],
  ["lang: install after the users are made (they stay English)",
    "scripts/build-preview.mjs",
    "    ...(languagePacks.length\n      ? [\n          {\n            step: \"installLanguagePack\",",
    "    ...(false\n      ? [\n          {\n            step: \"installLanguagePack\","],
  // THE mutant for this control: the check everyone reaches for first, which
  // reports success for an empty directory because English is loaded before the
  // language is overlaid.
  ["lang: use translation_exists, which an empty directory satisfies",
    "scripts/lang-assert.mjs",
    "      if (!is_file($dir . '/langconfig.php')) { error_log('langpack: missing ' . $c); exit(51); }\n      $name = $sm->get_string('thislanguage', 'langconfig', null, $c);",
    "      if (!$sm->translation_exists($c)) { error_log('langpack: missing ' . $c); exit(51); }\n      $name = 'x';"],
  ["lang: accept an English fallback as a real translation", "scripts/lang-assert.mjs",
    "      if ($name === 'English') { error_log('langpack: english fallback for ' . $c); exit(51); }\n", ""],
  ["lang: check the site language before the packs exist", "scripts/lang-assert.mjs",
    "    $lang = $CFG->lang ?? 'en';", "    $lang = $CFG->lang ?? 'en'; if ($lang !== '${want}') { exit(52); }"],
  ["lang: stop checking the site language at all", "scripts/lang-assert.mjs",
    "    if ($lang !== '${want}') { exit(52); }\n", ""],
  ["lang: silently drop a malformed code instead of refusing", "scripts/lang-assert.mjs",
    "      problems.push(\n        `${JSON.stringify(code)} is not a Moodle language code. They are lower case `", "      codes.push(code); problems.push(\n        ``"],
  ["lang: allow en, which fails the assertion on a healthy site",
    "scripts/lang-assert.mjs",
    '    if (code === "en") {', "    if (false) {"],
  ["lang: drop the cap on how many packs a preview downloads",
    "scripts/lang-assert.mjs",
    "  if (codes.length > MAX_LANGUAGE_PACKS) {", "  if (false) {"],
  ["lang: build an assertion from an untrusted code", "scripts/lang-assert.mjs",
    "    if (!LANG_CODE.test(String(c)) || c === \"en\") {", "    if (false) {"],
  ["lang: leave the site language out of the summary", "scripts/build-preview.mjs",
    "        ? `${languagePacks.join(\", \")} — site language is ${languagePacks[0]}`", '        ? ""'],
  ["lang: drop the partial-translation caveat", "scripts/build-preview.mjs",
    "    ...(languagePacks.length\n      ? [\n          `> **This preview is in ${languagePacks[0]}, not English.**`,",
    "    ...(false\n      ? [\n          `> **This preview is in ${languagePacks[0]}, not English.**`,"],
  ["mbz: stop reporting the users a backup creates", "scripts/mbz.mjs",
    "  const usernames = usersXml", "  const usernames = false"],

  // Step 2: wiring the restore into the builder
  ["restore: keep createCourse alongside the restore", "scripts/build-preview.mjs",
    "    restore\n      ? {", "    false\n      ? {"],
  ["restore: drop the post-restore assertion from the blueprint", "scripts/build-preview.mjs",
    "    ...(restore ? [buildRestoreAssertion({", "    ...(false ? [buildRestoreAssertion({"],
  ["restore: land on a hardcoded course id again", "scripts/build-preview.mjs",
    "  if (restored && (type === \"mod\" || type === \"theme\" || type === \"format\")) {",
    "  if (false) {"],
  ["restore: the one-course guard counts createCourse only", "scripts/build-preview.mjs",
    'const courseSteps = steps.filter((s) => s.step === "createCourse" || s.step === "restoreCourse");',
    'const courseSteps = steps.filter((s) => s.step === "createCourse");'],
  ["restore: stop gating the supplied backup", "scripts/build-preview.mjs",
    '            if (!verdict.ok) problems.add("restore-course-url", verdict.reason);',
    "            if (false) {}"],
  ["restore: stop checking the backup URL's host", "scripts/build-preview.mjs",
    "    const urlProblem = checkUrl(restoreUrl, hosts);", "    const urlProblem = null;"],

  // Step 3: panel findings on the coordinate parser (found in pushed code)
  ["coord: let a ref segment walk out of the repo", "scripts/coordinates.mjs",
    "  return !ref.split(\"/\").some((seg) => BAD_SEGMENT.test(seg));", "  return true;"],
  // NOT mutated: the percent guard is redundant with REF_CHARS, which has no
  // `%` in its class (measured). A mutant would demand a test for redundancy
  // rather than for behaviour — see the harness policy at the top.
  ["coord: build an archive URL for an unresolved ref", "scripts/coordinates.mjs",
    '  if (!COMMIT_RE.test(String(item?.ref ?? ""))) {', "  if (false) {"],
  ["coord: accept a short SHA as a pin", "scripts/coordinates.mjs",
    "export const COMMIT_RE = /^[0-9a-f]{40}$/;", "export const COMMIT_RE = /^[0-9a-f]{7,40}$/;"],

  // The sample-content menu
  ["sample: the menu resolves to nothing", "scripts/build-preview.mjs",
    '    typedUrl || (sampleContent === "review-course" ? SAMPLE_COURSE_URL : "");',
    "    typedUrl;"],
  ["sample: the menu wins over a typed address instead of being refused", "scripts/build-preview.mjs",
    "  if (sampleContent && typedUrl) {", "  if (false) {"],
  ["sample: the default restores the sample course anyway", "scripts/build-preview.mjs",
    'sampleContent === "review-course" ? SAMPLE_COURSE_URL : ""', "SAMPLE_COURSE_URL"],
  ["sample: point the sample course at a branch instead of a commit", "scripts/build-preview.mjs",
    "/4a0e7afcec0298462b9b28f5a93a65b164f84a56/fixtures/", "/main/fixtures/"],

  // A restored course brings its own sections and format
  ["restore: claim sections a restore ignored", "scripts/build-preview.mjs",
    "      course: restore\n        ? `${teachers} teacher(s), ${students} student(s), restored from a backup ` +\n          `(${restore.info.activityCount} activities)`\n        : `${teachers} teacher(s), ${students} student(s), ${sections} section(s), ` +\n          `${courseFormat} format`,",
    "      course: `${teachers} teacher(s), ${students} student(s), ${sections} section(s), ` +\n          `${courseFormat} format`,"],
  ["restore: summary names a landing page the link does not open", "scripts/build-preview.mjs",
    "        restored: Boolean(restore),", "        restored: false,"],
  ["restore: allow a format plugin against a restored course", "scripts/build-preview.mjs",
    '  if (restoreUrl && type === "format") {', "  if (false) {"],

  // Step 3: the plugin coordinate parser
  ["coord: make #type_name optional again", "scripts/coordinates.mjs",
    "  if (hash < 0) {", "  if (false) {"],
  ["coord: make @ref optional again", "scripts/coordinates.mjs",
    "  if (at < 0) {", "  if (false) {"],
  ["coord: stop rejecting traversal in owner/repo", "scripts/coordinates.mjs",
    'if (parts.length !== 2 || !parts.every((p) => OWNER_REPO.test(p) && p !== "." && p !== "..")) {',
    "if (parts.length !== 2) {"],
  ["coord: accept any ref shape", "scripts/coordinates.mjs",
    "  if (!refIsSafe(ref)) {", "  if (false) {"],
  ["coord: accept a plugin type Moodle has no directory for", "scripts/coordinates.mjs",
    "if (!Object.hasOwn(PLUGIN_TYPE_DIRS, type)) {", "if (false) {"],
  ["coord: split type_name at the LAST underscore", "scripts/coordinates.mjs",
    "const under = component.indexOf(\"_\");", 'const under = component.lastIndexOf("_");'],
  ["coord: filter empty elements away silently", "scripts/coordinates.mjs",
    "  const raws = s.split(\",\");", '  const raws = s.split(",").filter(Boolean);'],
  ["coord: drop the maximum", "scripts/coordinates.mjs",
    "if (raws.length > max) {", "if (false) {"],
  ["coord: allow two coordinates on the same component", "scripts/coordinates.mjs",
    "    if (seen.has(item.component)) {", "    if (false) {"],
  ["coord: report only the first problem", "scripts/coordinates.mjs",
    "      problems.push(`${label} ${i + 1} (${JSON.stringify(one.trim())}) ${parsed.reason}`);\n      continue;",
    "      problems.push(`${label} ${i + 1} (${JSON.stringify(one.trim())}) ${parsed.reason}`);\n      break;"],

  // Step 2: make-fixture's honesty proof
  ["fixture: accept an activity backup as the fixture", "scripts/check-fixture.mjs",
    'if (info.type !== "course") {', "if (false) {"],
  ["fixture: stop comparing activities to the spec", "scripts/check-fixture.mjs",
    "if (JSON.stringify(want) !== JSON.stringify(got)) {", "if (false) {"],
  ["fixture: check names but not the count", "scripts/check-fixture.mjs",
    "if (info.activityCount !== want.length) {", "if (false) {"],
  ["fixture: allow a fixture carrying users", "scripts/check-fixture.mjs",
    "if (Boolean(spec.includesUsers) !== Boolean(info.usernames?.length)) {", "if (false) {"],
  ["fixture: allow a fixture that owns REVIEW", "scripts/check-fixture.mjs",
    'if (info.originalCourseShortname === "REVIEW") {', "if (false) {"],
  ["fixture: report ok even with problems", "scripts/check-fixture.mjs",
    "return { ok: problems.length === 0, problems, info };",
    "return { ok: true, problems, info };"],

  // Step 2: the post-restore assertion
  ["assert: allow an assertion that cannot fail", "scripts/restore-assert.mjs",
    "if (!Number.isInteger(activityCount) || activityCount < 1) {", "if (false) {"],
  ["assert: allow asserting no module names", "scripts/restore-assert.mjs",
    "if (!Array.isArray(modulenames) || modulenames.length === 0) {", "if (false) {"],
  ["assert: stop validating the shortname", "scripts/restore-assert.mjs",
    "if (!SHORTNAME.test(shortname)) {", "if (false) {"],
  ["assert: stop validating module names", "scripts/restore-assert.mjs",
    "if (!IDENT.test(String(m))) {", "if (false) {"],
  // The one that makes it capable of failing at all — measured: without
  // CLI_SCRIPT, Moodle swallows exit codes, fatals AND uncaught exceptions.
  ["assert: drop CLI_SCRIPT so Moodle swallows the exit code", "scripts/restore-assert.mjs",
    "`<?php define('CLI_SCRIPT',true); require('/www/moodle/config.php'); global $DB; ` +",
    "`<?php require('/www/moodle/config.php'); global $DB; ` +"],
  ["assert: count modules queued for deletion too", "scripts/restore-assert.mjs",
    "'course=? AND deletioninprogress=0'", "'course=?'"],
  ["assert: stop requiring each declared module name", "scripts/restore-assert.mjs",
    "`foreach(array(${wanted}) as $w) { if(!in_array($w,$have)) exit(23); } ` +", ""],
  ["assert: stop checking the course exists", "scripts/restore-assert.mjs",
    "`if(!$c) exit(21); ` +", ""],

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
  // A name that is not an account at all must report ONE reason — the one that
  // says so. Without the early return it falls through to the count advice and
  // tells someone who typed "teacher9" to raise the teacher count, which cannot
  // help. (This replaced a `loginAsNameOk` flag when the checks moved into
  // checkLoginAs; the early return does the same job more directly.)
  ["rev2: login-as reports the count error on a bad name too", "scripts/build-preview.mjs",
    "  if (!everyName.includes(loginAs)) {", "  if (false) {"],
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

  // extras.mjs — the ref advertisement, the two existence proofs, and the
  // dependency ordering Moodle will not do for us.
  ["extras: decode the ref advertisement as UTF-8", "scripts/extras.mjs",
    'const text = Buffer.from(bytes).toString("latin1");',
    'const text = Buffer.from(bytes).toString("utf8");'],
  ["extras: accept anything as a ref advertisement", "scripts/extras.mjs",
    "if (!/^[0-9a-f]{4}$/i.test(head)) {", "if (false) {"],
  ["extras: read on past a truncated packet", "scripts/extras.mjs",
    "if (payload.length < len - 4) {", "if (false) {"],
  ["extras: treat a repo advertising nothing as resolvable", "scripts/extras.mjs",
    "if (!refs.size) {", "if (false) {"],
  ["extras: take an annotated tag's tag object, not the commit", "scripts/extras.mjs",
    "const tagSha = refs.get(peeled) ?? refs.get(tag);",
    "const tagSha = refs.get(tag) ?? refs.get(peeled);"],
  ["extras: resolve a branch/tag ambiguity by precedence", "scripts/extras.mjs",
    "if (branchSha && tagSha && branchSha !== tagSha) {", "if (false) {"],
  ["extras: look up a ref that is already a commit", "scripts/extras.mjs",
    "if (COMMIT_RE.test(item.ref)) {", "if (false) {"],
  // GitHub answers 401, not 404, for a repository that does not exist. The
  // 404-only form of this line never fired.
  ["extras: only treat 404 as a missing repository", "scripts/extras.mjs",
    "const missing = res.status === 401 || res.status === 404;",
    "const missing = res.status === 404;"],
  ["extras: follow a rename when resolving a ref", "scripts/extras.mjs",
    'const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });',
    "const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });"],
  // The archive URL answers 302 to codeload first; without following, every
  // real commit looks missing — and with `error`, every one is a refusal.
  ["extras: stop following the archive redirect", "scripts/extras.mjs",
    '        redirect: "follow",', '        redirect: "error",'],
  ["extras: accept a 404 archive", "scripts/extras.mjs",
    "      if (!res.ok) {\n        problems.push(", "      if (false) {\n        problems.push("],
  ["extras: swallow an unreachable archive host", "scripts/extras.mjs",
    "problems.push(`${label} ${item.component}: could not reach ${url} — ${err.message}`);", ";"],
  ["extras: accept a missing version.php", "scripts/extras.mjs",
    "  if (!res.ok) {\n    return {\n      ok: false,\n      reason:\n        `has no version.php",
    "  if (false) {\n    return {\n      ok: false,\n      reason:\n        `has no version.php"],
  // Quinn's case: a styled 404 page served with status 200 parses to a
  // version.php with every field empty, and empty passes everything below.
  ["extras: accept a version.php with no readable fields", "scripts/extras.mjs",
    "if (declared.component == null && declared.version == null && declared.requires == null) {",
    "if (false) {"],
  ["extras: ignore an unparseable extra version.php", "scripts/extras.mjs",
    "if (!declared.ok) return { ok: false, reason: declared.reason };",
    "if (false) return { ok: false, reason: declared.reason };"],
  ["extras: accept an extra that is not the plugin named", "scripts/extras.mjs",
    "if (declared.component && declared.component !== item.component) {", "if (false) {"],
  ["extras: skip the extra's Moodle compatibility", "scripts/extras.mjs",
    "if (!compat.ok) say(compat.reason);", "if (false) say(compat.reason);"],
  ["extras: stop counting core components as satisfying a dependency", "scripts/extras.mjs",
    "if (core.standard.has(dep)) continue;", "if (false) continue;"],
  ["extras: let a missing dependency through", "scripts/extras.mjs",
    "      if (!supplier) {\n        problems.push(",
    "      if (!supplier) { continue; }\n      if (false) {\n        problems.push("],
  ["extras: ignore a dependency pinned too old", "scripts/extras.mjs",
    "supplier.version < want", "false"],
  ["extras: guess dependencies with no core component list", "scripts/extras.mjs",
    "if (!core?.ok) return [];", "if (false) return [];"],
  ["extras: drop the extras-before-the-plugin-under-review tie-break", "scripts/extras.mjs",
    "const next = ready.find((n) => !n.isSelf) ?? ready[0];", "const next = ready[0];"],
  // A cycle left alone silently DROPS whichever plugins the sort could not
  // place: a preview quietly missing exactly what was asked for.
  ["extras: return a partial order instead of refusing a cycle", "scripts/extras.mjs",
    "      return {\n        ok: false,\n        reason:\n          `these plugins depend on each other",
    "      return {\n        ok: true,\n        order,\n        reason:\n          `these plugins depend on each other"],
  ["extras: treat a self-referential dependency as a cycle", "scripts/extras.mjs",
    "byComponent.has(d) && d !== n.component", "byComponent.has(d)"],
  ["extras: wait forever for a dependency outside the preview", "scripts/extras.mjs",
    "byComponent.has(d) && d !== n.component", "d !== n.component"],

  // $plugin->dependencies. An empty list is the value that satisfies every
  // dependency check there is, so every unreadable shape must refuse instead.
  ["deps: read $plugin->dependencies only, not $module->", "scripts/plugin-version.mjs",
    "/\\$(?:plugin|module)\\s*->\\s*dependencies\\s*=/", "/\\$plugin\\s*->\\s*dependencies\\s*=/"],
  ["deps: treat a non-literal dependencies list as no dependencies", "scripts/plugin-version.mjs",
    "  if (!open) {", "  if (!open) { return { ok: true, dependencies: {} }; }\n  if (false) {"],
  ["deps: accept an unterminated dependencies array", "scripts/plugin-version.mjs",
    "  if (end < 0) {", "  if (false) {"],
  ["deps: accept a partly-understood dependencies list", "scripts/plugin-version.mjs",
    "  if (residue) {", "  if (false) {"],
  ["deps: turn ANY_VERSION into a number", "scripts/plugin-version.mjs",
    'dependencies[m[2]] = m[3] === "ANY_VERSION" ? "ANY_VERSION" : Number(m[3]);',
    "dependencies[m[2]] = Number(m[3]);"],
  ["deps: let an unreadable list pass parseVersionPhp", "scripts/plugin-version.mjs",
    "  if (!deps.ok) {", "  if (false) {"],
  // NOT mutated: the `want !== "ANY_VERSION"` guard in checkDependenciesSatisfied.
  // MEASURED — with it removed the comparison is `number < "ANY_VERSION"`, which
  // JS evaluates against NaN and is false, so the behaviour is identical. It
  // documents the intent and protects the day the comparison changes; a mutant
  // for it would demand a test asserting something that does not happen.

  // theme-assert.mjs — the two silent-Boost failures, and the one visible
  // failure that must NOT take the boot down.
  ["theme: accept any theme name", "scripts/theme-assert.mjs",
    "if (!THEME_NAME.test(theme)) {", "if (false) {"],
  ["theme: drop the missing-directory exit", "scripts/theme-assert.mjs",
    "`if(!is_dir($CFG->dirroot.'/theme/'.$t)) exit(31); ` +", ""],
  ["theme: drop the wrong-theme exit", "scripts/theme-assert.mjs",
    "`if((string)($CFG->theme ?? '') !== $t) exit(32); ` +", ""],
  ["theme: drop CLI_SCRIPT so Moodle swallows the exit code", "scripts/theme-assert.mjs",
    "`<?php define('CLI_SCRIPT',true); require('/www/moodle/config.php'); ` +",
    "`<?php require('/www/moodle/config.php'); ` +"],
  ["theme: abort the boot when only the stylesheet failed", "scripts/theme-assert.mjs",
    "`catch (Throwable $e) { error_log('${THEME_CSS_FAILURE_MARKER}: '.$e->getMessage()); exit(0); } ` +",
    "`catch (Throwable $e) { exit(35); } ` +"],
  ["theme: report the stylesheet failure where nobody can read it", "scripts/theme-assert.mjs",
    "`catch (Throwable $e) { error_log('${THEME_CSS_FAILURE_MARKER}: '.$e->getMessage()); exit(0); } ` +",
    "`catch (Throwable $e) { echo '${THEME_CSS_FAILURE_MARKER}: '.$e->getMessage(); exit(0); } ` +"],
  ["theme: trust that a failed SCSS compile throws", "scripts/theme-assert.mjs",
    "`if($sz < ${MIN_STYLESHEET_BYTES}) error_log('${THEME_CSS_FAILURE_MARKER}: '.$t.' produced '.$sz.' bytes of CSS (may be normal for a theme that ships plain CSS)'); ` +",
    ""],
  ["theme: warm the hardcoded boost, as the runtime does", "scripts/theme-assert.mjs",
    "`try { $th = theme_config::load($t); } catch (Throwable $e) { exit(34); } ` +",
    "`try { $th = theme_config::load('boost'); } catch (Throwable $e) { exit(34); } ` +"],
  ["theme: let a broken theme config throw, which reports SUCCESS here", "scripts/theme-assert.mjs",
    "`try { $th = theme_config::load($t); } catch (Throwable $e) { exit(34); } ` +",
    "`$th = theme_config::load($t); ` +"],
  ["theme: stop detecting Moodle falling back to another theme", "scripts/theme-assert.mjs",
    "`if($th->name !== $t) exit(33); ` +", ""],
  ["theme: let the activation check fail without stopping the boot", "scripts/theme-assert.mjs",
    "  return { step: \"runPhpCode\", code, critical: true };\n}\n\n/**\n * Build the theme's stylesheet",
    "  return { step: \"runPhpCode\", code, critical: false };\n}\n\n/**\n * Build the theme's stylesheet"],
  ["theme: make the expensive CSS build able to abort the whole preview", "scripts/theme-assert.mjs",
    "  return { step: \"runPhpCode\", code, critical: false };\n}\n\n/** Turn a boot-log exit code",
    "  return { step: \"runPhpCode\", code, critical: true };\n}\n\n/** Turn a boot-log exit code"],
  ["theme: build the CSS before login, where a heap abort costs the preview", "scripts/build-preview.mjs",
    "  if (activeTheme) steps.push(buildThemeCssWarmup(activeTheme));\n", ""],

  // extras.mjs — $THEME->parents, the dependency version.php cannot see.
  ["theme parents: treat a config.php that never sets parents as fine", "scripts/extras.mjs",
    "  if (!mentioned) {", "  if (false) {"],
  ["theme parents: guess at parents decided at runtime instead of warning", "scripts/extras.mjs",
    "  if (literal.length === 1 && unparsed === 0 && !PARENTS_APPEND.test(text)) {",
    "  if (literal.length >= 1) {"],
  ["theme parents: ignore an appended parent", "scripts/extras.mjs",
    " && !PARENTS_APPEND.test(text)", ""],
  ["theme parents: read past the byte cap", "scripts/extras.mjs",
    "  const text = (await res.text()).slice(0, MAX_VERSION_PHP_BYTES);\n  return parseThemeParents(text, item.component);",
    "  const text = await res.text();\n  return parseThemeParents(text, item.component);"],

  // build-preview.mjs — the theme control's own refusals and wiring.
  ["theme: let the box override the theme under review", "scripts/build-preview.mjs",
    '  if (self.type === "theme") {', "  if (false) {"],
  ["theme: accept a non-theme component in the theme box", "scripts/build-preview.mjs",
    '  if (item.type !== "theme") {', "  if (false) {"],
  ["theme: activate without proving it took", "scripts/build-preview.mjs",
    "    steps.push(buildThemeAssertion(activeTheme));", ""],
  ["theme: hand setTheme the component instead of the name", "scripts/build-preview.mjs",
    'themeName: themeNode ? themeNode.item.name : "",',
    "themeName: themeNode ? themeNode.component : \"\","],
  ["theme: forget the theme under review still needs activating", "scripts/build-preview.mjs",
    'const activeTheme = themeName || (type === "theme" ? name : "");',
    'const activeTheme = themeName;'],
  ["theme: stop treating a parent theme as a dependency", "scripts/build-preview.mjs",
    '          node.dependencies[`theme_${parent}`] = "ANY_VERSION";', ""],
  ["theme: leave setTheme non-critical", "scripts/build-preview.mjs",
    'steps.push({ step: "setTheme", name: activeTheme, critical: true });',
    'steps.push({ step: "setTheme", name: activeTheme });'],
  ["theme parents: read commented-out code as a declaration", "scripts/extras.mjs",
    "  const text = blankComments(String(raw ?? \"\"));", "  const text = String(raw ?? \"\");"],
  ["exit codes: stop explaining what a builder exit code means", "scripts/assert.mjs",
    "    const meaning = BUILDER_EXIT_CODES[Number(m[1])];\n    if (!meaning) continue;", "    const meaning = \"\";"],
  ["exit codes: invent a meaning for a code that is not ours", "scripts/assert.mjs",
    "    if (!meaning) continue;", ""],
  ["theme: stop reporting a stylesheet that did not build", "scripts/assert.mjs",
    "    if (!line.includes(THEME_CSS_FAILURE_MARKER)) continue;", "    continue;"],
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

// Everything a test may read. `preview/` is here because
// render-comment.test.mjs reads ../preview/action.yml — and its absence is what
// made this whole harness vacuous (see the baseline self-test below).
// ".github" is here because a test reads the dispatch form to check that every
// login-as option the form offers is an account the builder accepts. Omit it
// and the unmutated baseline throws ENOENT inside the staged tree — which is
// PRECISELY the bug that made this harness vacuous until 2026-08-10, when
// render-comment.test.mjs read ../preview/action.yml and every mutant was
// "killed" by the resulting failure rather than by the mutation. The baseline
// self-test below caught the repeat within a second of it being introduced.
const COPY_DIRS = ["scripts", "test", "preview", "fixtures", ".github"];

// EVERY test file, found rather than listed. The old hard-coded list silently
// excluded five suites — coordinates, mbz, order-rules, restore-assert and
// check-fixture — so 45+ mutants targeted code whose tests never ran. A list
// fossilises; a glob cannot.
const TEST_FILES = readdirSync(join(ROOT, "test"))
  .filter((f) => f.endsWith(".test.mjs"))
  .sort()
  .map((f) => `test/${f}`);

function stageTree() {
  const dir = mkdtempSync(join(tmpdir(), "bv-mut-"));
  for (const d of COPY_DIRS) {
    const from = join(ROOT, d);
    if (existsSync(from)) cpSync(from, join(dir, d), { recursive: true });
  }
  return dir;
}

function suitePasses(dir) {
  try {
    // SERVE THE NET FIXTURES. `test/` is staged, so the helper and the captured
    // bodies come with it. Without this every mutant run reaches
    // raw.githubusercontent.com — 47 requests each, ~16,000 per gate — which is
    // what got this repo rate-limited into a red tree in the first place, and
    // what made the suite take four minutes instead of two seconds.
    execFileSync(process.execPath, ["--test", ...TEST_FILES], {
      cwd: dir,
      stdio: "pipe",
      env: {
        ...process.env,
        BV_NET_FIXTURES: "1",
        BV_NET_FIXTURE_DIR: join(dir, "test", "fixtures", "net"),
        NODE_OPTIONS: `--import=file://${join(dir, "test", "helpers", "net-fixtures.mjs")}`,
      },
    });
    return true;
  } catch {
    return false;
  }
}

// THE BASELINE SELF-TEST — without this the harness cannot tell "the mutation
// was caught" from "the suite was already broken".
//
// It was already broken. MEASURED 2026-08-10: the staged tree omitted
// `preview/`, render-comment.test.mjs died with ENOENT on preview/action.yml,
// the UNMUTATED baseline failed, and therefore every mutant was reported KILLED
// by that same failure. A comment-only mutation was "killed". The reported
// 235/235 meant nothing, and had meant nothing for the whole of this session's
// work.
{
  const dir = stageTree();
  try {
    if (!suitePasses(dir)) {
      console.error(
        "BASELINE FAILS: the unmutated tree does not pass inside the staged mutant\n" +
          "tree, so every mutant would be 'killed' by that failure rather than by the\n" +
          "mutation. Fix the staging (COPY_DIRS/TEST_FILES) before trusting any result.",
      );
      execFileSync(process.execPath, ["--test", ...TEST_FILES], { cwd: dir, stdio: "inherit" });
      process.exit(1);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// KNOWN SURVIVORS — a ratchet, not an amnesty.
//
// When the staging bug above was fixed, 27 mutants that had been reported
// "killed" for months turned out to survive. They are REAL vacuous assertions,
// most of them predating this work. Fixing all of them at once would mean a
// very large untested-in-anger change; hiding them would repeat the exact
// failure this harness exists to prevent.
//
// So: every survivor must be listed here WITH ITS REASON. The harness fails on
// any survivor that is not listed, AND on any listed one that has started being
// killed — so the list cannot rot, and it can only shrink.
//
// Burn this down. Each line is an assertion that does not assert.
const KNOWN_SURVIVORS = new Map([
  ["verdict: drop risky_steps from the verdict", "assert.mjs writes risky_steps into the verdict; no test reads it back"],
  ["summary: hide the risky-step notice", "render-summary emits the notice; no test asserts it appears"],
  ["preview: let the RESTORED course fall into Miscellaneous", "the restore branch's category is untested (the createCourse branch is covered)"],
  ["comment: allow userinfo in the posted link", "render-comment's URL guard has no hostile-URL case"],
  ["evidence: count extractions without requiring them distinct", "assert.mjs dedupe of extractions is unexercised"],
  ["verdict: drop the installed archive URLs", "the verdict's archive list is never read back by a test"],
  // "parse: stop blanking comments" was here until the dependency tests
  // arrived: a commented-out $plugin->dependencies is the first input where
  // blanking changes the answer. One line off the ratchet.
  ["parse: mistake a URL in a string for a comment", "the URL-in-string case asserts something that holds either way"],
  ["main: continue on a version.php we could not parse", "main()'s refusal on an unreadable version.php has no end-to-end test"],
  ["fetch: accept an HTML 404 page as a version.php", "fetchPluginVersion's content check needs a stubbed fetch"],
  ["fetch: drop the repo/sha shape check before requesting", "same — both return null today, so the test cannot tell them apart"],
  ["rev: identifier check honours installTheme's declared type again", "forcing theme changes nothing observable at the identifier check"],
  ["rev: free-text landing-path swallows the sentinel again", "checkLandingPath refuses '(default)' either way, so the opt() removal is invisible"],
  ["1c: accept an empty standard list as success", "needs fetchCoreComponents' parsing split out to be testable without a network stub"],
]);

const survivors = [];
let killed = 0;

// ANCHORS_ONLY — every anchor must resolve exactly once, checked in under a
// second instead of at minute 20 of a full run.
//
// A mutant whose anchor no longer matches is not a weak test, it is a mutant
// that never ran: the harness reports MUTATION STALE and the assertion it was
// guarding has been unguarded ever since the line moved. That has happened
// three times here — twice in the theme round, where the highest-value mutant
// of the commit (deleting the critical assertion) silently never executed, and
// once in this one. It is always the author's OWN edit that breaks it, which is
// exactly when a 20-minute feedback loop is too slow to catch it.
if (process.env.MUTATIONS_ANCHORS_ONLY) {
  const tree = stageTree();
  let stale = 0;
  try {
    for (const [label, file, find] of MUTATIONS) {
      const n = readFileSync(join(tree, file), "utf8").split(find).length - 1;
      if (n !== 1) {
        stale += 1;
        console.error(`STALE (${n}x) ${label}\n         in ${file}`);
      }
    }
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
  console.log(`anchors: ${MUTATIONS.length - stale}/${MUTATIONS.length} resolve exactly once`);
  process.exit(stale ? 1 : 0);
}

for (const [label, file, find, replace] of MUTATIONS) {
  const dir = stageTree();
  try {
    const target = join(dir, file);
    const src = readFileSync(target, "utf8");
    const occurrences = src.split(find).length - 1;
    if (occurrences !== 1) {
      survivors.push(`${label} — MUTATION STALE: pattern found ${occurrences}× in ${file}`);
      continue;
    }
    writeFileSync(target, src.replace(find, replace));
    if (!suitePasses(dir)) killed += 1; // the suite noticed — good
    else survivors.push(`${label} (${file})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`mutations: ${killed}/${MUTATIONS.length} killed`);

const label = (s) => s.replace(/ \(scripts\/.*\)$/, "").replace(/ — MUTATION STALE.*$/, "");
// A STALE anchor is NEVER known debt, whatever the label says. `label()` strips
// the "— MUTATION STALE" suffix before the lookup, so a mutant on the
// KNOWN_SURVIVORS list whose anchor stopped matching was absorbed as debt we
// had already accepted and the run exited 0 — while check 1a2, reading the same
// list, exited 1. A listed survivor is an assertion we know is unpinned; a
// stale anchor is a mutant that did not run at all, which is a different and
// worse thing and the list must not launder it.
const isStale = (s) => s.includes("MUTATION STALE");
const unexpected = survivors.filter((s) => isStale(s) || !KNOWN_SURVIVORS.has(label(s)));
const fixed = [...KNOWN_SURVIVORS.keys()].filter((k) => !survivors.some((s) => label(s) === k));

if (unexpected.length) {
  console.error("NEW SURVIVING MUTANTS (vacuous or unpinned assertions):");
  for (const s of unexpected) console.error(`  - ${s}`);
  console.error("\nEither pin the assertion with a test, or add it to KNOWN_SURVIVORS with a reason.");
  process.exit(1);
}
if (fixed.length) {
  // The list can only shrink, and it must not carry entries that are no longer
  // true — a stale allowlist is how a ratchet becomes an amnesty.
  console.error("These KNOWN_SURVIVORS are now KILLED. Remove them from the list:");
  for (const k of fixed) console.error(`  - ${k}`);
  process.exit(1);
}
if (survivors.length) {
  console.log(`${survivors.length} known survivor(s) outstanding — real debt, listed in KNOWN_SURVIVORS:`);
  for (const s of survivors) console.log(`  - ${s}`);
  console.log("No NEW vacuous assertions.");
} else {
  console.log("no surviving mutants — every assertion term is pinned by a test");
}
