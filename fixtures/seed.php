<?php
// Seed the review course and cut it to a .mbz. Run by the make-fixture
// workflow inside a real Moodle 4.4, NOT by the action.
//
// This file is the fixture's source of truth: regenerating the .mbz means
// re-running this, so a change to the review course is a reviewable diff here
// rather than a mystery binary someone produced on a laptop.
//
// Usage:  php fixtures/seed.php <moodle-dirroot> <output.mbz>
//
// dirroot is explicit because this file lives in the ACTION's repo, not in the
// Moodle tree — there is no fixed relative path to config.php from here.
//
// -----------------------------------------------------------------------------
// WHY IT IS BUILT THIS WAY — each of these was established the hard way.
//
// CUT ON 4.4, THE OLDEST BRANCH WE OFFER. Restoring FORWARD is safe; restoring
// BACKWARD fails silently. restore_prechecks_helper raises a WARNING (not an
// error) for a too-new backup, helpers.js discards execute_precheck()'s return,
// and restore_plan_builder::set_missing_modules() DROPS an activity type the
// target lacks with no error, no warning and no exception. A 5.0 fixture on 4.4
// would lose content without a word.
//
// NO chat, NO survey. Verified against Moodle's own lib/plugins.json for both
// branches: they are standard on 4.4 and GONE from 5.0, which is the default
// branch. They are the only two of twenty candidates that differ.
//
// users = 0, DELIBERATELY. A backup that carries users creates them on restore,
// and a preview account of the same name then fails to create. Measured by
// booting: a restore of a fixture containing `student1` succeeded, the
// post-restore assertion passed, and createUsers died with exit code 1 five
// steps in, leaving a half-built site. The preview supplies its own teacher and
// students and enrols them, so the fixture needs none. Cost: no submissions or
// grades in the fixture. Revisit only with usernames that cannot collide.
//
// SHORTNAME IS NOT "REVIEW". phpRestoreCourse only takes the requested
// shortname if no other course already holds it, so a fixture owning REVIEW
// would leave the content in a course silently named something else while an
// empty REVIEW sat beside it.
//
// NOT admin/cli/backup.php. That CLI sets exactly one setting (filename) and
// inherits the rest from the runner's site config — and the .mbz's own settings
// block IS the restore configuration, because restore_root_task::define_settings
// derives every restore default from it. A backup cut with someone's site
// defaults restores with those defaults. Everything is set explicitly below.

define('CLI_SCRIPT', true);

$dirroot = $argv[1] ?? null;
$target = $argv[2] ?? null;
if (!$dirroot || !$target) {
    fwrite(STDERR, "usage: php seed.php <moodle-dirroot> <output.mbz>\n");
    exit(2);
}
if (!is_file("$dirroot/config.php")) {
    fwrite(STDERR, "seed: no config.php under $dirroot — is Moodle installed there?\n");
    exit(2);
}

require("$dirroot/config.php");
require_once($CFG->dirroot . '/backup/util/includes/backup_includes.php');
// testing_util lives in lib/testing, NOT lib/phpunit. Verified in v4.4.12:
// lib/testing/classes/util.php:25 declares `abstract class testing_util`, and
// its get_data_generator() (:133) just requires the generator lib and returns
// `new testing_data_generator()` — no phpunit and no database prerequisite.
// Core's own production code does the same: admin/tool/generator's
// course_backend.php:231.
require_once($CFG->libdir . '/testing/classes/util.php');

// What the course contains is declared ONCE, in fixture-spec.json, and read by
// both this script and scripts/check-fixture.mjs. Two lists would be two
// sources of truth, and the one that drifts is the one nobody runs.
$spec = json_decode(file_get_contents(__DIR__ . '/fixture-spec.json'), true);
if (!$spec || empty($spec['modules'])) {
    fwrite(STDERR, "seed: fixture-spec.json is missing or declares no modules\n");
    exit(2);
}

$admin = get_admin();
if (!$admin) {
    fwrite(STDERR, "seed: no admin user; is this a fully installed Moodle?\n");
    exit(3);
}
// Backup annotates grade_grades.usermodified, so running as a real user rather
// than a synthetic one keeps the annotation resolvable.
\core\session\manager::set_user($admin);

// The generators are NOT phpunit-only: core's own tool_generator_course_backend
// calls get_data_generator() from production code, and
// testing_util::get_data_generator() is just `new testing_data_generator()`
// with no phpunit or database prerequisite. Using them means module creation
// goes through add_moduleinfo(), the same path the web UI uses — the
// alternative is reimplementing it here, worse.
$generator = \testing_util::get_data_generator();

$category = \core_course_category::create([
    'name' => 'Review fixtures',
    'idnumber' => 'reviewfixtures',
]);

$course = $generator->create_course([
    'fullname' => 'Review course fixture',
    // NOT "REVIEW" — see the header.
    'shortname' => 'FIXTURE',
    'category' => $category->id,
    'numsections' => 3,
    'format' => 'topics',
    'summary' => 'Sample content for previewing a Moodle plugin. Regenerate with fixtures/seed.php.',
    'summaryformat' => FORMAT_HTML,
], ['createsections' => true]);

$made = [];
foreach ($spec['modules'] as $i => $modname) {
    $plugin = $generator->get_plugin_generator('mod_' . $modname);
    $made[] = $plugin->create_instance([
        'course' => $course->id,
        'name' => ucfirst($modname) . ' example',
        // Spread across the sections that exist, so the restored course does not
        // dump everything into section 0.
        'section' => ($i % $spec['sections']) + 1,
    ]);
}

fwrite(STDOUT, sprintf("seeded course %d with %d activities: %s\n",
    $course->id, count($made), implode(', ', $spec['modules'])));

// -----------------------------------------------------------------------------
// The backup.

$bc = new backup_controller(
    backup::TYPE_1COURSE,
    $course->id,
    backup::FORMAT_MOODLE,
    backup::INTERACTIVE_NO,
    backup::MODE_GENERAL,
    $admin->id
);

// EVERY root setting, stated. Two landmines here, both real:
//  - set_status(NOT_LOCKED) must come BEFORE set_value(), or a setting locked
//    by site config throws setting_locked_by_config.
//  - finish_ui() throws under INTERACTIVE_NO, so it is never called.
$settings = [
    'users'                => $spec['includesUsers'] ? 1 : 0,  // see the header
    'anonymize'            => 0,
    'role_assignments'     => 0,   // nothing to assign without users
    'activities'           => 1,
    'blocks'               => 1,
    'files'                => 1,
    'filters'              => 1,
    'comments'             => 0,
    'badges'               => 0,
    'calendarevents'       => 1,
    'userscompletion'      => 0,
    'logs'                 => 0,
    'grade_histories'      => 0,
    'questionbank'         => 1,   // the quiz is useless without it
    'groups'               => 0,
    'competencies'         => 0,
    'customfield'          => 1,
    'contentbankcontent'   => 1,
    'legacyfiles'          => 0,
];
$plan = $bc->get_plan();
foreach ($settings as $name => $value) {
    if (!$plan->setting_exists($name)) {
        // Settings come and go between branches; a missing one is not a failure,
        // but it must be visible rather than silently skipped.
        fwrite(STDOUT, "  note: setting '$name' does not exist on this Moodle\n");
        continue;
    }
    $setting = $plan->get_setting($name);
    $setting->set_status(base_setting::NOT_LOCKED);
    $setting->set_value($value);
}

$bc->set_status(backup::STATUS_AWAITING);
$bc->execute_plan();

$results = $bc->get_results();
if (empty($results['backup_destination'])) {
    fwrite(STDERR, "seed: the backup produced no file\n");
    exit(4);
}
$results['backup_destination']->copy_content_to($target);
$bc->destroy();

fwrite(STDOUT, "wrote $target (" . filesize($target) . " bytes)\n");
exit(0);
