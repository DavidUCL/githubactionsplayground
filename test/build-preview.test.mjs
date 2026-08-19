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
  snapshotReservations,
  isAdministrator,
  previewSummary,
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

// A BOUND PER SHAPE, MEASURED — not one bound built from the cheapest blueprint
// there is.
//
// The old version built only the bare `mod` preview and capped it at 1200 while
// its comment claimed "~750". Measured 2026-08-18 it was 1144: 56 characters of
// headroom, against a comment that implied 450. Every control added since has
// been spending a budget nobody was reading, and the next step to land on the
// default preview would have failed this test with a number nobody could
// interpret. The ceiling that matters is the browser's, around 8000; these
// numbers exist to make GROWTH visible, so they are stated per shape and each
// one is the measured value plus room to move.
const URL_SHAPES = [
  // 1500, raised deliberately in the commit that added the course-id assertion:
  // a bare `mod` preview is the ONE shape whose landing carries a course number,
  // so it is the one shape that pays for the assertion. Measured 1118 -> 1358.
  { label: "bare mod", opts: {}, max: 1500 },
  // UNCHANGED at 1300, and that is the point: an admin landing names no course,
  // so it gets no assertion. If this bound ever needs raising, the assertion has
  // started being emitted where it can only compare a value with itself.
  { label: "local (admin landing)", opts: { type: "local", name: "myplugin" }, max: 1300 },
  // These two carry BOTH their own assertion and the course-id one, because
  // they are `mod` previews and land on the add form. Measured 1799 and 1821
  // after the course-id assertion; raised to 2000 because one character of
  // headroom is not headroom — the whole point of these numbers is to make
  // growth visible early enough to ask about it.
  { label: "course-format", opts: { courseFormat: "weeks" }, max: 2000 },
  { label: "language packs", opts: { languagePacks: ["es", "ar"] }, max: 2000 },
  // A theme under review lands by NAME, so it pays for no course-id assertion
  // and has not moved at all: 1763, unchanged.
  { label: "theme under review", opts: { type: "theme", name: "boost_union" }, max: 1900 },
  { label: "three courses", opts: { courses: 3 }, max: 1800 },
  // THE WORST CASE, on purpose. Every control that grows the blueprint, at
  // once. It is here because each bound above is measured in isolation and none
  // of them would notice the combination creeping up — `language packs` alone
  // was already at 1821 when this was written, and adding two courses to it is
  // the largest single preview this action can build.
  {
    label: "everything at once",
    opts: { courses: 3, languagePacks: ["es", "ar"], courseFormat: "weeks", teachers: 2, students: 5 },
    max: 2800,
  },
];

test("every preview shape stays well inside what a browser will carry", () => {
  const seen = [];
  for (const shape of URL_SHAPES) {
    // The ACTION'S OWN DEFAULT HOST, which is 14 characters longer than
    // moodle-playground.com — the old test measured the shorter one, so the
    // guarded number was 14 short of every real link.
    const url = buildPreviewUrl({
      playgroundHost: "https://daviducl.github.io/moodle-playground",
      blueprint: buildBlueprint({ ...base, ...shape.opts }),
    });
    seen.push(`${shape.label}=${url.length}`);
    assert.ok(
      url.length < shape.max,
      `${shape.label}: url was ${url.length} chars, over its ${shape.max} bound. ` +
        `If the growth is intended, raise THIS bound and say what added the bytes. ` +
        `All shapes: ${seen.join(", ")}`,
    );
  }
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
    // The builder's own assertions. The playground registers them all as
    // `runPhpCode`, so WHICH assertion a step is cannot be told from its name —
    // which is why the tests here select on each generator's exit-code block.
    "runPhpCode",
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
  // No RESTORE assertion — block 2x. There IS a course-id assertion (block 6x),
  // because this preview lands on the add form, which names a course by number.
  // Selected by exit-code block, since both are `runPhpCode` steps.
  assert.equal(phpIn(bp, 2).length, 0);
  assert.equal(phpIn(bp, 6).length, 1);
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


// The five tests below run the BUILDER as a subprocess against a real course
// backup. They used to reach raw.githubusercontent.com for it — see
// test/helpers/net-fixtures.mjs for what that cost and why it is now served
// from disk. `NODE_OPTIONS=--import=` propagates into the subprocess, so the
// builder's own fetch is stubbed too.

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
  const { buildThemeAssertion, buildThemeCssWarmup } = await import("../scripts/theme-assert.mjs");
  for (const bad of ["", "Boost", "boost-union", "boost union", "1boost", "boost';DROP", null, undefined]) {
    assert.throws(() => buildThemeAssertion(bad), /unusable theme name/, `accepted ${JSON.stringify(bad)}`);
    assert.throws(() => buildThemeCssWarmup(bad), /unusable theme name/, `accepted ${JSON.stringify(bad)}`);
  }
});

test("the warm-up can only fail the boot the one way this runtime allows", async () => {
  const { buildThemeAssertion } = await import("../scripts/theme-assert.mjs");
  const step = buildThemeAssertion("boost_union");
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
  const { buildThemeAssertion, buildThemeCssWarmup, THEME_CODES, THEME_CSS_FAILURE_MARKER } =
    await import("../scripts/theme-assert.mjs");
  const { code } = buildThemeAssertion("boost_union");
  const css = buildThemeCssWarmup("boost_union").code;
  // Four silent-Boost failures, all invisible to a reviewer, so all four must
  // take the boot down. 33 is the one that catches a MISSING PARENT THEME:
  // theme_config::load() falls back and returns a config named something else.
  for (const c of [31, 32, 33, 34]) {
    assert.match(code, new RegExp(`exit\\(${c}\\)`), `no exit(${c})`);
    assert.ok(THEME_CODES[c], `code ${c} has no explanation`);
  }
  // The fallback is detected by NAME, not by assuming load() throws — it does
  // not throw for a non-default theme, it quietly returns a different one.
  assert.match(code, /\$th->name !== \$t/);
  // A failed stylesheet leaves a working, unstyled site — visible on sight, and
  // better than no preview. It must NOT be an exit code.
  assert.match(css, new RegExp(`error_log\\('${THEME_CSS_FAILURE_MARKER}`));
  assert.equal(new RegExp(`${THEME_CSS_FAILURE_MARKER}[^;]*\\); exit\\([1-9]`).test(css), false);
  // ...and the expensive step cannot cost the reviewer the preview itself: a
  // WASM heap abort is not a PHP exception, so no try here can catch it.
  assert.equal(buildThemeCssWarmup("boost_union").critical, false);
  assert.equal(buildThemeAssertion("boost_union").critical, true);
  // And it must be error_log, not echo: measured, on a step that exits 0 `echo`
  // reaches neither boot-log.txt nor console.txt, so an `echo` here is a report
  // nobody can read.
  assert.equal(/echo '/.test(css), false, "the marker is echoed, which is invisible");
  // A compile failure does NOT throw — Moodle catches it and writes a near-empty
  // sheet — so the size of what was produced is the only real signal.
  assert.match(css, /theme_get_css_filename/);
  assert.match(css, /filesize/);
});

test("the warm-up reads the theme from $CFG, never the literal the runtime hardcodes", async () => {
  const { buildThemeAssertion } = await import("../scripts/theme-assert.mjs");
  const { code } = buildThemeAssertion("boost_union");
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

// A commented-out declaration is not a declaration. The theme skeleton every
// Moodle theme is copied from ships `// $THEME->parents = array('boost');` as
// boilerplate, and reading that as real cleared the one refusal that exists to
// catch a theme with no parents at all.
test("a commented-out $THEME->parents is not read as a declaration", async () => {
  const { parseThemeParents } = await import("../scripts/extras.mjs");
  const v = parseThemeParents(
    "<?php\n// $THEME->parents = array('boost');\n$THEME->name = 'x';\n",
    "theme_x",
  );
  assert.equal(v.ok, false);
  assert.match(v.reason, /never sets \$THEME->parents/);
});

// An APPEND is invisible to the assignment regex (the character after
// `parents` is `[`, not `=`), so a literal plus a conditional append was read as
// the literal alone: the appended parent got no dependency edge AND no warning,
// and the reviewer met it as exit 33 at boot instead of a sentence at build.
test("an appended parent makes the parse say it cannot tell", async () => {
  const { parseThemeParents } = await import("../scripts/extras.mjs");
  const v = parseThemeParents(
    "<?php\n$THEME->parents = ['boost'];\nif ($x) { $THEME->parents[] = 'other'; }\n",
    "theme_x",
  );
  assert.equal(v.ok, true);
  assert.deepEqual(v.parents, []);
  assert.match(v.note, /runtime/);
});

test("a // inside a string is still not a comment", async () => {
  const { parseThemeParents } = await import("../scripts/extras.mjs");
  const v = parseThemeParents(
    "<?php\n$THEME->docs = 'https://example.invalid/docs';\n$THEME->parents = ['boost'];\n",
    "theme_x",
  );
  assert.deepEqual(v.parents, ["boost"]);
});

// Distinct exit codes are worthless if nothing prints what they mean.
test("the run log explains the exit codes the builder assigns meaning to", async () => {
  const { explainExitCodes } = await import("../scripts/assert.mjs");
  const lines = explainExitCodes([
    "runPhpCode failed with exit code 33",
    "restore failed with exit code 23",
    "something failed with exit code 99",
  ]);
  assert.equal(lines.length, 2, lines.join(" | "));
  assert.match(lines[0], /33 means/);
  assert.match(lines[0], /parent theme/);
  assert.match(lines[1], /23 means/);
  // 99 is not ours. Inventing a meaning would be worse than saying nothing.
  assert.equal(lines.some((l) => l.includes("99")), false);
});

test("a clean boot log produces no exit-code explanations", async () => {
  const { explainExitCodes } = await import("../scripts/assert.mjs");
  assert.deepEqual(explainExitCodes(["Blueprint step 5/5: setLandingPage"]), []);
  assert.deepEqual(explainExitCodes([]), []);
});

// The stylesheet step is non-critical and exits 0, so it cannot fail a verdict.
// Without this it reaches nobody: it reports through error_log, which lands in
// console.txt, which nothing else in the pipeline opens.
test("a stylesheet that did not build is reported, and silence is not", async () => {
  const { explainStylesheet } = await import("../scripts/assert.mjs");
  const { THEME_CSS_FAILURE_MARKER } = await import("../scripts/theme-assert.mjs");
  const note = explainStylesheet(
    `[console:log] something\n[console:warning] [blueprint] runPhpCode errors: ${THEME_CSS_FAILURE_MARKER}: boost_union produced 412 bytes of CSS\n`,
  );
  assert.match(note, /unstyled/);
  assert.match(note, /412 bytes/);
  assert.equal(explainStylesheet("[console:log] all fine\n"), null);
  assert.equal(explainStylesheet(""), null);
  assert.equal(explainStylesheet(null), null);
});

// ---- the counts, and the three places each one is written ----------------

// THE BUG THIS EXISTS TO CATCH, measured before it was fixed. Every count used
// to be written twice in JS — once as `buildBlueprint`'s parameter default and
// once as `main()`'s `clampCount` fallback — and nothing compared them, because
// `main()` always passes the count explicitly. So the parameter default was
// exercised only by tests and the fallback only by real runs. Setting the
// `students` fallback to 0 left all four golden snapshots, check 1o and the
// whole unit suite green while every adopter of examples/pr-preview-workflow.yml
// (which passes no counts) got a preview whose only learner did not exist and
// whose last step died on MUST_EXIST.
//
// One table now makes that unrepresentable in JS. What a test still has to pin
// is the THIRD copy, in preview/action.yml, because YAML cannot import.
test("preview/action.yml's declared defaults agree with the one count table", async () => {
  const { COUNT_INPUTS, clampCount } = await import("../scripts/build-preview.mjs");
  const fs = await import("node:fs");
  const yaml = fs.readFileSync(new global.URL("../preview/action.yml", import.meta.url), "utf8");

  for (const [id, spec] of Object.entries(COUNT_INPUTS)) {
    // The input's own block, up to the next top-level input. A bare search for
    // `default:` would find whichever came first in the file.
    const block = new RegExp(`\\n  ${id}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z0-9-]*:\\n|\\noutputs:)`).exec(yaml);
    if (!block) continue; // not yet wired to the action — the count table leads
    const declared = /default:\s*"([^"]*)"/.exec(block[1]);
    assert.ok(declared, `preview/action.yml's "${id}" input declares no quoted default`);
    assert.equal(
      clampCount(declared[1], spec.fallback, spec.min, spec.max),
      spec.fallback,
      `preview/action.yml says ${id} defaults to "${declared[1]}", which is not ` +
        `COUNT_INPUTS.${id}.fallback (${spec.fallback}). A caller who omits the ` +
        `input and a caller who accepts the form default would get different previews.`,
    );
  }
});

test("every count input the action declares has a row in the count table", async () => {
  const { COUNT_INPUTS } = await import("../scripts/build-preview.mjs");
  const fs = await import("node:fs");
  const yaml = fs.readFileSync(new global.URL("../preview/action.yml", import.meta.url), "utf8");
  // The reverse direction. Without it, deleting a row from the table leaves the
  // loop above iterating over what is left and reporting a clean pass.
  for (const id of ["students", "sections"]) {
    assert.ok(
      new RegExp(`\\n  ${id}:\\n`).test(yaml),
      `preview/action.yml no longer declares "${id}" — if it was renamed, rename its COUNT_INPUTS row too`,
    );
    assert.ok(COUNT_INPUTS[id], `COUNT_INPUTS has no row for the declared input "${id}"`);
  }
});

// ---- the account roster --------------------------------------------------

test("the first teacher keeps the bare name every shared link already uses", async () => {
  const { teacherNames } = await import("../scripts/build-preview.mjs");
  assert.deepEqual(teacherNames(0), []);
  assert.deepEqual(teacherNames(1), ["teacher"]);
  assert.deepEqual(teacherNames(2), ["teacher", "teacher2"]);
  // NOT teacher1. `login-as` validates against this name, and so does every
  // saved `gh workflow run` command and every link already pasted into a pull
  // request. Symmetry with student1/student2 is not worth breaking them — and
  // `teacher1` is what Moodle's own backup generators produce, so reserving it
  // would refuse ordinary course backups.
  assert.equal(teacherNames(2).includes("teacher1"), false);
});

test("the account list covers every name a reviewer may be signed in as", async () => {
  const { accountNames } = await import("../scripts/build-preview.mjs");
  const names = accountNames(3, 2);
  // admin is made by installMoodle, not createUsers — absent it, `login-as:
  // admin` is refused as a fictional account on every preview.
  assert.deepEqual(names, ["admin", "teacher", "teacher2", "student1", "student2", "student3"]);
  assert.deepEqual(accountNames(1, 0), ["admin", "student1"]);
  assert.deepEqual(accountNames(1, 1), ["admin", "teacher", "student1"]);
});

test("a count that is not a number is not echoed raw into the runner log", async () => {
  const { clampCount } = await import("../scripts/build-preview.mjs");
  const said = [];
  const real = console.log;
  console.log = (...a) => said.push(a.join(" "));
  try {
    // A newline starts a new line of runner output at column 0, and `::` opens
    // a workflow command there. Demonstrated before this was fixed: a count of
    // this shape emitted an interpreted ::error:: annotation and an ::add-mask::
    // that hid later output.
    clampCount("x\n::error::forged\n::add-mask::secret", 1, 1, 20);
  } finally {
    console.log = real;
  }
  const all = said.join("\n");
  assert.equal(all.includes("\n::"), false, `a workflow command reached column 0: ${JSON.stringify(all)}`);
  assert.equal(all.includes("::error::"), false);
  assert.equal(said.length, 1, "one note, not one per line of the value");
});

test("truncation and clamping are reported as the different things they are", async () => {
  const { clampCount } = await import("../scripts/build-preview.mjs");
  const said = [];
  const real = console.log;
  console.log = (...a) => said.push(a.join(" "));
  try {
    assert.equal(clampCount("2.9", 1, 1, 20), 2);
  } finally {
    console.log = real;
  }
  // It used to print "2.9 is outside 1-20", which is false twice: 2.9 is inside
  // the range, and nothing was clamped. On the 0-2 teacher domain the old
  // wording reads as a refusal — "0.5 is outside 0-2".
  assert.equal(said.join(" ").includes("outside"), false, said.join(" "));
  assert.match(said.join(" "), /not a whole number/);
});

// ---- the teachers control ------------------------------------------------

const usersOf = (bp) => bp.steps.find((s) => s.step === "createUsers").users;
const enrolOf = (bp) => bp.steps.find((s) => s.step === "enrolUsers").enrolments;
const loginOf = (bp) => bp.steps.find((s) => s.step === "login").username;
const briefOf = (bp) => bp.steps.find((s) => s.step === "addModule").intro;

test("one teacher by default, and the default preview is unchanged", () => {
  const bp = buildBlueprint(base);
  assert.deepEqual(usersOf(bp).map((u) => u.username), ["teacher", "student1"]);
  assert.deepEqual(enrolOf(bp).map((e) => e.role), ["editingteacher", "student"]);
  // Omitting the option and passing the default must be the same preview. This
  // is what keeps every link and saved command from before the control valid.
  assert.deepEqual(buildBlueprint({ ...base, teachers: 1 }), bp);
});

test("the second teacher is inserted at index 1, NOT appended after the students", () => {
  const bp = buildBlueprint({ ...base, teachers: 2, students: 3 });
  assert.deepEqual(usersOf(bp).map((u) => u.username), [
    "teacher", "teacher2", "student1", "student2", "student3",
  ]);
  assert.equal(usersOf(bp)[1].username, "teacher2");
  assert.equal(enrolOf(bp)[1].username, "teacher2");
  // Appending instead would make the `teachers` blueprint diff byte-identical
  // to the `students` one — check 1o compares list elements by index over the
  // common prefix — and the gate would refuse a CORRECT build. Plant
  // `1o-overlap` proves the gate half; this is the builder half.
});

test("both teachers can edit — a non-editing second teacher would read as a bug", () => {
  const bp = buildBlueprint({ ...base, teachers: 2 });
  const roles = enrolOf(bp).filter((e) => e.username.startsWith("teacher")).map((e) => e.role);
  assert.deepEqual(roles, ["editingteacher", "editingteacher"]);
  // Moodle's non-editing `teacher` role is a strict subset: 88 core
  // capabilities are editingteacher-only and none are teacher-only, so a
  // non-editing teacher2 could not add an activity of any kind.
  assert.equal(roles.includes("teacher"), false);
});

test("teachers: 0 creates none, and signs the reviewer in as admin", () => {
  const bp = buildBlueprint({ ...base, teachers: 0 });
  assert.deepEqual(usersOf(bp).map((u) => u.username), ["student1"]);
  assert.equal(enrolOf(bp).some((e) => e.username.startsWith("teacher")), false);
  // NOT student1: the default landing for a `mod` plugin is the modedit ADD
  // FORM, which a student cannot open — the commonest preview would greet the
  // reviewer with a permission error.
  assert.equal(loginOf(bp), "admin");
  // And the steps still exist, with the teacher simply absent. An empty users
  // array is a legal no-op; branching to omit the step would add a path
  // exercised only at 0 students AND 0 teachers.
  assert.ok(bp.steps.some((s) => s.step === "createUsers"));
  assert.ok(bp.steps.some((s) => s.step === "enrolUsers"));
});

test("teachers: 0 does not override an explicit login-as", () => {
  // The count decides the DEFAULT. Someone who asked for student1 gets it.
  const bp = buildBlueprint({ ...base, teachers: 0, loginAs: "student1" });
  assert.equal(loginOf(bp), "student1");
});

test("the review brief names the accounts that exist, and no others", () => {
  const two = briefOf(buildBlueprint({ ...base, teachers: 2, students: 2 }));
  for (const u of ["admin", "teacher", "teacher2", "student1", "student2"]) {
    assert.ok(two.includes(`<code>${u}</code>`), `the brief should name ${u}`);
  }
  const none = briefOf(buildBlueprint({ ...base, teachers: 0 }));
  // The brief used to hardcode "admin, teacher, student1" — so a preview with
  // no teacher told the reviewer, on the course page, to log in as one.
  assert.equal(none.includes("<code>teacher</code>"), false);
  assert.match(none, /NO teacher/);
  assert.match(none, /administrator/);
  // ...and the caveat appears only when it is true.
  assert.equal(two.includes("NO teacher"), false);
});

test("a teacherless preview says so where a reviewer will actually read it", () => {
  // Three artifacts carry the roster, and all three used to be wrong at 0:
  // the blueprint (fixed above), the brief (fixed above) and the summary.
  // Without this the only evidence of the count is the count itself.
  const bp = buildBlueprint({ ...base, teachers: 0 });
  assert.equal(JSON.stringify(bp).includes('"teacher"'), false);
});

// ---- refusing a login that cannot happen ---------------------------------

test("login-as names the two boxes that disagree, not an internal check", async () => {
  const { checkLoginAs } = await import("../scripts/build-preview.mjs");
  assert.deepEqual(checkLoginAs({ loginAs: "", teachers: 0, students: 1 }), []);
  assert.deepEqual(checkLoginAs({ loginAs: "teacher", teachers: 1, students: 1 }), []);
  assert.deepEqual(checkLoginAs({ loginAs: "teacher2", teachers: 2, students: 1 }), []);
  assert.deepEqual(checkLoginAs({ loginAs: "admin", teachers: 0, students: 1 }), []);

  const noTeacher = checkLoginAs({ loginAs: "teacher", teachers: 0, students: 1 });
  assert.equal(noTeacher.length, 1);
  assert.match(noTeacher[0], /teachers field is set to 0/);
  assert.match(noTeacher[0], /sign in as admin or student1/);

  const oneTeacher = checkLoginAs({ loginAs: "teacher2", teachers: 1, students: 1 });
  assert.equal(oneTeacher.length, 1);
  assert.match(oneTeacher[0], /only teacher is created/);
  assert.match(oneTeacher[0], /set teachers to 2/);

  // A name that is not an account at all gets ONE reason, not two — the count
  // advice cannot help someone who typed a name that never exists.
  const bogus = checkLoginAs({ loginAs: "teacher9", teachers: 2, students: 1 });
  assert.equal(bogus.length, 1);
  assert.match(bogus[0], /only accounts the blueprint creates/);
  // The pre-existing student case still behaves, including its one-reason rule.
  assert.equal(checkLoginAs({ loginAs: "student99", teachers: 1, students: 1 }).length, 1);
  assert.match(checkLoginAs({ loginAs: "student5", teachers: 1, students: 1 })[0], /raise the student count/);
});

test("the string \"0\" from the form survives the trip to a teacher count", async () => {
  const { clampCount } = await import("../scripts/build-preview.mjs");
  // THE GAP THIS CLOSES, measured. Nothing exercised teachers: 0 through the
  // env: the probe row probes "2", and every unit test passes a NUMBER. So the
  // ordinary tidy-up `clampCount(Number(process.env[X]) || fallback, ...)` —
  // which turns the string "0" into 1, because 0 is falsy — left the whole
  // suite, check 1o and check 1u green while the form's 0 option built a
  // one-teacher preview. 0 is the only value of this control that does anything
  // novel, and it was the one value nothing tested end to end.
  assert.equal(clampCount("0", 1, 0, 2), 0);
  assert.equal(clampCount("1", 1, 0, 2), 1);
  assert.equal(clampCount("2", 1, 0, 2), 2);
  // ...and an empty box is the DEFAULT, not zero. A composite action passes an
  // omitted input as "", so these two cases are one character apart and mean
  // opposite things.
  assert.equal(clampCount("", 1, 0, 2), 1);
  assert.equal(clampCount(undefined, 1, 0, 2), 1);
});

test("the dispatch form's teachers box agrees with the count table", async () => {
  const { COUNT_INPUTS, clampCount } = await import("../scripts/build-preview.mjs");
  const fs = await import("node:fs");
  const yaml = fs.readFileSync(
    new global.URL("../.github/workflows/preview-a-plugin.yml", import.meta.url), "utf8");
  // The FORM's default is a fourth copy of this number, and nothing pinned it:
  // commit 1's test reads preview/action.yml, and probe-controls.py never opens
  // .github/workflows at all. Setting it to "0" left everything green while
  // every ordinary dispatch built a teacherless preview.
  const block = /\n      teachers:\n([\s\S]*?)(?=\n      [a-z][a-z0-9-]*:\n)/.exec(yaml);
  assert.ok(block, "the teachers input block moved");
  const declared = /default:\s*"([^"]*)"/.exec(block[1]);
  assert.ok(declared, "the form's teachers default must be QUOTED — an unquoted 0 makes the form vanish");
  assert.equal(
    clampCount(declared[1], COUNT_INPUTS.teachers.fallback, COUNT_INPUTS.teachers.min, COUNT_INPUTS.teachers.max),
    COUNT_INPUTS.teachers.fallback,
    `the form offers "${declared[1]}" as its default, which is not COUNT_INPUTS.teachers.fallback`,
  );
  // Every option must be QUOTED and inside the range, in both directions: an
  // option outside it is silently clamped to something the reviewer did not ask
  // for, and a missing one makes part of the range unreachable from the form.
  const options = /options:\s*\[([^\]]*)\]/.exec(block[1]);
  assert.ok(options, "the teachers options moved");
  const values = options[1].split(",").map((v) => v.trim());
  for (const v of values) {
    assert.match(v, /^"[0-9]+"$/, `every teachers option must be quoted, got ${v}`);
  }
  const nums = values.map((v) => Number(v.replace(/"/g, "")));
  assert.deepEqual(
    nums, [0, 1, 2],
    "the form must offer exactly the range COUNT_INPUTS.teachers allows",
  );
  assert.equal(Math.min(...nums), COUNT_INPUTS.teachers.min);
  assert.equal(Math.max(...nums), COUNT_INPUTS.teachers.max);
});

test("every option the dispatch form offers is an account the builder accepts", async () => {
  const { checkLoginAs } = await import("../scripts/build-preview.mjs");
  const fs = await import("node:fs");
  const yaml = fs.readFileSync(
    new global.URL("../.github/workflows/preview-a-plugin.yml", import.meta.url), "utf8");
  // The dropdown and the builder's allowlist are two independent lists with
  // nothing binding them. Adding teacher2 to the form alone would render a
  // control that is refused 100% of the time, with a message saying the account
  // does not exist — a green gate and an unusable box.
  const block = /\n      login-as:\n([\s\S]*?)(?=\n      [a-z][a-z0-9-]*:\n)/.exec(yaml);
  assert.ok(block, "the login-as input block moved");
  const options = [...block[1].matchAll(/^\s+- "?([A-Za-z0-9()._-]+)"?$/gm)].map((m) => m[1]);
  assert.ok(options.length >= 6, `expected the dropdown's options, got ${JSON.stringify(options)}`);
  const { COUNT_INPUTS, teacherNames } = await import("../scripts/build-preview.mjs");
  for (const opt of options.filter((o) => o !== "(default)")) {
    // At the maximum counts, every offered account must exist.
    assert.deepEqual(
      checkLoginAs({ loginAs: opt, teachers: COUNT_INPUTS.teachers.max, students: COUNT_INPUTS.students.max }), [],
      `the form offers "${opt}" but the builder refuses it`,
    );
  }
  // AND THE OTHER DIRECTION, which the first version of this test left open:
  // deleting `- teacher2` from the dropdown passed, leaving the teachers: 2
  // control building an account no reviewer could ever select. Every teacher
  // the maximum count creates must be offered. Students are deliberately NOT
  // symmetric — the count goes to 20 and offering twenty options would bury the
  // three that matter.
  for (const account of ["admin", ...teacherNames(COUNT_INPUTS.teachers.max)]) {
    assert.ok(
      options.includes(account),
      `the builder can create "${account}" but the login-as dropdown does not offer it`,
    );
  }
});

// ---- the run summary -----------------------------------------------------

// The reviewer's only statement of what the link will do. It had NO unit
// coverage until the mutation harness proved the cost: deleting the teacher
// count from it, and making it name a different account from the one the link
// signs you in as, both survived with the whole suite green.
const summaryOpts = {
  type: "mod", name: "attendance", headSha: SHA, url: "https://example.invalid/?blueprint=x",
  component: "mod_attendance", headRepo: "DavidUCL/moodle-mod_attendance",
  extras: { list: "", themeSummary: "" }, moodleBranch: "MOODLE_500_STABLE",
  signedInAs: "teacher", php: "8.3", restore: null,
  teachers: 1, students: 1, sections: 3,
  landingPage: "/course/modedit.php?add=attendance&course=2&section=1",
  versionPhp: "version.php", core: { ok: true, standard: new Set(["mod_assign"]) },
  risky: [], loginAs: "",
};

test("the summary states the counts it actually built", async () => {
  const { previewSummary } = await import("../scripts/build-preview.mjs");
  const one = previewSummary(summaryOpts).join("\n");
  assert.match(one, /1 teacher\(s\), 1 student\(s\), 3 section\(s\)/);
  const two = previewSummary({ ...summaryOpts, teachers: 2, students: 5, sections: 7 }).join("\n");
  assert.match(two, /2 teacher\(s\), 5 student\(s\), 7 section\(s\)/);
  // A restore ignores the section count, so the summary must not claim one —
  // but the people counts are still ours and must still appear.
  const restored = previewSummary({
    ...summaryOpts, teachers: 0, restore: { info: { activityCount: 10 } },
  }).join("\n");
  assert.match(restored, /0 teacher\(s\), 1 student\(s\), restored from a backup \(10 activities\)/);
  assert.equal(restored.includes("section(s)"), false);
});

test("the summary names the account the link actually signs you in as", async () => {
  const { previewSummary } = await import("../scripts/build-preview.mjs");
  // Not recomputed from the landing page — read back off the blueprint, so it
  // cannot disagree with the login step. Prove it tracks the argument.
  const row = (u) => `| signed in as | \`${u}\` |`;
  assert.ok(previewSummary({ ...summaryOpts, signedInAs: "admin" }).includes(row("admin")));
  assert.ok(previewSummary({ ...summaryOpts, signedInAs: "student1" }).includes(row("student1")));
  const asTeacher = previewSummary(summaryOpts);
  assert.ok(asTeacher.includes(row("teacher")));
  assert.equal(asTeacher.includes(row("admin")), false);
});

test("a teacherless preview says so under the summary table, and only then", async () => {
  const { previewSummary } = await import("../scripts/build-preview.mjs");
  const none = previewSummary({ ...summaryOpts, teachers: 0, signedInAs: "admin" }).join("\n");
  assert.match(none, /No teacher was created/);
  assert.match(none, /capability checks a plugin relies on are bypassed/);
  // Not when there IS a teacher...
  assert.equal(previewSummary(summaryOpts).join("\n").includes("No teacher was created"), false);
  // ...not when the reviewer chose a real account, because then the missing
  // teacher did not decide anything...
  const chosen = previewSummary({ ...summaryOpts, teachers: 0, loginAs: "student1", signedInAs: "student1" });
  assert.equal(chosen.join("\n").includes("No teacher was created"), false);
  // ...but DO say it when they asked for admin alongside teachers: 0. The old
  // rule was `!loginAs`, which stayed silent exactly there.
  const asked = previewSummary({ ...summaryOpts, teachers: 0, loginAs: "admin", signedInAs: "admin" });
  assert.match(asked.join("\n"), /No teacher was created/);
  // And never merely because the landing page needs an administrator: a block
  // or local plugin lands on /admin/..., where no other account was possible.
  const adminLanding = previewSummary({ ...summaryOpts, teachers: 1, signedInAs: "admin" });
  assert.equal(adminLanding.join("\n").includes("No teacher was created"), false);
});

test("no env-derived value can forge a workflow command on the runner", async () => {
  const { sanitiseForLog } = await import("../scripts/sanitise.mjs");
  // The class, not the instance. `clampCount` was fixed first; a sweep of the
  // other 22 env vars the action passes then found the same bug live in two
  // more places — `PLUGIN_ROOT` interpolated into a note on a run that EXITS 0,
  // and the error path dumping a refusal message's stack raw to stderr, which
  // undid the sanitising `Problems.annotate()` had already applied.
  //
  // A newline starts a new line of runner output at column 0; `::` opens a
  // command there. `::add-mask::` is the worst of them: it does not just forge
  // an annotation, it makes the runner replace that string everywhere in the
  // log afterwards — including inside the preview URL, which then prints
  // as ***.
  const payload = ".\n::add-mask::hunter2\n::error title=FORGED::pwned";
  const safe = sanitiseForLog(payload);
  assert.equal(safe.includes("\n"), false, "a newline survived");
  assert.equal(safe.includes("::"), false, "a workflow command opener survived");
  assert.equal(safe.includes("add-mask"), true, "the text itself should still be readable");
});

test("the review brief only claims the reviewer is an admin when they are", () => {
  // Keyed on BOTH the count and the account. Keyed on the count alone it told a
  // reviewer who chose login-as: student1 that they were an administrator —
  // and that pairing is what preview/action.yml recommends for a capability-
  // honest view, so it is the likeliest use of teachers: 0, not an edge case.
  const asStudent = briefOf(buildBlueprint({ ...base, teachers: 0, loginAs: "student1" }));
  assert.equal(asStudent.includes("administrator"), false);
  const asAdmin = briefOf(buildBlueprint({ ...base, teachers: 0 }));
  assert.match(asAdmin, /administrator/);
  // ...and never merely because the landing page needs one. A local plugin
  // lands on /admin/localplugins.php, where no other account was ever possible,
  // so the caveat there is noise in the one artifact a reviewer must read.
  const adminLanding = briefOf(buildBlueprint({
    ...base, type: "local", name: "myplugin", teachers: 1,
  }));
  assert.equal(adminLanding.includes("administrator"), false);
});

test("the roster helpers obey the count table, not a literal of their own", async () => {
  const { studentNames, teacherNames, COUNT_INPUTS } = await import("../scripts/build-preview.mjs");
  // Called directly with an out-of-range number — which main() prevents via
  // clampCount, so this is the only place the helpers' OWN bound is observable.
  // It matters because the two clamps are what keep the summary's count and the
  // blueprint's roster describing the same site.
  assert.equal(studentNames(999).length, COUNT_INPUTS.students.max);
  assert.equal(studentNames(0).length, COUNT_INPUTS.students.min);
  assert.equal(teacherNames(999).length, COUNT_INPUTS.teachers.max);
  assert.equal(teacherNames(-5).length, COUNT_INPUTS.teachers.min);
});

test("the reported account is read off the blueprint, not assumed", async () => {
  const { signedInAsOf } = await import("../scripts/build-preview.mjs");
  // The summary, the `preview-user` output and the login step must be one fact.
  // This is read back from the finished blueprint precisely so they cannot
  // disagree — and the disagreement is invisible to a reviewer, who sees only
  // the summary. Cover the cases where the answer is NOT the default, or a
  // constant would pass.
  assert.equal(signedInAsOf(buildBlueprint(base)), "teacher");
  assert.equal(signedInAsOf(buildBlueprint({ ...base, teachers: 0 })), "admin");
  assert.equal(signedInAsOf(buildBlueprint({ ...base, loginAs: "student1" })), "student1");
  assert.equal(signedInAsOf(buildBlueprint({ ...base, teachers: 2, loginAs: "teacher2" })), "teacher2");
  // A local plugin lands on /admin/, so the derived account is admin there too.
  assert.equal(signedInAsOf(buildBlueprint({ ...base, type: "local", name: "myplugin" })), "admin");
  // And a blueprint with no login step is an internal error, not "undefined"
  // printed into the reviewer's summary.
  assert.throws(() => signedInAsOf({ steps: [{ step: "installMoodle" }] }), /no login step/);
});

// ---- the course-format control -------------------------------------------

const courseOf = (bp) => bp.steps.find((s) => s.step === "createCourse");
// SELECT ON THE EXIT-CODE BLOCK, not on the step name. Every assertion this
// builder emits is a `runPhpCode` step, so counting by name silently conflated
// them the moment a second one could appear in the same blueprint — and it now
// can. Each generator owns a block of ten (21-24 restore, 31-34 theme, 41-44
// course format, 51-53 language packs, 61-62 course id) and a test enforces the
// blocks are disjoint, so the block IS the identity.
const phpIn = (bp, block) =>
  bp.steps.filter(
    (s) => s.step === "runPhpCode" && new RegExp(`exit\\(${block}\\d\\)`).test(s.code),
  );
const phpOf = (bp) => phpIn(bp, 4);

test("the format is stated in the blueprint, always, never left to the handler", () => {
  // `phpCreateCourses` defaults a missing format to topics, so omitting the key
  // is behaviourally identical — but the blueprint is the artifact a reviewer
  // can decode and read, and "no format key" is a fact about someone else's
  // code rather than about this preview.
  assert.equal(courseOf(buildBlueprint(base)).format, "topics");
  assert.equal(courseOf(buildBlueprint({ ...base, courseFormat: "weeks" })).format, "weeks");
});

test("a course-format plugin previews itself, under its own name", () => {
  const bp = buildBlueprint({ ...base, type: "format", name: "tiles" });
  assert.equal(courseOf(bp).format, "tiles");
  // ...and the assertion rides along, because that name is not the default and
  // a format that failed to install renders as an ordinary topics course.
  assert.equal(phpOf(bp).length, 1);
  assert.match(phpOf(bp)[0].code, /\$want = 'tiles'/);
});

test("the format assertion rides a non-default format and nothing else", () => {
  // At topics it could only ever pass — core resolving topics to topics — which
  // is the inert-assertion shape this project gates against. It also costs
  // ~1KB of URL on every preview, measured.
  assert.equal(phpOf(buildBlueprint(base)).length, 0);
  for (const f of ["weeks", "social", "singleactivity"]) {
    assert.equal(phpOf(buildBlueprint({ ...base, courseFormat: f })).length, 1, f);
  }
});

test("the assertion reads the RESOLVED format, not the column", async () => {
  const { buildCourseAssertion } = await import("../scripts/course-assert.mjs");
  const { code } = buildCourseAssertion({ format: "weeks", shortname: "REVIEW" });
  // THE POINT OF THE WHOLE FILE. Moodle stores a bogus format verbatim and then
  // renders the site default, so `$DB->get_field('course','format',...) === $want`
  // is TRUE in both the working and the broken case. Only the resolved format
  // tells them apart.
  assert.match(code, /course_get_format\(\$c\)->get_format\(\)/);
  // The column IS read — but only to choose between exit 41 and 43, which is
  // what makes LIVE 8b's "41 and not 43" a standing measurement that the column
  // keeps the bogus value.
  assert.match(code, /exit\(\$c->format === \$want \? 41 : 43\)/);
  // Failure is only reportable with the CLI_SCRIPT define before config.php.
  assert.match(code, /^<\?php define\('CLI_SCRIPT',true\);/);
  assert.ok(code.indexOf("CLI_SCRIPT") < code.indexOf("config.php"));
  // One line, and therefore no `//` — see the snapshot suite for why.
  assert.equal(code.includes("\n"), false);
  assert.equal(code.includes("//"), false);
});

test("the assertion refuses to be built from a name it cannot trust", async () => {
  const { buildCourseAssertion } = await import("../scripts/course-assert.mjs");
  for (const bad of ["we'eks", "we eks", "Weeks", "", "1weeks", "weeks;drop", "../etc"]) {
    assert.throws(
      () => buildCourseAssertion({ format: bad, shortname: "REVIEW" }),
      /unsafe course format/,
      `should refuse ${JSON.stringify(bad)}`,
    );
  }
  assert.throws(() => buildCourseAssertion({ format: "weeks", shortname: "rev iew" }), /unsafe course shortname/);
});

test("singleactivity moves the landing page, and only singleactivity does", () => {
  // It hides every section but 0 and moves every other displayable activity to
  // section 1 — the review brief with it — then redirects a reviewer who lands
  // on the bare course page to "Adding a new Forum".
  // BY NAME. /course/view.php resolves name= against the shortname through
  // MUST_EXIST, so a missing course is a loud error page rather than whichever
  // course happens to be number 2.
  assert.equal(
    landingPath("theme", "boost_union", { courseFormat: "singleactivity" }),
    "/course/view.php?name=REVIEW&section=1",
  );
  for (const f of ["topics", "weeks", "social", ""]) {
    assert.equal(landingPath("theme", "boost_union", { courseFormat: f }), "/course/view.php?name=REVIEW", f);
  }
  // A mod plugin lands on the add form, which is outside the redirect's guard,
  // so it is unaffected by the format.
  assert.match(landingPath("mod", "attendance", { courseFormat: "singleactivity", courseId: 2 }), /modedit\.php/);
});

test("the format the summary names is the format the course is in", async () => {
  const { previewSummary } = await import("../scripts/build-preview.mjs");
  assert.match(previewSummary({ ...summaryOpts, courseFormat: "weeks" }).join("\n"), /weeks format/);
  // The caveat appears for the one format that hides the course page...
  const single = previewSummary({ ...summaryOpts, courseFormat: "singleactivity" }).join("\n");
  assert.match(single, /hides the course page/);
  // ...and for no other.
  for (const f of ["topics", "weeks", "social"]) {
    assert.equal(
      previewSummary({ ...summaryOpts, courseFormat: f }).join("\n").includes("hides the course page"),
      false, f,
    );
  }
});

test("course-format refuses what Moodle would silently ignore", async () => {
  const { COURSE_FORMATS } = await import("../scripts/build-preview.mjs");
  assert.deepEqual(COURSE_FORMATS, ["topics", "weeks", "social", "singleactivity"]);
  // The list is closed because create_course() validates nothing: an unknown
  // format is stored verbatim and rendered as topics, so a typo in this box is
  // invisible in the preview AND in the boot log.
  assert.equal(COURSE_FORMATS.includes("weekly"), false);
});

test("every course format the form offers is one the builder accepts", async () => {
  const { COURSE_FORMATS, DEFAULT_SENTINEL } = await import("../scripts/build-preview.mjs");
  const fs = await import("node:fs");
  const yaml = fs.readFileSync(
    new global.URL("../.github/workflows/preview-a-plugin.yml", import.meta.url), "utf8");
  // Both directions, because the two lists are independent and nothing else
  // binds them: a form offering `weekly` — one letter off — would pass every
  // other check and boot a course in a format that does not exist.
  const block = /\n      course-format:\n([\s\S]*?)(?=\n      [a-z][a-z0-9-]*:\n|\n\n)/.exec(yaml);
  assert.ok(block, "the course-format input block moved");
  const options = /options:\s*\[([^\]]*)\]/.exec(block[1]);
  assert.ok(options, "the course-format options moved");
  const values = options[1].split(",").map((v) => v.trim());
  for (const v of values) {
    assert.match(v, /^"[a-z()]+"$/, `every course-format option must be quoted, got ${v}`);
  }
  const offered = values.map((v) => v.replace(/"/g, ""));
  assert.equal(offered[0], DEFAULT_SENTINEL, "the unset token must be first, as the default");
  assert.deepEqual(
    offered.slice(1), COURSE_FORMATS,
    "the form's formats and COURSE_FORMATS must be the same list, in the same order",
  );
  // And the declared default must BE the sentinel, not a real format.
  assert.match(block[1], new RegExp(`default:\\s*"${DEFAULT_SENTINEL.replace(/[()]/g, "\\$&")}"`));
});

test("course-format names the boxes that disagree, and only real reasons", async () => {
  const { checkCourseFormat } = await import("../scripts/build-preview.mjs");
  const ok = { courseFormat: "weeks", type: "mod", name: "attendance", restoreUrl: "" };
  assert.deepEqual(checkCourseFormat({ ...ok, courseFormat: "" }), []);
  assert.deepEqual(checkCourseFormat(ok), []);
  for (const f of ["topics", "social", "singleactivity"]) {
    assert.deepEqual(checkCourseFormat({ ...ok, courseFormat: f }), [], f);
  }

  // A format Moodle does not have. ONE reason, and it returns early: reporting
  // the conflicts as well would give one field several rows about a value that
  // is not a format at all.
  const bogus = checkCourseFormat({ ...ok, courseFormat: "weekly", type: "format", restoreUrl: "x" });
  assert.equal(bogus.length, 1);
  assert.match(bogus[0], /must be one of topics, weeks, social, singleactivity/);
  assert.match(bogus[0], /Moodle does NOT check this/);

  // The plugin under review is itself a course format.
  const selfFmt = checkCourseFormat({ ...ok, type: "format", name: "tiles" });
  assert.equal(selfFmt.length, 1);
  assert.match(selfFmt[0], /IS a course format \(format_tiles\)/);
  assert.match(selfFmt[0], /Leave the box alone/);

  // A restore brings its own format and emits no createCourse at all, so the
  // box would be dropped in silence.
  const restored = checkCourseFormat({ ...ok, restoreUrl: "https://example.invalid/c.mbz" });
  assert.equal(restored.length, 1);
  assert.match(restored[0], /brings its own format/);
  // ...and the sample-content menu is the same thing by another name.
  assert.equal(checkCourseFormat({ ...ok, restoreUrl: "review-course" }).length, 1);

  // Both conflicts at once are both reported: they are independent mistakes and
  // fixing one leaves the other.
  assert.equal(checkCourseFormat({ ...ok, type: "format", restoreUrl: "x" }).length, 2);
});

// ---- the language-packs control ------------------------------------------

const langStepOf = (bp) => bp.steps.find((s) => s.step === "installLanguagePack");

test("language packs are refused, never quietly dropped", async () => {
  const { parseLanguagePacks, MAX_LANGUAGE_PACKS } = await import("../scripts/lang-assert.mjs");
  assert.deepEqual(parseLanguagePacks(""), { codes: [], problems: [] });
  assert.deepEqual(parseLanguagePacks("es,ar").codes, ["es", "ar"]);
  assert.deepEqual(parseLanguagePacks(" es , ar ").codes, ["es", "ar"]);
  assert.deepEqual(parseLanguagePacks("pt_br").codes, ["pt_br"]);

  // Every rejection is a REPORTED problem, not a shorter list. `.filter(Boolean)`
  // on a split is how a preview boots without the thing that was asked for —
  // this repo has paid for that pattern more than once.
  const empty = parseLanguagePacks("es,,fr");
  assert.equal(empty.problems.length, 1);
  assert.match(empty.problems[0], /empty entry/);
  assert.match(parseLanguagePacks("ES").problems[0], /not a Moodle language code/);
  assert.match(parseLanguagePacks("e s").problems[0], /not a Moodle language code/);
  assert.match(parseLanguagePacks("es,es").problems[0], /listed more than once/);
  assert.match(parseLanguagePacks("es,fr,de,it").problems[0],
    new RegExp(`limit is ${MAX_LANGUAGE_PACKS}`));

  // `en` specifically. English lives in dirroot and never appears under
  // dataroot/lang/en, and its own `thislanguage` IS "English" — so it would
  // fail BOTH halves of the assertion on a completely healthy site. Refusing it
  // is honest; special-casing it inside the assertion would put a hole in the
  // assertion for every other code too.
  assert.match(parseLanguagePacks("en").problems[0], /built into Moodle/);
  assert.deepEqual(parseLanguagePacks("en").codes, []);
});

test("the language assertion cannot be satisfied by an empty directory", async () => {
  const { buildLangAssertion } = await import("../scripts/lang-assert.mjs");
  const { code } = buildLangAssertion({ codes: ["es", "ar"] });
  // THE POINT OF THE FILE. translation_exists('es') is
  // isset(get_list_of_translations()['es']), and that list keeps any directory
  // whose langconfig strings have a non-empty `thislanguage` — but
  // load_component_strings loads ENGLISH FIRST and only then overlays the
  // language, so an EMPTY dataroot/lang/es reports installed as "English (es)".
  assert.equal(code.includes("translation_exists"), false);
  assert.equal(code.includes("get_list_of_translations"), false);
  // What it does instead: the pack's own file, and a name that is not English.
  assert.match(code, /is_file\(\$dir \. '\/langconfig\.php'\)/);
  assert.match(code, /\$name === 'English'/);
  // Every code is checked BEFORE the site language, so asking for a language
  // that does not exist exits 51 (missing) and not 52 (wrong site language) —
  // the playground sets $CFG->lang to the first code unconditionally, so 52
  // would otherwise describe a missing pack as a wrong selection.
  assert.ok(code.indexOf("exit(51)") < code.indexOf("exit(52)"));
  assert.match(code, /^<\?php define\('CLI_SCRIPT',true\);/);
  assert.ok(code.indexOf("CLI_SCRIPT") < code.indexOf("config.php"));
  assert.equal(code.includes("\n"), false);
  assert.equal(code.includes("//"), false);
});

test("the language assertion refuses to be built from a code it cannot trust", async () => {
  const { buildLangAssertion } = await import("../scripts/lang-assert.mjs");
  assert.throws(() => buildLangAssertion({ codes: [] }), /at least one code/);
  for (const bad of ["ES", "e s", "e'; drop", "1es", "", "en"]) {
    assert.throws(() => buildLangAssertion({ codes: [bad] }), /unsafe language code/, bad);
  }
});

test("the install step and its assertion travel together, before any user exists", () => {
  const bp = buildBlueprint({ ...base, languagePacks: ["es", "ar"] });
  const order = bp.steps.map((s) => s.step);
  const step = langStepOf(bp);
  assert.deepEqual(step.languages, ["es", "ar"]);
  // One control, not two: the first pack becomes the site language, because the
  // stated use — seeing a plugin render right-to-left — needs it ACTIVE.
  assert.equal(step.setDefault, true);
  // A user takes its language from $CFG->lang AT CREATION, so accounts made
  // before this step would stay English while the site moved — and the reviewer
  // logs into one of them.
  assert.ok(order.indexOf("installLanguagePack") < order.indexOf("createUsers"));
  assert.ok(order.indexOf("installLanguagePack") < order.indexOf("login"));
  assert.ok(order.indexOf("installLanguagePack") < order.indexOf("setLandingPage"));
  // ...and after the plugin installs, so the language is not installed into a
  // Moodle that is about to have code dropped into it.
  assert.ok(order.indexOf("installLanguagePack") > order.lastIndexOf("installMoodlePlugin"));
  // The assertion is the very next step. The install step CANNOT fail — its PHP
  // and its JS each swallow everything — so nothing else would notice.
  assert.equal(order[order.indexOf("installLanguagePack") + 1], "runPhpCode");
  // Nothing at all when the box is empty. Selected by EXIT-CODE BLOCK, not by
  // step name: a bare `mod` preview now carries a course-id assertion, which is
  // also a `runPhpCode`, so counting by name would assert the wrong thing here.
  assert.equal(langStepOf(buildBlueprint(base)), undefined);
  assert.equal(phpIn(buildBlueprint(base), 5).length, 0);
});

test("the summary names the site language, and warns about what looks broken", async () => {
  const { previewSummary } = await import("../scripts/build-preview.mjs");
  const es = previewSummary({ ...summaryOpts, languagePacks: ["es", "ar"] }).join("\n");
  assert.match(es, /es, ar — site language is es/);
  assert.match(es, /This preview is in es, not English/);
  // The one that matters most: a partial translation is normal Moodle
  // behaviour and is indistinguishable from a half-finished download.
  assert.match(es, /fall back to English/);
  assert.match(es, /under your avatar/);
  const none = previewSummary(summaryOpts).join("\n");
  assert.equal(none.includes("site language is"), false);
  assert.equal(none.includes("not English"), false);
});

// ---- the review course's id ----------------------------------------------

test("the course id is derived from the steps, and refuses to guess", async () => {
  const { reviewCourseId } = await import("../scripts/build-preview.mjs");
  // Moodle numbers the site course 1 and the rest in creation order, so the
  // first course a blueprint makes is 2. That is the ONLY reason the old
  // `const COURSE_ID = 2` was right, and nothing checked it.
  assert.equal(reviewCourseId([{ step: "installMoodle" }, { step: "createCourse", shortname: "REVIEW" }]), 2);
  assert.equal(reviewCourseId([{ step: "restoreCourse", shortname: "REVIEW" }]), 2);

  // No course at all: there is no id to report, and returning 2 would send the
  // reviewer to whatever happened to be created by something else.
  // More than one is now LEGAL — that is what `courses` builds — provided ours
  // is first. This is the pair that matters: the same two courses, opposite
  // orders, opposite verdicts. A check that merely counted them would answer
  // both the same way.
  assert.equal(reviewCourseId([
    { step: "createCourse", shortname: "REVIEW" },
    { step: "createCourse", shortname: "REVIEW2" },
  ]), 2);
  assert.throws(
    () => reviewCourseId([
      { step: "createCourse", shortname: "REVIEW2" },
      { step: "createCourse", shortname: "REVIEW" },
    ]),
    /FIRST course-creating step makes "REVIEW2"/,
  );
  // No course at all, and REVIEW twice (the second aborts on shortnametaken).
  assert.throws(() => reviewCourseId([{ step: "installMoodle" }]), /no step creates a course/);
  assert.throws(
    () => reviewCourseId([
      { step: "createCourse", shortname: "REVIEW" },
      { step: "createCourse", shortname: "REVIEW" },
    ]),
    /created more than once/,
  );
  // The PLURAL step counts too. This builder never emits it, but the gate
  // allows it, and a course it made would otherwise be invisible here while
  // still taking an id from Moodle.
  assert.throws(
    () => reviewCourseId([
      { step: "createCourses", courses: [{ shortname: "OTHER" }, { shortname: "REVIEW" }] },
    ]),
    /FIRST course-creating step makes "OTHER"/,
  );
  // Someone else's course first. This is the reachable case today: a plugin
  // under review whose db/install.php creates a course takes id 2, because
  // installMoodlePlugin runs before createCourse.
  assert.throws(
    () => reviewCourseId([{ step: "createCourse", shortname: "DECOY" }]),
    /makes "DECOY", not REVIEW/,
  );
});

test("only the mod landing carries a course number, and it is the derived one", () => {
  const bp = buildBlueprint(base);
  const landing = bp.steps.find((s) => s.step === "setLandingPage").path;
  assert.match(landing, /course=2\b/);
  // Everything else that lands in the course does it by NAME, so those pages
  // cannot point at the wrong course however the numbering turns out.
  for (const opts of [{ type: "theme", name: "boost_union" }, { type: "format", name: "tiles" }]) {
    const p = buildBlueprint({ ...base, ...opts }).steps.find((s) => s.step === "setLandingPage").path;
    assert.match(p, /name=REVIEW/);
    assert.equal(/[?&]id=/.test(p), false, `${opts.type} should not carry a course id`);
  }
});

test("the summary's landing page IS the link's, not a second derivation", async () => {
  const { previewSummary, landingPageOf } = await import("../scripts/build-preview.mjs");
  // It used to be recomputed, and had already grown one argument to stay in
  // step; the next would have been the course id. Read back off the blueprint,
  // the two cannot disagree — and a reviewer only ever sees one of them.
  const bp = buildBlueprint({ ...base, courseFormat: "singleactivity", type: "theme", name: "boost_union" });
  const path = landingPageOf(bp);
  assert.equal(path, bp.steps.find((s) => s.step === "setLandingPage").path);
  assert.match(previewSummary({ ...summaryOpts, landingPage: path }).join("\n"), /section=1/);
  assert.throws(() => landingPageOf({ steps: [] }), /no landing page/);
});

// ---- the course-id assertion ---------------------------------------------

test("the expected id comes from the landing string, not from what built it", async () => {
  const { buildCourseIdAssertion, landingCourseId } = await import("../scripts/course-id-assert.mjs");
  // THE STRONGEST TEST IN THIS COMMIT. The whole point of the assertion is that
  // its two sides come from different places: the runtime reads mdl_course, and
  // the expected value is parsed back out of the landing string the reviewer
  // will open. Derive it from `reviewCourseId()` instead and it compares a
  // value with itself — two hashes of the same file, which this repo has
  // shipped once already.
  //
  // A `landing-path` override is the ONLY input that makes the two disagree, so
  // it is honoured rather than skipped; skipping it would make that mutant
  // unkillable and the assertion decorative.
  const bp = buildBlueprint({ ...base, landingOverride: "/course/view.php?id=9" });
  const step = bp.steps.find((s) => s.step === "runPhpCode" && /exit\(62\)/.test(s.code));
  assert.ok(step, "an overridden landing that names a course must still be checked");
  assert.match(step.code, /\$want = 9;/);
  // ...and NOT 2, which is what reviewCourseId() returns for this blueprint.
  assert.equal(/\$want = 2;/.test(step.code), false);
});

test("only a landing that names a course by number is checked", () => {
  const carries = (opts) =>
    buildBlueprint({ ...base, ...opts }).steps.some(
      (s) => s.step === "runPhpCode" && /exit\(62\)/.test(s.code),
    );
  // The add form takes required_param('course', PARAM_INT) — the one landing
  // that cannot use a name, and so the one that needs proving.
  assert.equal(carries({}), true);
  // These land by name or on an admin page. Emitting it there would compare
  // reviewCourseId() with itself AND cost ~245 characters of URL to say
  // nothing — measured on a `local` preview.
  assert.equal(carries({ type: "theme", name: "boost_union" }), false);
  assert.equal(carries({ type: "format", name: "tiles" }), false);
  assert.equal(carries({ type: "local", name: "myplugin" }), false);
  assert.equal(carries({ type: "block", name: "x" }), false);
});

test("a course number is recognised where it means a course, and nowhere else", async () => {
  const { landingCourseId } = await import("../scripts/course-id-assert.mjs");
  assert.equal(landingCourseId("/course/modedit.php?add=quiz&course=2&section=1"), 2);
  assert.equal(landingCourseId("/course/view.php?id=7"), 7);
  assert.equal(landingCourseId("/course/view.php?name=REVIEW"), null);
  assert.equal(landingCourseId("/admin/plugins.php"), null);
  // `id=` OUTSIDE /course/view.php is a course MODULE id, a user id or a
  // category id. A blanket `id=` would embed a cmid as a course id and fail a
  // perfectly correct build.
  assert.equal(landingCourseId("/mod/quiz/view.php?id=7"), null);
  assert.equal(landingCourseId("/user/profile.php?id=3"), null);
  assert.equal(landingCourseId("/course/index.php?categoryid=4"), null);
});

test("an add form with no course number is refused, not shipped", () => {
  // modedit.php would answer required_param with an error page reading as
  // "your plugin is broken". A refusal must not look like an absence.
  assert.throws(
    () => buildBlueprint({ ...base, landingOverride: "/course/modedit.php?add=quiz" }),
    /activity add form with no course number/,
  );
});

test("the assertion refuses inputs it cannot trust", async () => {
  const { buildCourseIdAssertion } = await import("../scripts/course-id-assert.mjs");
  for (const bad of [0, -1, 2.5, "2", null, undefined, NaN]) {
    assert.throws(() => buildCourseIdAssertion({ courseId: bad, shortname: "REVIEW" }),
      /positive integer id/, String(bad));
  }
  assert.throws(() => buildCourseIdAssertion({ courseId: 2, shortname: "rev iew" }), /unsafe course shortname/);
  const { code } = buildCourseIdAssertion({ courseId: 2, shortname: "REVIEW" });
  // IGNORE_MISSING plus an explicit test, never MUST_EXIST — not because a
  // throw is invisible (measured 2026-08-18: under CLI_SCRIPT it fails), but
  // because a throw exits 1, the GENERIC code, so it could not tell 61 from 62.
  assert.match(code, /IGNORE_MISSING/);
  assert.equal(code.includes("MUST_EXIST"), false);
  assert.match(code, /\(int\)\$c->id !== \$want/);
  assert.match(code, /^<\?php define\('CLI_SCRIPT',true\);/);
  assert.ok(code.indexOf("CLI_SCRIPT") < code.indexOf("config.php"));
  assert.equal(code.includes("\n"), false);
  assert.equal(code.includes("//"), false);
});

// ---- the courses control -------------------------------------------------

const coursesOf = (bp) =>
  bp.steps.filter((s) => s.step === "createCourse" || s.step === "restoreCourse")
    .map((s) => s.shortname);

test("the review course is created FIRST, whatever else is built", () => {
  assert.deepEqual(coursesOf(buildBlueprint(base)), ["REVIEW"]);
  assert.deepEqual(coursesOf(buildBlueprint({ ...base, courses: 2 })), ["REVIEW", "REVIEW2"]);
  assert.deepEqual(coursesOf(buildBlueprint({ ...base, courses: 3 })), ["REVIEW", "REVIEW2", "REVIEW3"]);
  // Moodle allocates course ids in creation order and the add form the reviewer
  // lands on carries a NUMBER, so first is not cosmetic.
  for (const n of [1, 2, 3]) {
    const bp = buildBlueprint({ ...base, courses: n });
    assert.equal(coursesOf(bp)[0], "REVIEW", `courses: ${n}`);
    assert.match(bp.steps.find((s) => s.step === "setLandingPage").path, /course=2\b/);
  }
});

test("the extras inherit what was chosen, not the handler's defaults", () => {
  const bp = buildBlueprint({ ...base, courses: 3, courseFormat: "weeks", sections: 7 });
  const made = bp.steps.filter((s) => s.step === "createCourse");
  assert.equal(made.length, 3);
  for (const c of made) {
    // The handler defaults a missing format to topics and a missing section
    // count to 5 — so omitting these would ship one weeks course and two topics
    // ones, and the reviewer would be comparing courses that differ in a way
    // nobody chose.
    assert.equal(c.format, "weeks", c.shortname);
    assert.equal(c.numsections, 7, c.shortname);
  }
  // ...and the extras are in their own category, so the review course is not
  // sorted below them (create_course sets sortorder 0, newest first).
  assert.equal(made[0].category, "Review");
  assert.deepEqual(made.slice(1).map((c) => c.category), ["Other courses", "Other courses"]);
  const cats = bp.steps.filter((s) => s.step === "createCategory").map((s) => s.name);
  for (const c of made) assert.ok(cats.includes(c.category), `${c.category} is never created`);
});

test("the last course is deliberately empty, and that is the point", () => {
  const bp = buildBlueprint({ ...base, courses: 3 });
  const enrol = bp.steps.find((s) => s.step === "enrolUsers").enrolments;
  const inCourse = (c) => enrol.filter((e) => e.course === c).map((e) => e.username);
  assert.deepEqual(inCourse("REVIEW"), ["teacher", "student1"]);
  assert.deepEqual(inCourse("REVIEW2"), ["teacher"]);
  // Enrol everyone everywhere and enrol_get_my_courses(), get_courses() and the
  // category API all return the same rows — so a plugin that ignores enrolment
  // is indistinguishable from one that honours it. The empty course is the
  // discriminator, and it is the most useful thing three courses can show.
  assert.deepEqual(inCourse("REVIEW3"), []);
  // The reviewer must still be able to SEE more than one, or the extras are
  // invisible to the account they arrive as.
  const loginUser = bp.steps.find((s) => s.step === "login").username;
  assert.ok(new Set(enrol.filter((e) => e.username === loginUser).map((e) => e.course)).size >= 2);
});

test("a course created after the enrolments is refused, not shipped", async () => {
  const { buildBlueprint: bb } = await import("../scripts/build-preview.mjs");
  // `order-rules.mjs` deliberately has no course-before-enrol rule, and on the
  // restore path checkReferences is waived from the opaque step onward — so a
  // badly ordered blueprint passes the gate and dies in the reviewer's browser
  // on a MUST_EXIST lookup. The builder has to hold this line itself.
  const bp = bb({ ...base, courses: 2 });
  const names = bp.steps.map((s) => s.step);
  assert.ok(names.lastIndexOf("createCourse") < names.indexOf("enrolUsers"));
});

test("every account is enrolled in the review course, per course not in total", () => {
  // The old invariant compared a flat set of usernames, so three courses with
  // enrolments in only one of them passed: nothing threw, the summary still
  // said three courses, and a "my courses" block would show one while the
  // reviewer blamed the plugin.
  for (const n of [1, 2, 3]) {
    const bp = buildBlueprint({ ...base, courses: n, teachers: 2, students: 3 });
    const created = bp.steps.find((s) => s.step === "createUsers").users.map((u) => u.username);
    const inReview = bp.steps.find((s) => s.step === "enrolUsers").enrolments
      .filter((e) => e.course === "REVIEW").map((e) => e.username);
    assert.deepEqual([...created].sort(), [...inReview].sort(), `courses: ${n}`);
  }
});

test("the summary names the courses, and the brief says which one is empty", async () => {
  const { previewSummary } = await import("../scripts/build-preview.mjs");
  const three = previewSummary({ ...summaryOpts, courseRoster: ["REVIEW", "REVIEW2", "REVIEW3"] }).join("\n");
  // The ROSTER, not "3 course(s)" — a count would still read correctly if the
  // builder made the wrong three.
  assert.match(three, /REVIEW, REVIEW2, REVIEW3/);
  const one = previewSummary({ ...summaryOpts, courseRoster: ["REVIEW"] }).join("\n");
  assert.equal(one.includes("REVIEW2"), false);
  const brief = buildBlueprint({ ...base, courses: 3 }).steps.find((s) => s.step === "addModule").intro;
  assert.match(brief, /REVIEW2/);
  assert.match(brief, /NOT in <code>REVIEW3<\/code>/);
  assert.equal(buildBlueprint(base).steps.find((s) => s.step === "addModule").intro.includes("REVIEW2"), false);
});

test("the course invariants reject the blueprints they exist to reject", async () => {
  const { checkCourseInvariants } = await import("../scripts/build-preview.mjs");
  const ok = [
    { step: "createCourse", shortname: "REVIEW" },
    { step: "createCourse", shortname: "REVIEW2" },
    { step: "createUsers", users: [{ username: "teacher" }, { username: "student1" }] },
    { step: "enrolUsers", enrolments: [
      { username: "teacher", course: "REVIEW" },
      { username: "student1", course: "REVIEW" },
      { username: "teacher", course: "REVIEW2" },
    ] },
  ];
  // These are invariants over the builder's OWN output, so nothing outside can
  // make them fail — which is why three mutants that gutted them survived a
  // full gate run while they were inline. Hand-built bad blueprints are the
  // only way to know they work.
  assert.doesNotThrow(() => checkCourseInvariants(ok, { loginUser: "teacher", extraCourses: ["REVIEW2"] }));

  // An account created and never enrolled in the review course. Counting a flat
  // set of usernames passed this, because the teacher IS enrolled somewhere.
  const flat = structuredClone(ok);
  flat[3].enrolments = [{ username: "teacher", course: "REVIEW2" }, { username: "student1", course: "REVIEW" }];
  assert.throws(
    () => checkCourseInvariants(flat, { loginUser: "student1", extraCourses: ["REVIEW2"] }),
    /teacher would be created but never enrolled in REVIEW/,
  );

  // The reviewer's own account seeing only one course while three exist.
  const blind = structuredClone(ok);
  blind[3].enrolments = blind[3].enrolments.filter((e) => e.course === "REVIEW");
  assert.throws(
    () => checkCourseInvariants(blind, { loginUser: "teacher", extraCourses: ["REVIEW2"] }),
    /enrolled in 1 course\(s\) but the preview builds 2/,
  );
  // ...unless they arrive as admin, who is in none of them by design.
  assert.doesNotThrow(() => checkCourseInvariants(blind, { loginUser: "admin", extraCourses: ["REVIEW2"] }));

  // A course created AFTER the enrolments. order-rules.mjs has no such rule and
  // on the restore path checkReferences is waived, so this would pass the gate
  // and die in the reviewer's browser on a MUST_EXIST lookup.
  const late = [ok[0], ok[2], ok[3], { step: "createCourse", shortname: "REVIEW2" }];
  assert.throws(() => checkCourseInvariants(late, { loginUser: "teacher", extraCourses: ["REVIEW2"] }),
    /created after enrolUsers/);
  // ...and a RESTORED course counts as a maker too.
  const lateRestore = [ok[0], ok[2], ok[3], { step: "restoreCourse", shortname: "REVIEW2" }];
  assert.throws(() => checkCourseInvariants(lateRestore, { loginUser: "teacher", extraCourses: ["REVIEW2"] }),
    /created after enrolUsers/);
});

test("buildBlueprint actually CALLS the course invariants", async () => {
  // A SOURCE-LEVEL test, and the reason is worth stating. The test above proves
  // `checkCourseInvariants` works by feeding it bad blueprints directly — but
  // it cannot prove buildBlueprint calls it, because buildBlueprint only ever
  // produces GOOD blueprints, so deleting the call changes no observable
  // behaviour. Measured: the mutant that removes the call survived while every
  // other invariant mutant died.
  //
  // Same shape as foreign-paths.test.mjs, which tests its wiring this way for
  // the same reason. A source test is weak, so it is used only where behaviour
  // genuinely cannot reach — never as a substitute for one that can.
  const fs = await import("node:fs");
  const src = fs.readFileSync(
    new global.URL("../scripts/build-preview.mjs", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("export function buildBlueprint("));
  assert.match(
    body,
    /checkCourseInvariants\(steps, \{ loginUser, extraCourses, isAdmin: arrivesAsAdmin \}\)/,
    "buildBlueprint must call checkCourseInvariants — without the call the " +
      "invariants are dead code and every one of their mutants is unkillable",
  );
});

test("a course backup that DECLARES an oversized body is refused unread", async () => {
  // The behavioural discriminator between `readCapped` and the
  // `Buffer.from(await res.arrayBuffer())` it replaced. Both accept every small
  // body, so only a content-length that disagrees with the body separates them:
  // one refuses before reading, the other reads and then measures — which is
  // the whole point of the change, since a hostile URL is not obliged to send a
  // small body.
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "cap-"));
  const url =
    "https://raw.githubusercontent.com/DavidUCL/githubactionsplayground/" +
    `${"c".repeat(40)}/fixtures/huge.mbz`;
  let out = "";
  try {
    execFileSync(process.execPath, ["scripts/build-preview.mjs"], {
      env: {
        ...process.env,
        HEAD_REPO: "DavidUCL/moodle-mod_attendance",
        HEAD_SHA: "a".repeat(40),
        PLUGIN_TYPE: "mod", PLUGIN_NAME: "attendance",
        RESTORE_COURSE_URL: url,
        OUT_DIR: dir, GITHUB_OUTPUT: join(dir, "gho"), GITHUB_STEP_SUMMARY: join(dir, "sum"),
      },
      encoding: "utf8", stdio: "pipe",
    });
    assert.fail("an oversized backup must be refused");
  } catch (err) {
    out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  assert.match(out, /restore-course-url/);
  assert.match(out, /declares 99999999 bytes, over the \d+ cap/);
});

// ---- restoring a whole database ------------------------------------------
//
// A different control from the course backup above, and they compose. See
// scripts/snapshot.mjs for why every check happens at link-build time, and
// scripts/db-assert.mjs for what the in-band assertion can still see.

/** What snapshot.mjs hands the builder for a healthy file. */
const SNAPSHOT = {
  url: "https://raw.githubusercontent.com/DavidUCL/mchef-urls/deadbeef/db.sq3",
  sha256: "a".repeat(64),
  facts: { identity: "b".repeat(32), branch: "500", adminUsername: "admin" },
};

test("the database is restored FIRST, before installMoodle", () => {
  const steps = buildBlueprint({ ...base, dbSnapshot: SNAPSHOT }).steps;
  const names = steps.map((s) => s.step);
  assert.equal(names[0], "restoreDatabase", "anything created before the swap is discarded");
  assert.equal(names[1], "installMoodle");
  assert.equal(steps[0].url, SNAPSHOT.url);
  // The action's default host aborts on any failed step, but the other honours
  // `critical` and would carry on into a site with no database of ours at all.
  assert.equal(steps[0].critical, true);
});

test("the assertion runs immediately after the install, before anything writes", () => {
  const steps = buildBlueprint({ ...base, dbSnapshot: SNAPSHOT }).steps;
  const names = steps.map((s) => s.step);
  assert.equal(names[2], "runPhpCode", "nothing may touch the database before it is checked");
  assert.ok(names.indexOf("runPhpCode") < names.indexOf("setConfigs"));
  // The identity read out of the file is what it compares against — the one
  // check that can see a snapshot whose bytes changed after the link was built.
  assert.ok(steps[2].code.includes(`'${SNAPSHOT.facts.identity}'`));
  assert.equal(steps[2].critical, true);
});

test("no database snapshot means no restoreDatabase step and no extra assertion", () => {
  const plain = buildBlueprint({ ...base }).steps.map((s) => s.step);
  assert.ok(!plain.includes("restoreDatabase"));
  assert.equal(plain[0], "installMoodle");
});

test("a restored database lands by name, because it decides its own course ids", () => {
  // reviewCourseId() answers 2 — the site course is 1 and ours is next. A
  // restored database makes that false: its own courses hold the low ids and
  // Moodle continues from the snapshot's sequence.
  for (const type of ["mod", "theme", "format"]) {
    const bp = buildBlueprint({ ...base, type, name: type === "mod" ? "attendance" : "boost_union", dbSnapshot: SNAPSHOT });
    assert.match(bp.landingPage, /\/course\/view\.php\?name=REVIEW/, `${type} landed on a number`);
    assert.ok(!/course=\d/.test(bp.landingPage), `${type} landing carries a course number`);
  }
});

test("a restored database emits no course-id assertion", () => {
  const steps = buildBlueprint({ ...base, dbSnapshot: SNAPSHOT }).steps;
  // It would compare the review course against id 2, which a restored database
  // makes wrong — aborting a boot that was otherwise fine.
  const phpSteps = steps.filter((s) => s.step === "runPhpCode");
  assert.ok(!phpSteps.some((s) => /get_field\('course','shortname'/.test(s.code)),
    "the course-id assertion must not be emitted under a database restore");
});

test("a landing-path that opens a course by number is refused under a restore", () => {
  // The one input that can override landing-by-name. Without this the link
  // opens somebody else's course, or aborts on the id assertion.
  assert.throws(
    () => buildBlueprint({
      ...base,
      dbSnapshot: SNAPSHOT,
      landingOverride: "/course/modedit.php?add=attendance&course=2&section=1",
    }),
    /decides its own course numbering/,
  );
  // A named path is fine.
  assert.ok(buildBlueprint({
    ...base,
    dbSnapshot: SNAPSHOT,
    landingOverride: "/course/view.php?name=REVIEW",
  }).landingPage);
  // ...and the same numeric override is still accepted with no snapshot, so
  // the refusal is about the restore rather than about the path.
  assert.ok(buildBlueprint({
    ...base,
    landingOverride: "/course/modedit.php?add=attendance&course=2&section=1",
  }).landingPage);
});

test("a database restore and a course backup compose, in that order", () => {
  const steps = buildBlueprint({
    ...base,
    dbSnapshot: SNAPSHOT,
    restore: {
      url: "https://raw.githubusercontent.com/o/r/c/review.mbz",
      info: { modulenames: ["assign"], activityCount: 1 },
    },
  }).steps;
  const names = steps.map((s) => s.step);
  // The database is swapped in first, so the course backup is restored INTO
  // the restored site rather than into a database that is about to be thrown
  // away.
  assert.ok(names.indexOf("restoreDatabase") < names.indexOf("restoreCourse"));
  assert.ok(!names.includes("createCourse"), "a course backup still replaces createCourse");
});

test("`admin` is never reserved against a snapshot, but every created account is", () => {
  const { reservedUsernames, reservedCourses } = snapshotReservations();
  // The mistake this exists to prevent, and it is not hypothetical: reserving
  // `admin` refused the real published snapshot the first time this ran.
  // installMoodle makes admin, createUsers does not — and after a restore
  // installMoodle finds a populated database and does nothing.
  assert.ok(!reservedUsernames.includes("admin"), "reserving admin refuses every real snapshot");
  assert.ok(reservedUsernames.includes("teacher"));
  assert.ok(reservedUsernames.includes("teacher2"));
  // The MAXIMUM of every count, not the counts chosen: a snapshot carrying
  // student20 must be refused even for a preview that makes one student, or
  // raising the count later boots into a createUsers failure.
  assert.deepEqual(reservedUsernames.filter((u) => u.startsWith("student")), studentNames(20));
  assert.deepEqual(reservedCourses, ["REVIEW", "REVIEW2", "REVIEW3"]);
});

test("the snapshot's own administrator is the account the reviewer arrives as", () => {
  // `admin` in the login-as box names a ROLE. Moodle does not require the
  // administrator to be called "admin", and `login` does a MUST_EXIST lookup —
  // so using the literal name would kill the boot at the last step on a
  // snapshot that is perfectly good.
  const renamed = { ...SNAPSHOT, facts: { ...SNAPSHOT.facts, adminUsername: "siteadmin" } };
  const steps = buildBlueprint({ ...base, type: "other", name: "x", dbSnapshot: renamed }).steps;
  assert.equal(steps.find((s) => s.step === "login").username, "siteadmin");

  // ...and the password is reset to the one the brief names, because the
  // account arrived with the source site's password and nobody has that.
  const setAdmin = steps.find((s) => s.step === "setAdminAccount");
  assert.ok(setAdmin, "the restored administrator's password is never reset");
  assert.equal(setAdmin.password, "password");
  assert.equal(setAdmin.critical, true);
  // Before anything the reviewer might need it for, and after the assertion —
  // there is no point resetting a password in a database we are about to refuse.
  const names = steps.map((s) => s.step);
  assert.ok(names.indexOf("runPhpCode") < names.indexOf("setAdminAccount"));
  assert.ok(names.indexOf("setAdminAccount") < names.indexOf("login"));

  // An explicitly chosen preview account is still honoured.
  const asStudent = buildBlueprint({ ...base, dbSnapshot: renamed, loginAs: "student1" }).steps;
  assert.equal(asStudent.find((s) => s.step === "login").username, "student1");
});

test("the review brief does not promise a password the restored admin does not have", () => {
  const brief = (opts) =>
    buildBlueprint({ ...base, ...opts }).steps.find((s) => s.name === "Review brief").intro;
  const plain = brief({});
  assert.match(plain, /<code>admin<\/code>/, "admin is a login when the preview creates it");
  assert.ok(!/administrator came with/.test(plain));

  // Under a restore the administrator is the SNAPSHOT'S, carrying the source
  // site's password. Listing it next to "password `password`" sent the reviewer
  // to a failed login that reads as a broken preview.
  const renamed = { ...SNAPSHOT, facts: { ...SNAPSHOT.facts, adminUsername: "siteadmin" } };
  const restored = brief({ dbSnapshot: renamed });
  assert.match(restored, /<code>siteadmin<\/code>/, "the snapshot's own admin is the login");
  assert.ok(!/Logins: <code>admin<\/code>/.test(restored), "`admin` may not be there at all");
  assert.match(restored, /is called <code>siteadmin<\/code>, not <code>admin<\/code>/);
  assert.match(restored, /<code>teacher<\/code>/, "the accounts it DOES create still appear");
});

test("the summary records the digest as a build-time fact, not a browser check", () => {
  const rows = (opts) =>
    previewSummary({
      type: "mod", name: "attendance", headSha: SHA, url: "https://x", component: "mod_attendance",
      headRepo: base.headRepo, extras: { list: "", themeSummary: "" },
      moodleBranch: "MOODLE_500_STABLE", signedInAs: "admin", php: "8.3",
      teachers: 1, students: 1, sections: 3, courseFormat: "topics", courseRoster: ["REVIEW"],
      landingPage: "/x", versionPhp: "", core: { ok: true, standard: new Set() },
      risky: [], loginAs: "", ...opts,
    }).join("\n");

  const none = rows({});
  assert.ok(!/database/.test(none), "no row when nothing was restored");

  const withDb = rows({ dbSnapshot: { ...SNAPSHOT, facts: { ...SNAPSHOT.facts, release: "5.0.2+" } } });
  // The full digest, so it can be compared against a file by hand.
  assert.ok(withDb.includes(SNAPSHOT.sha256), "the digest must be recorded in full");
  assert.match(withDb, /as downloaded when this link was built/);
  // It must NOT imply the reviewer's copy was checked: the restore rewrites the
  // file before any code of ours could hash it, so that claim would be false.
  assert.match(withDb, /the reviewer's browser re-downloads it/);
});

test("the risky note describes what each risky step actually does", () => {
  const note = (risky) =>
    previewSummary({
      type: "mod", name: "attendance", headSha: SHA, url: "https://x", component: "mod_attendance",
      headRepo: base.headRepo, extras: { list: "", themeSummary: "" },
      moodleBranch: "MOODLE_500_STABLE", signedInAs: "admin", php: "8.3",
      teachers: 1, students: 1, sections: 3, courseFormat: "topics", courseRoster: ["REVIEW"],
      landingPage: "/x", versionPhp: "", core: { ok: true, standard: new Set() },
      risky, loginAs: "",
    }).filter((l) => l.startsWith(">")).join("\n");

  // The old single note said "can rewrite Moodle AFTER installing ... code that
  // installs for real can be overwritten afterwards". Backwards for the restore
  // steps, which replace DATA, and do it BEFORE anything is installed.
  const db = note(["restoreDatabase"]);
  assert.match(db, /replaces the whole database before anything is installed/);
  assert.ok(!/overwritten afterwards/.test(db), "the code-rewriting wording must not be used here");
  assert.match(db, /version check/, "the reviewer must be told the mismatch check is off");

  const code = note(["runPhpCode"]);
  assert.match(code, /can rewrite Moodle after installing/);
  assert.ok(!/replaces the whole database/.test(code));

  // Both kinds at once: each gets its own note, neither is dropped.
  const both = note(["restoreDatabase", "writeFile"]);
  assert.match(both, /replaces the whole database/);
  assert.match(both, /can rewrite Moodle after installing/);
  assert.match(both, /`writeFile`/);
  assert.ok(!/`restoreDatabase`.*can rewrite Moodle after installing/s.test(both.split("\n")[0]));
});

// The account's NAME stopped answering "is this an administrator?" the moment a
// restored database could supply one called anything. Three separate places
// asked it that way, and each failed differently and silently.

test("a restored preview with extra courses does not demand enrolments of its admin", () => {
  // The invariant requires whoever arrives to reach more than one course when
  // more than one is built — and exempts an administrator, who reaches all of
  // them without an enrolment. Keyed on the NAME, a snapshot whose admin is
  // called `siteadmin` failed that exemption and refused to build a link at all.
  const renamed = { ...SNAPSHOT, facts: { ...SNAPSHOT.facts, adminUsername: "siteadmin" } };
  assert.doesNotThrow(() =>
    buildBlueprint({ ...base, type: "block", name: "html", courses: 3, dbSnapshot: renamed }));
  const steps = buildBlueprint({ ...base, type: "block", name: "html", courses: 3, dbSnapshot: renamed }).steps;
  assert.equal(steps.find((s) => s.step === "login").username, "siteadmin");
});

test("the in-course brief still warns a reviewer arriving as a renamed administrator", () => {
  const renamed = { ...SNAPSHOT, facts: { ...SNAPSHOT.facts, adminUsername: "siteadmin" } };
  const brief = (opts) =>
    buildBlueprint({ ...base, type: "block", name: "html", teachers: 0, ...opts })
      .steps.find((s) => s.name === "Review brief").intro;
  // An administrator bypasses the capability checks a plugin relies on. That is
  // exactly as true of `siteadmin`, and the caveat used to vanish for it.
  assert.match(brief({ dbSnapshot: renamed }), /you are an administrator/);
  assert.match(brief({}), /you are an administrator/);
  // ...and still silent when the reviewer chose a real account.
  assert.ok(!/you are an administrator/.test(brief({ dbSnapshot: renamed, loginAs: "student1" })));
});

test("the summary caveat is keyed on the role, and defaults to the name", async () => {
  const { previewSummary } = await import("../scripts/build-preview.mjs");
  const opts = {
    type: "mod", name: "attendance", headSha: SHA, url: "https://x", component: "mod_attendance",
    headRepo: base.headRepo, extras: { list: "", themeSummary: "" },
    moodleBranch: "MOODLE_500_STABLE", php: "8.3", teachers: 0, students: 1, sections: 3,
    courseFormat: "topics", courseRoster: ["REVIEW"], landingPage: "/x", versionPhp: "",
    core: { ok: true, standard: new Set() }, risky: [], loginAs: "",
  };
  // Told explicitly, the name is irrelevant.
  assert.match(
    previewSummary({ ...opts, signedInAs: "siteadmin", arrivesAsAdmin: true }).join("\n"),
    /No teacher was created/,
  );
  assert.ok(!previewSummary({ ...opts, signedInAs: "siteadmin" }).join("\n")
    .includes("No teacher was created"), "unset, a non-admin name means not an admin");
  // ...and the default still reads the name, so every caller that restores
  // nothing behaves exactly as it did.
  assert.match(previewSummary({ ...opts, signedInAs: "admin" }).join("\n"), /No teacher was created/);
});

test("who counts as an administrator is decided in one place", () => {
  // Three separate `=== "admin"` tests used to answer this, and each broke
  // differently once a restored database could supply an administrator called
  // something else.
  assert.equal(isAdministrator("admin"), true);
  assert.equal(isAdministrator("teacher"), false);
  const snap = { facts: { adminUsername: "siteadmin" } };
  assert.equal(isAdministrator("siteadmin", snap), true);
  assert.equal(isAdministrator("admin", snap), true, "`admin` is still an admin");
  assert.equal(isAdministrator("student1", snap), false);
  // An empty name is nobody, and — the trap — must not match a snapshot whose
  // administrator could not be read. "" === "" would report the reviewer as an
  // administrator on the strength of two missing values.
  assert.equal(isAdministrator("", { facts: {} }), false);
  assert.equal(isAdministrator("", null), false);
  assert.equal(isAdministrator(undefined, { facts: { adminUsername: "" } }), false);
  // A name that only matches because the snapshot was not consulted.
  assert.equal(isAdministrator("siteadmin"), false, "without the snapshot it is just a name");
});
