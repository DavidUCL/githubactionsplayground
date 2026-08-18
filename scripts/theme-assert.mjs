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
// non-zero `exit()`, fails the step *and says which failure it was*.
//
// A throw and a fatal error report SUCCESS only WITHOUT `CLI_SCRIPT`, which is the
// only way that was ever measured until 2026-08-18. WITH it — and every
// generator here defines it — a throw fails the step with exit code 1. The
// recipe is unchanged: exit code 1 is the GENERIC one, so a throw cannot say
// WHICH failure happened, writes no error_log line, and routes through
// default_exception_handler, which builds a renderer inside a CLI script.
// Always exit(N) explicitly.

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
 * they have to take the boot down. A failed stylesheet is different — the site
 * works, it is merely unstyled, and that IS visible to the reviewer on sight. A
 * preview with ugly CSS is strictly better than no preview, so this is reported
 * and exits 0. It is a log line, not an exit code, and giving it a number would
 * imply a failure mode it does not have.
 *
 * REPORTED VIA error_log, NOT echo. Measured, twice, because the first
 * measurement was contaminated: `handleRunPhpCode` (moodle-playground
 * `src/blueprint/steps/request.js:32-43`) discards `result.text` and
 * console.warns only `result.errors`. On a step that exits 0:
 *
 *   echo 'X'        reaches NEITHER boot-log.txt NOR console.txt   (invisible)
 *   error_log('X')  reaches console.txt                            (visible)
 *
 * A first probe appeared to show `echo` working — but that probe also called
 * `fwrite(STDERR, ...)`, which throws in this runtime ("Undefined constant
 * STDERR"), and the flushed stdout rode into the exception message. Four
 * reviewers had it right and the measurement was wrong.
 */
export const THEME_CSS_FAILURE_MARKER = "theme-css-build-failed";

/** Below this, the stylesheet is not a stylesheet. See the comment at the
 * check itself for the two measurements this sits between. */
export const MIN_STYLESHEET_BYTES = 50000;

/** Moodle theme names are [a-z][a-z0-9_]* — the same shape the runtime's own
 * `VALID_PLUGIN_NAME` enforces before it builds a path from one. */
const THEME_NAME = /^[a-z][a-z0-9_]*$/;

/** Shared preamble. `CLI_SCRIPT` before `config.php` is the only thing that
 * makes a non-zero exit fail the step at all. */
const PREAMBLE =
  `<?php define('CLI_SCRIPT',true); require('/www/moodle/config.php'); ` +
  `require_once($CFG->libdir.'/outputlib.php'); `;

function themeName(name, what) {
  const theme = String(name ?? "");
  if (!THEME_NAME.test(theme)) {
    throw new Error(`${what}: unusable theme name ${JSON.stringify(name)}`);
  }
  return theme;
}

function oneLine(code, what) {
  // preflight refuses any control character in a blueprint string, and a
  // newline would also end a workflow command if this were ever echoed.
  if (/[\x00-\x1f\x7f]/.test(code)) {
    throw new Error(`${what}: generated code contains a control character`);
  }
  return code;
}

/**
 * Prove the theme is really the one the site is using.
 *
 * CRITICAL, and it must be: every failure it detects is invisible, so letting
 * the boot continue means shipping a link that shows the wrong thing.
 *
 * @param {string} name the theme's plugin NAME (`boost_union`), never the
 *   component (`theme_boost_union`) and never the repository name. `setTheme`
 *   writes it straight into `set_config('theme', ...)`, and Moodle then looks
 *   for a directory of exactly that name.
 * @returns {{step: string, code: string, critical: boolean}}
 */
export function buildThemeAssertion(name) {
  const theme = themeName(name, "theme assertion");
  const code = oneLine(
    PREAMBLE +
      `$t='${theme}'; ` +
      `if(!is_dir($CFG->dirroot.'/theme/'.$t)) exit(31); ` +
      `if((string)($CFG->theme ?? '') !== $t) exit(32); ` +
      // The strongest of the four, and the only one that catches a MISSING
      // PARENT THEME. Measured in Moodle 5.0's theme_config: find_theme_config()
      // returns null both when $THEME->parents is not an array (:2107) and when
      // any parent's own config cannot be found (:2114), and load() then falls
      // back — to the site theme, and failing that to Boost (:454-463) —
      // announcing it with a debugging(DEBUG_NORMAL) this runtime does not
      // display. The returned object carries `public $name` (:281, set at :490),
      // so comparing it is how you tell "the theme loaded" from "something
      // loaded".
      //
      // load() itself can throw on a broken config.php, and an uncaught throw
      // cannot say WHICH failure it was in this runtime (a throw exits 1, the
      // generic code) — hence the try with an explicit exit.
      `try { $th = theme_config::load($t); } catch (Throwable $e) { exit(34); } ` +
      `if($th->name !== $t) exit(33); ` +
      `exit(0);`,
    "theme assertion",
  );
  return { step: "runPhpCode", code, critical: true };
}

/**
 * Build the theme's stylesheet before the reviewer's first page view.
 *
 * DELIBERATELY NOT CRITICAL, and deliberately AFTER `login`. Compiling a
 * theme's SCSS is the most expensive thing in the whole blueprint and the one
 * most likely to exhaust the WASM heap — and a heap abort is not a PHP
 * exception, so no `try` in this file can catch it. It runs after `login` so
 * that everything the preview promises is already done before the expensive
 * part is attempted.
 *
 * THE `critical: false` HALF IS NOT A GUARANTEE ON THE HOST WE POINT AT, and
 * this docblock used to imply it was. Measured 2026-08-17 by fetching both
 * deployed bundles: daviducl.github.io — the action.yml default — serves an
 * executor.js of 2,687 bytes containing the string "critical" ZERO times, and
 * aborts on ANY step throw; ateeducacion.github.io serves 4,649 bytes and
 * honours the flag per ADR-0005. So on the default host a failure here still
 * takes the whole preview down. The AFTER-`login` half is what actually buys
 * the reviewer something on both hosts: by the time this runs, the site is
 * built and the reviewer is signed in. Re-measure rather than trust this —
 * ateeducacion's bundle was rebuilt the same day it was written.
 *
 * @returns {{step: string, code: string, critical: boolean}}
 */
export function buildThemeCssWarmup(name) {
  const theme = themeName(name, "theme warm-up");

  const code = oneLine(
    PREAMBLE +
      `$t='${theme}'; ` +
      // Loaded again rather than passed along: this is a separate step with a
      // separate PHP process, and re-loading is cheap next to the compile. The
      // assertion above has already proved this returns the right theme.
      `try { $th = theme_config::load($t); } catch (Throwable $e) { exit(0); } ` +
      // The arguments mirror the runtime's own warm-up so the sheet lands
      // exactly where theme/styles.php serves it from; hand-rolling that path
      // is a documented way to warm a file nothing reads.
      `$dir = right_to_left() ? 'rtl' : 'ltr'; ` +
      `try { theme_build_css_for_themes(array($th), array($dir)); } ` +
      `catch (Throwable $e) { error_log('${THEME_CSS_FAILURE_MARKER}: '.$e->getMessage()); exit(0); } ` +
      // ...and then CHECK THE RESULT, because a failed compile does not throw.
      // Moodle's get_css_content_from_scss() catches its own exception, sets
      // $compiled = false and calls debugging() (theme_config.php:1277-1282 on
      // 5.0, same on 4.5 and 4.4); get_css_content() then falls back to
      // precompiled CSS, which for a child theme is empty. So the sheet is
      // WRITTEN and the sub-revision bumped either way, and a try/catch alone
      // reports success on an unstyled site.
      //
      // The floor is measured, not guessed: on a real boot of this runtime,
      // boost compiled to 1,053,990 bytes and boost_union to 1,902,942. A theme
      // whose SCSS failed falls back to a few hundred bytes at most, so 50 KB
      // sits twenty times below the smallest real sheet and far above any
      // fallback. The path is computed the way the runtime does
      // (bootstrap.js:926-928); hand-rolling it misses the css/ subdirectory
      // and the _<subrev> suffix, which is how you warm a file nothing reads.
      //
      // The message says "may be normal": a theme that ships plain CSS via
      // $THEME->sheets never invokes the compiler and legitimately produces
      // very little here. This is a note for a human, not a verdict.
      `$f = theme_get_css_filename($t, theme_get_revision(), theme_get_sub_revision_for_theme($t), $dir); ` +
      `$sz = is_readable($f) ? filesize($f) : -1; ` +
      `if($sz < ${MIN_STYLESHEET_BYTES}) error_log('${THEME_CSS_FAILURE_MARKER}: '.$t.' produced '.$sz.' bytes of CSS (may be normal for a theme that ships plain CSS)'); ` +
      `exit(0);`,
    "theme warm-up",
  );
  // NOT critical. See the docblock: a WASM heap abort here would otherwise take
  // the whole preview down, which is worse than the unstyled site this exists
  // to avoid.
  return { step: "runPhpCode", code, critical: false };
}

/** Turn a boot-log exit code back into a sentence, for the summary. */
export function explainThemeExit(code) {
  return THEME_CODES[Number(code)] ?? `the theme check exited ${code}, which it has no meaning for`;
}
