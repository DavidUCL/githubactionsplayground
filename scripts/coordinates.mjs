// The plugin coordinate: `owner/repo@ref#type_name`.
//
// Shared by `extra-plugins` and `theme`, which are the same thing pointed at
// different install steps. Parsing is pure and offline; resolving a ref to a
// commit and checking the archive exists are separate, because a parse failure
// should cost nothing and a network failure should be reported differently.
//
// EVERY PART IS REQUIRED, and each one for a measured reason.
//
// `#type_name` — Quinn ran this against the real gate and it was ACCEPTED:
//     extra-plugins: someone/repo@sha#mod_assign
// The archive extracts over /www/moodle/mod/assign file by file, Moodle reads
// the version.php inside it, sees mod_assign, and reports a clean install. The
// page is headed with the PR under review and every assertion passes. Without
// the type_name we could not even name what was being installed, let alone
// refuse it — the core-component check needs a component to check.
//
// `@ref` — the plugin under review is pinned to a commit (SHA_RE). An extra
// pinned to a branch would boot later commits than the link claims, and 404
// forever once the branch is deleted. A ref is accepted here and RESOLVED to a
// commit before it reaches a link, so what ships is always a commit.
//
// A missing element in the list is an ERROR, not something to filter away.
// `a/b@r#mod_x,,c/d@r#mod_y` silently loses an element under
// `.split(",").filter(Boolean)`, which is the pattern this repo keeps paying
// for: the third category that is neither success nor refusal.

import { PLUGIN_TYPE_DIRS } from "./assert.mjs";

/** Max coordinates in one control. Beyond this a reviewer is building a site,
 * not previewing a change, and each one costs a resolution round trip. */
export const MAX_COORDINATES = 5;

const OWNER_REPO = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const IDENT = /^[a-z][a-z0-9_]*$/;
// Refs are resolved later, so this only has to exclude what cannot be a ref.
// Deliberately no `..`, no leading/trailing slash, no whitespace, no `~^:?*[`.
const REF = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/;

/**
 * @param {string} raw one coordinate
 * @returns {{ok: boolean, reason?: string, owner?, repo?, ref?, type?, name?, component?}}
 */
export function parseCoordinate(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return { ok: false, reason: "is empty" };

  const hash = s.indexOf("#");
  if (hash < 0) {
    return {
      ok: false,
      reason:
        `has no "#type_name". It is required, not optional: without it we cannot ` +
        `name what is being installed, and a plugin declaring itself to be a core ` +
        `component would be written over Moodle's own copy file by file`,
    };
  }
  const left = s.slice(0, hash);
  const component = s.slice(hash + 1);

  const at = left.indexOf("@");
  if (at < 0) {
    return {
      ok: false,
      reason:
        `has no "@ref". It is required: an unpinned plugin boots whatever the ` +
        `branch points at today, which is not what the link claims, and 404s ` +
        `once the branch is deleted`,
    };
  }
  const slug = left.slice(0, at);
  const ref = left.slice(at + 1);

  const parts = slug.split("/");
  if (parts.length !== 2 || !parts.every((p) => OWNER_REPO.test(p) && p !== "." && p !== "..")) {
    return { ok: false, reason: `has no usable "owner/repo" (got ${JSON.stringify(slug)})` };
  }
  if (!ref || !REF.test(ref)) {
    return { ok: false, reason: `has an unusable ref ${JSON.stringify(ref)}` };
  }

  // `type_name` splits at the FIRST underscore: `mod_coursework`, but also
  // `gradereport_grader` and `qtype_multichoice`. The name may itself contain
  // underscores (`theme_boost_union`), so only the first one separates.
  const under = component.indexOf("_");
  if (under < 1) {
    return {
      ok: false,
      reason: `has no usable "type_name" (got ${JSON.stringify(component)})`,
    };
  }
  const type = component.slice(0, under);
  const name = component.slice(under + 1);
  if (!IDENT.test(type) || !IDENT.test(name)) {
    return { ok: false, reason: `has a malformed component ${JSON.stringify(component)}` };
  }
  if (!Object.hasOwn(PLUGIN_TYPE_DIRS, type)) {
    return {
      ok: false,
      reason:
        `names plugin type "${type}", which this Moodle has no directory for — ` +
        `the archive would extract somewhere nothing looks for it`,
    };
  }

  return { ok: true, owner: parts[0], repo: parts[1], ref, type, name, component: `${type}_${name}` };
}

/**
 * Parse a comma-separated control value.
 *
 * @returns {{ok: boolean, items: object[], problems: string[]}}
 */
export function parseCoordinateList(raw, { max = MAX_COORDINATES, label = "coordinate" } = {}) {
  const s = String(raw ?? "").trim();
  if (!s) return { ok: true, items: [], problems: [] };

  const problems = [];
  const items = [];
  // NOT `.filter(Boolean)`: an empty element is a mistake worth naming, and
  // silently dropping it is how `a/b,,c/d` becomes "two plugins, no comment".
  const raws = s.split(",");
  if (raws.length > max) {
    problems.push(`${raws.length} ${label}s supplied, the maximum is ${max}`);
  }
  for (const [i, one] of raws.entries()) {
    const parsed = parseCoordinate(one);
    if (!parsed.ok) {
      problems.push(`${label} ${i + 1} (${JSON.stringify(one.trim())}) ${parsed.reason}`);
      continue;
    }
    items.push(parsed);
  }
  // Two coordinates installing the same component overwrite each other file by
  // file, and the second wins silently — the same shape as the gate's
  // duplicate-target check, caught here so the message names the INPUT.
  const seen = new Map();
  for (const [i, item] of items.entries()) {
    if (seen.has(item.component)) {
      problems.push(
        `${label} ${i + 1} installs ${item.component}, which ${label} ` +
          `${seen.get(item.component) + 1} already installs — the second would ` +
          `overwrite the first file by file, with nothing reporting it`,
      );
      continue;
    }
    seen.set(item.component, i);
  }

  return { ok: problems.length === 0, items, problems };
}

/** Where a resolved coordinate's archive lives. One definition, so the builder
 * and anything that checks it cannot disagree. */
export const coordinateZipUrl = (item) =>
  `https://github.com/${item.owner}/${item.repo}/archive/${item.ref}.zip`;
