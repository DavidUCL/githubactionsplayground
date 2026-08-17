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
import { gateBlueprint, assertNoPlaceholders, checkUrl } from "./preflight.mjs";
import { buildRestoreAssertion } from "./restore-assert.mjs";
import { buildThemeAssertion, buildThemeCssWarmup } from "./theme-assert.mjs";
import { buildCourseAssertion } from "./course-assert.mjs";
import { checkCourseBackup } from "./mbz.mjs";
// Re-exported: the check now lives in preflight so BOTH halves get it (the
// verify half fetches foreign blueprints and never had it), but this stays the
// import site for preview concerns.
export { assertNoPlaceholders };
import { parseCoordinateList, coordinateZipUrl } from "./coordinates.mjs";
import {
  resolveCoordinates,
  checkArchives,
  fetchExtraVersion,
  checkExtraPlugin,
  checkDependenciesSatisfied,
  orderInstalls,
  fetchThemeParents,
} from "./extras.mjs";
import {
  readPluginVersion,
  checkMoodleCompatibility,
  checkComponent,
  fetchCoreComponents,
  checkNotCoreComponent,
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
// A landing override is a path INSIDE the previewed site. Anything that walks
// out of it lands the reviewer somewhere else on the same origin — which on a
// shared origin means another of our own sites.
//
// Character-matched twice, wrong twice: first `//evil.tld` (protocol-relative,
// resolves to another origin), then `/../../../../mchef-urls/` (resolves to
// `/mchef-urls/`, demonstrated live). A regex answers "does it look like a
// path"; the question is "where does it END UP". So the charset stays a regex
// and the traversal is decided structurally, on segments, after decoding.
const LANDING_CHARS_RE =
  /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*(\?[A-Za-z0-9._~!$&'()*+,;=:@%/?&-]*)?$/;

/** Segments that walk up or stay put, in raw and percent-encoded forms. */
const TRAVERSAL_SEGMENT = /^(\.|%2e|\.\.|%2e%2e|%2e\.|\.%2e)$/i;

/**
 * @returns {{ok: boolean, reason?: string}}
 */
export function checkLandingPath(value) {
  const v = String(value);
  if (!v.startsWith("/")) return { ok: false, reason: "must start with /" };
  if (v.startsWith("//")) {
    // `//host/x` is protocol-relative: a browser reads it as another origin.
    return { ok: false, reason: "must not start with // (that is another origin)" };
  }
  if (!LANDING_CHARS_RE.test(v)) return { ok: false, reason: "contains characters a path may not" };
  const path = v.split("?")[0];
  for (const seg of path.split("/")) {
    if (TRAVERSAL_SEGMENT.test(seg)) {
      return { ok: false, reason: `contains a "${seg}" segment, which walks out of the site` };
    }
  }
  // Decode once and re-check: %2f can introduce a separator that hides a
  // traversal segment from the split above.
  let decoded;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return { ok: false, reason: "contains invalid percent-encoding" };
  }
  if (decoded !== path) {
    for (const seg of decoded.split("/")) {
      if (TRAVERSAL_SEGMENT.test(seg)) {
        return { ok: false, reason: `decodes to a "${seg}" segment, which walks out of the site` };
      }
    }
    if (decoded.startsWith("//")) return { ok: false, reason: "decodes to another origin" };
  }
  return { ok: true };
}
const PR_NUMBER_RE = /^\d+$/;
/** A review course backup is a fixture, not a data set. Bounded because it is
 * fetched from a URL at link-build time. */
export const MAX_MBZ_BYTES = 64 * 1024 * 1024;

/**
 * The sample review course, pinned to the commit that introduced it.
 *
 * Pinned rather than tracking a branch on purpose: a link is read weeks after
 * it is posted, and a branch address would quietly start serving a different
 * course — or stop serving one at all when the branch is deleted. This exact
 * file was produced by `make-fixture`, checked against
 * `fixtures/fixture-spec.json` in the run that produced it, and a preview
 * restoring it has been booted (4.4 backup into a 5.0 site, all ten activities
 * present).
 */
export const SAMPLE_COURSE_URL =
  "https://raw.githubusercontent.com/DavidUCL/githubactionsplayground/4a0e7afcec0298462b9b28f5a93a65b164f84a56/fixtures/review-course-MOODLE_404_STABLE.mbz";

/**
 * The reserved token a `choice` input uses to mean "leave this unset".
 *
 * `workflow_dispatch` has no unset state for a choice: every dropdown always
 * submits something. The previous answer was an English sentence in the
 * `default`, the same sentence in `options`, and a `${{ }}` ternary comparing
 * against it a third time — three copies per control, in YAML, where NOTHING
 * tests them. A mutation harness cannot reach inside a `${{ }}` expression.
 * Improve a dropdown label, forget the ternary, and the literal sentence
 * "default for the branch" is passed through as a PHP version.
 *
 * One token, passed verbatim by the YAML, resolved here where verify.sh can
 * mutation-test it. Parentheses are illegal in a PHP version, a username, a
 * component, a host, a course format and a language code, so it cannot be
 * confused with a real value.
 */
export const DEFAULT_SENTINEL = "(default)";

/** Read an optional input, resolving the sentinel to "unset". */
export function opt(value) {
  const v = String(value ?? "").trim();
  return v === DEFAULT_SENTINEL ? "" : v;
}

/**
 * Collects input failures instead of throwing at the first.
 *
 * main() used to throw on the first failed check, so three simultaneous
 * mistakes cost three runs and about five minutes to learn three things that
 * were all knowable in the first 200ms. Tolerable at nine inputs; at twenty it
 * becomes the dominant experience of using the form.
 */
export class Problems {
  constructor() {
    this.list = [];
  }
  /** @param {string} input the FORM FIELD at fault, not the internal check */
  add(input, message) {
    // Never drop a failure for want of wording. `if (message)` meant a verdict
    // of {ok:false} with no reason vanished, `any` stayed false, and the link
    // was built as though the check had passed — a guard that fails OPEN, in
    // the file whose whole subject is guards that fail closed.
    this.list.push({ input, message: message || "refused, but the check gave no reason" });
    return this;
  }
  /** Add when `check` is a {ok, reason} verdict; returns ok. */
  check(input, verdict) {
    if (verdict && verdict.ok === false) this.add(input, verdict.reason);
    return !verdict || verdict.ok !== false;
  }
  get any() {
    return this.list.length > 0;
  }
  /** One `::error title=<input>::` per problem, so GitHub annotates the run. */
  annotate(log = console.log) {
    for (const { input, message } of this.list) {
      // Annotations are one line: a newline would end the command and dump the
      // rest as plain output. Belt and braces — sanitiseForLog already strips
      // newlines (measured), so this is the guard that survives IT changing.
      log(`::error title=${sanitiseForLog(input)}::${sanitiseForLog(message).replace(/\r?\n/g, " ")}`);
    }
  }
  toError() {
    const n = this.list.length;
    const head =
      n === 1 ? this.list[0].message : `${n} inputs are wrong, all of them fixable before the next run:`;
    const body = n === 1 ? [] : this.list.map(({ input, message }) => `  - ${input}: ${message}`);
    const err = new Error([head, ...body].join("\n"));
    err.problems = this.list;
    return err;
  }
}

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
 * The counted controls, in ONE place: the fallback when the box is empty, and
 * the range a typed value is clamped to.
 *
 * There used to be two independent copies of every one of these numbers —
 * `main()`'s `clampCount` arguments and `buildBlueprint`'s parameter defaults —
 * and nothing compared them, because `main()` always passes the count
 * explicitly. So the parameter default was exercised only by tests and the
 * `main()` fallback only by real runs. MEASURED: changing the `main()` fallback
 * for `students` to 0 leaves all four golden snapshots, check 1o and the whole
 * unit suite green, while every adopter of `examples/pr-preview-workflow.yml`
 * — which passes no counts — gets a preview whose only enrolled learner does
 * not exist. A test comparing two constants would have caught that; one
 * constant makes it unrepresentable, which is better. What a test still has to
 * pin is the THIRD copy, in `preview/action.yml`, since YAML cannot import.
 */
/**
 * The course formats the `course-format` box offers, and the one it means by
 * "leave it alone". Core formats only — this table governs THE BOX, not the
 * blueprint: a course-format plugin under review legitimately sets a format
 * name that is not in here, which is the whole point of previewing it.
 *
 * WHY A CLOSED LIST AND NOT FREE TEXT. `create_course()` does not validate the
 * format at all (`course/lib.php:1969` inserts the row verbatim), and
 * `core_courseformat\base::get_format_or_default()` then substitutes the site
 * default with only a DEBUG_DEVELOPER message this runtime never displays.
 * `/course/view.php:142-144` overwrites the value in memory before the renderer
 * runs, so there is no error, no notice, and not even a body class: a typo in
 * this box would boot a perfectly healthy-looking `topics` course. The form is
 * a dropdown, but `preview/action.yml` accepts free text, so the refusal has to
 * live in JS.
 *
 * `singleactivity` is here and works, but it moves every displayable activity
 * out of section 0 and hides every section but that one — including the
 * preview's own Review brief, which is the only place the logins are written
 * down. `landingPath()` compensates; see the comment there.
 */
export const COURSE_FORMATS = ["topics", "weeks", "social", "singleactivity"];
export const DEFAULT_COURSE_FORMAT = "topics";

export const COUNT_INPUTS = {
  // 0 is a legal teacher count and 1 is the shape every preview had before the
  // control existed. The row is here rather than beside the control it serves
  // so that the one place holding these numbers stays the one place.
  teachers: { env: "TEACHERS", fallback: 1, min: 0, max: 2 },
  students: { env: "STUDENTS", fallback: 1, min: 1, max: 20 },
  sections: { env: "SECTIONS", fallback: 3, min: 1, max: 20 },
};

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
export function landingPath(type, name, { restored = false, courseFormat = "" } = {}) {
  // A RESTORED course is not created by us, so its id is not knowable when the
  // link is built — "Course restored (id 2)" held in every boot measured, but
  // it holds only while nothing else makes a course first, and that is exactly
  // the assumption COURSE_ID already encodes and should not encode twice.
  // Land by NAME instead: /course/view.php?name= resolves through MUST_EXIST,
  // so a missing course is a loud error page rather than someone else's course.
  //
  // This costs the `mod` add-form landing, which is the better review page
  // when there is no content. With a restored course there IS content, so
  // landing in it is the more useful place anyway.
  if (restored && (type === "mod" || type === "theme" || type === "format")) {
    return `/course/view.php?name=${COURSE_SHORTNAME}`;
  }
  // `singleactivity` needs `&section=1`, and this is the only format that needs
  // anything. It hides every section but 0 and MOVES every other displayable
  // activity out of section 0 into section 1 — including the preview's own
  // Review brief label, which is the only place the logins and the password are
  // written down. It then redirects a reviewer who lands on the bare course
  // page to "Adding a new Forum", because no single activity exists yet.
  //
  // `page_set_course()` returns without redirecting when a section is named and
  // the user can view hidden sections (the teacher and admin accounts this
  // preview creates both can), and the renderer is called as
  // `display($course, $section != 0)`, which draws the orphaned-activities page
  // — the one holding the brief. So `&section=1` both stops the redirect and
  // shows the reviewer the thing they need.
  const courseView = (fmt) =>
    fmt === "singleactivity"
      ? `/course/view.php?id=${COURSE_ID}&section=1`
      : `/course/view.php?id=${COURSE_ID}`;
  switch (type) {
    case "mod":
      // CONFIRMED in a browser: the real add form, which runs the plugin's own
      // mod_form. Deliberately NOT pre-adding via addModule — that writes
      // straight to course_modules and bypasses add_instance().
      return `/course/modedit.php?add=${name}&course=${COURSE_ID}&section=1`;
    case "theme":
    case "format":
      // Both are applied to the course, so a content page shows them working.
      return courseView(courseFormat);
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
/** student1..studentN, clamped: the URL is size-bound and 20 is already more
 * than any review needs. */
/** Surnames, so a participants list reads as people. The first is "Review",
 * unchanged from before the count was adjustable — a display name is not a
 * contract, but changing one for symmetry is churn a reviewer has to check. */
const TEACHER_SURNAMES = ["Review", "Second"];

const STUDENT_ORDINALS = [
  "One", "Two", "Three", "Four", "Five", "Six",
  "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve",
];

/**
 * Read a count, and SAY when the value was not usable rather than coercing in
 * silence. Returns the clamped number; the caller reports it, so what the
 * summary prints is what the blueprint got.
 */
export function clampCount(raw, fallback, min, max) {
  const s = String(raw ?? "").trim();
  if (s === "") return fallback;
  const n = Number(s);
  // sanitiseForLog, NOT the raw string. This value comes from an env var the
  // composite action accepts as free text, and a newline in it starts a new
  // line of runner output at column 0. Demonstrated:
  // STUDENTS=$'2\n::error::…\n::add-mask::secret' emitted interpreted workflow
  // commands — a forged annotation, and a mask that hides later output.
  if (!Number.isFinite(n)) {
    console.log(`note: ${JSON.stringify(sanitiseForLog(s).slice(0, 40))} is not a number — using ${fallback}`);
    return fallback;
  }
  // Truncation and clamping are DIFFERENT and used to print the same sentence:
  // 2.9 reported "2.9 is outside 1-20 — using 2", which is false twice over (it
  // is inside the range, and nothing was clamped). On a 0-2 domain the old
  // wording is worse still — "0.5 is outside 0-2" reads as a refusal.
  const truncated = Math.trunc(n);
  if (truncated !== n) console.log(`note: ${n} is not a whole number — using ${truncated}`);
  const clamped = Math.max(min, Math.min(max, truncated));
  if (clamped !== truncated) {
    console.log(`note: ${truncated} is outside ${min}-${max} — using ${clamped}`);
  }
  return clamped;
}

export function studentNames(n) {
  // Bounds from the table, like teacherNames. These were literals until a
  // review measured the consequence: raising COUNT_INPUTS.students.max to 30
  // left every test green while the summary claimed 25 student(s) over a
  // blueprint that created 20, and the login-as refusal advertised a range of
  // accounts that could not exist. Half a refactor is worse than none, because
  // the remaining literal looks like it was considered.
  const { min, max } = COUNT_INPUTS.students;
  const count = Math.max(min, Math.min(max, Number(n) || min));
  return Array.from({ length: count }, (_, i) => `student${i + 1}`);
}

/**
 * teacher, teacher2 — NOT teacher1, teacher2.
 *
 * The first one keeps the bare name it has always had: `login-as` validates
 * against it, and every link and saved `gh workflow run` command already shared
 * uses it. Renaming it to `teacher1` for symmetry would break all of them, and
 * would additionally reserve the commonest teacher username in real course
 * backups — Moodle's own backup generators produce `teacher1`
 * (`test/mbz.test.mjs`), and a reserved name is a refused backup.
 */
export function teacherNames(n) {
  const { min, max } = COUNT_INPUTS.teachers;
  const count = Math.max(min, Math.min(max, Number(n) || 0));
  return Array.from({ length: count }, (_, i) => (i === 0 ? "teacher" : `teacher${i + 1}`));
}

/**
 * Every account name the preview may sign a reviewer in as, at the given
 * counts. `admin` is made by `installMoodle` itself, not by `createUsers`.
 *
 * ONE definition, deliberately. This list was hand-copied at three sites — the
 * `login-as` name check, the follow-up count check, and the `.mbz` collision
 * refusal — and a name added to one and not another is silent in BOTH
 * directions: a valid account reported as nonexistent, or a colliding username
 * waved through into the half-built site that collision check exists to stop.
 */
export function accountNames(students, teachers) {
  return ["admin", ...teacherNames(teachers), ...studentNames(students)];
}

/**
 * Everything wrong with a `login-as` value, given the counts chosen alongside
 * it. Zero, one or two reasons; each names the FORM FIELD at fault.
 *
 * Pulled out of main() so it can be tested at all. It used to be three inline
 * `if`s among forty other lines of env reading, reachable only by running the
 * builder as a subprocess with a network — so the one thing here that is easy
 * to get wrong (which combinations refuse, and what they say) was covered by
 * nothing, and the mutation harness could not reach it either.
 *
 * NOT a replacement for the gate's own referential check. `checkReferences`
 * refuses a blueprint whose `login` names a user no `createUsers` makes, and it
 * must keep doing so — it is what protects a blueprint someone else supplies.
 * This exists so the person who typed the value gets a sentence naming the two
 * boxes that disagree, instead of "refusing to build a link from a blueprint
 * our own gate rejects". Neither may be deleted because the other exists.
 *
 * @returns {string[]}
 */
/**
 * Everything wrong with a `course-format` value, given what else was asked for.
 * Zero, one or more reasons; each names the FORM FIELD at fault.
 *
 * Pulled out of main() so it can be tested at all — and, this time, tested in
 * the same commit. The previous control learned the hard way that extracting a
 * function so it CAN be tested is not the same as testing it: three refusals
 * sat in main() where no unit test could reach them, and all three mutants
 * survived a full gate run.
 *
 * @returns {string[]}
 */
export function checkCourseFormat({ courseFormat, type, name, restoreUrl }) {
  if (!courseFormat) return [];
  const reasons = [];
  if (!COURSE_FORMATS.includes(courseFormat)) {
    // A closed list, because Moodle does not check this at all: an unknown
    // format is stored as typed and then rendered as the site default, with no
    // error, no notice and nothing in the boot log. Returning early — the
    // conflicts below are not worth reporting about a value that is not a
    // format, and one field with two rows was a real complaint on `login-as`.
    return [
      `must be one of ${COURSE_FORMATS.join(", ")} — got ${JSON.stringify(courseFormat)}. ` +
        `Moodle does NOT check this: an unknown format is stored as typed and then ` +
        `rendered as an ordinary topics course, with nothing in the log to say so.`,
    ];
  }
  // Two ways into one field. Refused rather than resolved: `format` is a single
  // key on a single step, so whichever value lost would leave no trace anywhere
  // — no step, no log line, nothing in the blueprint a reviewer could decode.
  // That is worse than the theme conflict this mirrors, where both setThemes at
  // least appear in the blueprint.
  if (type === "format") {
    reasons.push(
      `the plugin under review IS a course format (${type}_${name}), so the review ` +
        `course already uses it — setting this box to "${courseFormat}" as well would ` +
        `replace it, and the preview would show a format that is not the one being ` +
        `reviewed. Leave the box alone, or preview a different plugin.`,
    );
  }
  // A restored course brings its OWN format, and the restore branch emits no
  // createCourse step at all — so the box would be dropped at build time with
  // nothing said, exactly as `sections` was until a reviewer noticed. `sections`
  // was downgraded to a corrected summary because a wrong section count is
  // cosmetic. The format is the thing the reviewer is looking AT, so it is a
  // refusal.
  if (restoreUrl) {
    reasons.push(
      `a course backup brings its own format, and a restored course is not created ` +
        `by this preview — so "${courseFormat}" would be silently dropped and the ` +
        `reviewer would see whatever format the backup was cut in. Pick the backup ` +
        `or the format, not both.`,
    );
  }
  return reasons;
}

export function checkLoginAs({ loginAs, teachers, students }) {
  if (!loginAs) return [];
  const reasons = [];
  // Against the MAXIMUM of every count, so an account this preview could have
  // made is never called fictional. Whether the CHOSEN counts made it is the
  // separate question below — and reporting both at once produced two rows for
  // one field, the second advising a count raise that cannot help.
  const everyName = accountNames(COUNT_INPUTS.students.max, COUNT_INPUTS.teachers.max);
  if (!everyName.includes(loginAs)) {
    return [
      `must be admin, teacher, teacher2 or student1..student${COUNT_INPUTS.students.max} — ` +
        `those are the only accounts the blueprint creates. Got: ${JSON.stringify(loginAs)}`,
    ];
  }
  if (loginAs.startsWith("student") && !studentNames(students).includes(loginAs)) {
    reasons.push(
      `${loginAs} but only ${students} student account(s) are created — raise the student count`,
    );
  }
  if (loginAs.startsWith("teacher") && !teacherNames(teachers).includes(loginAs)) {
    reasons.push(
      teachers === 0
        ? `${loginAs}, but the teachers field is set to 0, so no teacher account is ` +
            `created — set teachers to 1 or 2, or sign in as admin or student1`
        : `${loginAs}, but the teachers field is set to ${teachers}, so only ` +
            `${teacherNames(teachers).join(", ")} ${teachers === 1 ? "is" : "are"} ` +
            `created — set teachers to 2, or sign in as teacher`,
    );
  }
  return reasons;
}

/**
 * Which account the finished blueprint signs the reviewer in as, READ BACK off
 * the login step rather than recomputed.
 *
 * There were three independent copies of this derivation — the login step, the
 * `preview-user` output and the summary's "signed in as" row — each re-deriving
 * the landing page in order to re-derive the user. A summary naming a different
 * account from the one the link actually uses is invisible to the reviewer,
 * who has no way to compare them.
 *
 * Exported because main() is not reachable from a test: with this inline, the
 * mutant that replaces it with a constant SURVIVED a full gate run.
 */
export function signedInAsOf(blueprint) {
  const login = blueprint.steps.find((s) => s.step === "login");
  if (!login?.username) {
    // Every blueprint this builder makes ends with a login. If one does not,
    // saying so beats printing "undefined" into the reviewer's summary.
    throw new Error("internal: the blueprint has no login step to report");
  }
  return login.username;
}

export function previewUser(landing, teachers = COUNT_INPUTS.teachers.fallback) {
  if (String(landing).startsWith("/admin/")) return "admin";
  // With no teacher there is nobody to be. `admin`, not `student1`: the default
  // landing page for a `mod` plugin is /course/modedit.php?add=... — an EDITING
  // form — so a student would arrive at a permission error on the commonest
  // kind of preview there is. admin is also the only account installMoodle
  // guarantees regardless of every other control, so this needs no truth table
  // if a student count of 0 ever exists.
  //
  // The cost is real and is stated out loud rather than hidden: admin
  // short-circuits has_capability() (accesslib.php) and is not ENROLLED, so
  // completion tracking never evaluates for it. A reviewer who wants a
  // capability-honest view has a control for that — login-as: student1.
  if (Number(teachers) === 0) return "admin";
  return "teacher";
}

/**
 * PHP version to pin for a Moodle branch. Every branch the action knows
 * accepts 8.3 today, so this is one entry per branch rather than a range —
 * but it exists so that a branch bundling a different range cannot silently
 * fall back to the playground's substitution. verify.sh check 1n fails if a
 * branch's lowest offered PHP stops satisfying the Moodle the bundle runs.
 * (This comment used to name check 1m, which is the accepted-origins check.)
 */
export const PHP_FOR_BRANCH = {
  MOODLE_404_STABLE: "8.3",
  MOODLE_405_STABLE: "8.3",
  MOODLE_500_STABLE: "8.3",
};

/**
 * PHP versions each branch actually accepts, from the playground's own
 * `version-resolver.js` `phpVersions`. They DIFFER — 4.x takes 8.1-8.3, 5.x
 * takes 8.2-8.4 — and the playground answers an invalid pair by silently
 * substituting 8.3 (`version-resolver.js:199-208`). So an unchecked php input
 * would let someone chase a PHP 8.1 bug on Moodle 5.0 and test 8.3 without
 * being told. Refuse the pair instead; gate check 1n fails if this drifts —
 * and until 2026-08-08 that was a LIE: there was no check 1n, and nothing
 * checked either PHP table. A comment claiming a guard is worse than none,
 * because the next person trusts it. The check now exists.
 */
export const PHP_BY_BRANCH = {
  MOODLE_404_STABLE: ["8.1", "8.2", "8.3"],
  MOODLE_405_STABLE: ["8.1", "8.2", "8.3"],
  MOODLE_500_STABLE: ["8.2", "8.3", "8.4"],
};

export const phpForBranch = (branch) => PHP_FOR_BRANCH[branch] ?? "8.3";

/** @returns {{ok: boolean, reason?: string}} */
export function checkPhpForBranch(php, branch) {
  if (!php) return { ok: true };
  const allowed = PHP_BY_BRANCH[branch];
  if (!allowed) {
    return { ok: true, reason: `unknown Moodle branch "${branch}" — PHP pairing not checked` };
  }
  if (!allowed.includes(php)) {
    return {
      ok: false,
      reason:
        `PHP ${php} is not available on ${branch} (it takes ${allowed.join(", ")}). ` +
        `The playground would silently substitute 8.3 and the preview would not ` +
        `be testing the PHP you asked for.`,
    };
  }
  return { ok: true };
}

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
  phpOverride = "",
  loginAs = "",
  // From the one table, so this default and main()'s fallback cannot drift
  // apart — they used to be separate literals that nothing compared.
  // The course format. "" means the box was left alone, in which case the
  // plugin under review decides (a format plugin previews itself) and topics is
  // the floor. Emitted UNCONDITIONALLY below.
  courseFormat = "",
  teachers = COUNT_INPUTS.teachers.fallback,
  students = COUNT_INPUTS.students.fallback,
  sections = COUNT_INPUTS.sections.fallback,
  // {url, info} from mbz.mjs when a course backup is being restored.
  restore = null,
  // Every plugin this preview installs, ALREADY IN INSTALL ORDER, one entry per
  // installMoodlePlugin step. Exactly one must be the commit under review.
  //
  // A list rather than a single step because `extra-plugins` exists: a plugin
  // that needs another plugin does not install, and Moodle enforces no
  // dependency during a scripted install (see extras.mjs). Ordering is decided
  // by the caller, which is the only place that knows what depends on what.
  installs = null,
  // The theme to switch the site to, as a plugin NAME (`boost_union`). Empty
  // means "whatever the plugin under review implies" — which is the theme
  // itself when a theme is under review, and Boost otherwise.
  themeName = "",
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

  // The default is the shape every preview had before extras existed: install
  // exactly the commit under review. Stated here rather than in the parameter
  // list because it is derived from two other parameters.
  const pluginInstalls = installs ?? [
    { url: pluginZipUrl(headRepo, headSha), pluginType: type, pluginName: name, isSelf: true },
  ];
  // The link's whole claim is that it boots THIS commit. A caller-supplied list
  // that lost it — through a sort, a filter, or a mis-set flag — must not
  // produce a link at all. The gate checks the same thing from the finished
  // blueprint (requireSelfUrl); this catches it at the point the mistake is
  // made, where the message can name the list.
  const selfUrl = pluginZipUrl(headRepo, headSha);
  if (!pluginInstalls.some((p) => p.url === selfUrl)) {
    throw new Error(
      `internal: the install list does not contain the commit under review (${selfUrl})`,
    );
  }

  // Which format the review course ends up in. Two ways in, ONE key: the box,
  // or a course-format plugin previewing itself. They cannot both apply and the
  // combination is refused in main(), because the loser of a duplicate key
  // leaves no trace anywhere at all.
  const activeFormat = courseFormat || (type === "format" ? name : DEFAULT_COURSE_FORMAT);
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
    // One installMoodlePlugin per plugin, in the order the caller decided.
    // `critical` on ALL of them, including the extras — verified against the
    // DEPLOYED executor, which says: "step failures are non-fatal by default
    // (ADR-0005). A step with `critical: true` aborts the remaining blueprint
    // on failure." The moodle-playground checkout in this tree is OLDER and
    // aborts on any throw, so reading only that source makes this look like a
    // no-op. It is not: without it, a failed install on the live host boots a
    // clean Moodle and the reviewer concludes the plugin does nothing. An
    // extra that fails is the same story one step removed — the plugin under
    // review then installs against a dependency that is not there.
    ...pluginInstalls.map((p) => ({
      step: "installMoodlePlugin",
      url: p.url,
      pluginType: p.pluginType,
      pluginName: p.pluginName,
      critical: true,
    })),
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
    // One course, made one of two ways. A restore REPLACES createCourse rather
    // than joining it: phpRestoreCourse only takes the shortname if no other
    // course holds it, so keeping both would leave the sample content in a
    // course silently named "restored" while REVIEW sat empty next to it.
    restore
      ? {
          step: "restoreCourse",
          url: restore.url,
          fullname: label,
          shortname: COURSE_SHORTNAME,
          category: "Review",
          critical: true,
        }
      : {
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
          // ALWAYS emitted, never conditional. Two reasons. The blueprint is
          // the artifact a reviewer can decode and read, and "no format key"
          // means "whatever the handler defaults to today", which is a fact
          // about someone else's code rather than about this preview. And
          // check 1o compares two controls by the VALUES their diffs change:
          // emitted conditionally, this control's diff has an empty value
          // signature, which is the weak half of the identical-diff test.
          // Behaviourally identical — phpCreateCourses already does
          // `course.format || "topics"`.
          //
          // A format plugin under review previews ITSELF, which is the analogue
          // of setTheme for themes. The box and a format plugin cannot both
          // apply, and that combination is refused in main() rather than
          // resolved here: they would be two values for one key in one object
          // literal, so the loser would leave no trace anywhere — not a step,
          // not a log line. That is worse than the theme conflict it mirrors,
          // where both setThemes are at least visible in the blueprint.
          format: activeFormat,
          numsections: sections,
        },
    // Immediately after the restore and BEFORE anything depends on the course:
    // restoreCourse cannot report a content failure (its handler catches and
    // bare-returns), so without this a restore that produced nothing carries on
    // and the reviewer gets a working-looking site with an empty course.
    ...(restore ? [buildRestoreAssertion({
      shortname: COURSE_SHORTNAME,
      modulenames: restore.info.modulenames,
      activityCount: restore.info.activityCount,
    })] : []),
    // ...and the format assertion, on the createCourse path, ONLY when the
    // format is not the default. A restored course brings its own format and
    // emits no createCourse step at all, which is why the box is REFUSED
    // alongside a restore rather than quietly dropped.
    //
    // NOT unconditional, and this is a departure from the written plan, made on
    // a measurement: the assertion is ~1.4 KB of PHP and takes the preview URL
    // from ~750 characters to 2117 on EVERY preview. `topics` is the default
    // and resolves to itself unless core itself is broken, so at the default
    // the step can only ever pass — the inert-assertion shape this project
    // gates against. Every case where the format CAN be wrong is a case where
    // it differs from the default: the box was set, or a format plugin is under
    // review and previews itself under its own name.
    ...(!restore && activeFormat !== DEFAULT_COURSE_FORMAT
      ? [buildCourseAssertion({ format: activeFormat, shortname: COURSE_SHORTNAME })]
      : []),
    {
      step: "createUsers",
      critical: true,
      users: [
        // TEACHERS FIRST, and the second one at index 1 — NOT appended after
        // the students. Two reasons, and the second is the one that bites.
        // Firstly the teachers belong together and `teacher` has always been
        // index 0. Secondly check 1o compares two controls by diffing their
        // blueprints ELEMENT BY ELEMENT over the common prefix: appended, a
        // `teachers` diff is byte-identical to a `students` diff, and the gate
        // refuses a CORRECT build for "two names for one thing". Measured
        // three times independently. Plant `1o-overlap` pins the gate half; the
        // `users[1].username` test below pins this half.
        ...teacherNames(teachers).map((u, i) => ({
          username: u,
          firstname: "Teacher",
          // "Review" for the first, so its display name is unchanged from every
          // preview built before this control existed.
          lastname: TEACHER_SURNAMES[i] ?? `Number ${i + 1}`,
        })),
        // student1..studentN. One is enough to see a plugin as a learner;
        // more matter for anything that lists, groups or grades people —
        // measured at ~280ms for 20, so the cost is not the reason to keep
        // the default small.
        ...studentNames(students).map((u, i) => ({
          username: u,
          firstname: "Student",
          // "One", "Two", … so a reviewer reading the participants list sees
          // names rather than indices. Beyond the list, fall back to the
          // number — nobody reviews with twelve students.
          lastname: STUDENT_ORDINALS[i] ?? `Number ${i + 1}`,
        })),
      ],
    },
    {
      step: "enrolUsers",
      critical: true,
      enrolments: [
        // Every teacher is an EDITING teacher. Moodle's non-editing `teacher`
        // role is a strict subset — 88 core capabilities are editingteacher-only
        // and NONE are teacher-only — so a quietly non-editing second teacher
        // could not add an activity of any kind, and would read as a bug in the
        // plugin under review rather than a choice made here.
        ...teacherNames(teachers).map((u) => ({
          username: u,
          course: COURSE_SHORTNAME,
          role: "editingteacher",
        })),
        ...studentNames(students).map((u) => ({
          username: u,
          course: COURSE_SHORTNAME,
          role: "student",
        })),
      ],
    },
  ];
  // COMPUTED HERE, above the review brief, because the brief has to say who the
  // reviewer arrives as — and the login STEP itself is pushed much further
  // down, after the theme. Two derivations of the same fact is how the summary
  // and the link came to disagree in the first place, so there is exactly one.
  const landing =
    landingOverride || landingPath(type, name, { restored: Boolean(restore), courseFormat: activeFormat });
  // `login-as` overrides the derived default. Derivation is a good default —
  // admin for admin pages, teacher elsewhere — but it cannot know you want to
  // see the plugin as a learner, and nothing else lets you.
  const loginUser = loginAs || previewUser(landing, teachers);

  // Read back off the steps rather than recomputed, so the brief cannot name a
  // set of accounts the blueprint did not actually create.
  const roster = [
    "admin",
    ...steps.find((s) => s.step === "createUsers").users.map((u) => u.username),
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
      // Enumerated, never hardcoded. This is the ONE artifact a reviewer reads
      // to find out who they can be, and it used to name `teacher` even in a
      // preview that has none — while the summary said nothing about teachers
      // at all. So a build that quietly made the wrong number of accounts
      // changed nothing a reviewer could see, before or after.
      `<ul><li>Logins: ${roster.map((u) => `<code>${escapeHtml(u)}</code>`).join(", ")}` +
      ` — password <code>password</code></li>` +
      `<li>Debugging is DEVELOPER: yellow boxes are deprecation notices, not crashes</li>` +
      `<li>Student view: user menu → Switch role to… → Student. That is a VIEW only —` +
      ` log in as <code>student1</code> for anything that owns data</li>` +
      // Keyed on the ACCOUNT THE REVIEWER ARRIVES AS, not on the count. Keyed
      // on `teachers === 0` it was wrong at both edges, and both are reachable:
      // at teachers:0 with login-as student1 — the combination action.yml
      // recommends — it told a student they were an administrator; and at
      // teachers:1 with an /admin/ landing page the reviewer IS admin and was
      // told nothing. The PR comment already keyed on the account; these two
      // now agree with it.
      // The caveat is about a SUBSTITUTION — you are admin because there was no
      // teacher to be — not about being admin at all. Keyed on `teachers === 0`
      // alone it told a reviewer who chose `login-as: student1` that they were
      // an administrator, which is the combination action.yml recommends. Keyed
      // on `loginUser === "admin"` alone it fires on every block, local, filter,
      // report and qtype preview, whose landing page REQUIRES admin and where
      // no other account was ever possible — noise in the one artifact a
      // reviewer is meant to read. Both conditions, therefore.
      (teachers === 0 && loginUser === "admin"
        ? `<li>This preview has NO teacher, so you are an administrator — who can ` +
          `open anything. This is not what the site looks like to a teacher</li>`
        : "") +
      `</ul>`,
  });

  // Everyone created must be enrolled. The review brief lists the roster from
  // `createUsers`, so a build that created two teachers and enrolled one would
  // produce a byte-identical brief AND a byte-identical summary — the reviewer
  // has no way to see the difference, and the account simply cannot reach the
  // course. Checked here rather than asserted in the boot, because it is
  // decidable at build time and a link should not exist at all.
  const created = steps.find((s) => s.step === "createUsers").users.map((u) => u.username);
  const enrolled = new Set(steps.find((s) => s.step === "enrolUsers").enrolments.map((e) => e.username));
  const unenrolled = created.filter((u) => !enrolled.has(u));
  if (unenrolled.length) {
    throw new Error(
      `internal: ${unenrolled.join(", ")} would be created but never enrolled — ` +
        `the account could not reach the review course, and nothing on screen would say so`,
    );
  }
  // The invariant is "exactly one course we control", not "exactly one
  // createCourse" — a restore makes the course too, and the original guard
  // refused that blueprint outright.
  const courseSteps = steps.filter((s) => s.step === "createCourse" || s.step === "restoreCourse");
  if (courseSteps.length !== 1) {
    throw new Error(
      `internal: the preview assumes exactly one course, found ${courseSteps.length}`,
    );
  }
  // Which theme the site ends up on. Two ways in, ONE step: the plugin under
  // review is itself a theme, or the `theme` box named one. They cannot both
  // apply — `planThemeControl` refuses that combination, because `set_config`
  // is last-write-wins and the loser is invisible.
  //
  // The warm-up rides with it in both cases. The self-theme path has been
  // missing it since the day it was written: the runtime warms `boost` and only
  // `boost` at boot, before the blueprint runs, so a theme activated here is
  // compiled lazily on the reviewer's first page view.
  const activeTheme = themeName || (type === "theme" ? name : "");
  if (activeTheme) {
    // `critical`, like everything else from createCategory onward. "The
    // DEPLOYED executor" used to appear here as if there were one: there are
    // two, and they differ. On ateeducacion a non-critical failure is non-fatal
    // (ADR-0005), so a setTheme that threw would let the boot carry on and the
    // reviewer would get stock Boost — which is why this flag is set. On
    // daviducl.github.io, the action's own default, any throw aborts and the
    // flag changes nothing. Setting it is right for both: it is the only one of
    // the two that needs saying, and it costs nothing where it is ignored.
    // (Measured 2026-08-17: executor.js is 2,687 bytes with zero occurrences of
    // "critical" on the default host, 4,649 bytes and four on the other.)
    steps.push({ step: "setTheme", name: activeTheme, critical: true });
    // The proof goes here, before login: everything it detects is invisible, so
    // a failure must stop the link being produced at all. The CSS build is a
    // SEPARATE, non-critical step further down — compiling a theme's SCSS is
    // the most expensive thing in the blueprint and the likeliest to exhaust
    // the WASM heap, and a heap abort is not catchable in PHP. With the two
    // joined, that abort took the whole preview down; split, the reviewer gets
    // an unstyled but working site, which is what this was always meant to do.
    steps.push(buildThemeAssertion(activeTheme));
  }
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

  steps.push({ step: "login", username: loginUser, critical: true });
  // Last, and non-critical. Everything the preview promises is done by now, so
  // the expensive part cannot cost the reviewer the preview itself.
  if (activeTheme) steps.push(buildThemeCssWarmup(activeTheme));
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
    preferredVersions: { php: phpOverride || phpForBranch(moodleBranch), moodle: moodleBranch },
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
export function assertGated(
  blueprint,
  { dataHosts = DEFAULT_DATA_HOSTS, requireSelfUrl, coreComponents } = {},
) {
  const { stepErrors, urlErrors, unsafeStrings, bindErrors, riskySteps } = gateBlueprint(
    blueprint,
    dataHosts,
    { ...(requireSelfUrl ? { requireSelfUrl } : {}), ...(coreComponents ? { coreComponents } : {}) },
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
// What this defends against is a NEWLINE. A value carrying one injects a
// second `name=value` line into $GITHUB_OUTPUT, letting a file-derived value
// forge `comment-body` — which the caller posts verbatim as the bot.
//
// It is a DENY-LIST, deliberately, after an allow-list of punctuation was
// wrong three times: no comma (a two-element `risky-steps` threw), then no `@`
// (an `owner/repo@sha` coordinate threw). Each time the throw landed AFTER
// `preview-url` was written, so the link still posted with the value stripped —
// the failure direction inverted, hurting most when there was most to say.
// An allow-list must be widened for every new value shape; the set of
// characters that can actually break `$GITHUB_OUTPUT` does not grow.
//
// C0 controls, DEL, and the Unicode line terminators U+2028/U+2029 (which some
// parsers treat as line breaks). Length is capped so a runaway value fails
// here rather than at GitHub's own limit.
const UNSAFE_OUTPUT_RE = /[\u0000-\u001f\u007f\u2028\u2029]/;
const MAX_OUTPUT_CHARS = 4096;

export function setOutput(name, value) {
  const str = String(value);
  if (UNSAFE_OUTPUT_RE.test(str)) {
    throw new Error(
      `refusing to emit output ${name}: it contains a control character or line ` +
        `terminator, which would inject a second line into $GITHUB_OUTPUT`,
    );
  }
  if (str.length > MAX_OUTPUT_CHARS) {
    throw new Error(`refusing to emit output ${name}: ${str.length} chars exceeds ${MAX_OUTPUT_CHARS}`);
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${str}\n`);
  } else {
    console.log(`output ${name}=${str}`);
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
/**
 * The run summary, as lines. A pure function of what was decided, so it can be
 * TESTED — it used to be a 60-line literal inside main(), reachable only by
 * running the builder as a subprocess with a network, and the mutation harness
 * proved the consequence: deleting the teacher count from it, and making it
 * name a different account from the one the link signs you in as, both survived
 * with the whole suite green.
 *
 * This is the reviewer's only summary of what the link will do. Nothing else
 * states the counts, the theme, or which Moodle was checked.
 */
export function previewSummary({
  type, name, headSha, url, component, headRepo, extras, moodleBranch,
  signedInAs, php, restore, teachers, students, sections, courseFormat, landingPage,
  versionPhp, core, risky, loginAs,
}) {
  return [
    "## ▶ Playground preview",
    "",
    `### [Open ${sanitiseForLog(`${type}_${name}`)} at ${headSha.slice(0, 7)}](${url})`,
    "",
    "| | |",
    "|---|---|",
    ...factRows({
      plugin: component,
      commit: headSha,
      repository: headRepo,
      // In INSTALL ORDER, which is the fact a reviewer cannot see any other
      // way: a dependency that arrived second is the difference between a
      // plugin that works and one that installed against nothing. Pinned to
      // commits, because that is what the link actually boots.
      "extra plugins": extras.list,
      // Its own row, at full length. A theme changes every page the reviewer
      // looks at, so "which theme, from which commit" is not a detail — and
      // without it there is nothing on the page saying a theme was applied at
      // all, which is indistinguishable from the failure where it was not.
      theme: extras.themeSummary,
      Moodle: moodleBranch,
      // The landing page MUST be computed the same way the link was, restore
      // included — otherwise the summary names the add-form path while the link
      // opens the course.
      "signed in as": signedInAs,
      PHP: php,
      // Do not claim a section count that a restore ignored.
      // From the CLAMPED values, and teachers included. Without the teacher
      // count here, a build that made the wrong number of them showed a
      // reviewer nothing different at all — the one genuinely invisible way
      // this control can be wrong, and it is cured by printing the number
      // rather than by asserting it inside the boot.
      course: restore
        ? `${teachers} teacher(s), ${students} student(s), restored from a backup ` +
          `(${restore.info.activityCount} activities)`
        : `${teachers} teacher(s), ${students} student(s), ${sections} section(s), ` +
          `${courseFormat} format`,
      "landing page": landingPage,
      "version.php": versionPhp || "not checked out — compatibility NOT checked",
      "core components": core.ok
        ? `${core.standard.size} from lib/plugins.json`
        : "NOT CHECKED — could not read Moodle's plugin list",
    }),
    "",
    // Same rule as the in-course brief and the PR comment: keyed on the account
    // the reviewer ARRIVES as. Keyed on `teachers === 0 && !loginAs` it was
    // silent for a reviewer who is admin for any other reason — an /admin/
    // landing page, or login-as: admin — which is most of the previews where
    // the caveat is worth reading.
    // Same rule as the in-course brief, and for the same reason: the caveat is
    // about arriving as admin BECAUSE there was no teacher. `!loginAs` was the
    // wrong second half — someone who explicitly asks for `login-as: admin`
    // alongside `teachers: 0` should still be told.
    // singleactivity is the one format that changes what the reviewer can see.
    // It hides every section but 0 and moves every other displayable activity
    // into section 1 — including this preview's own Review brief, which is the
    // only place the logins and the password are written down.
    ...(courseFormat === "singleactivity"
      ? [
          "> **`singleactivity` hides the course page.** It shows one activity and",
          "> nothing else, so the Review brief with the logins is not on it — the",
          "> landing page links straight to it, and the password is `password`.",
          "",
        ]
      : []),
    ...(teachers === 0 && signedInAs === "admin"
      ? [
          "> **No teacher was created, so you arrive as `admin`.** An administrator",
          "> can open anything, which is not what the site looks like to a teacher —",
          "> and capability checks a plugin relies on are bypassed.",
          "",
        ]
      : []),
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
  ];
}

function writeSummary(lines) {
  const body = lines.join("\n") + "\n";
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, body);
  } else {
    process.stdout.write(body);
  }
}

/** A markdown table cell: sanitised, with pipes escaped so one value
 * cannot become several columns. */
const cell = (v) => sanitiseForLog(String(v)).replace(/\|/g, "\\|");

function summariseRefusal(reason, facts, problems = []) {
  // With several problems the joined message is a wall of text. Give each one
  // its own row naming the FORM FIELD at fault, so the reader sees how many
  // things to fix and where each of them is.
  const problemRows = problems.length
    ? [
        "",
        `### ${problems.length} input${problems.length === 1 ? "" : "s"} to fix`,
        "",
        "| input | problem |",
        "|---|---|",
        // `|` is escaped because the message embeds raw form input
        // (JSON.stringify of landing-path), and an unescaped pipe splits the
        // row into extra columns and mangles the table.
        ...problems.map(
          ({ input, message }) =>
            `| \`${cell(input)}\` | ${cell(message)} |`,
        ),
      ]
    : [];
  writeSummary([
    "## 🚫 No preview link for this commit",
    "",
    `**${sanitiseForLog(problems.length > 1 ? String(reason).split("\n")[0] : String(reason))}**`,
    "",
    "No link was built, so nothing was posted. This is a refusal, not a crash:",
    "the check below decided the preview would have been misleading.",
    ...problemRows,
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

/**
 * Turn the `extra-plugins` and `theme` boxes into an ordered list of installs,
 * or into refusals that name the coordinate at fault.
 *
 * Nothing here is deferrable. A plugin that fails to install produces a boot
 * that looks entirely successful (installMoodlePlugin catches php.run errors
 * and returns success, moodle-plugins.js:322-345), and a dependency that is
 * simply absent produces a plugin that installs and then fails at whatever
 * moment it first calls the code that is not there. Both read to a reviewer as
 * "this pull request is broken".
 *
 * THE THEME IS A PLUGIN AND GOES THROUGH THE SAME PIPELINE. It is the same
 * coordinate, the same ref resolution, the same archive check, the same
 * version.php read, the same core-component refusal and the same dependency
 * sort — the only differences are that it installs into `theme/`, that it is
 * limited to one, and that it has a second file to read (config.php, for the
 * parents version.php never declares). A second pipeline for it is how the two
 * would drift, and every refusal above is one this repo has already paid for.
 *
 * @returns {Promise<{installs: object[], list: string, themeName: string, themeSummary: string}>}
 */
export async function planInstalls({
  raw,
  theme = null,
  self,
  headRepo,
  headSha,
  moodleBranch,
  core,
  problems,
  fetchImpl = fetch,
}) {
  const selfComponent = `${self.type}_${self.name}`;
  const selfInstall = {
    url: pluginZipUrl(headRepo, headSha),
    pluginType: self.type,
    pluginName: self.name,
    isSelf: true,
  };
  const only = { installs: [selfInstall], list: "", themeName: "", themeSummary: "" };
  const value = String(raw ?? "").trim();
  if (!value && !theme) return only;

  // Counted rather than read off `problems.any`: this function must not stop
  // because some OTHER input was wrong, and it must not carry on because
  // another input's problem made `any` true before it started.
  const before = problems.list.length;
  const failed = () => problems.list.length > before;

  // Each coordinate carries the FORM FIELD it came from, so a theme's refusal
  // is annotated against the theme box rather than against `extra-plugins`.
  // Sharing the pipeline must not mean sharing the blame.
  const groups = [];
  if (value) {
    const parsed = parseCoordinateList(value, { label: "extra plugin" });
    for (const p of parsed.problems) problems.add("extra-plugins", p);
    groups.push({ field: "extra-plugins", label: "extra plugin", items: parsed.items });
  }
  // Already parsed, and already refused for everything decidable from the
  // coordinate alone — see planThemeControl.
  if (theme) groups.push({ field: "theme", label: "theme", items: [theme] });
  if (failed()) return only;

  // Everything decidable from the coordinate ALONE, before a single request.
  // Ordering measured, not assumed: with these below the network work, asking
  // for `moodle/moodle@MOODLE_500_STABLE#mod_assign` was refused for having no
  // plugin-shaped version.php — true, but the wrong reason, and the right one
  // (it is Moodle's own component) would never have been printed.
  for (const g of groups) {
    for (const item of g.items) {
      if (item.component === selfComponent) {
        // The gate refuses this too, as a duplicate install target. Said here as
        // well because the gate's message is about a blueprint the user never
        // wrote, while this one names the box they typed it into.
        problems.add(
          g.field,
          `${g.label} ${item.component} is the plugin under review. The second archive ` +
            `would be extracted over the first file by file, and the page would still be ` +
            `headed with your commit while running the other one`,
        );
      }
      // Redundant for the theme, which planThemeControl already checked, and
      // kept anyway: this is the loop that runs for every coordinate, and a
      // guard wired into only some of its callers is the mistake this repo
      // made with 1c.
      const notCore = checkNotCoreComponent(item.type, item.name, core);
      if (!notCore.ok) problems.add(g.field, `${g.label} ${item.component}: ${notCore.reason}`);
    }
  }
  if (failed()) return only;

  for (const g of groups) {
    const resolved = await resolveCoordinates(g.items, { fetchImpl, label: g.label });
    for (const p of resolved.problems) problems.add(g.field, p);
    g.items = resolved.items;
  }
  if (failed()) return only;

  for (const g of groups) {
    for (const p of await checkArchives(g.items, { fetchImpl, label: g.label })) {
      problems.add(g.field, p);
    }
  }
  if (failed()) return only;

  const nodes = [];
  let themeNode = null;
  for (const g of groups) {
    for (const item of g.items) {
      const v = await fetchExtraVersion(item, { fetchImpl });
      if (!v.ok) {
        problems.add(g.field, `${g.label} ${item.component} ${v.reason}`);
        continue;
      }
      for (const p of checkExtraPlugin(item, v.declared, { moodleBranch, core, label: g.label })) {
        problems.add(g.field, p);
      }
      const node = {
        component: item.component,
        version: v.declared.version,
        dependencies: { ...v.declared.dependencies },
        item,
      };
      // A child theme's parent is NOT in version.php — it is `$THEME->parents`
      // in the theme's own config.php, which nothing above has read. Without
      // this, a theme whose parent is absent passes every check and renders
      // stock Boost.
      if (g.field === "theme") {
        const parents = await fetchThemeParents(item, { fetchImpl });
        if (!parents.ok) {
          problems.add("theme", `theme ${item.component} ${parents.reason}`);
          continue;
        }
        if (parents.note) console.log(`note: ${parents.note}`);
        for (const parent of parents.parents) {
          // ANY_VERSION: a parent theme carries no version requirement anywhere
          // we can read, so comparing one would be invented rather than measured.
          node.dependencies[`theme_${parent}`] = "ANY_VERSION";
        }
        themeNode = node;
      }
      nodes.push(node);
    }
  }
  if (failed()) return only;

  // The plugin under review is part of the dependency graph, not a special
  // case: it can depend on an extra, and an extra can depend on it.
  //
  // When its version.php could not be read, its dependencies are UNKNOWN, and
  // an empty list would quietly mean "none" — the state that satisfies every
  // check. Say so instead; the extras are still checked against each other.
  if (!self.declared) {
    console.log(
      "note: no version.php for the plugin under review, so ITS OWN dependencies " +
        "were not checked — only the extras' were",
    );
  }
  const selfNode = {
    component: selfComponent,
    version: self.declared?.version ?? null,
    dependencies: self.declared?.dependencies ?? {},
    isSelf: true,
    item: selfInstall,
  };
  const graph = [...nodes, selfNode];

  if (!core.ok) {
    // checkDependenciesSatisfied cannot tell a core component from a missing
    // one without Moodle's list, so it returns nothing. A skipped check must
    // never look like a passed one.
    console.log("note: dependencies NOT checked — Moodle's own component list did not load");
  }
  // A missing dependency is reported against the box that can fix it: adding
  // the parent theme is an `extra-plugins` edit even when the theme box is what
  // needed it.
  for (const p of checkDependenciesSatisfied(graph, core)) problems.add("extra-plugins", p);

  const ordered = orderInstalls(graph);
  if (!ordered.ok) problems.add("extra-plugins", ordered.reason);
  if (failed()) return only;

  return {
    installs: ordered.order.map((n) =>
      n.isSelf
        ? selfInstall
        : { url: coordinateZipUrl(n.item), pluginType: n.item.type, pluginName: n.item.name },
    ),
    // The NAME, never the component and never the repository: `setTheme` writes
    // it straight into set_config('theme', ...) and Moodle then looks for a
    // directory of exactly that name.
    themeName: themeNode ? themeNode.item.name : "",
    // At FULL length, on its own line in the summary. The 7-character
    // abbreviation used for the extras list is shared formatting and is being
    // dealt with separately; a theme is the one install whose effect is visible
    // on every page, so its provenance is worth the width.
    themeSummary: themeNode ? `${themeNode.component}@${themeNode.item.ref}` : "",
    // Commits, not the refs that were typed: what the link boots is the commit,
    // and a reviewer comparing the summary against the plugin's history needs
    // the same thing the URL carries.
    list: ordered.order
      .filter((n) => !n.isSelf && n !== themeNode)
      .map((n) => `${n.component}@${n.item.ref.slice(0, 7)}`)
      .join(", "),
  };
}

/**
 * Turn the `theme` box into ONE coordinate, or into refusals that name it.
 *
 * Everything decidable without a request lives here; the network work rides the
 * extras pipeline, because a theme is a plugin and duplicating that pipeline is
 * how the two would drift.
 *
 * WHY EVERY REFUSAL BELOW IS A REFUSAL AND NOT A WARNING. All three failures
 * land on the same screen: a Moodle rendering stock Boost, with a green run and
 * nothing in the log. `handleSetTheme` is `if (!step.name) throw` and then
 * `php.run(set_config('theme', name))` — it never checks the theme exists — and
 * `find_theme_location()` is a bare filesystem test for `theme/<name>/config.php`
 * (`lib/classes/output/theme_config.php:2107`). A name that resolves to nothing
 * falls back to Boost with a `debugging()` the playground's config never shows.
 *
 * @returns {{item: object|null}} an UNRESOLVED coordinate — its ref is still
 *   whatever was typed. Resolution, the archive check and the version.php read
 *   are the extras pipeline's job.
 */
export function planThemeControl({ raw, self, core, problems }) {
  const value = String(raw ?? "").trim();
  if (!value) return { item: null };

  // Counted, not read off `problems.any`: this must not stop because some other
  // input was wrong, and must not continue because another input's problem made
  // `any` true before it started.
  const before = problems.list.length;
  const failed = () => problems.list.length > before;
  const add = (message) => problems.add("theme", message);

  // The plugin under review is ITSELF a theme. The builder already emits
  // `setTheme` for it, so a second one would run too and `set_config` is
  // last-write-wins: the page stays headed with this pull request while the
  // site renders somebody else's theme. Refused here, where the intent is ours,
  // rather than in the gate — `preview-a-blueprint` runs foreign blueprints
  // through the same preflight and we do not own their intent.
  if (self.type === "theme") {
    add(
      `the plugin under review is itself a theme (theme_${self.name}), and the preview ` +
        `already switches to it. Setting the theme box as well would activate ` +
        `${JSON.stringify(value)} INSTEAD — last one wins — so the page would still be ` +
        `headed with your commit while showing a different theme. Leave the box empty.`,
    );
  }

  const parsed = parseCoordinateList(value, { max: 1, label: "theme" });
  for (const p of parsed.problems) add(p);
  if (failed()) return { item: null };

  const item = parsed.items[0];
  if (item.type !== "theme") {
    add(
      `${item.component} is not a theme. The archive would be extracted into ` +
        `${PLUGIN_TYPE_DIRS[item.type]}/, nothing would appear under theme/, and the ` +
        `activation step would succeed while the site kept stock Boost — no error, ` +
        `nothing in the log. Give a theme_* component.`,
    );
  }
  const notCore = checkNotCoreComponent(item.type, item.name, core);
  if (!notCore.ok) add(`theme ${item.component}: ${notCore.reason}`);

  if (failed()) return { item: null };
  return { item };
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

  // Moodle's OWN list of what it ships, from the branch under test. Replaces a
  // hand-written table that knew only about `atto`; this also catches
  // `assignment` and `tinymce`, and is right per branch — `mod_qbank` is core
  // on 5.0 and not on 4.5, so a static table is wrong for one of them.
  const core = await fetchCoreComponents(moodleBranch);
  if (!core.ok) {
    // Loud, not silent: a skipped check must never look like a passed one.
    console.log(`note: core-component collision NOT checked — ${core.reason}`);
  }

  // The resolved identity, whatever it came from. `plugin-component` is a
  // caller-supplied override that `derivePlugin` trusts above version.php and
  // validates only for SHAPE, so without this a caller could simply declare
  // themselves to be mod_assign.
  //
  // Deliberately redundant with the gate, which checks every plugin step and
  // catches the same input (measured — deleting this still refuses, via
  // "a blueprint our own gate rejects"). Kept because it names the problem
  // directly, and because it does not depend on the resolved identity
  // reaching a plugin step.
  const notCore = checkNotCoreComponent(type, name, core);
  // From here on, input failures are COLLECTED rather than thrown one at a
  // time. Everything below is a pure-string check on something the form
  // supplied, so all of it is knowable in one pass.
  const problems = new Problems();
  problems.check("plugin-component", notCore);

  // A parse we could not trust is a REFUSAL. It used to collapse to nulls, and
  // nulls pass every check — so an unreadable version.php was indistinguishable
  // from a permissive one.
  if (declared && declared.ok === false) {
    problems.add("version.php", declared.reason || "version.php could not be read reliably");
  } else if (declared) {
    // A component that disagrees with the install path is a silent failure:
    // upgrade_plugins skips a directory with no readable version.php without
    // saying anything, and the reviewer gets a Moodle with no plugin.
    problems.check("plugin-component", checkComponent(declared.component, type, name));

    const compat = checkMoodleCompatibility(declared, moodleBranch);
    problems.check("moodle-branch", compat);
    if (compat.ok && compat.reason) console.log(`note: ${compat.reason}`);
  }
  if (!declared) {
    // Not fatal. This repo's own dogfood previews a third-party plugin that
    // was never checked out, and that is a legitimate shape. Say plainly that
    // the strongest check was skipped rather than implying it passed.
    console.log(
      `note: no version.php on disk under ${JSON.stringify(sanitiseForLog(pluginRoot))} and none fetched for ` +
        `${headSha.slice(0, 7)} — Moodle-version compatibility NOT checked`,
    );
  }

  // A landing override must stay on the playground's own origin. Validated
  // here rather than trusted: `//evil.tld/x` and `https://evil.tld` both parse
  // as "somewhere else" to a browser, and schema.js accepts them (it does not
  // check), so the refusal has to be ours.
  // NOT opt(): landing-path is free text, so a literal "(default)" here is a
  // mistake to refuse, not a token to swallow. Only CHOICE inputs, which
  // cannot be left blank, use the sentinel.
  const landingOverride = (process.env.LANDING_PATH || "").trim();
  if (landingOverride) {
    const ok = checkLandingPath(landingOverride);
    if (!ok.ok) {
      problems.add("landing-path", `${ok.reason}: ${JSON.stringify(landingOverride)}`);
    }
  }
  const builtBy = (process.env.BUILT_BY || "").trim();

  // PHP is refused rather than substituted. The playground answers an invalid
  // branch/PHP pair by quietly using 8.3, so an unchecked value here would
  // produce a preview that is not testing what the summary says it is.
  const phpOverride = opt(process.env.PHP_VERSION);
  const phpOk = checkPhpForBranch(phpOverride, moodleBranch);
  problems.check("php-version", phpOk);
  if (phpOk.ok && phpOk.reason) console.log(`note: ${phpOk.reason}`);

  const loginAs = opt(process.env.LOGIN_AS);
  // The NAME check runs against the maximum of every count, so an account this
  // preview could have made is never reported as fictional. Whether it was
  // actually made at the CHOSEN counts is the separate check below.
  // Clamped HERE, not inside studentNames(), so the summary reports the number
  // actually created. It used to print the raw input: "-5 student(s)" while
  // building 1, "999" while building 20.
  const count = (id) => {
    const c = COUNT_INPUTS[id];
    return clampCount(process.env[c.env], c.fallback, c.min, c.max);
  };
  // The course format. `opt()` because it is a CHOICE input: "(default)" is the
  // reserved token a dropdown uses for "unset", since a choice cannot be blank.
  const courseFormat = opt(process.env.COURSE_FORMAT);
  for (const reason of checkCourseFormat({
    courseFormat,
    type,
    name,
    // Read straight from the env: the restore is fetched further down, and this
    // refusal is decidable from the text alone. Deciding it before any request
    // is the same rule the theme control follows.
    restoreUrl: opt(process.env.RESTORE_COURSE_URL) || opt(process.env.SAMPLE_CONTENT),
  })) {
    problems.add("course-format", reason);
  }
  const teachers = count("teachers");
  const students = count("students");
  const sections = count("sections");
  for (const reason of checkLoginAs({ loginAs, teachers, students })) {
    problems.add("login-as", reason);
  }

  const dataHosts = (process.env.DATA_HOSTS || "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  const hosts = dataHosts.length ? dataHosts : DEFAULT_DATA_HOSTS;

  // Other plugins to install before the one under review. Everything about
  // them is decided HERE, at link-build time: the ref becomes a commit, the
  // archive is proved to exist, its version.php is read, and the install order
  // is derived from what depends on what. None of it can be checked later —
  // a plugin that fails to install is invisible in the boot, and a missing
  // dependency is invisible until the moment the plugin uses it.
  // The theme to switch the site to. Parsed and refused FIRST, with no request
  // made: a theme box on a theme pull request, a non-theme component and a core
  // theme are all decidable from the text alone, and all three otherwise end as
  // a green run showing stock Boost.
  const themePlan = planThemeControl({
    raw: process.env.THEME,
    self: { type, name },
    core,
    problems,
  });

  const extras = await planInstalls({
    raw: process.env.EXTRA_PLUGINS,
    theme: themePlan.item,
    self: { type, name, declared },
    headRepo,
    headSha,
    moodleBranch,
    core,
    problems,
  });

  // A course backup to restore instead of building an empty course. Fetched
  // HERE, at link-build time, so a bad one is a refusal with a readable reason
  // rather than a boot that silently produces an empty course — restoreCourse
  // cannot report a content failure itself.
  // `sample-content` is a menu; `restore-course-url` is the escape hatch. They
  // feed ONE setting, because two names for one thing is how a form ends up
  // with a menu saying one course and a box saying another.
  const sampleContent = opt(process.env.SAMPLE_CONTENT);
  const typedUrl = opt(process.env.RESTORE_COURSE_URL);
  if (sampleContent && typedUrl) {
    problems.add(
      "sample-content",
      `both a sample course ("${sampleContent}") and a course backup address were ` +
        `given, and only one course can be restored. Pick the menu or the address, ` +
        `not both.`,
    );
  }
  const restoreUrl =
    typedUrl || (sampleContent === "review-course" ? SAMPLE_COURSE_URL : "");
  let restore = null;
  if (restoreUrl) {
    const urlProblem = checkUrl(restoreUrl, hosts);
    if (urlProblem) {
      problems.add("restore-course-url", urlProblem);
    } else {
      try {
        const res = await fetch(restoreUrl, { signal: AbortSignal.timeout(30000), redirect: "error" });
        if (!res.ok) {
          problems.add("restore-course-url", `HTTP ${res.status} fetching the course backup`);
        } else {
          const bytes = Buffer.from(await res.arrayBuffer());
          if (bytes.length > MAX_MBZ_BYTES) {
            problems.add("restore-course-url", `the backup is ${bytes.length} bytes, over the ${MAX_MBZ_BYTES} cap`);
          } else {
            const verdict = checkCourseBackup(bytes);
            if (!verdict.ok) problems.add("restore-course-url", verdict.reason);
            else {
              // A backup that carries users will CREATE them on restore, and a
              // preview account of the same name then fails to create. Measured
              // by booting: the restore succeeded, the assertion passed, and
              // createUsers died with exit code 1 five steps in, leaving a
              // half-built site. Refuse at link-build time instead.
              // The MAXIMUM of every count, not the counts actually chosen. A
              // list computed from the chosen counts is a second expression for
              // "who gets created", and every way it can drift lands on the
              // ACCEPT side — which is the half-built site this refusal exists
              // to prevent. Reserving a name the preview did not make costs one
              // avoidable refusal with a readable reason; the other direction
              // costs a boot that dies five steps in.
              const mine = accountNames(COUNT_INPUTS.students.max, COUNT_INPUTS.teachers.max);
              const clash = (verdict.info.usernames ?? []).filter((u) => mine.includes(u));
              if (clash.length) {
                problems.add(
                  "restore-course-url",
                  // "reserves", not "also creates". At the default counts the
                  // preview does not create student5 — but it may, so the name
                  // is refused, and the old wording made that a plain untruth.
                  `the backup creates user(s) ${clash.join(", ")}, which the preview reserves ` +
                    `for its own accounts (${mine.filter((n) => !n.startsWith("student")).join(", ")}, ` +
                    `student1-student${COUNT_INPUTS.students.max}) — ` +
                    `createUsers would fail mid-boot and leave a half-built site. ` +
                    `Use a course backup whose users do not include ${clash.join(", ")}.`,
                );
              } else {
                restore = { url: restoreUrl, info: verdict.info };
              }
            }
          }
        }
      } catch (err) {
        problems.add("restore-course-url", `could not fetch the course backup: ${err.message}`);
      }
    }
  }

  // A restored course arrives with its own sections and its own format —
  // restoreCourse takes neither (moodle-restore.js accepts fullname, shortname,
  // category, createCategory, visible). Both were being dropped in silence
  // while the summary still printed "10 section(s)", and a course-format plugin
  // previewed this way showed an ordinary topics course, so the reviewer
  // concluded the plugin was broken. Found independently by two reviewers.
  //
  // Sections are merely ignored, so the summary is corrected below. A FORMAT
  // plugin is different: the whole point of the preview is to see the format,
  // and a restored course cannot show it. Refuse rather than mislead.
  if (restoreUrl && type === "format") {
    problems.add(
      "restore-course-url",
      `a course-format plugin cannot be previewed against a restored course: the ` +
        `backup brings its own format, so "${name}" would never be applied and the ` +
        `reviewer would see an ordinary course and conclude the plugin is broken`,
    );
  }

  // One throw for everything above. Annotations first, so GitHub shows a marker
  // against each offending field even though the run ends here.
  if (problems.any) {
    problems.annotate();
    throw problems.toError();
  }

  const blueprint = buildBlueprint({
    headRepo,
    headSha,
    prNumber,
    type,
    name,
    moodleBranch,
    landingOverride,
    builtBy,
    phpOverride,
    loginAs,
    courseFormat,
    teachers,
    students,
    sections,
    restore,
    installs: extras.installs,
    themeName: extras.themeName,
  });
  // Hosts other plugins may come from. Comma separated, trimmed, empties
  // dropped so a trailing comma is not a silent empty-string host.
  const url = buildPreviewUrl({
    playgroundHost,
    blueprint,
    dataHosts: hosts,
    requireSelfUrl: pluginZipUrl(headRepo, headSha),
  });

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "preview-blueprint.json"), JSON.stringify(blueprint, null, 2));
  writeFileSync(join(outDir, "preview-url.txt"), url + "\n");

  // ORDER IS LOAD-BEARING: `preview-url` is written LAST.
  //
  // Three separate incidents had the same shape — an output threw AFTER the
  // link was already in $GITHUB_OUTPUT, so the caller's `if: always()` posting
  // step published the link with the qualifying information stripped. The
  // reviewer got a link and no warning. Emitting the link last means any
  // failure above it leaves NO link to post, which is the safe direction.
  const risky = assertGated(blueprint, {
    dataHosts: hosts,
    requireSelfUrl: pluginZipUrl(headRepo, headSha),
    coreComponents: core,
  });
  setOutput("plugin-type", type);
  setOutput("plugin-name", name);
  setOutput("head-sha", headSha);
  setOutput("plugin-component", declared?.component || `${type}_${name}`);
  // READ BACK off the finished blueprint, not recomputed. There were three
  // independent copies of this expression — the login step, this output and the
  // summary row — each re-deriving the landing page to re-derive the user. A
  // summary naming a different account from the one the link signs you in as is
  // exactly the kind of wrong a reviewer cannot see.
  const signedInAs = signedInAsOf(blueprint);
  setOutput("preview-user", signedInAs);
  setOutput("risky-steps", risky.join(","));
  setOutput("preview-url", url);
  if (risky.length) {
    console.log(
      `note: this blueprint can rewrite Moodle after installing — ${risky.join(", ")}`,
    );
  }
  console.log(`preview: ${type}_${name} @ ${headSha.slice(0, 7)} (${url.length} chars)`);

  writeSummary(previewSummary({
    type,
    name,
    headSha,
    url,
    component: declared?.component || `${type}_${name}`,
    headRepo,
    extras,
    moodleBranch,
    signedInAs,
    php: phpOverride || phpForBranch(moodleBranch),
    restore,
    teachers,
    students,
    sections,
    // The RESOLVED format, so the summary names what the course is actually in
    // — which for a course-format plugin under review is the plugin's own name,
    // not anything the box says.
    courseFormat: courseFormat || (type === "format" ? name : DEFAULT_COURSE_FORMAT),
    landingPage:
      landingOverride ||
      landingPath(type, name, {
        restored: Boolean(restore),
        // The summary must compute the landing page the SAME way the link did.
        // singleactivity is the one format that changes it, and a summary
        // naming a different page from the one the link opens is invisible to
        // the reviewer, who sees only one of them.
        courseFormat: courseFormat || (type === "format" ? name : DEFAULT_COURSE_FORMAT),
      }),
    versionPhp: declared ? declared.path : "",
    core,
    risky,
    loginAs,
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (err) {
    // A refusal is the designed outcome of several checks, and its wording is
    // the whole point. Put it where a human will see it, then still fail —
    // the caller decides what to do with a red step.
    summariseRefusal(
      err?.message ?? String(err),
      {
        repository: process.env.HEAD_REPO,
        commit: process.env.HEAD_SHA,
        Moodle: process.env.MOODLE_BRANCH || DEFAULT_MOODLE_BRANCH,
        "plugin root": process.env.PLUGIN_ROOT || ".",
      },
      err?.problems ?? [],
    );
    // sanitiseForLog, because this text is built from env values the caller
    // supplied. Problems.annotate() already sanitises the same strings on the
    // way to stdout — dumping the raw stack here undid that for any message
    // that did not happen to wrap its value in JSON.stringify.
    console.error(sanitiseForLog(err?.stack ?? String(err)));
    process.exit(1);
  }
}
