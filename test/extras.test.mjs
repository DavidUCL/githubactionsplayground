// `extra-plugins`: resolving a ref to a commit, proving the archive and the
// version.php are really there, and installing dependencies FIRST.
//
// The dependency ordering is not a nicety. Moodle's `upgrade_plugins()`
// discards `$plugin->dependencies` outright, so nothing downstream of this file
// will ever notice a missing one — see the header of scripts/extras.mjs.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseRefAdvertisement,
  resolveRefIn,
  resolveCoordinates,
  checkArchives,
  fetchExtraVersion,
  checkExtraPlugin,
  checkDependenciesSatisfied,
  orderInstalls,
  clearAdvertisementCache,
  fetchThemeParents,
  parseThemeParents,
} from "../scripts/extras.mjs";
import { MAX_VERSION_PHP_BYTES } from "../scripts/plugin-version.mjs";

// ---------------------------------------------------------------------------
// pkt-line helpers. The advertisement is built here rather than captured as a
// fixture blob so a test can say what it is testing: the LENGTHS are the
// format, and a hand-written binary fixture hides them.

const pkt = (payload) => {
  const len = Buffer.byteLength(payload, "latin1") + 4;
  return len.toString(16).padStart(4, "0") + payload;
};
const FLUSH = "0000";

/** A realistic advertisement: service header, flush, then refs — the first ref
 * line carrying the server's capabilities after a NUL. */
const advertisement = (refs, { caps = "multi_ack thin-pack side-band-64k agent=git/2.45" } = {}) => {
  let out = pkt("# service=git-upload-pack\n") + FLUSH;
  refs.forEach(([name, sha], i) => {
    out += pkt(i === 0 ? `${sha} ${name}\0${caps}\n` : `${sha} ${name}\n`);
  });
  return Buffer.from(out + FLUSH, "latin1");
};

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

test("an advertisement decodes to its refs, and the capabilities are not one", () => {
  const r = parseRefAdvertisement(
    advertisement([
      ["refs/heads/main", A],
      ["refs/tags/v1.0", B],
    ]),
  );
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.refs.get("refs/heads/main"), A);
  assert.equal(r.refs.get("refs/tags/v1.0"), B);
  assert.equal(r.refs.size, 2, "the capability list was read as a ref");
});

// The lengths in the wire format count BYTES. Decoding as UTF-8 makes a
// multi-byte ref name shorter in characters than the packet says it is, and the
// parser then starts every later packet in the middle of the previous one.
test("a ref name with a multi-byte character does not derail the parser", () => {
  const r = parseRefAdvertisement(
    advertisement([
      ["refs/heads/café-fix", A].map((s, i) => (i === 0 ? Buffer.from(s, "utf8").toString("latin1") : s)),
      ["refs/heads/main", B],
    ]),
  );
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.refs.get("refs/heads/main"), B, "the ref after the multi-byte one was lost");
});

test("an html error page is not mistaken for an advertisement", () => {
  const r = parseRefAdvertisement(Buffer.from("<!DOCTYPE html><title>404</title>", "latin1"));
  assert.equal(r.ok, false);
  assert.match(r.reason, /not a git ref advertisement/);
});

test("a truncated advertisement is refused rather than half-read", () => {
  const full = advertisement([["refs/heads/main", A]]).toString("latin1");
  const r = parseRefAdvertisement(Buffer.from(full.slice(0, full.length - 12), "latin1"));
  assert.equal(r.ok, false);
  assert.match(r.reason, /mid-packet/);
});

// An empty repository is a well-formed advertisement with nothing in it. Saying
// "no such branch" would blame the user for typing a name that was never wrong.
test("a repository advertising no refs says so, not 'no such branch'", () => {
  const r = parseRefAdvertisement(Buffer.from(pkt("# service=git-upload-pack\n") + FLUSH + FLUSH, "latin1"));
  assert.equal(r.ok, false);
  assert.match(r.reason, /advertises no branches or tags/);
});

// ---------------------------------------------------------------------------

test("a branch resolves to its commit", () => {
  const refs = new Map([["refs/heads/main", A]]);
  assert.deepEqual(resolveRefIn(refs, "main"), { ok: true, sha: A, via: "refs/heads/main" });
});

// An annotated tag points at a TAG OBJECT. GitHub serves no archive for one, so
// the unpeeled SHA builds a URL that 404s — a preview with the plugin missing.
test("an annotated tag resolves to the commit it wraps, not the tag object", () => {
  const refs = new Map([
    ["refs/tags/v2", A],
    ["refs/tags/v2^{}", B],
  ]);
  assert.equal(resolveRefIn(refs, "v2").sha, B);
});

test("a name that is both a branch and a tag at different commits is refused", () => {
  const refs = new Map([
    ["refs/heads/release", A],
    ["refs/tags/release", B],
  ]);
  const r = resolveRefIn(refs, "release");
  assert.equal(r.ok, false);
  assert.match(r.reason, /both a branch and a tag/);
  assert.match(r.reason, /refs\/heads\/release/, "the reason must say how to disambiguate");
});

// The ambiguity only matters if the two disagree. Refusing when they point at
// the same commit would be a false refusal — the link is identical either way.
test("a branch and a tag at the SAME commit resolve", () => {
  const refs = new Map([
    ["refs/heads/release", A],
    ["refs/tags/release", A],
  ]);
  assert.equal(resolveRefIn(refs, "release").sha, A);
});

test("a fully qualified ref is looked up exactly, with no branch/tag guessing", () => {
  const refs = new Map([
    ["refs/heads/release", A],
    ["refs/tags/release", B],
  ]);
  assert.equal(resolveRefIn(refs, "refs/tags/release").sha, B);
  assert.equal(resolveRefIn(refs, "refs/heads/release").sha, A);
});

// A 7-character commit is what a human copies out of a UI, and it appears in no
// advertisement. The reason has to say what WOULD work.
test("a short commit is refused, and the reason says what to give instead", () => {
  const r = resolveRefIn(new Map([["refs/heads/main", A]]), "bafa3ed");
  assert.equal(r.ok, false);
  assert.match(r.reason, /full 40-character commit/);
});

// ---------------------------------------------------------------------------

const item = (over = {}) => ({
  owner: "o",
  repo: "moodle-mod_x",
  ref: A,
  type: "mod",
  name: "x",
  component: "mod_x",
  ...over,
});

const stubFetch = (routes) => {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url, ...opts });
    for (const [pattern, res] of routes) {
      if (url.includes(pattern)) return typeof res === "function" ? res(url, opts) : res;
    }
    throw new Error(`no stub for ${url}`);
  };
  impl.calls = calls;
  return impl;
};

const ok = (body) => ({
  ok: true,
  status: 200,
  text: async () => body,
  arrayBuffer: async () => Buffer.from(body, "latin1"),
});
const bad = (status) => ({ ok: false, status, text: async () => "", arrayBuffer: async () => Buffer.alloc(0) });

test("a coordinate already pinned to a commit costs no request", async () => {
  clearAdvertisementCache();
  const f = stubFetch([]);
  const r = await resolveCoordinates([item()], { fetchImpl: f });
  assert.deepEqual(r.problems, []);
  assert.equal(r.items[0].ref, A);
  assert.equal(r.items[0].requestedRef, A);
  assert.equal(f.calls.length, 0);
});

test("two coordinates in one repository share a single advertisement", async () => {
  clearAdvertisementCache();
  const f = stubFetch([["info/refs", () => ok(advertisement([["refs/heads/main", A], ["refs/tags/v1", B]]).toString("latin1"))]]);
  const r = await resolveCoordinates(
    [item({ ref: "main" }), item({ ref: "v1", name: "y", component: "mod_y" })],
    { fetchImpl: f },
  );
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.items.map((i) => i.ref), [A, B]);
  assert.equal(f.calls.length, 1, "the advertisement was fetched twice");
});

// MEASURED: GitHub answers 401, not 404, for a repository that does not exist —
// it will not say which of "missing" and "private" applies. The 404-only branch
// this replaced never fired.
test("a repository that does not exist is reported whether it answers 401 or 404", async () => {
  for (const status of [401, 404]) {
    clearAdvertisementCache();
    const f = stubFetch([["info/refs", bad(status)]]);
    const r = await resolveCoordinates([item({ ref: "main" })], { fetchImpl: f });
    assert.equal(r.items.length, 0);
    assert.match(r.problems[0], /no public repository o\/moodle-mod_x/, `status ${status}`);
    assert.match(r.problems[0], /downloads the archive with no credentials/);
  }
});

// A renamed repository redirects. Following it would resolve the ref in a
// repository the coordinate does not name.
test("the advertisement request refuses redirects", async () => {
  clearAdvertisementCache();
  const f = stubFetch([["info/refs", () => ok(advertisement([["refs/heads/main", A]]).toString("latin1"))]]);
  await resolveCoordinates([item({ ref: "main" })], { fetchImpl: f });
  assert.equal(f.calls[0].redirect, "error");
});

test("an unresolvable ref names the coordinate it came from", async () => {
  clearAdvertisementCache();
  const f = stubFetch([["info/refs", () => ok(advertisement([["refs/heads/main", A]]).toString("latin1"))]]);
  const r = await resolveCoordinates([item({ ref: "nope" })], { fetchImpl: f, label: "extra plugin" });
  assert.match(r.problems[0], /^extra plugin mod_x: "nope" is not a branch or a tag/);
});

// ---------------------------------------------------------------------------

// Wasi booted a preview whose plugin URL 404'd: the install failed, the
// blueprint carried on, and the reviewer landed — logged out — on a stack trace.
test("a missing archive is refused, with the consequence spelled out", async () => {
  const f = stubFetch([["/archive/", bad(404)]]);
  const problems = await checkArchives([item()], { fetchImpl: f, label: "extra plugin" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no archive at/);
  assert.match(problems[0], /stack trace/);
});

// MEASURED: the archive URL answers 302 to codeload and only then 200. Without
// following, every real commit looks missing.
test("the archive check follows the redirect to codeload", async () => {
  const f = stubFetch([["/archive/", ok("")]]);
  assert.deepEqual(await checkArchives([item()], { fetchImpl: f }), []);
  assert.equal(f.calls[0].method, "HEAD");
  assert.equal(f.calls[0].redirect, "follow");
});

test("an unreachable host is a refusal, not a pass", async () => {
  const f = stubFetch([["/archive/", () => { throw new Error("timed out"); }]]);
  const problems = await checkArchives([item()], { fetchImpl: f });
  assert.match(problems[0], /could not reach .*timed out/);
});

// ---------------------------------------------------------------------------

const VERSION_PHP = `<?php
$plugin->component = 'mod_x';
$plugin->version = 2024010100;
$plugin->requires = 2022112800;
`;

test("a version.php at the resolved commit is read", async () => {
  const f = stubFetch([["raw.githubusercontent.com", ok(VERSION_PHP)]]);
  const r = await fetchExtraVersion(item(), { fetchImpl: f });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.declared.component, "mod_x");
  assert.match(f.calls[0].url, new RegExp(`/o/moodle-mod_x/${A}/version.php$`));
});

// `upgrade_plugins()` skips a directory with no readable version.php using a
// bare `continue`. No error, no plugin — the archive extracts perfectly.
test("no version.php is a refusal that says the plugin would simply be absent", async () => {
  const f = stubFetch([["raw.githubusercontent.com", bad(404)]]);
  const r = await fetchExtraVersion(item(), { fetchImpl: f });
  assert.equal(r.ok, false);
  assert.match(r.reason, /has no version.php/);
  assert.match(r.reason, /would simply not be there/);
});

// Quinn's case: GitHub serves a styled 404 PAGE with status 200 for some paths.
// It parses to a version.php with every field empty, and empty passes every
// check there is downstream.
test("a version.php that parses to nothing at all is a refusal", async () => {
  const f = stubFetch([["raw.githubusercontent.com", ok("<!DOCTYPE html><title>404 Not Found</title>")]]);
  const r = await fetchExtraVersion(item(), { fetchImpl: f });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no readable \$plugin fields/);
  assert.match(r.reason, /pass on the\s+strength of nothing/);
});

test("an unreadable dependencies list in an extra is a refusal", async () => {
  const f = stubFetch([
    ["raw.githubusercontent.com", ok("<?php\n$plugin->component='mod_x';\n$plugin->dependencies = $DEPS;\n")],
  ]);
  const r = await fetchExtraVersion(item(), { fetchImpl: f });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not a literal array/);
});

// ---------------------------------------------------------------------------

const core = { ok: true, standard: new Set(["mod_forum", "block_html"]) };

test("an extra that is not the plugin the coordinate names is refused", () => {
  const problems = checkExtraPlugin(
    item(),
    { component: "mod_other", version: 1, requires: null },
    { moodleBranch: "MOODLE_500_STABLE", core, label: "extra plugin" },
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /declares itself to be "mod_other", not "mod_x"/);
});

test("an extra needing a newer Moodle than the preview boots is refused", () => {
  const problems = checkExtraPlugin(
    item(),
    { component: "mod_x", version: 1, requires: 2099010100 },
    { moodleBranch: "MOODLE_404_STABLE", core },
  );
  assert.equal(problems.length, 1, JSON.stringify(problems));
  assert.match(problems[0], /extra-plugins mod_x: /);
});

test("an extra that matches and fits is accepted silently", () => {
  assert.deepEqual(
    checkExtraPlugin(
      item(),
      { component: "mod_x", version: 2024010100, requires: 2022112800 },
      { moodleBranch: "MOODLE_500_STABLE", core },
    ),
    [],
  );
});

// ---------------------------------------------------------------------------

const node = (component, dependencies = {}, over = {}) => ({
  component,
  version: 2024010100,
  dependencies,
  ...over,
});

test("a dependency on one of Moodle's own components is satisfied", () => {
  assert.deepEqual(checkDependenciesSatisfied([node("local_a", { mod_forum: 2022041900 })], core), []);
});

test("a dependency on another installed extra is satisfied", () => {
  assert.deepEqual(
    checkDependenciesSatisfied([node("local_a", { block_b: 2023010100 }), node("block_b")], core),
    [],
  );
});

// The failure this control exists for: Moodle installs the plugin anyway and
// the reviewer sees it break later, with nothing on screen saying why.
test("a missing dependency is refused, naming it and how to supply it", () => {
  const problems = checkDependenciesSatisfied([node("local_a", { block_b: 2023010100 })], core);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /local_a depends on block_b/);
  assert.match(problems[0], /neither part of Moodle nor .*installed by this preview/s);
  assert.match(problems[0], /Add block_b to extra-plugins/);
});

test("a dependency pinned to an older commit than required is refused", () => {
  const problems = checkDependenciesSatisfied(
    [node("local_a", { block_b: 2023010100 }), node("block_b", {}, { version: 2022010100 })],
    core,
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /needs block_b version 2023010100 or later/);
  assert.match(problems[0], /is version 2022010100/);
});

// ANY_VERSION is a Moodle constant, not a number. Comparing it would be a
// silent `false` — an accepted preview built on a comparison that never ran.
test("ANY_VERSION accepts any commit of the dependency", () => {
  assert.deepEqual(
    checkDependenciesSatisfied(
      [node("local_a", { block_b: "ANY_VERSION" }), node("block_b", {}, { version: 1 })],
      core,
    ),
    [],
  );
});

// A skipped check must not look like a passed one. The caller says so out loud;
// this only has to refuse to guess.
test("with no core component list the check is skipped, not guessed", () => {
  assert.deepEqual(
    checkDependenciesSatisfied([node("local_a", { mod_forum: 1 })], { ok: false, standard: new Set() }),
    [],
  );
});

// ---------------------------------------------------------------------------

const order = (nodes) => {
  const r = orderInstalls(nodes);
  assert.equal(r.ok, true, r.reason);
  return r.order.map((n) => n.component);
};

test("a dependency is installed before the plugin that needs it", () => {
  assert.deepEqual(
    order([node("local_a", { block_b: 1 }), node("block_b"), node("mod_x", {}, { isSelf: true })]),
    ["block_b", "local_a", "mod_x"],
  );
});

// The spec's rule: extras before the commit under review, so the reviewer's
// plugin installs into a site that already has what it needs.
test("the plugin under review goes last among plugins that are all ready", () => {
  assert.deepEqual(order([node("mod_x", {}, { isSelf: true }), node("local_a"), node("block_b")]), [
    "local_a",
    "block_b",
    "mod_x",
  ]);
});

// The one case where the rule and the mechanism disagree — an extra that
// depends on the plugin under review. Order beats the tie-break.
test("an extra depending on the plugin under review installs after it", () => {
  assert.deepEqual(order([node("local_a", { mod_x: 1 }), node("mod_x", {}, { isSelf: true })]), [
    "mod_x",
    "local_a",
  ]);
});

test("a dependency outside the preview does not hold up the ordering", () => {
  // checkDependenciesSatisfied has already refused this case; the sort must not
  // ALSO treat it as a cycle and produce a second, confusing message.
  assert.deepEqual(order([node("local_a", { block_elsewhere: 1 })]), ["local_a"]);
});

// Left alone, a cycle silently drops whichever plugins the sort could not place
// — a preview quietly missing exactly the plugins that were asked for.
test("a circular dependency is refused, naming every plugin in the circle", () => {
  const r = orderInstalls([node("local_a", { block_b: 1 }), node("block_b", { local_a: 1 })]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /circle/);
  assert.match(r.reason, /block_b, local_a/);
});

test("a plugin depending on itself is not a cycle", () => {
  assert.deepEqual(order([node("local_a", { local_a: 1 })]), ["local_a"]);
});

// ---------------------------------------------------------------------------
// $THEME->parents — the dependency version.php cannot see.
//
// Both fixtures are the REAL config.php from the theme's own repository (see
// COPYRIGHT). A hand-written fixture is how this parse gets to be wrong and
// green at the same time.

const themeFixture = (f) =>
  readFileSync(new URL(`./fixtures/themes/${f}`, import.meta.url), "utf8");

test("moove: one literal assignment is read exactly", () => {
  const v = parseThemeParents(themeFixture("moove-config.php"), "theme_moove");
  assert.equal(v.ok, true);
  assert.deepEqual(v.parents, ["boost"]);
  assert.equal(v.note, undefined);
});

// The case that decides the whole design. boost_union assigns parents in both
// arms of a Workplace check, so the union would make every preview of it depend
// on theme_workplace — a refusal with no fix, on the most-installed third-party
// theme there is.
test("boost_union: parents decided at runtime warn, and never refuse", () => {
  const v = parseThemeParents(themeFixture("boost_union-config.php"), "theme_boost_union");
  assert.equal(v.ok, true);
  assert.deepEqual(v.parents, []);
  assert.match(v.note, /runtime/);
  // Specifically NOT theme_workplace, which is what a union would have produced.
  assert.ok(!/workplace/i.test(v.parents.join(",")));
});

test("a config.php that never sets parents is refused", () => {
  const v = parseThemeParents("<?php\n$THEME->name = 'x';\n$THEME->sheets = [];\n", "theme_x");
  assert.equal(v.ok, false);
  assert.match(v.reason, /never sets \$THEME->parents/);
  // The reason must name what the reviewer would otherwise see.
  assert.match(v.reason, /stock Boost/);
});

// `$THEME->parents[] = 'boost';` APPENDS. It is unusual but valid, and reading
// it as "no parents at all" would refuse a theme that works.
test("an appended parent is not read as an absent one", () => {
  const v = parseThemeParents("<?php\n$THEME->parents = [];\n$THEME->parents[] = 'boost';\n", "theme_x");
  assert.equal(v.ok, true);
});

test("array() spelling is read the same as []", () => {
  const v = parseThemeParents("<?php\n$THEME->parents = array('boost');\n", "theme_x");
  assert.deepEqual(v.parents, ["boost"]);
});

test("a computed parents value warns rather than being read as empty", () => {
  const v = parseThemeParents("<?php\n$THEME->parents = theme_x_parents();\n", "theme_x");
  assert.equal(v.ok, true);
  assert.deepEqual(v.parents, []);
  assert.match(v.note, /add the parent theme to extra-plugins/);
});

// A 404 over raw.githubusercontent.com is a REAL 404 (measured), so this is a
// refusal and not a parse of a styled error page.
test("a theme with no config.php at all is refused", async () => {
  const v = await fetchThemeParents(
    { owner: "a", repo: "b", ref: "c", name: "x", component: "theme_x" },
    { fetchImpl: async () => ({ ok: false, status: 404 }) },
  );
  assert.equal(v.ok, false);
  assert.match(v.reason, /no config.php/);
  assert.match(v.reason, /stock\s+\n?\s*Boost|stock Boost/);
});

test("the config.php fetch refuses redirects", async () => {
  let seen = null;
  await fetchThemeParents(
    { owner: "a", repo: "b", ref: "c", name: "x", component: "theme_x" },
    {
      fetchImpl: async (url, opts) => {
        seen = { url, opts };
        return { ok: true, text: async () => "<?php $THEME->parents = ['boost'];" };
      },
    },
  );
  assert.match(seen.url, /^https:\/\/raw\.githubusercontent\.com\/a\/b\/c\/config\.php$/);
  assert.equal(seen.opts.redirect, "error");
});

// The cap is asserted by its EFFECT, not by reading the constant back: a
// parents assignment beyond it must be invisible. Without a real cap this test
// passes trivially, so the assignment is placed just past the boundary.
test("the config.php body is capped, and what is past the cap is not read", async () => {
  const padding = "// x\n".repeat(Math.ceil(MAX_VERSION_PHP_BYTES / 5) + 10);
  const v = await fetchThemeParents(
    { owner: "a", repo: "b", ref: "c", name: "x", component: "theme_x" },
    { fetchImpl: async () => ({ ok: true, text: async () => `<?php\n${padding}$THEME->parents = ['boost'];` }) },
  );
  assert.equal(v.ok, false, "read a parents assignment past the byte cap");
  assert.match(v.reason, /never sets \$THEME->parents/);
});
