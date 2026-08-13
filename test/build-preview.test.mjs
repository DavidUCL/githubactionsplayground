// The preview link is a truth claim: "this opens the code in this PR". These
// tests exist to stop it quietly becoming false. Every "must refuse" case
// below corresponds to a way a plausible-looking link boots the wrong code.

import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import {
  derivePlugin,
  landingPath,
  buildBlueprint,
  buildPreviewUrl,
  encodeBlueprint,
  assertNoPlaceholders,
  FORBIDDEN_PARAMS,
  DEFAULT_DATA_HOSTS,
  pluginZipUrl,
  checkLandingPath,
  PHP_BY_BRANCH,
  checkPhpForBranch,
  studentNames,
} from "../scripts/build-preview.mjs";

const SHA = "d0638b39df1c28fd93c27778ae2cbada7cc1660f";
const base = {
  headRepo: "DavidUCL/moodle-mod_attendance",
  headSha: SHA,
  prNumber: "42",
  type: "mod",
  name: "attendance",
};
const decode = (url) => {
  const b64 = new URL(url).searchParams.get("blueprint");
  const bytes = Buffer.from(b64.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return JSON.parse(gunzipSync(bytes).toString("utf8"));
};

// ---- plugin identity -----------------------------------------------------

test("derives type and name from the repo naming convention", () => {
  assert.deepEqual(derivePlugin("DavidUCL/moodle-mod_attendance"), {
    type: "mod",
    name: "attendance",
  });
  assert.deepEqual(derivePlugin("x/moodle-theme_boost_union"), {
    type: "theme",
    name: "boost_union",
  });
});

test("the moodle- prefix is optional — plenty of repos omit it", () => {
  // `local_myplugin` is a perfectly normal repo name; requiring the prefix
  // made the action refuse it and demand explicit inputs.
  assert.deepEqual(derivePlugin("DavidUCL/local_myplugin"), {
    type: "local",
    name: "myplugin",
  });
  assert.deepEqual(derivePlugin("x/theme_boost_union"), {
    type: "theme",
    name: "boost_union",
  });
});

test("explicit values override inference", () => {
  const p = derivePlugin("x/anything-at-all", { type: "local", name: "thing" });
  assert.deepEqual(p, { type: "local", name: "thing" });
});

test("refuses a repo it cannot resolve rather than guessing", () => {
  assert.throws(() => derivePlugin("x/my-plugin"), /pass plugin-type explicitly/);
});

test("refuses an activity module name with an underscore", () => {
  // modedit.php reads it as PARAM_ALPHANUM and would strip the underscore,
  // opening the add form for a different module entirely.
  assert.throws(() => derivePlugin("x/moodle-mod_my_thing"), /underscore/);
  // Other types may legitimately contain one.
  assert.deepEqual(derivePlugin("x/moodle-theme_boost_union"),
    { type: "theme", name: "boost_union" });
});

test("refuses a plugin type Moodle does not have", () => {
  assert.throws(() => derivePlugin("x/y", { type: "notatype", name: "a" }), /plugin type/);
});

// ---- the link must be pinned to a commit ---------------------------------

test("the ZIP URL is pinned to the head commit", () => {
  const bp = buildBlueprint(base);
  const install = bp.steps.find((s) => s.step === "installMoodlePlugin");
  assert.equal(install.url, `https://github.com/${base.headRepo}/archive/${SHA}.zip`);
});

test("refuses a branch ref — it would show later commits and 404 after merge", () => {
  for (const bad of ["main", "refs/heads/main", "HEAD", SHA.slice(0, 7)]) {
    assert.throws(() => buildBlueprint({ ...base, headSha: bad }), /40-hex commit/);
  }
});

test("refuses a malformed repo", () => {
  assert.throws(() => buildBlueprint({ ...base, headRepo: "not-a-repo" }), /bad repo/);
});

// ---- the link must not be rewritable after posting ------------------------

test("refuses placeholders anywhere in the blueprint", () => {
  const bp = buildBlueprint(base);
  bp.steps[3].url = "https://raw.githubusercontent.com/{{REPO}}/{{REF}}/p.zip";
  assert.throws(() => assertNoPlaceholders(bp), /placeholder syntax is banned/);
  assert.throws(() => buildPreviewUrl({ playgroundHost: "https://x.example", blueprint: bp }), /placeholder/);
});

test("a blueprint our own step-gate would reject is never turned into a link", () => {
  // We built preflight's gate and were not using it here. A typo'd or banned
  // step is not caught by the inline path at runtime — the playground silently
  // falls back to its starter blueprint, so the reviewer gets a clean Moodle.
  // A risky step (runPhpCode, writeFile) no longer blocks — those are reported
  // instead. An UNKNOWN name still does, and that is the case that matters
  // here: the inline path never validates, so a typo silently boots the
  // playground's own starter blueprint and the reviewer gets a clean Moodle.
  const banned = buildBlueprint(base);
  banned.steps.push({ step: "instalMoodle", code: "typo" });
  assert.throws(
    () => buildPreviewUrl({ playgroundHost: "https://moodle-playground.com", blueprint: banned }),
    /our own gate rejects/,
  );

  const offHost = buildBlueprint(base);
  offHost.steps.find((st) => st.step === "installMoodlePlugin").url =
    "https://evil.example/plugin.zip";
  assert.throws(
    () => buildPreviewUrl({ playgroundHost: "https://moodle-playground.com", blueprint: offHost }),
    /our own gate rejects/,
  );
});

test("the finished URL carries only the blueprint parameter", () => {
  const url = buildPreviewUrl({
    playgroundHost: "https://moodle-playground.com",
    blueprint: buildBlueprint(base),
  });
  const params = [...new URL(url).searchParams.keys()];
  assert.deepEqual(params, ["blueprint"]);
});

test("refuses a host that already carries override params", () => {
  for (const host of [
    "https://moodle-playground.com/?ref=evil",
    "https://moodle-playground.com/?repo=evil/evil",
  ]) {
    assert.throws(() => buildPreviewUrl({ playgroundHost: host, blueprint: buildBlueprint(base) }), /no query/);
  }
});

test("refuses a non-https playground host", () => {
  assert.throws(
    () => buildPreviewUrl({ playgroundHost: "http://moodle-playground.com", blueprint: buildBlueprint(base) }),
    /https/,
  );
});

// ---- the blueprint has to survive the round trip -------------------------

test("the encoded blueprint decodes back to exactly what we built", () => {
  const bp = buildBlueprint(base);
  const url = buildPreviewUrl({ playgroundHost: "https://moodle-playground.com", blueprint: bp });
  assert.deepEqual(decode(url), bp);
});

test("the encoding is gzip + base64url, which is what the parser detects", () => {
  const encoded = encodeBlueprint(buildBlueprint(base));
  assert.equal(/^[A-Za-z0-9_-]+$/.test(encoded), true, "must be url-safe and unpadded");
  const bytes = Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  assert.equal(bytes[0], 0x1f);
  assert.equal(bytes[1], 0x8b);
});

test("the URL stays well inside what a comment and a browser will carry", () => {
  const url = buildPreviewUrl({
    playgroundHost: "https://moodle-playground.com",
    blueprint: buildBlueprint(base),
  });
  // Measured ~750; anything approaching 2000 means the blueprint grew a step
  // it should not have, so keep the bound tight enough to notice.
  assert.equal(url.length < 1200, true, `url was ${url.length} chars`);
});

// ---- the reviewer must be able to tell what they are looking at ----------

test("the review course names the PR and the commit", () => {
  const course = buildBlueprint(base).steps.find((s) => s.step === "createCourse");
  assert.match(course.fullname, /PR #42/);
  // Exact, not "contains a prefix": a 12-char sha would pass a loose match
  // while the comment shows 7, and the reviewer's cross-check would fail.
  assert.equal(course.fullname, `PR #42 · ${SHA.slice(0, 7)} · mod_attendance`);
});

test("works without a PR number (manual runs) and still names the commit", () => {
  const course = buildBlueprint({ ...base, prNumber: "" }).steps.find((s) => s.step === "createCourse");
  assert.match(course.fullname, new RegExp(SHA.slice(0, 7)));
  assert.equal(course.fullname.includes("PR #"), false);
});

// ---- the reviewer must land somewhere useful ----------------------------

test("a mod lands on the add form, NOT a pre-added instance", () => {
  // addModule inserts straight into course_modules and bypasses the plugin's
  // add_instance(), so a pre-added activity often renders blank and the
  // reviewer wrongly fails a working plugin.
  const bp = buildBlueprint(base);
  // A `label` IS pre-added (the review brief) — that is core, trivial, and
  // safe. What must never be pre-added is the PLUGIN under review.
  for (const st of bp.steps.filter((s) => s.step === "addModule")) {
    assert.notEqual(st.module, base.name, "the reviewed plugin must not be pre-added");
    assert.equal(st.module, "label");
  }
  const landing = bp.steps.find((s) => s.step === "setLandingPage");
  assert.match(landing.path, /modedit\.php\?add=attendance/);
});

// Landing-page policy is asserted in preview-snapshot.test.mjs, which also
// pins the types that are NOT given a bespoke page.

test("a theme is activated after it is installed, with its own name", () => {
  const bp = buildBlueprint({ ...base, type: "theme", name: "boost_union" });
  const install = bp.steps.findIndex((s) => s.step === "installMoodlePlugin");
  const idx = bp.steps.findIndex((s) => s.step === "setTheme");
  assert.equal(idx > install, true, "setTheme must follow the install");
  assert.equal(bp.steps[idx].name, "boost_union");
});

// ---- the site must show real problems -----------------------------------

test("developer debugging is on, so deprecations are visible", () => {
  const cfg = buildBlueprint(base).steps.find((s) => s.step === "setConfigs");
  const debug = cfg.configs.find((c) => c.name === "debug");
  assert.equal(debug.value, "32767");
  assert.equal(cfg.configs.find((c) => c.name === "debugdisplay").value, "1");
});

test("mail is disabled, or debugging turns enrolment into a wall of backtrace", () => {
  // Live run before this: enrolUsers printed a full email_to_user stack that
  // reads like a plugin fault. Debugging is only useful if the noise is real.
  const cfg = buildBlueprint(base).steps.find((s) => s.step === "setConfigs");
  assert.equal(cfg.configs.find((c) => c.name === "noemailever").value, "1");
  // noemailever alone only swaps the message for "Not sending email due to
  // ...", still a full backtrace. The welcome message must not be generated.
  const welcome = cfg.configs.find((c) => c.name === "sendcoursewelcomemessage");
  assert.equal(welcome.value, "0");
  assert.equal(welcome.plugin, "enrol_manual");
});

test("a teacher and a student exist and are enrolled in the review course", () => {
  const bp = buildBlueprint(base);
  const users = bp.steps.find((s) => s.step === "createUsers").users.map((u) => u.username);
  assert.deepEqual(users, ["teacher", "student1"]);
  const roles = bp.steps.find((s) => s.step === "enrolUsers").enrolments.map((e) => e.role);
  assert.deepEqual(roles, ["editingteacher", "student"]);
});

test("every step name is one the playground actually registers", () => {
  // Guards against inventing a step: an unknown step aborts the whole boot.
  const known = new Set([
    "installMoodle", "login", "setConfigs", "installMoodlePlugin", "createCategory",
    "createCourse", "createUsers", "enrolUsers", "addModule", "setTheme", "setLandingPage",
  ]);
  for (const s of buildBlueprint(base).steps) {
    assert.equal(known.has(s.step), true, `unknown step: ${s.step}`);
  }
});

// Runtime versions resolve "URL params > blueprint > defaults"
// (moodle-playground shell/main.js:575), so a version param overrides the
// blueprint's own preferredVersions — the link would boot a different Moodle
// from the one the plugin was checked against, and still look correct.
// The proxy params decide who the preview's network traffic goes THROUGH:
// phpCorsProxyUrl reaches the PHP runtime's tcpOverFetch tunnel, addonProxyUrl
// decides who serves the plugin ZIP. Either would let a link route traffic via
// someone else's server while still reading as the playground.
for (const param of [
  "moodle", "moodleBranch", "php", "phpVersion",
  "addonProxyUrl", "phpCorsProxyUrl",
]) {
  test(`a playground host carrying ?${param}= is refused`, () => {
    const bp = buildBlueprint({ ...base, type: "mod", name: "attendance" });
    assert.throws(
      () => buildPreviewUrl({
        playgroundHost: `https://moodle-playground.com/?${param}=MOODLE_501_STABLE`,
        blueprint: bp,
      }),
      /must carry no query/,
    );
  });

  test(`${param} is on the forbidden list, so a finished link can never carry it`, () => {
    // The host guard above already rejects any query, making this belt and
    // braces — but it is the belt that has to hold if a future change ever
    // adds a parameter of its own.
    assert.ok(FORBIDDEN_PARAMS.includes(param));
  });
}

test("the emitted link carries the blueprint and nothing else", () => {
  const bp = buildBlueprint({ ...base, type: "mod", name: "attendance" });
  const url = new URL(buildPreviewUrl({
    playgroundHost: "https://moodle-playground.com",
    blueprint: bp,
  }));
  assert.deepEqual([...url.searchParams.keys()], ["blueprint"]);
});

// The commit under review must be INSTALLED, not merely named. A blueprint may
// install any number of other plugins — dependencies, third-party plugins the
// reviewer needs — but omitting your own is what makes the link a lie: the
// course heading still reads "PR #42 · <sha> · mod_x" because we build that
// from the event, so the page would actively confirm the wrong thing.
test("a blueprint that installs OTHER plugins alongside this one is accepted", () => {
  const bp = buildBlueprint({ ...base, type: "mod", name: "attendance" });
  bp.steps.splice(3, 0, {
    step: "installMoodlePlugin",
    url: "https://github.com/someone/moodle-local_dependency/archive/" + "a".repeat(40) + ".zip",
    pluginType: "local",
    pluginName: "dependency",
  });
  assert.doesNotThrow(() =>
    buildPreviewUrl({
      playgroundHost: "https://moodle-playground.com",
      blueprint: bp,
      requireSelfUrl: pluginZipUrl(base.headRepo, base.headSha),
    }),
  );
});

test("a blueprint that omits this commit's plugin is refused", () => {
  const bp = buildBlueprint({ ...base, type: "mod", name: "attendance" });
  const install = bp.steps.find((s) => s.step === "installMoodlePlugin");
  install.url = "https://github.com/someone-else/moodle-mod_other/archive/" + "b".repeat(40) + ".zip";
  assert.throws(
    () =>
      buildPreviewUrl({
        playgroundHost: "https://moodle-playground.com",
        blueprint: bp,
        requireSelfUrl: pluginZipUrl(base.headRepo, base.headSha),
      }),
    /no plugin step installs the commit under review/,
  );
});

test("a dependency on a host outside the allowlist is refused", () => {
  const bp = buildBlueprint({ ...base, type: "mod", name: "attendance" });
  bp.steps.splice(3, 0, {
    step: "installMoodlePlugin",
    url: "https://gitlab.example/group/plugin/-/archive/x/plugin.zip",
    pluginType: "local",
    pluginName: "dep",
  });
  assert.throws(
    () => buildPreviewUrl({ playgroundHost: "https://moodle-playground.com", blueprint: bp }),
    /gate rejects/,
  );
});

test("...and accepted once that host is added to data-hosts", () => {
  const bp = buildBlueprint({ ...base, type: "mod", name: "attendance" });
  bp.steps.splice(3, 0, {
    step: "installMoodlePlugin",
    url: "https://gitlab.example/group/plugin/-/archive/x/plugin.zip",
    pluginType: "local",
    pluginName: "dep",
  });
  assert.doesNotThrow(() =>
    buildPreviewUrl({
      playgroundHost: "https://moodle-playground.com",
      blueprint: bp,
      dataHosts: [...DEFAULT_DATA_HOSTS, "gitlab.example"],
      requireSelfUrl: pluginZipUrl(base.headRepo, base.headSha),
    }),
  );
});

test("every URL param the playground reads is forbidden in a link", () => {
  // version-resolver.js reads exactly these from the URL. `debug` and
  // `profile` are deliberately absent: they change logging verbosity, not what
  // code runs or where it comes from.
  const READ_BY_PLAYGROUND = [
    "php", "phpVersion", "moodle", "moodleBranch",
    "addonProxyUrl", "phpCorsProxyUrl", "debug", "profile",
  ];
  const unguarded = READ_BY_PLAYGROUND.filter((p) => !FORBIDDEN_PARAMS.includes(p));
  assert.deepEqual(unguarded, ["debug", "profile"]);
});

// A dispatch-built link is shape-identical to one born from a push, so the
// course name is its ONLY provenance — the ecosystem's answer (Netlify in the
// hostname, Vercel on the page) applied to the one surface we control.
test("built-by appears in the review course name", () => {
  const bp = buildBlueprint({ ...base, type: "mod", name: "attendance", builtBy: "dispatch · alice" });
  const course = bp.steps.find((s) => s.step === "createCourse");
  assert.match(course.fullname, /^dispatch · alice · /);
  assert.match(course.fullname, /mod_attendance$/);
});

test("built-by is refused unless it is plain text", () => {
  for (const bad of ["alice<script>", "a\nb", "x".repeat(61), "a<b>c"]) {
    assert.throws(
      () => buildBlueprint({ ...base, type: "mod", name: "attendance", builtBy: bad }),
      /built-by must be plain text/,
      JSON.stringify(bad),
    );
  }
});

test("a landing override replaces the per-type default everywhere", () => {
  const bp = buildBlueprint({
    ...base, type: "mod", name: "attendance", landingOverride: "/admin/plugins.php",
  });
  assert.equal(bp.landingPage, "/admin/plugins.php");
  assert.equal(bp.steps.find((s) => s.step === "setLandingPage").path, "/admin/plugins.php");
  // and the login user follows the landing, not the plugin type
  assert.equal(bp.steps.find((s) => s.step === "login").username, "admin");
});

test("a landing override that walks out of the site is refused", () => {
  // Character-matched twice, wrong twice: `//evil.tld` (protocol-relative) and
  // then `/../../../../mchef-urls/`, which was BOOTED and landed the reviewer
  // on a neighbouring site on the same origin. The check is structural now:
  // segments, after decoding, not a pattern.
  for (const bad of [
    "//evil.tld/x",
    "https://evil.tld",
    "no-leading-slash",
    "/../../../../mchef-urls/",
    "/a/../b",
    "/./x",
    "/%2e%2e/x",
    "/..%2fx",
    "/%2e%2e%2fx",
  ]) {
    assert.equal(checkLandingPath(bad).ok, false, bad);
  }
  for (const good of [
    "/course/view.php?id=2",
    "/admin/plugins.php",
    "/",
    "/a//b",
    "/course/modedit.php?add=x&course=2&section=1",
  ]) {
    assert.equal(checkLandingPath(good).ok, true, `${good}: ${checkLandingPath(good).reason}`);
  }
});

test("the landing refusal says which segment was the problem", () => {
  assert.match(checkLandingPath("/a/../b").reason, /".." segment/);
  assert.match(checkLandingPath("//evil.tld").reason, /another origin/);
  assert.match(checkLandingPath("relative").reason, /must start with/);
});

// The playground answers an invalid branch/PHP pair by silently substituting
// 8.3 (version-resolver.js:199-208), so an unvalidated php input would build a
// preview that is not testing the PHP the summary claims. Refuse instead.
test("PHP is refused when the chosen Moodle does not accept it", () => {
  assert.equal(checkPhpForBranch("8.1", "MOODLE_500_STABLE").ok, false);
  assert.equal(checkPhpForBranch("8.4", "MOODLE_404_STABLE").ok, false);
  assert.match(checkPhpForBranch("8.1", "MOODLE_500_STABLE").reason, /8\.2, 8\.3, 8\.4/);
});

test("PHP each branch really accepts is allowed", () => {
  for (const [branch, versions] of Object.entries(PHP_BY_BRANCH)) {
    for (const v of versions) assert.equal(checkPhpForBranch(v, branch).ok, true, `${v} on ${branch}`);
  }
});

test("a php override reaches the blueprint's version pin", () => {
  const bp = buildBlueprint({ ...base, type: "mod", name: "attendance", phpOverride: "8.2" });
  assert.equal(bp.preferredVersions.php, "8.2");
});

test("student and section counts drive the course, and are clamped", () => {
  const bp = buildBlueprint({ ...base, type: "mod", name: "attendance", students: 5, sections: 6 });
  assert.equal(bp.steps.find((s) => s.step === "createUsers").users.length, 6); // teacher + 5
  assert.equal(bp.steps.find((s) => s.step === "enrolUsers").enrolments.length, 6);
  assert.equal(bp.steps.find((s) => s.step === "createCourse").numsections, 6);
  // Every student is enrolled as a student, and named readably.
  const users = bp.steps.find((s) => s.step === "createUsers").users;
  assert.deepEqual(users.slice(1).map((u) => u.lastname), ["One", "Two", "Three", "Four", "Five"]);
  assert.deepEqual(studentNames(99).length, 20);
  assert.deepEqual(studentNames(0), ["student1"]);
});

test("login-as overrides the derived user", () => {
  const derived = buildBlueprint({ ...base, type: "mod", name: "attendance" });
  assert.equal(derived.steps.find((s) => s.step === "login").username, "teacher");
  const forced = buildBlueprint({ ...base, type: "mod", name: "attendance", loginAs: "student1" });
  assert.equal(forced.steps.find((s) => s.step === "login").username, "student1");
});

test("the default blueprint is unchanged by any of this", () => {
  // The counts became adjustable; the shape every existing preview had must
  // not move. One student, three sections, teacher login.
  const bp = buildBlueprint({ ...base, type: "mod", name: "attendance" });
  assert.deepEqual(
    bp.steps.find((s) => s.step === "createUsers").users.map((u) => u.username),
    ["teacher", "student1"],
  );
  assert.equal(bp.steps.find((s) => s.step === "createCourse").numsections, 3);
});

// Three incidents had the same shape: an output threw AFTER preview-url was in
// $GITHUB_OUTPUT, so the caller's `if: always()` step posted the link with the
// qualifying information stripped. Writing the link last means a failure above
// it leaves no link to post.
test("preview-url is the LAST output written", async () => {
  const { mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "order-"));
  const out = join(dir, "gho.txt");
  writeFileSync(out, "");
  execFileSync(process.execPath, ["scripts/build-preview.mjs"], {
    env: {
      ...process.env,
      GITHUB_OUTPUT: out,
      HEAD_REPO: "DavidUCL/moodle-mod_attendance",
      HEAD_SHA: SHA,
      OUT_DIR: join(dir, "out"),
    },
    stdio: "pipe",
  });
  const names = readFileSync(out, "utf8").trim().split("\n").map((l) => l.split("=")[0]);
  assert.ok(names.length > 1, "expected several outputs");
  assert.equal(names.at(-1), "preview-url", `got order: ${names.join(", ")}`);
});

// The summary used to print the raw input while the blueprint got a clamped
// one: "-5 student(s)" building 1, "999" building 20.
test("a count is clamped once, where the summary can see it", async () => {
  const { clampCount } = await import("../scripts/build-preview.mjs");
  assert.equal(clampCount("3", 1, 1, 20), 3);
  assert.equal(clampCount("999", 1, 1, 20), 20);
  assert.equal(clampCount("-5", 1, 1, 20), 1);
  assert.equal(clampCount("0", 1, 1, 20), 1);
  assert.equal(clampCount("abc", 1, 1, 20), 1);
  assert.equal(clampCount("", 7, 1, 20), 7);
  assert.equal(clampCount(undefined, 7, 1, 20), 7);
  assert.equal(clampCount("2.9", 1, 1, 20), 2);
});

// --- 1e: the (default) sentinel and collect-all-errors ----------------------
// A `choice` input always submits something, so one option has to MEAN unset.
// It used to be an English sentence in three places — the option, the default,
// and a `${{ }}` ternary — none of which any test or mutant can reach. Now it
// is one token resolved here.
test("the sentinel resolves to unset, and real values survive", async () => {
  const { opt, DEFAULT_SENTINEL } = await import("../scripts/build-preview.mjs");
  assert.equal(DEFAULT_SENTINEL, "(default)");
  assert.equal(opt(DEFAULT_SENTINEL), "");
  assert.equal(opt(" (default) "), "");
  assert.equal(opt("8.3"), "8.3");
  assert.equal(opt("  admin "), "admin");
  assert.equal(opt(""), "");
  assert.equal(opt(undefined), "");
});

// Parentheses are illegal in every value space these controls accept, which is
// why this token cannot collide with a real answer.
test("the sentinel cannot be confused with a legitimate value", async () => {
  const { opt, DEFAULT_SENTINEL } = await import("../scripts/build-preview.mjs");
  assert.match(DEFAULT_SENTINEL, /[()]/);
  for (const real of ["8.3", "admin", "student1", "mod_attendance", "topics", "en", "de_du"]) {
    assert.equal(opt(real), real);
  }
});

test("Problems collects every failure and names the input for each", async () => {
  const { Problems } = await import("../scripts/build-preview.mjs");
  const p = new Problems();
  assert.equal(p.any, false);
  p.check("php-version", { ok: true });
  assert.equal(p.any, false, "a passing check must not register a problem");
  p.check("php-version", { ok: false, reason: "bad php" });
  p.add("login-as", "no such user");
  assert.equal(p.any, true);
  const err = p.toError();
  assert.match(err.message, /2 inputs are wrong/);
  assert.match(err.message, /php-version: bad php/);
  assert.match(err.message, /login-as: no such user/);
  assert.deepEqual(err.problems.map((x) => x.input), ["php-version", "login-as"]);
});

test("a single problem reads as itself, not as a list of one", async () => {
  const { Problems } = await import("../scripts/build-preview.mjs");
  const p = new Problems();
  p.add("php-version", "bad php");
  assert.equal(p.toError().message, "bad php");
});

// An annotation is one line: a newline would terminate the workflow command
// and dump the remainder as plain output.
test("annotations are one line each and carry the input name", async () => {
  const { Problems } = await import("../scripts/build-preview.mjs");
  const p = new Problems();
  p.add("landing-path", "line one\nline two");
  const lines = [];
  p.annotate((l) => lines.push(l));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^::error title=landing-path::/);
  assert.ok(!lines[0].slice(2).includes("\n"), `annotation contains a newline: ${lines[0]}`);
});

// Three simultaneous mistakes used to cost three runs. This is the end-to-end
// proof that they now cost one — and that each is attributed to its own field.
test("three bad inputs are all reported by one run", async () => {
  const { mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "collect-"));
  const summary = join(dir, "summary.md");
  writeFileSync(summary, "");
  let out = "";
  try {
    execFileSync(process.execPath, ["scripts/build-preview.mjs"], {
      env: {
        ...process.env,
        HEAD_REPO: "DavidUCL/moodle-mod_attendance",
        HEAD_SHA: SHA,
        PHP_VERSION: "8.9",
        LOGIN_AS: "nobody",
        LANDING_PATH: "//evil.tld/x",
        OUT_DIR: join(dir, "out"),
        GITHUB_OUTPUT: join(dir, "gho.txt"),
        GITHUB_STEP_SUMMARY: summary,
      },
      stdio: "pipe",
    });
    assert.fail("expected a refusal");
  } catch (err) {
    out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  for (const input of ["php-version", "login-as", "landing-path"]) {
    assert.match(out, new RegExp(`::error title=${input}::`), `no annotation for ${input}`);
  }
  const md = readFileSync(summary, "utf8");
  assert.match(md, /3 inputs to fix/);
  for (const input of ["php-version", "login-as", "landing-path"]) {
    assert.ok(md.includes(`\`${input}\``), `summary table missing ${input}`);
  }
});

test("a free-text input does NOT swallow the sentinel", async () => {
  const { checkLandingPath } = await import("../scripts/build-preview.mjs");
  // "(default)" is not a path; landing-path must refuse it rather than treat
  // it as "unset", which would silently drop what the user asked for.
  assert.equal(checkLandingPath("(default)").ok, false);
});

test("the sentinel is accepted everywhere a choice can send it", async () => {
  const { mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "sentinel-"));
  const gho = join(dir, "gho.txt");
  writeFileSync(gho, "");
  execFileSync(process.execPath, ["scripts/build-preview.mjs"], {
    env: {
      ...process.env,
      HEAD_REPO: "DavidUCL/moodle-mod_attendance",
      HEAD_SHA: SHA,
      // Only the CHOICE inputs send the sentinel. landing-path is free text,
      // where a literal "(default)" is a mistake and must be refused.
      PHP_VERSION: "(default)",
      LOGIN_AS: "(default)",
      OUT_DIR: join(dir, "out"),
      GITHUB_OUTPUT: gho,
    },
    stdio: "pipe",
  });
  assert.match(readFileSync(gho, "utf8"), /preview-url=/);
});

// --- review round 2 (2026-08-08) -------------------------------------------
// `add()` did `if (message) push(...)`, so a {ok:false} verdict carrying no
// reason vanished, `any` stayed false, and the link was built as though the
// check had passed — a guard that fails OPEN.
test("a failure with no message is still a failure", async () => {
  const { Problems } = await import("../scripts/build-preview.mjs");
  const p = new Problems();
  p.check("php-version", { ok: false });
  assert.equal(p.any, true, "a message-less refusal was dropped");
  assert.match(p.toError().message, /no reason/);
});

// The message embeds JSON.stringify(landing-path) — raw form input. An
// unescaped `|` split the markdown row into extra columns.
test("a pipe in a problem message cannot break the summary table", async () => {
  const { mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "pipe-"));
  const summary = join(dir, "s.md");
  writeFileSync(summary, "");
  try {
    execFileSync(process.execPath, ["scripts/build-preview.mjs"], {
      env: { ...process.env, HEAD_REPO: "DavidUCL/moodle-mod_attendance", HEAD_SHA: SHA,
        LANDING_PATH: "//evil|x", OUT_DIR: join(dir, "o"), GITHUB_OUTPUT: join(dir, "g"),
        GITHUB_STEP_SUMMARY: summary },
      stdio: "pipe",
    });
    assert.fail("expected a refusal");
  } catch { /* refusal is the point */ }
  const row = readFileSync(summary, "utf8").split("\n").find((l) => l.includes("landing-path"));
  assert.ok(row, "no landing-path row in the summary");
  // 2 cells => 3 pipes. A raw `|` in the message would add more.
  assert.equal((row.match(/(?<!\\)\|/g) || []).length, 3, `row split into extra columns: ${row}`);
});

// `student99` tripped both the name check and the count check, and the second
// told the user to raise a count whose maximum is 20.
test("an invalid login-as name produces exactly one problem", async () => {
  const { mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "loginas-"));
  const summary = join(dir, "s.md");
  writeFileSync(summary, "");
  let out = "";
  try {
    execFileSync(process.execPath, ["scripts/build-preview.mjs"], {
      env: { ...process.env, HEAD_REPO: "DavidUCL/moodle-mod_attendance", HEAD_SHA: SHA,
        LOGIN_AS: "student99", OUT_DIR: join(dir, "o"), GITHUB_OUTPUT: join(dir, "g"),
        GITHUB_STEP_SUMMARY: summary },
      stdio: "pipe",
    });
    assert.fail("expected a refusal");
  } catch (err) { out = `${err.stdout ?? ""}${err.stderr ?? ""}`; }
  assert.equal((out.match(/::error title=login-as::/g) || []).length, 1, out);
  assert.ok(!out.includes("raise the student count"), "gave advice that cannot help");
});

// --- step 2: restoring a course instead of building an empty one -----------
const MBZ_FIXTURE = "test/fixtures/mbz/legacy_course_completion.mbz";

async function restoreInfo() {
  const { readFileSync } = await import("node:fs");
  const { inspectMbz } = await import("../scripts/mbz.mjs");
  return inspectMbz(readFileSync(MBZ_FIXTURE));
}

test("a restore REPLACES createCourse rather than joining it", async () => {
  const { buildBlueprint } = await import("../scripts/build-preview.mjs");
  const info = await restoreInfo();
  const bp = buildBlueprint({
    headRepo: "DavidUCL/moodle-mod_attendance", headSha: SHA, type: "mod", name: "attendance",
    restore: { url: "https://raw.githubusercontent.com/a/b/c.mbz", info },
  });
  const names = bp.steps.map((s) => s.step);
  // phpRestoreCourse only takes the shortname if no other course holds it, so
  // keeping both would leave the content in a course named "restored" while
  // REVIEW sat empty beside it.
  assert.ok(!names.includes("createCourse"), "createCourse must be gone");
  assert.equal(names.filter((n) => n === "restoreCourse").length, 1);
});

test("the post-restore assertion is inserted, and before anything uses the course", async () => {
  const { buildBlueprint } = await import("../scripts/build-preview.mjs");
  const info = await restoreInfo();
  const bp = buildBlueprint({
    headRepo: "DavidUCL/moodle-mod_attendance", headSha: SHA, type: "mod", name: "attendance",
    restore: { url: "https://raw.githubusercontent.com/a/b/c.mbz", info },
  });
  const names = bp.steps.map((s) => s.step);
  const assertIdx = names.indexOf("runPhpCode");
  assert.ok(assertIdx > names.indexOf("restoreCourse"), "assertion must follow the restore");
  assert.ok(assertIdx < names.indexOf("login"), "a failure must land the reviewer before login");
  // It has to assert what the backup actually declares, not a hand-typed guess.
  assert.match(bp.steps[assertIdx].code, /'assign'/);
});

// A restored course's id is not knowable when the link is built. Landing by
// name resolves through MUST_EXIST, so a missing course is a loud error rather
// than someone else's course.
test("a restore lands by course NAME, never by hardcoded id", async () => {
  const { buildBlueprint } = await import("../scripts/build-preview.mjs");
  const info = await restoreInfo();
  for (const type of ["mod", "theme", "format"]) {
    const bp = buildBlueprint({
      headRepo: "DavidUCL/moodle-mod_attendance", headSha: SHA, type, name: "attendance",
      restore: { url: "https://raw.githubusercontent.com/a/b/c.mbz", info },
    });
    const path = bp.steps.find((s) => s.step === "setLandingPage").path;
    assert.match(path, /name=REVIEW/, `${type} landed on ${path}`);
    assert.ok(!/course=2|id=2/.test(path), `${type} still hardcodes an id: ${path}`);
  }
});

test("without a restore the blueprint is unchanged", async () => {
  const { buildBlueprint } = await import("../scripts/build-preview.mjs");
  const bp = buildBlueprint({
    headRepo: "DavidUCL/moodle-mod_attendance", headSha: SHA, type: "mod", name: "attendance",
  });
  const names = bp.steps.map((s) => s.step);
  assert.ok(names.includes("createCourse"));
  assert.ok(!names.includes("restoreCourse"));
  assert.ok(!names.includes("runPhpCode"));
  assert.match(bp.steps.find((s) => s.step === "setLandingPage").path, /course=2/);
});

// The guard used to count createCourse only, and refused the restore blueprint
// outright. The invariant is "exactly one course we control".
test("two courses are still refused, however they are made", async () => {
  const { buildBlueprint } = await import("../scripts/build-preview.mjs");
  const info = await restoreInfo();
  assert.throws(
    () => buildBlueprint({
      headRepo: "DavidUCL/moodle-mod_attendance", headSha: SHA, type: "mod", name: "attendance",
      restore: { url: "https://raw.githubusercontent.com/a/b/c.mbz", info: { ...info, modulenames: [] } },
    }),
    /refusing to assert nothing/,
  );
});

// Found by BOOTING, not by reading: the restore succeeded and the assertion
// passed, then createUsers died with exit code 1 because the backup already
// contained `student1`. Refuse at link-build time instead of half-building a
// site.
test("a backup whose users collide with the preview's is refused", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "collide-"));
  writeFileSync(join(dir, "s.md"), "");
  let out = "";
  try {
    execFileSync(process.execPath, ["scripts/build-preview.mjs"], {
      env: {
        ...process.env,
        HEAD_REPO: "DavidUCL/moodle-mod_attendance",
        HEAD_SHA: SHA,
        RESTORE_COURSE_URL:
          "https://raw.githubusercontent.com/moodle/moodle/MOODLE_404_STABLE/completion/tests/fixtures/legacy_course_completion.mbz",
        OUT_DIR: join(dir, "out"),
        GITHUB_OUTPUT: join(dir, "g"),
        GITHUB_STEP_SUMMARY: join(dir, "s.md"),
      },
      stdio: "pipe",
    });
    assert.fail("expected a refusal");
  } catch (err) {
    out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  assert.match(out, /::error title=restore-course-url::/);
  assert.match(out, /student1/);
  assert.match(out, /createUsers would fail mid-boot/);
});

// Each restore refusal needs its own test: a mutant that stops gating the
// BACKUP survived while the username-collision test passed, because the
// collision check sits after the verdict check and never exercised it.
test("a supplied backup that is not a course backup is refused", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "notcourse-"));
  writeFileSync(join(dir, "s.md"), "");
  let out = "";
  try {
    execFileSync(process.execPath, ["scripts/build-preview.mjs"], {
      env: {
        ...process.env, HEAD_REPO: "DavidUCL/moodle-mod_attendance", HEAD_SHA: SHA,
        // A real ACTIVITY backup from core: restoring it leaves a
        // working-looking Moodle with no course in it.
        RESTORE_COURSE_URL:
          "https://raw.githubusercontent.com/moodle/moodle/MOODLE_404_STABLE/mod/quiz/tests/fixtures/moodle_311_quiz.mbz",
        OUT_DIR: join(dir, "out"), GITHUB_OUTPUT: join(dir, "g"),
        GITHUB_STEP_SUMMARY: join(dir, "s.md"),
      },
      stdio: "pipe",
    });
    assert.fail("an activity backup was accepted");
  } catch (err) {
    out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  assert.match(out, /::error title=restore-course-url::/, out);
  assert.match(out, /not a course backup/, out);
});

test("a backup URL on a host we do not allow is refused", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "badhost-"));
  writeFileSync(join(dir, "s.md"), "");
  let out = "";
  try {
    execFileSync(process.execPath, ["scripts/build-preview.mjs"], {
      env: {
        ...process.env, HEAD_REPO: "DavidUCL/moodle-mod_attendance", HEAD_SHA: SHA,
        RESTORE_COURSE_URL: "https://gitlab.com/someone/something.mbz",
        OUT_DIR: join(dir, "out"), GITHUB_OUTPUT: join(dir, "g"),
        GITHUB_STEP_SUMMARY: join(dir, "s.md"),
      },
      stdio: "pipe",
    });
    assert.fail("an off-allowlist backup host was accepted");
  } catch (err) {
    out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  assert.match(out, /not in allowlist/, out);
});

// The data-hosts input was only exercised through buildBlueprint's parameter.
// main() decides whether to USE it, and that decision had no test.
test("data-hosts narrows the allowlist that main() applies", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "hosts-"));
  writeFileSync(join(dir, "s.md"), "");
  let out = "";
  try {
    execFileSync(process.execPath, ["scripts/build-preview.mjs"], {
      env: {
        ...process.env, HEAD_REPO: "DavidUCL/moodle-mod_attendance", HEAD_SHA: SHA,
        // github.com excluded, so the plugin's own archive is off-allowlist.
        DATA_HOSTS: "raw.githubusercontent.com",
        OUT_DIR: join(dir, "out"), GITHUB_OUTPUT: join(dir, "g"),
        GITHUB_STEP_SUMMARY: join(dir, "s.md"),
      },
      stdio: "pipe",
    });
    assert.fail("a narrowed data-hosts was ignored");
  } catch (err) {
    out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  assert.match(out, /not in allowlist: github\.com/, out);
});

// --- a restored course brings its own sections and format ------------------
// Found independently by two reviewers. restoreCourse accepts fullname,
// shortname, category, createCategory and visible — NOT numsections or format.
// Both were dropped in silence while the summary still claimed them.

test("the summary does not claim sections a restore ignored", async () => {
  const { mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "sections-"));
  const summary = join(dir, "s.md");
  writeFileSync(summary, "");
  execFileSync(process.execPath, ["scripts/build-preview.mjs"], {
    env: {
      ...process.env, HEAD_REPO: "DavidUCL/moodle-mod_attendance", HEAD_SHA: SHA,
      SECTIONS: "10",
      RESTORE_COURSE_URL:
        "https://raw.githubusercontent.com/moodle/moodle/MOODLE_404_STABLE/admin/tool/uploadcourse/tests/fixtures/backup.mbz",
      OUT_DIR: join(dir, "out"), GITHUB_OUTPUT: join(dir, "g"), GITHUB_STEP_SUMMARY: summary,
    },
    stdio: "pipe",
  });
  const md = readFileSync(summary, "utf8");
  assert.ok(!/10 section\(s\)/.test(md), `the summary claimed sections it never applied:\n${md}`);
  assert.match(md, /restored from a backup/);
});

// The summary named the add-form path while the link opened the course.
//
// The first version of this test compared landingPath() with the blueprint —
// two things the bug does not touch — so it passed on the very mutant it
// existed to catch. Read the SUMMARY THE RUN WROTE and compare it with the
// LINK THAT RUN BUILT. Nothing else proves they agree.
test("the summary's landing page is the one the link opens", async () => {
  const { mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "landing-"));
  const summary = join(dir, "s.md");
  writeFileSync(summary, "");
  execFileSync(process.execPath, ["scripts/build-preview.mjs"], {
    env: {
      ...process.env, HEAD_REPO: "DavidUCL/moodle-mod_attendance", HEAD_SHA: SHA,
      RESTORE_COURSE_URL:
        "https://raw.githubusercontent.com/moodle/moodle/MOODLE_404_STABLE/admin/tool/uploadcourse/tests/fixtures/backup.mbz",
      OUT_DIR: join(dir, "out"), GITHUB_OUTPUT: join(dir, "g"), GITHUB_STEP_SUMMARY: summary,
    },
    stdio: "pipe",
  });
  const blueprint = JSON.parse(readFileSync(join(dir, "out", "preview-blueprint.json"), "utf8"));
  const inLink = blueprint.steps.find((s) => s.step === "setLandingPage").path;
  const row = readFileSync(summary, "utf8").split("\n").find((l) => l.startsWith("| landing page |"));
  assert.ok(row, "no landing page row in the summary");
  assert.ok(
    row.includes(inLink),
    `the summary names a different page than the link opens.\n  link: ${inLink}\n  row : ${row}`,
  );
});

// A format plugin's whole point is the format. A restored course brings its
// own, so the plugin would never be applied and the reviewer would conclude it
// is broken. Refuse rather than mislead.
test("a course-format plugin cannot be previewed against a restored course", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "fmt-"));
  writeFileSync(join(dir, "s.md"), "");
  let out = "";
  try {
    execFileSync(process.execPath, ["scripts/build-preview.mjs"], {
      env: {
        ...process.env, HEAD_REPO: "DavidUCL/moodle-format_thing", HEAD_SHA: SHA,
        RESTORE_COURSE_URL:
          "https://raw.githubusercontent.com/moodle/moodle/MOODLE_404_STABLE/admin/tool/uploadcourse/tests/fixtures/backup.mbz",
        OUT_DIR: join(dir, "out"), GITHUB_OUTPUT: join(dir, "g"), GITHUB_STEP_SUMMARY: join(dir, "s.md"),
      },
      stdio: "pipe",
    });
    assert.fail("a format plugin with a restored course was accepted");
  } catch (err) {
    out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  assert.match(out, /::error title=restore-course-url::/, out);
  assert.match(out, /brings its own format/, out);
});

// --- the sample-content menu ------------------------------------------------
// A menu and a free-text box feeding ONE setting, on purpose: two separate
// settings is how a form ends up with a menu saying one course and a box
// saying another.

test("the sample course address is pinned to a commit, not a branch", async () => {
  const { SAMPLE_COURSE_URL } = await import("../scripts/build-preview.mjs");
  // A branch address quietly starts serving a different course, and stops
  // serving one at all when the branch is deleted. Links are read weeks later.
  assert.match(SAMPLE_COURSE_URL, /\/[0-9a-f]{40}\//, SAMPLE_COURSE_URL);
  assert.match(SAMPLE_COURSE_URL, /^https:\/\/raw\.githubusercontent\.com\//);
  assert.ok(SAMPLE_COURSE_URL.endsWith(".mbz"));
});

test("the pinned sample course is the one the spec describes", async () => {
  const { readFileSync } = await import("node:fs");
  const { checkFixture } = await import("../scripts/check-fixture.mjs");
  const spec = JSON.parse(readFileSync("fixtures/fixture-spec.json", "utf8"));
  // The committed file, not the network: this asserts what we SHIP.
  const r = checkFixture(readFileSync("fixtures/review-course-MOODLE_404_STABLE.mbz"), spec);
  assert.deepEqual(r.problems, []);
});

test("choosing the menu restores the sample course", async () => {
  const { mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const { SAMPLE_COURSE_URL } = await import("../scripts/build-preview.mjs");
  const dir = mkdtempSync(join(tmpdir(), "menu-"));
  writeFileSync(join(dir, "s.md"), "");
  execFileSync(process.execPath, ["scripts/build-preview.mjs"], {
    env: {
      ...process.env, HEAD_REPO: "DavidUCL/moodle-mod_attendance", HEAD_SHA: SHA,
      SAMPLE_CONTENT: "review-course",
      OUT_DIR: join(dir, "out"), GITHUB_OUTPUT: join(dir, "g"), GITHUB_STEP_SUMMARY: join(dir, "s.md"),
    },
    stdio: "pipe",
  });
  const bp = JSON.parse(readFileSync(join(dir, "out", "preview-blueprint.json"), "utf8"));
  const restore = bp.steps.find((s) => s.step === "restoreCourse");
  assert.ok(restore, "the menu did not produce a restore");
  assert.equal(restore.url, SAMPLE_COURSE_URL);
});

test("the menu left at its default builds the small course as before", async () => {
  const { mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "none-"));
  writeFileSync(join(dir, "s.md"), "");
  execFileSync(process.execPath, ["scripts/build-preview.mjs"], {
    env: {
      ...process.env, HEAD_REPO: "DavidUCL/moodle-mod_attendance", HEAD_SHA: SHA,
      SAMPLE_CONTENT: "(default)",
      OUT_DIR: join(dir, "out"), GITHUB_OUTPUT: join(dir, "g"), GITHUB_STEP_SUMMARY: join(dir, "s.md"),
    },
    stdio: "pipe",
  });
  const bp = JSON.parse(readFileSync(join(dir, "out", "preview-blueprint.json"), "utf8"));
  assert.ok(bp.steps.some((s) => s.step === "createCourse"));
  assert.ok(!bp.steps.some((s) => s.step === "restoreCourse"));
});

test("asking for the menu AND an address at once is refused", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "both-"));
  writeFileSync(join(dir, "s.md"), "");
  let out = "";
  try {
    execFileSync(process.execPath, ["scripts/build-preview.mjs"], {
      env: {
        ...process.env, HEAD_REPO: "DavidUCL/moodle-mod_attendance", HEAD_SHA: SHA,
        SAMPLE_CONTENT: "review-course",
        RESTORE_COURSE_URL:
          "https://raw.githubusercontent.com/moodle/moodle/MOODLE_404_STABLE/admin/tool/uploadcourse/tests/fixtures/backup.mbz",
        OUT_DIR: join(dir, "out"), GITHUB_OUTPUT: join(dir, "g"), GITHUB_STEP_SUMMARY: join(dir, "s.md"),
      },
      stdio: "pipe",
    });
    assert.fail("both a menu choice and an address were accepted");
  } catch (err) {
    out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  assert.match(out, /::error title=sample-content::/, out);
  assert.match(out, /only one course can be restored/, out);
});

// ---- more than one plugin (extra-plugins) --------------------------------

const SELF_URL = `https://github.com/${base.headRepo}/archive/${SHA}.zip`;
const extra = (component, sha = "e".repeat(40)) => ({
  url: `https://github.com/x/moodle-${component}/archive/${sha}.zip`,
  pluginType: component.split("_")[0],
  pluginName: component.split("_").slice(1).join("_"),
});

test("an install list becomes one installMoodlePlugin step per plugin, in order", () => {
  const installs = [extra("block_b"), extra("local_a"), { url: SELF_URL, pluginType: "mod", pluginName: "attendance", isSelf: true }];
  const steps = buildBlueprint({ ...base, installs }).steps.filter((s) => s.step === "installMoodlePlugin");
  assert.deepEqual(steps.map((s) => s.url), installs.map((i) => i.url));
  // Ordering is the whole point: a dependency installed second is a plugin
  // installed against something that is not there yet.
  assert.deepEqual(steps.map((s) => `${s.pluginType}_${s.pluginName}`), [
    "block_b",
    "local_a",
    "mod_attendance",
  ]);
});

// Every extra is `critical` too. An extra that fails silently is the plugin
// under review installing against a dependency that is not there.
test("every plugin install is critical, not just the first", () => {
  const bp = buildBlueprint({
    ...base,
    installs: [extra("block_b"), { url: SELF_URL, pluginType: "mod", pluginName: "attendance", isSelf: true }],
  });
  const steps = bp.steps.filter((s) => s.step === "installMoodlePlugin");
  assert.equal(steps.length, 2);
  assert.ok(steps.every((s) => s.critical === true), "an install step was left non-critical");
});

// The link's whole claim is that it boots THIS commit. A list that lost it —
// through a sort, a filter, or a mis-set flag — must not produce a link at all.
test("an install list without the commit under review is refused", () => {
  assert.throws(
    () => buildBlueprint({ ...base, installs: [extra("block_b")] }),
    /does not contain the commit under review/,
  );
});

test("no install list at all still installs exactly the commit under review", () => {
  const steps = buildBlueprint(base).steps.filter((s) => s.step === "installMoodlePlugin");
  assert.equal(steps.length, 1);
  assert.equal(steps[0].url, SELF_URL);
});

// ---------------------------------------------------------------------------
// The `theme` control, parse-and-refuse half. Every case below is one that
// otherwise boots a green run showing stock Boost: setTheme never verifies the
// theme exists, and find_theme_location() is a bare filesystem test.

const CORE_THEMES = {
  ok: true,
  standard: new Set(["theme_boost", "theme_classic", "mod_assign"]),
  removedTypes: new Set(),
};
const themePlan = async (raw, self = { type: "mod", name: "attendance" }, core = CORE_THEMES) => {
  const { Problems, planThemeControl } = await import("../scripts/build-preview.mjs");
  const problems = new Problems();
  const { item } = planThemeControl({ raw, self, core, problems });
  return { item, problems: problems.list.map((p) => `${p.input}: ${p.message}`) };
};

test("an empty theme box is not a refusal and plans nothing", async () => {
  for (const raw of ["", "   ", undefined, null]) {
    const { item, problems } = await themePlan(raw);
    assert.equal(item, null);
    assert.deepEqual(problems, []);
  }
});

test("a full theme coordinate is accepted, unresolved", async () => {
  const { item, problems } = await themePlan(
    "moodle-an-hochschulen/moodle-theme_boost_union@MOODLE_405_STABLE#theme_boost_union",
  );
  assert.deepEqual(problems, []);
  assert.equal(item.component, "theme_boost_union");
  assert.equal(item.name, "boost_union");
  // Still the ref that was TYPED. Resolving it to a commit is the extras
  // pipeline's job, and a test asserting otherwise here would be asserting
  // that this function does something it must not.
  assert.equal(item.ref, "MOODLE_405_STABLE");
});

test("a theme box on a theme pull request is refused, naming both", async () => {
  const { item, problems } = await themePlan(
    "someone/moodle-theme_moove@abc#theme_moove",
    { type: "theme", name: "boost_union" },
  );
  assert.equal(item, null);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /theme_boost_union/);
  assert.match(problems[0], /theme_moove/);
  // The reason has to be the one the reviewer would otherwise never see.
  assert.match(problems[0], /last one wins/);
});

test("a non-theme component in the theme box is refused", async () => {
  const { item, problems } = await themePlan("someone/moodle-mod_thing@abc#mod_thing");
  assert.equal(item, null);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /is not a theme/);
  // Names the directory it would land in, which is the whole reason it fails.
  assert.match(problems[0], /mod\//);
});

test("two themes are refused — only one can be active", async () => {
  const { item, problems } = await themePlan(
    "a/b@abc#theme_one,c/d@def#theme_two",
  );
  assert.equal(item, null);
  assert.ok(problems.some((p) => /maximum is 1/.test(p)), problems.join("; "));
});

test("a theme box naming a CORE theme is refused", async () => {
  const { item, problems } = await themePlan("someone/moodle-theme_boost@abc#theme_boost");
  assert.equal(item, null);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /theme_boost/);
});

// The coordinate parser's own refusals must reach the reviewer under the name
// of the box they typed into, not as an internal message.
test("an incomplete theme coordinate is refused under the theme field", async () => {
  for (const raw of ["someone/moodle-theme_moove", "someone/moodle-theme_moove@abc", "@abc#theme_moove"]) {
    const { item, problems } = await themePlan(raw);
    assert.equal(item, null, `accepted ${raw}`);
    assert.ok(problems.length >= 1, `no refusal for ${raw}`);
    assert.ok(problems.every((p) => p.startsWith("theme:")), problems.join("; "));
  }
});

// A skipped check must never look like a passed one — but it must also not
// invent a refusal. With no core list, the collision check simply does not run.
test("the core-theme refusal is skipped, not guessed, when Moodle's list is absent", async () => {
  const { item, problems } = await themePlan(
    "someone/moodle-theme_boost@abc#theme_boost",
    { type: "mod", name: "attendance" },
    { ok: false, reason: "offline" },
  );
  assert.deepEqual(problems, []);
  assert.equal(item.component, "theme_boost");
});

// ---------------------------------------------------------------------------
// The theme warm-up. Its whole job is to make two invisible failures visible,
// so the tests are about what it REFUSES and what it exits with.

test("the warm-up refuses a name it cannot safely put in PHP", async () => {
  const { buildThemeWarmup } = await import("../scripts/theme-assert.mjs");
  for (const bad of ["", "Boost", "boost-union", "boost union", "1boost", "boost';DROP", null, undefined]) {
    assert.throws(() => buildThemeWarmup(bad), /unusable theme name/, `accepted ${JSON.stringify(bad)}`);
  }
});

test("the warm-up can only fail the boot the one way this runtime allows", async () => {
  const { buildThemeWarmup } = await import("../scripts/theme-assert.mjs");
  const step = buildThemeWarmup("boost_union");
  assert.equal(step.step, "runPhpCode");
  assert.equal(step.critical, true);
  // Measured: without CLI_SCRIPT defined BEFORE config.php is required, a
  // non-zero exit reports SUCCESS. Asserting the ORDER, not just presence —
  // indexOf comparisons pass when the term is absent, since -1 is less than
  // everything.
  const define = step.code.indexOf("define('CLI_SCRIPT',true)");
  const config = step.code.indexOf("config.php");
  assert.ok(define >= 0, "CLI_SCRIPT is not defined at all");
  assert.ok(config >= 0, "config.php is never required");
  assert.ok(define < config, "CLI_SCRIPT is defined after config.php is required");
  // One line, or preflight refuses the blueprint.
  assert.equal(step.code.includes("\n"), false);
});

test("the warm-up aborts on both silent-Boost failures and on neither visible one", async () => {
  const { buildThemeWarmup, THEME_CODES, THEME_CSS_FAILURE_MARKER } = await import(
    "../scripts/theme-assert.mjs"
  );
  const { code } = buildThemeWarmup("boost_union");
  // 31: no theme directory. 32: the site is not on the theme we set. Both are
  // invisible to a reviewer, so both must take the boot down.
  assert.match(code, /exit\(31\)/);
  assert.match(code, /exit\(32\)/);
  for (const c of [31, 32]) assert.ok(THEME_CODES[c], `code ${c} has no explanation`);
  // A CSS build that throws leaves a working, unstyled site — visible on sight,
  // and better than no preview. It must NOT be an exit code.
  assert.match(code, new RegExp(`echo '${THEME_CSS_FAILURE_MARKER}`));
  assert.equal(Object.keys(THEME_CODES).includes("33"), false);
});

test("the warm-up reads the theme from $CFG, never the literal the runtime hardcodes", async () => {
  const { buildThemeWarmup } = await import("../scripts/theme-assert.mjs");
  const { code } = buildThemeWarmup("boost_union");
  // bootstrap.js warms `boost` and only `boost`, before the blueprint runs.
  // Repeating that literal here would warm the wrong theme and leave the
  // reviewer's first page compiling SCSS in WASM.
  assert.match(code, /\$CFG->theme/);
  assert.equal(/'boost'/.test(code), false, "the warm-up hardcodes a theme name");
});

// ---------------------------------------------------------------------------
// planInstalls, with the network stubbed. The golden snapshots pin what
// buildBlueprint does with a themeName; these pin what planInstalls DECIDES the
// themeName is — which is a different question and the one Phil warned about.
// `setTheme` writes its value straight into set_config('theme', ...), and
// Moodle then looks for a directory of exactly that name, so a component or a
// repository name there is silent stock Boost.

const THEME_COMMIT = "649c2d7b22fee1de767d145b7ec5a95543e9a305";
const THEME_COORD = `moodle-an-hochschulen/moodle-theme_boost_union@${THEME_COMMIT}#theme_boost_union`;

/** Serves the three files the pipeline reads, and 404s anything else, so a
 * request nobody expected is a visible failure rather than a silent undefined. */
const stubHost = ({ version, config } = {}) => async (url, opts = {}) => {
  if (opts.method === "HEAD") return { ok: true, status: 200 };
  if (url.endsWith("/version.php")) {
    return {
      ok: true,
      text: async () =>
        version ?? "<?php\n$plugin->component = 'theme_boost_union';\n$plugin->version = 2025041477;\n",
    };
  }
  if (url.endsWith("/config.php")) {
    return { ok: true, text: async () => config ?? "<?php\n$THEME->parents = ['boost'];\n" };
  }
  return { ok: false, status: 404 };
};

const planned = async (opts = {}) => {
  const { Problems, planInstalls, planThemeControl } = await import("../scripts/build-preview.mjs");
  const problems = new Problems();
  const core = { ok: true, standard: new Set(["theme_boost"]), removedTypes: new Set() };
  const self = { type: "mod", name: "attendance", declared: null };
  const { item } = planThemeControl({ raw: opts.raw ?? THEME_COORD, self, core, problems });
  const out = await planInstalls({
    raw: "",
    theme: item,
    self,
    headRepo: "DavidUCL/moodle-mod_attendance",
    headSha: SHA,
    moodleBranch: "MOODLE_500_STABLE",
    core,
    problems,
    fetchImpl: stubHost(opts),
  });
  return { ...out, problems: problems.list.map((p) => `${p.input}: ${p.message}`) };
};

test("planInstalls hands setTheme the plugin NAME, not the component", async () => {
  const out = await planned();
  assert.deepEqual(out.problems, []);
  assert.equal(out.themeName, "boost_union");
});

test("the theme is installed like any other plugin, into theme/", async () => {
  const out = await planned();
  const theme = out.installs.find((i) => i.pluginType === "theme");
  assert.ok(theme, "no theme install step was planned");
  assert.equal(theme.pluginName, "boost_union");
  assert.match(theme.url, new RegExp(`/archive/${THEME_COMMIT}\\.zip$`));
  // Before the plugin under review, which is what the ordering exists for.
  assert.ok(out.installs.indexOf(theme) < out.installs.findIndex((i) => i.isSelf));
});

test("the theme is reported at full commit length, and not in the extras list", async () => {
  const out = await planned();
  assert.equal(out.themeSummary, `theme_boost_union@${THEME_COMMIT}`);
  // Listing it twice would read as two plugins; the extras list is for extras.
  assert.equal(out.list, "");
});

test("a theme whose config.php sets no parents is refused, and plans nothing", async () => {
  const out = await planned({ config: "<?php\n$THEME->name = 'boost_union';\n" });
  assert.equal(out.themeName, "");
  assert.ok(out.problems.some((p) => /never sets \$THEME->parents/.test(p)), out.problems.join("; "));
  // The refusal is annotated against the box that caused it.
  assert.ok(out.problems.every((p) => p.startsWith("theme:")), out.problems.join("; "));
});

test("a theme declaring a different component to the one named is refused", async () => {
  const out = await planned({
    version: "<?php\n$plugin->component = 'theme_something_else';\n$plugin->version = 1;\n",
  });
  assert.equal(out.themeName, "");
  assert.ok(out.problems.some((p) => /theme_something_else/.test(p)), out.problems.join("; "));
});

test("a theme whose parent is neither core nor installed is refused", async () => {
  const out = await planned({ config: "<?php\n$THEME->parents = ['some_missing_parent'];\n" });
  assert.equal(out.themeName, "");
  assert.ok(
    out.problems.some((p) => /theme_some_missing_parent/.test(p)),
    out.problems.join("; "),
  );
});

test("no theme box plans no theme at all", async () => {
  const out = await planned({ raw: "" });
  assert.deepEqual(out.problems, []);
  assert.equal(out.themeName, "");
  assert.equal(out.themeSummary, "");
  assert.equal(out.installs.length, 1);
});
