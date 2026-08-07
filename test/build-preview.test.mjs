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
