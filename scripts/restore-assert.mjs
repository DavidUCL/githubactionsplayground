// The post-restore assertion — gate 2 of the curated-.mbz work.
//
// Why it has to exist: `restoreCourse` CANNOT report a content failure. Its
// handler catches and bare-returns (moodle-restore.js:75-84), so a restore
// that produced nothing carries on to the next step and the run reports
// success. The reviewer gets a working-looking Moodle with an empty course and
// concludes the plugin does nothing. `restore_plan_builder` also SILENTLY
// drops activity types the target Moodle lacks (`set_missing_modules()`), so
// "the restore worked" and "the content is there" are different questions.
//
// HOW A PHP STEP SIGNALS FAILURE — measured, and it is not what you would
// guess. Each row is a separate boot against the real playground:
//
//   exit(7)                                             FAILS, "exit code 7"
//   require(config.php); exit(9)                        SUCCEEDS
//   require(config.php); nosuchfunction()   (fatal)     SUCCEEDS
//   require(config.php); throw new Exception            SUCCEEDS
//   define('CLI_SCRIPT',true); require(...); exit(9)    FAILS, "exit code 9"
//
// So an assertion written the obvious way — load Moodle, throw if the course
// is empty — reports SUCCESS. So does a fatal error. Only CLI_SCRIPT plus a
// non-zero exit fails the step, and the executor on the action's DEFAULT host
// aborts the whole blueprint on any step failure, so no `critical:` flag is
// needed there. That is host-specific and was written as though it were
// universal: ateeducacion's build honours `critical` and would CONTINUE past a
// non-critical failure. Measured 2026-08-17 — daviducl.github.io's
// executor.js is 2,687 bytes with zero occurrences of "critical";
// ateeducacion's is 4,649 with four. Steps that must not be skipped say so.
//
// The expected values come from the .mbz itself (see mbz.mjs). They are never
// hand-typed: a hand-typed count is a second source of truth that silently
// stops matching the fixture.

import { ownStep } from "./own-steps.mjs";

/** Exit codes. Distinct so the boot log's "exit code N" names the failure. */
export const ASSERT_CODES = {
  0: "the restored course is present and complete",
  21: "no course with the expected shortname exists — the restore produced nothing",
  22: "the course exists but has fewer activities than the .mbz declares",
  23: "an activity type the .mbz declares is missing — Moodle dropped it silently",
  24: "the assertion could not read the course at all",
};

/** Moodle component names are [a-z0-9_]; anything else is not one. */
const IDENT = /^[a-z][a-z0-9_]*$/;
/** A course shortname reaches SQL as a bound parameter, but it also has to
 * survive being embedded in a single-quoted PHP string on one line. */
const SHORTNAME = /^[A-Za-z0-9_-]+$/;

/**
 * Build the assertion step.
 *
 * @param {{shortname: string, modulenames: string[], activityCount: number}} expected
 * @returns {{step: string, code: string, critical: boolean}}
 */
export function buildRestoreAssertion(expected) {
  const shortname = String(expected?.shortname ?? "");
  const modulenames = expected?.modulenames ?? [];
  const activityCount = Number(expected?.activityCount);

  if (!SHORTNAME.test(shortname)) {
    throw new Error(`restore assertion: unusable course shortname ${JSON.stringify(shortname)}`);
  }
  if (!Array.isArray(modulenames) || modulenames.length === 0) {
    throw new Error("restore assertion: refusing to assert nothing — no module names supplied");
  }
  for (const m of modulenames) {
    if (!IDENT.test(String(m))) {
      throw new Error(`restore assertion: unusable module name ${JSON.stringify(m)}`);
    }
  }
  if (!Number.isInteger(activityCount) || activityCount < 1) {
    throw new Error(
      `restore assertion: refusing to assert ${activityCount} activities — an assertion ` +
        `that passes on an empty course is worse than no assertion`,
    );
  }

  // ONE LINE. preflight refuses any control character in a blueprint string,
  // and a newline would also end the workflow command if it were ever echoed.
  // `deletioninprogress=0` matters: a module queued for async deletion still
  // has a course_modules row and would inflate the count.
  const wanted = modulenames.map((m) => `'${m}'`).join(",");
  const code =
    `<?php define('CLI_SCRIPT',true); require('/www/moodle/config.php'); global $DB; ` +
    `try { $c=$DB->get_record('course',array('shortname'=>'${shortname}')); ` +
    `if(!$c) exit(21); ` +
    `$n=$DB->count_records_select('course_modules','course=? AND deletioninprogress=0',array($c->id)); ` +
    `if($n < ${activityCount}) exit(22); ` +
    `$have=$DB->get_fieldset_sql('SELECT DISTINCT m.name FROM {course_modules} cm JOIN {modules} m ON m.id=cm.module WHERE cm.course=?',array($c->id)); ` +
    `foreach(array(${wanted}) as $w) { if(!in_array($w,$have)) exit(23); } ` +
    `} catch (Throwable $e) { exit(24); } ` +
    `exit(0);`;

  if (/[\x00-\x1f\x7f]/.test(code)) {
    throw new Error("restore assertion: generated code contains a control character");
  }
  return ownStep({ step: "runPhpCode", code, critical: true });
}

/** Turn a boot-log exit code back into a sentence, for the summary. */
export function explainAssertionExit(code) {
  return ASSERT_CODES[Number(code)] ?? `the assertion exited ${code}, which it has no meaning for`;
}
