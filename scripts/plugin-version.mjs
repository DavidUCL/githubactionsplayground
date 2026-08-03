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
 * Moodle core `$version` at the tip of each branch the playground can bundle.
 *
 * Compared exactly as Moodle compares it in `upgrade_requires_exception`:
 * a plugin is refused when `requires > core version`.
 *
 * These drift upward as core cuts point releases, and a stale entry here can
 * only ever produce a FALSE REFUSAL (never a false pass), because core's
 * number only increases. `verify.sh` check 1h re-derives them from
 * moodle/moodle and fails loudly on drift, the same way check 1e guards
 * PLUGIN_TYPE_DIRS.
 *
 * Verified 2026-08-03 against raw.githubusercontent.com/moodle/moodle/<branch>/version.php.
 * (`v5.0.0` reads 2025041400.00, confirming the X.Y.0 base convention.)
 */
export const MOODLE_BRANCH_VERSIONS = {
  MOODLE_404_STABLE: 2024042212,
  MOODLE_405_STABLE: 2024100712,
  MOODLE_500_STABLE: 2025041408,
};

/**
 * Plugin types core has REMOVED, and the core version that removed them.
 * A subplugin of a host that no longer exists cannot install, and the preview
 * would show a clean Moodle with nothing in it — the same silent failure the
 * `requires` check exists to stop, arriving by a different route.
 *
 * Verified 2026-08-03: lib/editor/atto/version.php is present on
 * MOODLE_405_STABLE and 404s on MOODLE_500_STABLE.
 */
export const REMOVED_PLUGIN_TYPES = {
  atto: { removedAt: 2025041400, replacement: "tiny", release: "Moodle 5.0" },
};

/** The playground's own default branch (version-resolver.js, `default: true`). */
export const DEFAULT_MOODLE_BRANCH = "MOODLE_500_STABLE";

// `$plugin->requires = 2025100600;` — also accept `$module->`, which very old
// plugins still use, and tolerate any spacing. The trailing `.00` fractional
// form that core itself uses is truncated to the integer part, because that is
// the part `requires` is ever expressed in.
const numberField = (src, field) => {
  const m = new RegExp(
    `\\$(?:plugin|module)\\s*->\\s*${field}\\s*=\\s*'?([0-9]+)(?:\\.[0-9]+)?'?\\s*;`,
  ).exec(src);
  return m ? Number(m[1]) : null;
};

const stringField = (src, field) => {
  const m = new RegExp(
    `\\$(?:plugin|module)\\s*->\\s*${field}\\s*=\\s*['"]([^'"]+)['"]\\s*;`,
  ).exec(src);
  return m ? m[1] : null;
};

/**
 * Parse the fields we care about out of a version.php source string.
 *
 * @param {string} src
 * @returns {{component: string|null, version: number|null, requires: number|null}}
 */
export function parseVersionPhp(src) {
  const text = String(src);
  return {
    component: stringField(text, "component"),
    version: numberField(text, "version"),
    requires: numberField(text, "requires"),
  };
}

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
export function readPluginVersion(pluginRoot) {
  const path = join(pluginRoot || ".", "version.php");
  if (!existsSync(path)) return null;
  // 256 KB is far beyond any real version.php; the cap stops a pathological
  // file in a pull request from being read into memory in full.
  const src = readFileSync(path, "utf8").slice(0, 262144);
  return { ...parseVersionPhp(src), path };
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
 * Refuse a plugin whose TYPE no longer exists in the bundled Moodle.
 *
 * @returns {{ok: boolean, reason?: string}}
 */
export function checkPluginTypeSupported(type, moodleBranch = DEFAULT_MOODLE_BRANCH) {
  const removed = REMOVED_PLUGIN_TYPES[String(type)];
  if (!removed) return { ok: true };
  const coreVersion = MOODLE_BRANCH_VERSIONS[String(moodleBranch)];
  if (coreVersion == null || coreVersion < removed.removedAt) return { ok: true };
  return {
    ok: false,
    reason:
      `"${type}" plugins were removed in ${removed.release}, which is what the ` +
      `playground bundles (${moodleBranch}). The plugin cannot install, and the ` +
      `preview would show a working Moodle without it` +
      (removed.replacement ? ` — ${removed.replacement} replaced it.` : "."),
  };
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
