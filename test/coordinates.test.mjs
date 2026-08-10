// The plugin coordinate parser, shared by extra-plugins and theme.

import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCoordinate,
  parseCoordinateList,
  coordinateZipUrl,
  MAX_COORDINATES,
} from "../scripts/coordinates.mjs";

test("a full coordinate parses into its parts", () => {
  const r = parseCoordinate("ucl-isd/moodle-mod_coursework@bafa3ed#mod_coursework");
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.owner, "ucl-isd");
  assert.equal(r.repo, "moodle-mod_coursework");
  assert.equal(r.ref, "bafa3ed");
  assert.equal(r.type, "mod");
  assert.equal(r.name, "coursework");
  assert.equal(r.component, "mod_coursework");
});

// theme_boost_union: only the FIRST underscore separates type from name.
test("a name containing underscores survives", () => {
  const r = parseCoordinate("a/b@sha#theme_boost_union");
  assert.equal(r.type, "theme");
  assert.equal(r.name, "boost_union");
});

// Quinn ran `someone/repo@sha#mod_assign` against the real gate and it was
// ACCEPTED, extracting over Moodle's own mod/assign. Without a required
// type_name we cannot even NAME what is being installed, so the core-component
// check has nothing to check.
test("the #type_name is required, and the reason says why", () => {
  const r = parseCoordinate("a/b@sha");
  assert.equal(r.ok, false);
  assert.match(r.reason, /required, not optional/);
  assert.match(r.reason, /written over Moodle's own copy/);
});

// The plugin under review is pinned to a commit; an unpinned extra would boot
// later commits than the link claims and 404 once the branch is deleted.
test("the @ref is required, and the reason says why", () => {
  const r = parseCoordinate("a/b#mod_x");
  assert.equal(r.ok, false);
  assert.match(r.reason, /404s\s+once the branch is deleted/);
});

test("a traversal in the owner, repo or ref is refused", () => {
  assert.equal(parseCoordinate("../evil/b@sha#mod_x").ok, false);
  assert.equal(parseCoordinate("a/../b@sha#mod_x").ok, false);
  assert.equal(parseCoordinate("a/b@../../etc#mod_x").ok, false);
  assert.equal(parseCoordinate("a/b/c@sha#mod_x").ok, false);
  // TWO segments, so a length check alone still accepts these. Every case
  // above splits into three, which is why the charset check looked covered
  // when it was not.
  assert.equal(parseCoordinate("a/..@sha#mod_x").ok, false, "owner/.. accepted");
  assert.equal(parseCoordinate("../b@sha#mod_x").ok, false, "../repo accepted");
  assert.equal(parseCoordinate("./b@sha#mod_x").ok, false, "./repo accepted");
});

test("an unknown plugin type is refused, because nothing would look there", () => {
  const r = parseCoordinate("a/b@sha#nosuchtype_x");
  assert.equal(r.ok, false);
  assert.match(r.reason, /no directory for/);
});

test("a malformed component is refused", () => {
  for (const bad of ["#assign", "#_x", "#mod_", "#Mod_X", "#mod_X"]) {
    assert.equal(parseCoordinate(`a/b@sha${bad}`).ok, false, bad);
  }
});

// `.split(",").filter(Boolean)` is the pattern this repo keeps paying for: the
// element vanishes and nothing says so.
test("an empty element in the list is an error, named by position", () => {
  const r = parseCoordinateList("a/b@s#mod_x,,c/d@s#mod_y");
  assert.equal(r.ok, false);
  assert.match(r.problems.join(";"), /coordinate 2 .* is empty/);
});

test("two coordinates installing the same component are refused", () => {
  const r = parseCoordinateList("a/b@s#mod_x,c/d@s#mod_x");
  assert.equal(r.ok, false);
  assert.match(r.problems.join(";"), /overwrite the first file by file/);
});

test("more than the maximum is refused, and the maximum is stated", () => {
  const many = Array.from({ length: MAX_COORDINATES + 1 }, (_, i) => `a/b@s#mod_x${i}`).join(",");
  const r = parseCoordinateList(many);
  assert.equal(r.ok, false);
  assert.match(r.problems[0], new RegExp(`maximum is ${MAX_COORDINATES}`));
});

test("an empty control is not an error", () => {
  const r = parseCoordinateList("");
  assert.equal(r.ok, true);
  assert.deepEqual(r.items, []);
  assert.deepEqual(parseCoordinateList(undefined).items, []);
});

test("every problem is reported, not just the first", () => {
  const r = parseCoordinateList("a/b#mod_x,notacoord,c/d@s#nosuch_y");
  assert.equal(r.problems.length, 3, r.problems.join(" | "));
});

test("the archive URL is built from the parsed parts", () => {
  const sha = "a".repeat(40);
  const item = parseCoordinate(`a/b@${sha}#mod_x`);
  assert.equal(coordinateZipUrl(item), `https://github.com/a/b/archive/${sha}.zip`);
});

// --- found by the panel, in code already pushed ----------------------------
// MEASURED before the fix:
//   ucl-isd/moodle-mod_coursework@x/../../../../evil/moodle-mod_coursework/archive/main
//     -> https://github.com/evil/moodle-mod_coursework/archive/main.zip
// and checkUrl passes it, because the host is still github.com. The host
// allowlist constrains the HOST and has never constrained the OWNER.
test("a ref cannot walk the archive URL into another owner", () => {
  const evil =
    "ucl-isd/moodle-mod_coursework@x/../../../../evil/moodle-mod_coursework/archive/main#mod_coursework";
  const r = parseCoordinate(evil);
  assert.equal(r.ok, false, "a traversal ref was accepted");
  assert.match(r.reason, /different\s+owner/);
});

test("every traversal shape is refused, not just the literal one", () => {
  for (const ref of ["..", "a/../b", "a/./b", "/lead", "trail/", "a//b", "x/..%2f..%2fevil"]) {
    assert.equal(parseCoordinate(`a/b@${ref}#mod_x`).ok, false, `ref ${ref} was accepted`);
  }
});

// Branch names legitimately contain slashes; refusing them would be a false
// refusal, which is what makes the charset-only approach tempting and wrong.
test("an ordinary slashed branch name still works", () => {
  for (const ref of ["feature/foo", "release/4.4", "dependabot/npm_and_yarn/x-1.2.3"]) {
    assert.equal(parseCoordinate(`a/b@${ref}#mod_x`).ok, true, `ref ${ref} was refused`);
  }
});

// A prefix is not a pin: GitHub serves an archive for a 7-char SHA quite
// happily. What ships in a link must be a full commit, enforced where the URL
// is built so no caller can forget.
test("the archive URL refuses anything that is not a full commit", () => {
  for (const ref of ["1764f02", "main", "v4.4.12", "", "A".repeat(40)]) {
    assert.throws(
      () => coordinateZipUrl({ owner: "a", repo: "b", ref, component: "mod_x" }),
      /not a 40-character commit/,
      `ref ${JSON.stringify(ref)} produced a URL`,
    );
  }
});
