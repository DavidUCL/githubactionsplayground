// Prove the review course is really in the format the link claims — and fix the
// one thing `createCourse` cannot set.
//
// WHY THE OBVIOUS ASSERTION IS VACUOUS. Moodle stores whatever format string it
// is given: `create_course()` does no validation and `$DB->insert_record` at
// `course/lib.php:1969` writes it verbatim. When the format does not exist,
// `core_courseformat\base::get_format_or_default()` silently substitutes the
// site default with a `debugging(DEBUG_DEVELOPER)` this runtime never displays,
// and `/course/view.php:142-144` overwrites the value IN MEMORY before the
// pagetype, the renderer and the `require .../format.php` — so the page renders
// as a healthy `topics` course with no error, no notice and no body class.
//
// The consequence, and it is the whole design of this file: reading
// `mdl_course.format` back and comparing it to what was asked for PASSES IN
// BOTH CASES. The column holds the bogus value. An assertion written that way
// is exactly the vacuous kind this project has shipped before and now gates
// against. What has to be read is the RESOLVED format —
// `course_get_format($id)->get_format()` — which is what the site will actually
// render with.
//
// The two exit codes are not decoration. 41 says "resolved differs from asked
// AND the column still holds what we asked for", i.e. the silent-substitution
// case. 43 says the column differs too, which would mean something rewrote the
// row and is a different bug. LIVE check 8b asserts on 41 SPECIFICALLY, so the
// pair is also the standing measurement that the column retains the bogus
// value. Collapse them into one code and that measurement is gone.
//
// See BOOT-MEASUREMENTS.md for the recipe: `define('CLI_SCRIPT', true)` BEFORE
// `require(config.php)` and then a non-zero `exit()` is the only thing that
// fails a step *and says which failure it was*.
//
// A throw and a fatal error report SUCCESS only WITHOUT `CLI_SCRIPT`, which is the
// only way that was ever measured until 2026-08-18. WITH it — and every
// generator here defines it — a throw fails the step with exit code 1. The
// recipe is unchanged: exit code 1 is the GENERIC one, so a throw cannot say
// WHICH failure happened, writes no error_log line, and routes through
// default_exception_handler, which builds a renderer inside a CLI script.
// Always exit(N) explicitly.

/** Exit codes this step can produce, for the boot-log explainer. */
export const COURSE_CODES = {
  41: "the review course is NOT in the format the link asked for — Moodle " +
    "silently fell back to the site default, which renders as a normal course " +
    "with nothing in the log. The format name is almost certainly not installed.",
  42: "the review course does not exist at the point the format was checked",
  43: "the review course's format column was rewritten after it was created",
  44: "the course format could not be loaded at all",
};

/**
 * A format name safe to embed in single-quoted PHP, and to trust.
 *
 * Moodle plugin names are `[a-z][a-z0-9_]*` (frankenstyle), so this is the
 * shape rather than a character blocklist — the lesson from three separate
 * guards in this repo that were wrong about which character to ban.
 */
const FORMAT_NAME = /^[a-z][a-z0-9_]*$/;

/** Collapse to one line: a newline in any blueprint string is rejected. */
const oneLine = (s) => s.replace(/\s+/g, " ").trim();

/**
 * @param {{format: string, shortname: string}} opts
 * @returns {{step: string, code: string, critical: boolean}}
 */
export function buildCourseAssertion({ format, shortname }) {
  if (!FORMAT_NAME.test(String(format))) {
    // Refusing to BUILD an assertion that could not be trusted, rather than
    // emitting one that embeds something odd. A refusal must never look like an
    // absence.
    throw new Error(`internal: unsafe course format for an assertion: ${JSON.stringify(format)}`);
  }
  if (!/^[A-Z0-9]+$/.test(String(shortname))) {
    throw new Error(`internal: unsafe course shortname for an assertion: ${JSON.stringify(shortname)}`);
  }

  // NO `//` COMMENTS INSIDE THIS STRING. `oneLine` collapses the whole program
  // onto one physical line, so a `//` comment swallows EVERYTHING after it —
  // the first draft of this file commented out its own startdate fix, both
  // exits and the entire comparison, and would have exited 0 on every boot
  // including the broken ones. The reasoning lives in the docblock above and in
  // the JS comments here, where it cannot become part of the program.
  const code = oneLine(`<?php
    define('CLI_SCRIPT',true);
    require('/www/moodle/config.php');
    require_once($CFG->dirroot . '/course/lib.php');
    $want = '${format}';
    $c = $DB->get_record('course', array('shortname' => '${shortname}'));
    if (!$c) { exit(42); }
    if (empty($c->startdate)) {
      $DB->set_field('course', 'startdate', usergetmidnight(time()), array('id' => $c->id));
      rebuild_course_cache($c->id, true);
      $c = $DB->get_record('course', array('id' => $c->id));
    }
    try { $got = course_get_format($c)->get_format(); }
    catch (Throwable $e) { exit(44); }
    error_log('course-format: asked=' . $want . ' column=' . $c->format
      . ' resolved=' . $got . ' installed='
      . (is_dir($CFG->dirroot . '/course/format/' . $want) ? '1' : '0'));
    if ($got === $want) { exit(0); }
    exit($c->format === $want ? 41 : 43);
  `);

  // The startdate line above is the one thing `createCourse` cannot do:
  // phpCreateCourses accepts exactly six fields and silently discards the rest,
  // so a `weeks` course is created with startdate 0 and format_weeks labels its
  // sections "1/01/70 - 7/01/70". set_field + rebuild_course_cache
  // deliberately, NOT update_course(), whose event and completion writes are
  // the delegated-transaction path known to crash SQLite in this runtime.
  //
  // The error_log line is for a human reading console.txt. THE GATE NEVER
  // DEPENDS ON IT: error_log is the only channel that reaches anywhere from a
  // step that exits 0, and a check built on log text is a check built on a
  // courtesy.

  return { step: "runPhpCode", code, critical: true };
}
