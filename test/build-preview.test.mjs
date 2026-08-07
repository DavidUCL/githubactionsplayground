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
  LANDING_RE,
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

test("a landing override that leaves the origin is refused", () => {
  for (const bad of ["//evil.tld/x", "https://evil.tld", "\\\\evil.tld", "no-leading-slash"]) {
    assert.equal(LANDING_RE.test(bad), false, bad);
  }
  for (const good of ["/course/view.php?id=2", "/admin/plugins.php", "/"]) {
    assert.equal(LANDING_RE.test(good), true, good);
  }
});
