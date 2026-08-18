// Prove the reviewer's landing page points at the review course, and not at
// whatever else happens to have that number.
//
// THE FAILURE. `/course/modedit.php` takes an integer course id and has no name
// form, so the one landing that matters most — the activity add form, where
// most previews arrive — carries a number. That number is 2 because Moodle
// numbers the site course 1 and allocates the rest in creation order, and
// `reviewCourseId()` proves the ORDER of the steps we emit. What neither can
// see is Moodle allocating an id to something else first: `installMoodlePlugin`
// runs BEFORE `createCourse` and triggers the plugin upgrade, so a plugin under
// review whose own `db/install.php` creates a course takes id 2 and the
// reviewer is sent into the plugin's course.
//
// Today that is survivable — the reviewer arrives as a teacher who is not
// enrolled there, so `require_login()` refuses and they get an error rather
// than a plausible wrong page. `courses` is what makes it silent: once the
// teacher is enrolled in more than one course that refusal stops firing, and a
// wrong number becomes a normal-looking add form in the wrong course. Hence
// this ships in the commit BEFORE `courses`, so no commit in history leaves the
// failure silent.
//
// THE TWO COMPARED VALUES MUST NOT COME FROM THE SAME PLACE. The runtime id is
// read out of `mdl_course`; the expected id is parsed back out of the LANDING
// STRING the reviewer will actually open — not from `reviewCourseId()`'s return
// value, which is what produced that string in the first place. Two hashes of
// the same file always agree, and this repo has shipped exactly that once. It
// is also why a `landing-path` override is honoured here rather than skipped:
// an override is the only input that can make the two sources disagree, so
// dropping the assertion there would make the self-comparison unkillable.
//
// WHY NOT `MUST_EXIST`. Not because a throw is invisible — that was the
// recorded reason and it was wrong. MEASURED 2026-08-18: under `CLI_SCRIPT` a
// throw DOES fail the step. It fails with exit code 1, which is the generic
// code, so it cannot say WHICH of the two failures happened; it writes no
// `error_log` line for the human; and it routes through
// `default_exception_handler`, which builds a renderer inside a CLI script —
// the uncatchable heap-abort path. `IGNORE_MISSING` plus an explicit test says
// exactly what went wrong and costs nothing.
//
// WHAT THIS CANNOT SEE. It runs before the reviewer arrives, so it proves the
// id at assertion time. `restore-database-*`, the last control still to be
// built, replaces the whole database — `mdl_course` AND SQLite's sequence — so
// it invalidates this premise entirely. That is the next panel's problem and is
// recorded as such rather than half-guarded here.

/** Exit codes this step can produce, for the boot-log explainer. Block 61-69. */
export const COURSE_ID_CODES = {
  61: "the review course does not exist at the point its id was checked",
  62: "the review course exists, but NOT at the id the landing page points at — " +
    "the reviewer would have been sent into a different course, which looks " +
    "completely normal on arrival",
};

/** Collapse to one line: a newline in any blueprint string is rejected. */
const oneLine = (s) => s.replace(/\s+/g, " ").trim();

/**
 * The course id a landing page will actually open, or null when it names no
 * course by number.
 *
 * `course=` is unambiguous wherever it appears. `id=` is NOT: on
 * `/course/view.php` it is a course, but elsewhere in Moodle it is a course
 * MODULE id, a user id or a category id, so a blanket `id=` would embed a cmid
 * as a course id and fail a perfectly correct build.
 */
export function landingCourseId(path) {
  const s = String(path ?? "");
  const byCourse = /[?&]course=(\d+)(?:&|$)/.exec(s);
  if (byCourse) return Number(byCourse[1]);
  if (s.startsWith("/course/view.php")) {
    const byId = /[?&]id=(\d+)(?:&|$)/.exec(s);
    if (byId) return Number(byId[1]);
  }
  return null;
}

/**
 * @param {{courseId: number, shortname: string}} opts
 * @returns {{step: string, code: string, critical: boolean}}
 */
export function buildCourseIdAssertion({ courseId, shortname }) {
  if (!Number.isInteger(courseId) || courseId < 1) {
    // Refusing to BUILD an assertion that could not be trusted, rather than
    // emitting a weakened one. A refusal must never look like an absence.
    throw new Error(
      `internal: a course-id assertion needs a positive integer id, got ${JSON.stringify(courseId)}`,
    );
  }
  if (!/^[A-Z0-9]+$/.test(String(shortname))) {
    throw new Error(
      `internal: unsafe course shortname for an assertion: ${JSON.stringify(shortname)}`,
    );
  }

  // NO `//` COMMENTS INSIDE THIS STRING — `oneLine` collapses the program onto
  // one physical line, so the first one would comment out everything after it.
  const code = oneLine(`<?php
    define('CLI_SCRIPT',true);
    require('/www/moodle/config.php');
    $c = $DB->get_record('course', array('shortname' => '${shortname}'), 'id', IGNORE_MISSING);
    if (!$c) { error_log('course-id: no ${shortname} course'); exit(61); }
    $want = ${courseId};
    error_log('course-id: ${shortname} is ' . (int)$c->id . ', landing points at ' . $want);
    if ((int)$c->id !== $want) { exit(62); }
    exit(0);
  `);

  // 61 IS DEFENSIVE AND UNREACHABLE ON THE PATHS THIS RUNS ON, deliberately.
  // The assertion is only emitted when the landing carries a number, which is
  // the created-course path, and `createCourse` is `critical` — a failure there
  // aborts the boot before this step. It is kept because the ONE path that can
  // silently produce no REVIEW course is a failed restore (its handler catches
  // and returns on both hosts, leaving an orphan shell that also burns the id),
  // and `restore-database-*` will make more such paths. A code that says "no
  // course" is worth having the day one of them reaches here; without it that
  // case would report 62 and blame the numbering.
  return { step: "runPhpCode", code, critical: true };
}
