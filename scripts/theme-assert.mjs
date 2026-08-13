// The post-activation theme step: prove the theme is really on, and build its
// CSS before the reviewer's first page view.
//
// WHY IT HAS TO EXIST. `setTheme` cannot fail in any way the reviewer can see.
// Its handler is `if (!step.name) throw` and then
// `php.run(set_config('theme', $name))` (moodle-config.js) — it never checks
// that the theme exists. Moodle finds a theme by testing for
// `theme/<name>/config.php` and nothing else (`find_theme_location()`), and when
// that fails `theme_config::load()` falls back to Boost with a
// `debugging(DEBUG_NORMAL)` this runtime does not display. So a theme that did
// not install, or a name that does not match the directory, produces: a green
// run, a normal-looking Moodle, and stock Boost. The reviewer concludes the
// theme is broken, or never notices it was not applied at all.
//
// AND WHY IT BUILDS THE CSS. The runtime warms exactly one theme's stylesheet
// at boot and the name is hardcoded — `$themename = 'boost'`
// (`moodle-playground/src/runtime/bootstrap.js:913`) — and it runs BEFORE the
// blueprint (`:2993` vs `:3091`). Every plugin install purges caches and
// `set_config('theme', ...)` bumps the theme revision, so by the time the
// reviewer lands, the warmed sheet is stale and `theme/styles.php` compiles the
// SCSS lazily, on the first page view, in WASM. That is the slow, crash-prone
// path. Re-running the warm-up here, parameterised off `$CFG->theme` instead of
// a literal, is the fix — and it applies just as much to a theme UNDER REVIEW,
// which has had this bug since the day that path was written.
//
// HOW A PHP STEP SIGNALS FAILURE — measured, and not what you would guess. See
// `scripts/restore-assert.mjs` and `playground/BOOT-MEASUREMENTS.md`: only
// `define('CLI_SCRIPT', true)` BEFORE `require(config.php)`, followed by a
// non-zero `exit()`, fails the step. A fatal error reports SUCCESS. An uncaught
// exception reports SUCCESS.

/** Exit codes. Distinct so the boot log's "exit code N" names the failure. */
export const THEME_CODES = {
  0: "the theme is installed and active",
  31: "no theme directory of that name exists — the install did not produce one, so the site is showing stock Boost",
  32: "the site's theme setting is not the theme we activated — something later overwrote it",
  33: "Moodle could not initialise the theme and fell back to another one — most often a parent theme that is not installed",
  34: "loading the theme threw — its config.php is broken",
};

/**
 * The CSS build failing is NOT in the table above, deliberately, and this is
 * the one asymmetry worth stating out loud.
 *
 * 31-34 are the silent-Boost class: the reviewer cannot see any of them, so
 * they have to take the boot down. A CSS build that throws is different — the
 * site works, it is merely unstyled, and that is visible to the reviewer on
 * sight. A preview with ugly CSS is strictly better than no preview, so this
 * echoes into the boot log and exits 0. It is a log line, not an exit code, and
 * giving it a number would imply a failure mode it does not have.
 */
export const THEME_CSS_FAILURE_MARKER = "theme-css-build-failed";

/** Moodle theme names are [a-z][a-z0-9_]* — the same shape the runtime's own
 * `VALID_PLUGIN_NAME` enforces before it builds a path from one. */
const THEME_NAME = /^[a-z][a-z0-9_]*$/;

/**
 * Build the activation check + CSS warm-up step.
 *
 * @param {string} name the theme's plugin NAME (`boost_union`), never the
 *   component (`theme_boost_union`) and never the repository name. `setTheme`
 *   writes it straight into `set_config('theme', ...)`, and Moodle then looks
 *   for a directory of exactly that name.
 * @returns {{step: string, code: string, critical: boolean}}
 */
export function buildThemeWarmup(name) {
  const theme = String(name ?? "");
  if (!THEME_NAME.test(theme)) {
    throw new Error(`theme warm-up: unusable theme name ${JSON.stringify(name)}`);
  }

  // ONE LINE. preflight refuses any control character in a blueprint string,
  // and a newline would also end a workflow command if this were ever echoed.
  const code =
    `<?php define('CLI_SCRIPT',true); require('/www/moodle/config.php'); ` +
    `require_once($CFG->libdir.'/outputlib.php'); $t='${theme}'; ` +
    `if(!is_dir($CFG->dirroot.'/theme/'.$t)) exit(31); ` +
    `if((string)($CFG->theme ?? '') !== $t) exit(32); ` +
    // The strongest of the four, and the only one that catches a MISSING PARENT
    // THEME. Measured in Moodle 5.0's theme_config: find_theme_config() returns
    // null both when $THEME->parents is not an array (:2107) and when any
    // parent's own config cannot be found (:2114), and load() then falls back —
    // to the site theme, and failing that to Boost (:454-463) — announcing it
    // with a debugging(DEBUG_NORMAL) this runtime does not display. The
    // returned object carries `public $name` (:281, set at :490), so comparing
    // it is how you tell "the theme loaded" from "something loaded".
    //
    // load() itself can throw on a broken config.php, and an uncaught throw
    // reports SUCCESS in this runtime — hence the try around it with an exit,
    // not merely around the build below.
    `try { $th = theme_config::load($t); } catch (Throwable $e) { exit(34); } ` +
    `if($th->name !== $t) exit(33); ` +
    // The build is best-effort by design — see THEME_CSS_FAILURE_MARKER. The
    // arguments mirror the runtime's own warm-up so the sheet lands exactly
    // where theme/styles.php serves it from; hand-rolling that path is a
    // documented way to warm a file nothing reads.
    `try { theme_build_css_for_themes(array($th), ` +
    `array(right_to_left() ? 'rtl' : 'ltr')); } ` +
    `catch (Throwable $e) { echo '${THEME_CSS_FAILURE_MARKER}: '.$e->getMessage(); } ` +
    `exit(0);`;

  if (/[\x00-\x1f\x7f]/.test(code)) {
    throw new Error("theme warm-up: generated code contains a control character");
  }
  return { step: "runPhpCode", code, critical: true };
}

/** Turn a boot-log exit code back into a sentence, for the summary. */
export function explainThemeExit(code) {
  return THEME_CODES[Number(code)] ?? `the theme check exited ${code}, which it has no meaning for`;
}
