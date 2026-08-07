// Build the preview URL that goes on a pull request: a playground link that
// boots Moodle with THIS commit's plugin installed.
//
// Everything here exists to stop the link lying about which code it opens:
//
//  - the plugin ZIP is pinned to the head COMMIT, never a branch ref (a branch
//    link shows later commits, and 404s forever once the branch is deleted);
//  - no `{{REPO}}`/`{{REF}}` placeholders may appear anywhere, and the finished
//    link may carry no repo/ref/owner/branch query params — the playground
//    resolver gives those the HIGHEST precedence and rewrites plugin URLs with
//    them, so a link can otherwise boot different code while looking correct
//    and hashing identically;
//  - the blueprint travels INSIDE the link (gzipped, base64url) so it cannot
//    rot, drift, or be swapped after posting;
//  - the review course is named for the PR and commit, so the reviewer's own
//    screen confirms what they are looking at.
//
// Construction fails closed: anything it cannot make safe, it refuses to build.

import { gzipSync } from "node:zlib";
import { writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { sanitiseForLog } from "./sanitise.mjs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PLUGIN_TYPE_DIRS } from "./assert.mjs";
import { gateBlueprint, assertNoPlaceholders } from "./preflight.mjs";
// Re-exported: the check now lives in preflight so BOTH halves get it (the
// verify half fetches foreign blueprints and never had it), but this stays the
// import site for preview concerns.
export { assertNoPlaceholders };
import {
  readPluginVersion,
  checkMoodleCompatibility,
  checkComponent,
  checkPluginTypeSupported,
  fetchPluginVersion,
  DEFAULT_MOODLE_BRANCH,
} from "./plugin-version.mjs";

const SHA_RE = /^[0-9a-f]{40}$/;
// Deliberately stricter than GitHub: a segment of `.` or `..` is folded away
// by the URL parser, so `../evil` becomes a different repo entirely.
const REPO_SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const isRepo = (v) => {
  const parts = String(v).split("/");
  return (
    parts.length === 2 &&
    parts.every((seg) => REPO_SEGMENT_RE.test(seg) && seg !== "." && seg !== "..")
  );
};
const IDENT_RE = /^[a-z][a-z0-9_]*$/;
// Plain text for the review course name. Deliberately narrow: it is rendered
// as FORMAT_HTML, and `·` is the separator the label already uses.
const BUILT_BY_RE = /^[A-Za-z0-9 ._·-]{1,60}$/;
// A landing override is a site-relative path, never an absolute URL — a link
// that lands the reviewer on another origin is the whole failure this design
// refuses. No scheme, no `//`, no backslash, no `..`.
export const LANDING_RE = /^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@/-]*(\?[A-Za-z0-9._~!$&'()*+,;=:@/?-]*)?$/;
const PR_NUMBER_RE = /^\d+$/;

/** Escape for the label's FORMAT_HTML intro, which renders as live HTML. */
const escapeHtml = (v) =>
  String(v).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
// Params the playground resolver treats as overrides. None may appear in a
// finished link, because they are resolved "URL params > blueprint > defaults"
// (shell/main.js:575) — so any of them beats the blueprint's own settings.
//
//   repo/ref/owner/branch      rewrite the plugin ZIP URL
//   moodle/moodleBranch/       boot a DIFFERENT Moodle from the one the
//   php/phpVersion             compatibility check was made against
//   addonProxyUrl              decides who serves the plugin ZIP
//   phpCorsProxyUrl            decides where PHP's own outbound traffic goes,
//                              via resolveCorsProxyUrl -> getTcpOverFetchOptions
//                              -> corsProxyUrl (php-loader.js:27,40,56)
//
// In every case the link still reads as the playground and looks correct.
// Names are camelCase to match the playground's parser (version-resolver.js);
// the comparison is case-sensitive. Gate check 1l fails if the playground
// gains a param that is neither listed here nor a deliberate exception.
//
// The proxy entries bound who traffic goes THROUGH, not whether there is any:
// PHP has network access regardless, because tcpOverFetch is enabled
// unconditionally. What bounds that is the dedicated preview origin.
export const FORBIDDEN_PARAMS = [
  "repo", "ref", "owner", "branch", "blueprint-url",
  "moodle", "moodleBranch", "php", "phpVersion",
  "addonProxyUrl", "phpCorsProxyUrl",
];
// The preview half had no origin concept at all, while the verify half has
// ACCEPTED_ORIGINS. A link is a capability; it must not point anywhere.
/**
 * Hosts a blueprint's URLs may point at. Widen it with the `data-hosts` input
 * when a blueprint installs plugins from elsewhere — a dependency on GitLab, a
 * university host, the Moodle plugins directory. The commit under review is
 * bound separately (see requireSelfUrl), so widening this does NOT let a link
 * quietly swap out the plugin it claims to preview.
 */
export const DEFAULT_DATA_HOSTS = ["github.com", "raw.githubusercontent.com"];

/** Where this commit's own plugin ZIP lives. One definition, so the builder
 * and the gate that checks it can never disagree. */
export const pluginZipUrl = (headRepo, headSha) =>
  `https://github.com/${headRepo}/archive/${headSha}.zip`;

export const DEFAULT_ORIGINS = [
  "https://moodle-playground.com",
  "https://ateeducacion.github.io",
  "https://daviducl.github.io",
];

/** Course the reviewer lands in. Fixed shortname; id 2 because exactly one
 * course is created and the site course is 1. */
const COURSE_SHORTNAME = "REVIEW";
const COURSE_ID = 2;

/**
 * Plugin identity from the repo name (`moodle-mod_foo` → mod/foo), unless the
 * caller states it. Inference is a convenience, never a dependency: the
 * blueprint always carries the resolved values explicitly, because the
 * playground otherwise re-derives them from the URL path and throws on
 * anything that is not a `/<repo>/archive/` shape.
 */
export function derivePlugin(repoFullName, overrides = {}) {
  let type = overrides.type || "";
  let name = overrides.name || "";
  // version.php's `component` is the plugin's own statement of identity and
  // beats any inference from the repository name, which is only a convention.
  if ((!type || !name) && overrides.component) {
    const c = /^([a-z][a-z0-9]*)_([a-z][a-z0-9_]*)$/.exec(String(overrides.component));
    if (c) {
      type = type || c[1];
      name = name || c[2];
    }
  }
  if (!type || !name) {
    // The `moodle-` prefix is a convention, not a rule: plenty of repos are
    // named plainly (`local_myplugin`), and requiring the prefix rejected them
    // outright. Strip it if present, then split on the FIRST underscore —
    // plugin names may contain more (`theme_boost_union`).
    const repo = String(repoFullName).split("/")[1] || "";
    const m = /^(?:moodle-)?([a-z][a-z0-9]*)_([a-z][a-z0-9_]*)$/.exec(repo);
    if (m) {
      type = type || m[1];
      name = name || m[2];
    }
  }
  if (!IDENT_RE.test(type) || !Object.hasOwn(PLUGIN_TYPE_DIRS, type)) {
    throw new Error(
      `cannot determine plugin type from "${repoFullName}" — pass plugin-type ` +
        `explicitly (one of: ${Object.keys(PLUGIN_TYPE_DIRS).slice(0, 8).join(", ")}, …)`,
    );
  }
  if (!IDENT_RE.test(name)) {
    throw new Error(
      `cannot determine plugin name from "${repoFullName}" — pass plugin-name explicitly`,
    );
  }
  if (type === "mod" && name.includes("_")) {
    // Moodle forbids underscores in activity module names, and modedit.php
    // reads the name as PARAM_ALPHANUM — it would silently strip the
    // underscore and open the add form for a DIFFERENT module.
    throw new Error(`activity module names cannot contain an underscore: ${name}`);
  }
  return { type, name };
}

/**
 * Where to drop the reviewer so they see the plugin rather than a bare site.
 * NB deliberately NOT pre-adding an activity: addModule writes straight to
 * course_modules and bypasses the plugin's own add_instance(), so a working
 * mod plugin often renders blank — land on the add form instead.
 */
export function landingPath(type, name) {
  switch (type) {
    case "mod":
      // CONFIRMED in a browser: the real add form, which runs the plugin's own
      // mod_form. Deliberately NOT pre-adding via addModule — that writes
      // straight to course_modules and bypasses add_instance().
      return `/course/modedit.php?add=${name}&course=${COURSE_ID}&section=1`;
    case "theme":
    case "format":
      // Both are applied to the course, so a content page shows them working.
      return `/course/view.php?id=${COURSE_ID}`;
    // Below: admin pages verified in Moodle source to take no required
    // params. Stronger than the guesses they replace (an earlier qtype path
    // needed a `cmid` and would have shown the reviewer an error page), but
    // still only source-verified — confirm in a browser before trusting one.
    case "block":
      return "/admin/blocks.php";
    case "filter":
      return "/admin/filters.php";
    case "local":
      return "/admin/localplugins.php";
    case "report":
      return "/admin/reports.php";
    case "qtype":
      return "/admin/qtypes.php";
    case "auth":
      return "/admin/settings.php?section=manageauths";
    case "enrol":
      return "/admin/settings.php?section=manageenrols";
    case "editor":
      return "/admin/settings.php?section=manageeditors";
    case "tiny":
      // TinyMCE subplugins have their own settings page, defined in
      // lib/editor/tiny/settings.php (NOT admin/settings/plugins.php, which is
      // why a grep of that file suggests the section does not exist).
      return "/admin/settings.php?section=editorsettingstiny";
    default:
      // Proves registration, version and settings for everything else, and
      // shows absence loudly — better than a page that looks normal whether
      // or not the plugin arrived.
      return "/admin/plugins.php";
  }
}

/**
 * Who the reviewer should arrive as. Admin pages need an admin; everything
 * else is judged better as a teacher, because admin bypasses the capability
 * checks a plugin's own code relies on. `editingteacher` is enrolled in the
 * review course, so a teacher can still add and configure activities.
 */
export function previewUser(landing) {
  return String(landing).startsWith("/admin/") ? "admin" : "teacher";
}

/**
 * PHP version to pin for a Moodle branch. Every branch the action knows
 * accepts 8.3 today, so this is one entry per branch rather than a range —
 * but it exists so that a branch bundling a different range cannot silently
 * fall back to the playground's substitution. verify.sh check 1m fails if a
 * branch's list stops containing what we pin.
 */
export const PHP_FOR_BRANCH = {
  MOODLE_404_STABLE: "8.3",
  MOODLE_405_STABLE: "8.3",
  MOODLE_500_STABLE: "8.3",
};
export const phpForBranch = (branch) => PHP_FOR_BRANCH[branch] ?? "8.3";

/** @returns {object} the blueprint the preview link carries */
export function buildBlueprint({
  headRepo,
  headSha,
  prNumber,
  type,
  name,
  moodleBranch = DEFAULT_MOODLE_BRANCH,
  landingOverride = "",
  builtBy = "",
}) {
  if (!isRepo(headRepo)) throw new Error(`bad repo: ${headRepo}`);
  if (!SHA_RE.test(String(headSha))) {
    throw new Error(`head SHA must be a full 40-hex commit, got: ${headSha}`);
  }
  if (prNumber !== "" && prNumber !== undefined && !PR_NUMBER_RE.test(String(prNumber))) {
    // It reaches a FORMAT_HTML label, so anything but digits is live HTML on
    // the reviewer's page, same-origin with the playground.
    throw new Error(`pr-number must be digits, got: ${JSON.stringify(prNumber)}`);
  }
  const shortSha = headSha.slice(0, 7);
  // The course name is the reviewer's cross-check, and — for a link built by
  // hand and pasted to a colleague — its ONLY provenance. A dispatch-built
  // link is otherwise shape-identical to one born from a push, so it would
  // read as a verified preview when nothing booted it. Netlify puts the PR in
  // the hostname, Vercel puts branch+SHA on the page; this is the same idea in
  // the only surface we control.
  if (builtBy && !BUILT_BY_RE.test(builtBy)) {
    // It reaches a FORMAT_HTML label. Escaped below regardless, but a closed
    // charset means an odd value is a refusal rather than a rendering puzzle.
    throw new Error(`built-by must be plain text (letters, digits, space . _ - ·), got: ${JSON.stringify(builtBy)}`);
  }
  const label = [
    builtBy || null,
    prNumber ? `PR #${prNumber}` : null,
    shortSha,
    `${type}_${name}`,
  ]
    .filter(Boolean)
    .join(" · ");

  const steps = [
    { step: "installMoodle" },
    {
      // Without DEVELOPER debugging, deprecations and notices are invisible and
      // a reviewer passes a plugin that is warning loudly on a real site.
      //
      // ORDER IS LOAD-BEARING: enrol_manual copies
      // `sendcoursewelcomemessage` into the enrolment instance when the
      // COURSE IS CREATED, so setting it afterwards would do nothing.
      step: "setConfigs",
      configs: [
        { name: "debug", value: "32767" },
        { name: "debugdisplay", value: "1" },
        // There is no mail transport here, so enrolling a user makes Moodle
        // try to send a welcome email and — with debugging on — print a long
        // email_to_user backtrace that reads exactly like a broken plugin.
        // Observed live 2026-07-31. `noemailever` alone is not enough: it
        // only swaps the message for "Not sending email due to …", still a
        // wall of backtrace. Stop the welcome message being generated at all.
        { name: "noemailever", value: "1" },
        { name: "sendcoursewelcomemessage", value: "0", plugin: "enrol_manual" },
      ],
    },
    {
      step: "installMoodlePlugin",
      url: pluginZipUrl(headRepo, headSha),
      pluginType: type,
      pluginName: name,
      // NOT redundant — verified against the DEPLOYED executor, which says:
      // "step failures are non-fatal by default (ADR-0005). A step with
      // `critical: true` aborts the remaining blueprint on failure."
      // The moodle-playground checkout in this tree is OLDER and aborts on
      // any throw, so reading only that source makes this look like a no-op.
      // It is not: without it, a failed install on the live host boots a
      // clean Moodle and the reviewer concludes the plugin does nothing.
      critical: true,
    },
    // From here on every step is `critical`. A reload of the same link
    // re-runs the whole blueprint against the EXISTING database: createCourse
    // then fails `shortnametaken` while enrolUsers and addModule still
    // succeed, leaving two identical review briefs and a "found more than one
    // record" debug box. Observed live, twice — once spontaneously, when a
    // late service-worker takeover forced a second boot, which is MORE likely
    // on a slow connection. Aborting at the first duplicate keeps the site
    // coherent. (The local playground checkout aborts on any throw and cannot
    // reproduce this; only the deployed build can.)
    { step: "createCategory", name: "Review", critical: true },
    {
      step: "createCourse",
      // The course name is the self-check: the reviewer's screen either shows
      // the commit named in the PR header, or something is wrong.
      fullname: label,
      shortname: COURSE_SHORTNAME,
      critical: true,
      // Without this the course lands in Miscellaneous and the category
      // created above sits empty — the helper only honours a named category
      // on the course itself.
      category: "Review",
      // A format plugin is only visible if the review course actually uses it
      // — the exact analogue of setTheme for themes.
      ...(type === "format" ? { format: name } : {}),
      numsections: 3,
    },
    {
      step: "createUsers",
      critical: true,
      users: [
        { username: "teacher", firstname: "Teacher", lastname: "Review" },
        { username: "student1", firstname: "Student", lastname: "One" },
      ],
    },
    {
      step: "enrolUsers",
      critical: true,
      enrolments: [
        { username: "teacher", course: COURSE_SHORTNAME, role: "editingteacher" },
        { username: "student1", course: COURSE_SHORTNAME, role: "student" },
      ],
    },
  ];
  // A brief on the course page. Everything a reviewer needs in order not to
  // misread the site: which commit, the logins, and that yellow debug boxes
  // are deliberate. One line — a newline in any blueprint string is rejected.
  steps.push({
    step: "addModule",
    critical: true,
    module: "label",
    course: COURSE_SHORTNAME,
    section: 0,
    name: "Review brief",
    intro:
      `<p><strong>${escapeHtml(label)}</strong></p>` +
      `<ul><li>Logins: <code>admin</code>, <code>teacher</code>, <code>student1</code>` +
      ` — password <code>password</code></li>` +
      `<li>Debugging is DEVELOPER: yellow boxes are deprecation notices, not crashes</li>` +
      `<li>Student view: user menu → Switch role to… → Student. That is a VIEW only —` +
      ` log in as <code>student1</code> for anything that owns data</li></ul>`,
  });

  if (steps.filter((s) => s.step === "createCourse").length !== 1) {
    // Every landing page hardcodes course id 2, which only holds while this
    // blueprint creates exactly one course.
    throw new Error("internal: landing pages assume exactly one createCourse");
  }
  if (type === "theme") steps.push({ step: "setTheme", name });
  // Log in LAST, and as whoever can actually judge the landing page.
  //
  // The reviewer used to arrive as admin, and admin bypasses capability checks
  // entirely. A pull request that FIXES a capability bug therefore previewed
  // identically to one that did not — the single thing a preview most needs
  // to show.
  //
  // Ordering is load-bearing twice over. phpLogin does a MUST_EXIST lookup on
  // the username, so it cannot run before createUsers. And bootstrap.js:3088
  // skips its own hardcoded admin auto-login whenever the blueprint contains a
  // `login` step, so this REPLACES that session rather than adding one.
  // Provisioning needs no session: the create/enrol helpers call core APIs
  // directly and never read $USER.
  const landing = landingOverride || landingPath(type, name);
  steps.push({ step: "login", username: previewUser(landing), critical: true });
  steps.push({ step: "setLandingPage", path: landing });


  const landingPage = landing;
  return {
    // The branch here MUST be the one the compatibility checks ran against.
    // It used to be the literal "MOODLE_500_STABLE" while `moodle-branch` fed
    // only the checks — so setting that input validated the plugin against one
    // Moodle and then built a link that booted another. Nobody hit it because
    // the input's default happened to equal the literal. One source now.
    //
    // PHP is derived rather than fixed for the same reason: valid versions
    // differ per branch (4.4/4.5 take 8.1-8.3, 5.x take 8.2-8.4), and the
    // playground answers an invalid pair by silently substituting 8.3
    // (version-resolver.js:199-208) — so a wrong literal here would be
    // invisible.
    preferredVersions: { php: phpForBranch(moodleBranch), moodle: moodleBranch },
    // Both: the top-level value aims the FIRST navigation at the target, and
    // the step keeps working if a build ignores the top-level field.
    landingPage,
    steps,
  };
}

/**
 * Run the blueprint through this repo's own step-gate before anyone sees it.
 * We own that gate and were not using it here: it catches a typo'd step name
 * (which the inline path never validates, so it would fail at runtime in the
 * reviewer's browser), a banned step, and any URL outside the allowed hosts.
 */
export function assertGated(blueprint, { dataHosts = DEFAULT_DATA_HOSTS, requireSelfUrl } = {}) {
  const { stepErrors, urlErrors, unsafeStrings, bindErrors, riskySteps } = gateBlueprint(
    blueprint,
    dataHosts,
    requireSelfUrl ? { requireSelfUrl } : {},
  );
  const problems = [...stepErrors, ...unsafeStrings, ...urlErrors, ...bindErrors];
  if (problems.length) {
    throw new Error(`refusing to build a link from a blueprint our own gate rejects: ${problems.join("; ")}`);
  }
  return riskySteps || [];
}


/** gzip + base64url (unpadded) — the form the playground's parser detects. */
export function encodeBlueprint(blueprint) {
  return gzipSync(Buffer.from(JSON.stringify(blueprint), "utf8"))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** @returns {string} the URL to put on the PR */
export function buildPreviewUrl({
  playgroundHost,
  blueprint,
  allowedOrigins = DEFAULT_ORIGINS,
  dataHosts = DEFAULT_DATA_HOSTS,
  requireSelfUrl,
}) {
  assertNoPlaceholders(blueprint);
  assertGated(blueprint, { dataHosts, requireSelfUrl });
  const url = new URL(String(playgroundHost));
  if (url.protocol !== "https:") throw new Error(`playground host must be https: ${playgroundHost}`);
  // `https://moodle-playground.com@evil.tld/` parses to host evil.tld while
  // READING as the playground — in a comment, both the link text and the
  // visible prefix lie, and the reviewer's session opens on the other origin.
  if (url.username || url.password) {
    throw new Error(`playground host must not carry userinfo: ${playgroundHost}`);
  }
  if (url.search || url.hash) throw new Error(`playground host must carry no query: ${playgroundHost}`);
  if (!allowedOrigins.includes(url.origin)) {
    throw new Error(
      `playground origin not allowed: ${url.origin} (allowed: ${allowedOrigins.join(", ")})`,
    );
  }
  url.searchParams.set("blueprint", encodeBlueprint(blueprint));

  // Belt and braces: whatever the host string contained, the finished link
  // must carry nothing the resolver could treat as an override.
  for (const p of FORBIDDEN_PARAMS) {
    if (url.searchParams.has(p)) throw new Error(`preview URL must not carry ?${p}=`);
  }
  return url.toString();
}

// Values here now include strings read from version.php — a file the pull
// request under review controls. A newline in one would inject a second
// `name=value` line into $GITHUB_OUTPUT, and the caller workflow posts
// `comment-body` verbatim as the bot. Refuse anything outside the shape every
// legitimate output already has. (render-summary.mjs has carried this guard
// from the start; build-preview did not, because until version.php was read
// every value here came from a regex-validated scalar.)
// The comma is here because `risky-steps` is a comma-joined LIST, matching
// `data-hosts` and GitHub's convention for list inputs. Widening a guard is
// worth a moment's thought: what this defends against is a NEWLINE, which
// would inject a second `name=value` line into $GITHUB_OUTPUT and let a
// file-derived value forge `comment-body`. Newline stays excluded; a comma
// cannot terminate a line. Omitting it made a two-element list THROW after
// preview-url was already written, so the link still posted with the warning
// stripped — the more risky steps a blueprint used, the less the reviewer was
// told.
const SAFE_OUTPUT_RE = /^[A-Za-z0-9._:/?=&%~+,-]{0,4096}$/;

export function setOutput(name, value) {
  const str = String(value);
  const safe = SAFE_OUTPUT_RE.test(str) ? str : "";
  if (!safe && str) {
    throw new Error(`refusing to emit unsafe output ${name}=${JSON.stringify(str.slice(0, 80))}`);
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${safe}\n`);
  } else {
    console.log(`output ${name}=${safe}`);
  }
}

/**
 * Write the run's own account of itself to the job summary.
 *
 * The preview half wrote NOTHING here. A refusal surfaced as a red X and an
 * empty summary, with the reason — which is good text, carefully worded —
 * buried in a collapsed log nobody expands. Unread, not unwritten.
 *
 * Everything interpolated is either a value this script derived and validated,
 * or is passed through sanitiseForLog. The blueprint is not echoed: it can
 * contain strings from a plugin repo, and a job summary renders markdown.
 */
function writeSummary(lines) {
  const body = lines.join("\n") + "\n";
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, body);
  } else {
    process.stdout.write(body);
  }
}

function summariseRefusal(reason, facts) {
  writeSummary([
    "## 🚫 No preview link for this commit",
    "",
    `**${sanitiseForLog(String(reason))}**`,
    "",
    "No link was built, so nothing was posted. This is a refusal, not a crash:",
    "the check below decided the preview would have been misleading.",
    "",
    "| | |",
    "|---|---|",
    ...factRows(facts),
    "",
    "A preview that boots a Moodle without your plugin in it looks like a",
    "working site, so the reviewer concludes the plugin does nothing. Refusing",
    "is the loud version of that.",
  ]);
}

/** Rows for the fact table, skipping anything we could not determine. */
function factRows(facts) {
  return Object.entries(facts)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `| ${k} | \`${sanitiseForLog(String(v))}\` |`);
}

async function main() {
  const headRepo = process.env.HEAD_REPO || "";
  const headSha = process.env.HEAD_SHA || "";
  const prNumber = process.env.PR_NUMBER || "";
  // Keep in step with preview/action.yml's default; check 1j fails if they drift.
  const playgroundHost = process.env.PLAYGROUND_HOST || "https://daviducl.github.io/moodle-playground";
  const outDir = process.env.OUT_DIR || "preview-out";
  // Which Moodle the playground will boot. Not pinned in the link today (see
  // README) — this states the assumption the compatibility check is made
  // against, so a wrong assumption is visible rather than silent.
  const moodleBranch = process.env.MOODLE_BRANCH || DEFAULT_MOODLE_BRANCH;

  // version.php is the plugin's own declaration of what it is and what it
  // needs. When the plugin repo is the one checked out — the normal case for
  // an adopting repo — it is on disk and authoritative. Prefer it over
  // guessing identity from the repository name.
  const pluginRoot = process.env.PLUGIN_ROOT || ".";
  let declared = readPluginVersion(pluginRoot);
  // Not on disk — nothing was checked out, or the plugin lives in another
  // repo. Fetch it rather than skipping every strong check. Costs one request
  // and only on this path; the normal adopting-repo case never gets here, so
  // the action still makes no network calls in the case that matters.
  if (!declared) {
    declared = await fetchPluginVersion(headRepo, headSha, pluginRoot);
    if (declared) console.log(`note: read version.php over https (${declared.path})`);
  }

  // An explicit component beats both version.php and the repository name: it
  // is the caller stating identity outright, which is what a dispatch form
  // needs when nothing is checked out and the repo is named unconventionally.
  const { type, name } = derivePlugin(headRepo, {
    type: process.env.PLUGIN_TYPE,
    name: process.env.PLUGIN_NAME,
    component: (process.env.PLUGIN_COMPONENT || "").trim() || declared?.component,
  });

  // Independent of version.php: a plugin TYPE the bundled Moodle no longer has
  // cannot install whatever the plugin declares.
  const supported = checkPluginTypeSupported(type, moodleBranch);
  if (!supported.ok) throw new Error(supported.reason);

  if (declared) {
    // A component that disagrees with the install path is a silent failure:
    // upgrade_plugins skips a directory with no readable version.php without
    // saying anything, and the reviewer gets a Moodle with no plugin.
    const comp = checkComponent(declared.component, type, name);
    if (!comp.ok) throw new Error(comp.reason);

    const compat = checkMoodleCompatibility(declared, moodleBranch);
    if (!compat.ok) throw new Error(compat.reason);
    if (compat.reason) console.log(`note: ${compat.reason}`);
  } else {
    // Not fatal. This repo's own dogfood previews a third-party plugin that
    // was never checked out, and that is a legitimate shape. Say plainly that
    // the strongest check was skipped rather than implying it passed.
    console.log(
      `note: no version.php on disk under "${pluginRoot}" and none fetched for ` +
        `${headSha.slice(0, 7)} — Moodle-version compatibility NOT checked`,
    );
  }

  // A landing override must stay on the playground's own origin. Validated
  // here rather than trusted: `//evil.tld/x` and `https://evil.tld` both parse
  // as "somewhere else" to a browser, and schema.js accepts them (it does not
  // check), so the refusal has to be ours.
  const landingOverride = (process.env.LANDING_PATH || "").trim();
  if (landingOverride && !LANDING_RE.test(landingOverride)) {
    throw new Error(
      `landing-path must be a site-relative path starting with "/" and no scheme or "//", got: ` +
        JSON.stringify(landingOverride),
    );
  }
  const builtBy = (process.env.BUILT_BY || "").trim();

  const blueprint = buildBlueprint({
    headRepo,
    headSha,
    prNumber,
    type,
    name,
    moodleBranch,
    landingOverride,
    builtBy,
  });
  // Hosts other plugins may come from. Comma separated, trimmed, empties
  // dropped so a trailing comma is not a silent empty-string host.
  const dataHosts = (process.env.DATA_HOSTS || "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  const hosts = dataHosts.length ? dataHosts : DEFAULT_DATA_HOSTS;
  const url = buildPreviewUrl({
    playgroundHost,
    blueprint,
    dataHosts: hosts,
    requireSelfUrl: pluginZipUrl(headRepo, headSha),
  });

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "preview-blueprint.json"), JSON.stringify(blueprint, null, 2));
  writeFileSync(join(outDir, "preview-url.txt"), url + "\n");

  setOutput("preview-url", url);
  setOutput("plugin-type", type);
  setOutput("plugin-name", name);
  setOutput("head-sha", headSha);
  setOutput("plugin-component", declared?.component || `${type}_${name}`);
  setOutput("preview-user", previewUser(landingOverride || landingPath(type, name)));
  const risky = assertGated(blueprint, {
    dataHosts: hosts,
    requireSelfUrl: pluginZipUrl(headRepo, headSha),
  });
  setOutput("risky-steps", risky.join(","));
  if (risky.length) {
    console.log(
      `note: this blueprint can rewrite Moodle after installing — ${risky.join(", ")}`,
    );
  }
  console.log(`preview: ${type}_${name} @ ${headSha.slice(0, 7)} (${url.length} chars)`);

  writeSummary([
    "## ▶ Playground preview",
    "",
    `### [Open ${sanitiseForLog(`${type}_${name}`)} at ${headSha.slice(0, 7)}](${url})`,
    "",
    "| | |",
    "|---|---|",
    ...factRows({
      plugin: declared?.component || `${type}_${name}`,
      commit: headSha,
      repository: headRepo,
      Moodle: moodleBranch,
      "signed in as": previewUser(landingOverride || landingPath(type, name)),
      "landing page": landingOverride || landingPath(type, name),
      "version.php": declared ? declared.path : "not checked out — compatibility NOT checked",
    }),
    "",
    ...(risky.length
      ? [
          `> **This blueprint can rewrite Moodle after installing:** ${risky
            .map((r) => `\`${r}\``)
            .join(", ")}.`,
          "> Code that installs for real can be overwritten afterwards without",
          "> touching the database, the boot log, or any assertion.",
          "",
        ]
      : []),
    "Smoke test only: this shows whether the plugin installs and renders, not",
    "whether it is correct. Nothing here booted it — the link boots in your",
    "browser when you open it.",
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (err) {
    // A refusal is the designed outcome of several checks, and its wording is
    // the whole point. Put it where a human will see it, then still fail —
    // the caller decides what to do with a red step.
    summariseRefusal(err?.message ?? String(err), {
      repository: process.env.HEAD_REPO,
      commit: process.env.HEAD_SHA,
      Moodle: process.env.MOODLE_BRANCH || DEFAULT_MOODLE_BRANCH,
      "plugin root": process.env.PLUGIN_ROOT || ".",
    });
    console.error(err?.stack ?? String(err));
    process.exit(1);
  }
}
