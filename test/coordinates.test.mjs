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
  const item = parseCoordinate("a/b@deadbeef#mod_x");
  assert.equal(coordinateZipUrl(item), "https://github.com/a/b/archive/deadbeef.zip");
});
