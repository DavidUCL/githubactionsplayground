// Read a Moodle plugin's version.php and decide whether the playground can
// actually run it.
//
// This exists because of a failure the preview cannot otherwise detect. When a
// plugin declares `$plugin->requires` higher than the bundled Moodle core,
// Moodle throws `upgrade_requires_exception` during the upgrade — but
// `installMoodlePlugin` catches php.run errors and returns success
// (moodle-plugins.js:322-345), and the blueprint carries on. The reviewer gets
// a clean, working Moodle with no plugin in it and no error on screen, which
// reads as "this plugin does nothing".
//
// Observed for real: mod_attendance master declares `requires = 2025100600`
// ("Requires 5.1") while the playground bundles Moodle 5.0.8. Every preview of
// that branch is silently empty. The pinned commit this repo dogfoods
// (8b217b1, `requires = 2025031100`) is fine — which is why the failure went
// unnoticed.
//
// version.php is PARSED, never executed. It is a file from the pull request
// under review; running it would be running unreviewed code on the runner.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The Moodle `$version` each branch's BUNDLED IMAGE runs — the Moodle the
 * reviewer actually boots, NOT the tip of moodle/moodle.
 *
 * The distinction is the whole point, and this comment used to have it
 * backwards. Core only ever increases $version, so gating this table against
 * the branch TIP pushes it ABOVE the bundle: when core cuts 5.0.9 the table
 * would say 2025041409 while the bundle still runs 5.0.8, and a plugin
 * requiring 5.0.9 would pass the compatibility check, boot, and install
 * NOTHING. That is a false PASS, not the "false refusal only" this comment
 * once claimed.
 *
 * Check 1h keeps it honest without anyone maintaining a number: the branch
 * base comes from core's version.php (floored to 100) and the point release
 * from the bundle's own {playground-host}/assets/manifests/{branch}.json
 * `release` field. Update this table to what the BUNDLE runs.
 */
export const MOODLE_BRANCH_VERSIONS = {
  MOODLE_404_STABLE: 2024042212,
  MOODLE_405_STABLE: 2024100712,
  MOODLE_500_STABLE: 2025041408,
};

/**
 * Moodle's own list of the plugins it ships, read from the branch under test.
 *
 * `lib/plugins.json` (MDL-81084) is the ONLY source
 * `core_plugin_manager::standard_plugins_list()` reads
 * (plugin_manager.php:348-355), so it is the same bytes Moodle itself uses.
 *
 * Fetched per branch rather than shipped as a table, because a table would be
 * WRONG for at least one branch in the selector — measured:
 *   4.4: 442 standard components, `mod_qbank` absent, `atto` still standard
 *   4.5: 448
 *   5.0: 412, `mod_qbank` present, `atto` moved to `deleted`
 * A per-branch fetch is authoritative and cannot drift; a table fossilises.
 *
 * Why it matters: `installViaZipDownload` never clears the target directory
 * (moodle-plugins.js:198-262), so a ZIP declaring `mod_assign` is written file
 * by file over Moodle's own. If it also declares a higher version, nothing
 * throws — the attacker's `xmldb_assign_upgrade()` runs against the live
 * schema and `update_capabilities()` -> `capabilities_cleanup()`
 * (lib/accesslib.php:2426) DELETES every core `mod/assign:*` capability absent
 * from the new db/access.php, and unassigns it from every role. Silently.
 *
 * @returns {Promise<{ok: boolean, reason?: string, standard: Set<string>, removedTypes: Set<string>}>}
 */
const coreComponentCache = new Map();

export async function fetchCoreComponents(branch) {
  const key = String(branch);
  if (coreComponentCache.has(key)) return coreComponentCache.get(key);
  const empty = { ok: false, standard: new Set(), removedTypes: new Set() };
  if (!/^[A-Za-z0-9_]+$/.test(key)) {
    return { ...empty, reason: `refusing to fetch a core list for branch ${JSON.stringify(branch)}` };
  }
  const url = `https://raw.githubusercontent.com/moodle/moodle/${key}/lib/plugins.json`;
  let result;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: "error" });
    if (!res.ok) {
      result = { ...empty, reason: `HTTP ${res.status} fetching ${url}` };
    } else {
      const doc = JSON.parse((await res.text()).slice(0, 1048576));
      const standard = new Set();
      for (const [type, names] of Object.entries(doc.standard || {})) {
        for (const name of names) standard.add(`${type}_${name}`);
      }
      // A plugin TYPE present in `deleted` but absent from `standard` is a type
      // core has removed. On 5.0 that is assignment, atto, tinymce — a superset
      // of the hand-written table this replaces, which knew only about atto.
      const removedTypes = new Set(
        Object.keys(doc.deleted || {}).filter((t) => !Object.hasOwn(doc.standard || {}, t)),
      );
      result = standard.size
        ? { ok: true, standard, removedTypes }
        : { ...empty, reason: `${url} parsed but listed no standard plugins` };
    }
  } catch (err) {
    result = { ...empty, reason: `could not fetch ${url}: ${err.message}` };
  }
  coreComponentCache.set(key, result);
  return result;
}

/**
 * Refuse a component Moodle itself ships.
 *
 * @returns {{ok: boolean, reason?: string}}
 */
export function checkNotCoreComponent(type, name, core) {
  if (!core?.ok) return { ok: true };
  const component = `${type}_${name}`;
  if (core.standard.has(component)) {
    return {
      ok: false,
      reason:
        `"${component}" is a plugin Moodle itself ships. Installing over it does not ` +
        `replace it — the ZIP is written file by file into the same directory, and if ` +
        `it declares a higher version Moodle runs its upgrade against the live schema ` +
        `and silently deletes core capabilities. Rename the plugin, or preview it as ` +
        `the component it really is.`,
    };
  }
  if (core.removedTypes.has(String(type))) {
    return {
      ok: false,
      reason:
        `"${type}" plugins were removed from this Moodle — it lists the type under ` +
        `"deleted". The plugin cannot install, and the preview would show a working ` +
        `Moodle without it.`,
    };
  }
  return { ok: true };
}

/** The playground's own default branch (version-resolver.js, `default: true`). */
export const DEFAULT_MOODLE_BRANCH = "MOODLE_500_STABLE";

/**
 * Blank out PHP comments, preserving offsets and newlines.
 *
 * Needs to track STRINGS to do it: `'http://example.com'` contains `//` and is
 * not a comment, and a naive strip deletes real assignments — measured at 12
 * false passes against today's 9 on a corpus of 960 real version.php files
 * checked against executed PHP. A deleted field parses as null, and null passes
 * every check, so getting this wrong is worse than not doing it.
 */
function blankComments(src) {
  const out = src.split("");
  let i = 0;
  const n = src.length;
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "'" || c === '"') {
      const quote = c;
      i++;
      while (i < n && src[i] !== quote) i += src[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (c === "<" && src.startsWith("<<<", i)) {
      // Heredoc / nowdoc: skip to the closing label at a line start.
      const m = /^<<<\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1\r?\n/.exec(src.slice(i));
      if (m) {
        const label = m[2];
        const close = new RegExp(`^[ \\t]*${label}\\b`, "m");
        const rest = src.slice(i + m[0].length);
        const found = close.exec(rest);
        i = found ? i + m[0].length + found.index + found[0].length : n;
        continue;
      }
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const to = end === -1 ? n : end + 2;
      blank(i, to);
      i = to;
      continue;
    }
    if ((c === "/" && next === "/") || c === "#") {
      let end = src.indexOf("\n", i);
      if (end === -1) end = n;
      blank(i, end);
      i = end;
      continue;
    }
    i++;
  }
  return out.join("");
}

/**
 * Parse the fields a preview depends on out of a version.php source string.
 *
 * Returns a STATE, not just values. Every parse failure used to collapse to
 * `null`, and `null` means "no requirement", which passes every check — so an
 * unreadable file was indistinguishable from a permissive one. `ok: false`
 * means "do not trust this", and the caller must refuse rather than continue.
 *
 * PARSED, never executed: it is a file from the commit under review.
 *
 * @returns {{ok: boolean, reason?: string, component: string|null,
 *            version: number|null, requires: number|null,
 *            incompatible: number|null}}
 */
export function parseVersionPhp(src) {
  const text = String(src);
  const code = blankComments(text);
  const out = {
    ok: true,
    component: lastString(code, "component"),
    version: lastNumber(code, "version"),
    requires: lastNumber(code, "requires"),
    // Moodle enforces this in the same loop as `requires`
    // (lib/upgradelib.php:707-711, plugin_incompatible_exception): a plugin
    // with `incompatible = 500` is REFUSED on Moodle 5.x however low its
    // `requires` is. Five published plugins do exactly that, so a preview that
    // ignores it builds a link Moodle then refuses to install.
    incompatible: lastNumber(code, "incompatible"),
  };

  // A field that IS assigned but whose value we could not read is the
  // dangerous case: a constant, a concatenation, a conditional. Silently
  // treating that as "absent" is how an unreadable file passes.
  for (const [field, value] of [
    ["component", out.component],
    ["version", out.version],
    ["requires", out.requires],
    ["incompatible", out.incompatible],
  ]) {
    if (value === null && assignmentsOf(code, field).length > 0) {
      out.ok = false;
      out.reason =
        `version.php assigns $plugin->${field} in a form this cannot read ` +
        `(a constant, a concatenation, or a conditional). Refusing rather than ` +
        `treating it as absent, because absent passes every check.`;
      break;
    }
  }
  return out;
}

const assignmentsOf = (code, field) => [
  ...code.matchAll(new RegExp(`\\$(?:plugin|module)\\s*->\\s*${field}\\s*=`, "g")),
];

/** LAST literal assignment, because PHP executes top to bottom and the last one wins. */
const lastNumber = (code, field) => {
  const all = [
    ...code.matchAll(
      new RegExp(`\\$(?:plugin|module)\\s*->\\s*${field}\\s*=\\s*'?([0-9]+)(?:\\.[0-9]+)?'?\\s*;`, "g"),
    ),
  ];
  return all.length ? Number(all[all.length - 1][1]) : null;
};

const lastString = (code, field) => {
  const all = [
    ...code.matchAll(
      new RegExp(`\\$(?:plugin|module)\\s*->\\s*${field}\\s*=\\s*['"]([^'"]+)['"]\\s*;`, "g"),
    ),
  ];
  return all.length ? all[all.length - 1][1] : null;
};


/**
 * Read version.php from a checked-out plugin, if it is there.
 *
 * Returns null when the file does not exist — the caller decides whether that
 * is fatal. It is not always: this repo's own dogfood previews a third-party
 * plugin that was never checked out.
 *
 * @param {string} pluginRoot
 * @returns {{component: string|null, version: number|null, requires: number|null, path: string}|null}
 */
export const MAX_VERSION_PHP_BYTES = 262144;

export function readPluginVersion(pluginRoot) {
  const path = join(pluginRoot || ".", "version.php");
  if (!existsSync(path)) return null;
  const src = readFileSync(path, "utf8");
  // TRUNCATION USED TO BE SILENT, and silence was the bug: slicing produced an
  // all-null result, which is truthy, so the "compatibility NOT checked" note
  // was suppressed AND every check passed vacuously. 256 KB is far beyond any
  // real version.php, so a file over it is pathological — say so.
  if (src.length > MAX_VERSION_PHP_BYTES) {
    return {
      ok: false,
      reason: `version.php is ${src.length} bytes (limit ${MAX_VERSION_PHP_BYTES}) — refusing to guess at its contents`,
      component: null,
      version: null,
      requires: null,
      incompatible: null,
      path,
    };
  }
  return { ...parseVersionPhp(src), path };
}

/**
 * Fetch version.php for a commit when it is NOT on disk.
 *
 * The strong checks — component identity, `$plugin->requires`, removed plugin
 * types — all read version.php. When the plugin repo IS the checked-out repo
 * (the normal case for an adopting workflow) it is on disk and this is never
 * called. When it is not — previewing a third-party plugin, or any run where
 * nothing was checked out — those checks were skipped entirely, and skipping
 * them is how a preview boots a clean Moodle with no plugin in it.
 *
 * Deliberately narrow, because the action otherwise makes NO network calls and
 * that is a property worth keeping: only raw.githubusercontent.com, only over
 * https, 5s timeout, 256 KB cap, and a failure WARNS rather than refuses — a
 * flaky network must not stop a preview being built.
 *
 * PARSED, never executed. It is a file from the commit under review.
 *
 * @returns {{component,version,requires,path}|null}
 */
export async function fetchPluginVersion(headRepo, headSha, pluginRoot = ".") {
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(headRepo)) || !/^[0-9a-f]{40}$/.test(String(headSha))) {
    return null;
  }
  // pluginRoot is a LOCAL path. It maps to a repo subdirectory only when it is
  // relative and not "." — an absolute path (a runner workspace, or another
  // repo's checkout entirely) tells us nothing about layout inside headRepo,
  // so fetch from its root. Getting this wrong builds a 404 URL and the
  // fallback silently does nothing, which is how it first shipped.
  const rel = String(pluginRoot || ".");
  const sub =
    rel === "." || rel === "" || rel.startsWith("/") || /^[A-Za-z]:/.test(rel)
      ? ""
      : `${rel.replace(/^\.\/+/, "").replace(/\/+$/, "")}/`;
  const url = `https://raw.githubusercontent.com/${headRepo}/${headSha}/${sub}version.php`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "error" });
    if (!res.ok) return null;
    const text = (await res.text()).slice(0, 262144);
    // A 404 page or an HTML error would parse to all-nulls; require at least
    // one field before claiming we read a version.php.
    const parsed = parseVersionPhp(text);
    if (parsed.component == null && parsed.version == null && parsed.requires == null) return null;
    return { ...parsed, path: url };
  } catch {
    return null;
  }
}

/**
 * Decide whether a plugin can run on the bundled Moodle.
 *
 * @param {{requires: number|null}} plugin
 * @param {string} moodleBranch
 * @returns {{ok: boolean, reason?: string, coreVersion?: number}}
 */
export function checkMoodleCompatibility(plugin, moodleBranch = DEFAULT_MOODLE_BRANCH) {
  const branch = String(moodleBranch);
  if (!Object.hasOwn(MOODLE_BRANCH_VERSIONS, branch)) {
    // An unknown branch means the table is behind the playground. Refusing
    // would block every preview on a newly-bundled Moodle; passing silently is
    // how this class of bug got here in the first place. Say so and continue.
    return { ok: true, reason: `unknown Moodle branch "${branch}" — compatibility not checked` };
  }
  const coreVersion = MOODLE_BRANCH_VERSIONS[branch];

  // `incompatible` is a HARD refusal in Moodle, checked in the same loop as
  // `requires` (lib/upgradelib.php:707-711). A plugin declaring
  // `incompatible = 500` is refused on any 5.x however permissive its
  // `requires` is — five published plugins do exactly that. Ignoring it built
  // a link Moodle then refused to install, leaving a clean Moodle with no
  // plugin: the failure this whole file exists to prevent.
  const incompatible = plugin?.incompatible;
  if (incompatible != null) {
    const branchNumber = Number(String(branch).replace(/^MOODLE_(\d+)_STABLE$/, "$1"));
    if (Number.isFinite(branchNumber) && branchNumber >= incompatible) {
      return {
        ok: false,
        coreVersion,
        reason:
          `plugin declares it is incompatible with Moodle ${incompatible} and later, and ` +
          `the playground bundles ${branch}. Moodle would refuse the install and the ` +
          `preview would show a working Moodle without the plugin.`,
      };
    }
  }

  const requires = plugin?.requires;
  if (requires == null) return { ok: true, coreVersion };
  if (requires > coreVersion) {
    return {
      ok: false,
      coreVersion,
      reason:
        `plugin requires Moodle ${requires}, but the playground bundles ` +
        `${branch} (${coreVersion}). The plugin would fail to install and the ` +
        `preview would show a working Moodle without it.`,
    };
  }
  return { ok: true, coreVersion };
}


/**
 * Cross-check a declared component against the identity the blueprint will use.
 *
 * A mismatch means the ZIP would extract to a directory Moodle does not
 * recognise: `upgrade_plugins` does `if (!is_readable($fullplug.'/version.php')) continue;`
 * — a silent skip, and another clean-Moodle-with-no-plugin outcome.
 *
 * @returns {{ok: boolean, reason?: string}}
 */
export function checkComponent(component, type, name) {
  if (!component) return { ok: true };
  const expected = `${type}_${name}`;
  if (component !== expected) {
    return {
      ok: false,
      reason:
        `version.php declares component "${component}" but the preview would ` +
        `install it as "${expected}". Pass plugin-type/plugin-name explicitly.`,
    };
  }
  return { ok: true };
}
