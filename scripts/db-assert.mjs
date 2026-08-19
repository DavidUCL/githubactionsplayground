// The post-restore-database assertion — the in-browser half of the snapshot work.
//
// WHY IT HAS TO EXIST. `restoreDatabase` (the playground's
// src/blueprint/steps/moodle-database.js, read 2026-08-19) splits its failure
// handling at the moment it renames the downloaded file over the live
// database:
//
//   * BEFORE the swap it throws — the step honestly failed, nothing changed.
//   * AFTER the swap it CANNOT throw, by design: "aborting cannot undo the
//     swap". It calls publish() and returns.
//
// So a restore that swapped the database and then failed to patch it reports
// the step as SUCCESSFUL. Its own comment says what that leaves behind: "the
// restored data is in place with the source instance's wwwroot/dirroot still
// in mdl_config — the site is likely stuck in a redirect loop". The executor
// sees a successful step, the blueprint carries on, and the link is published.
// Nothing outside the database can see it. That is exit code 73 below.
//
// THE OTHER HALF is what the swap deliberately destroys. It ends with
//     set_config('allversionshash', core_component::get_all_versions_hash());
// with a comment explaining the choice: an empty hash would strand a
// version-mismatched restore on the upgrade screen. The consequence is that
// `moodle_needs_upgrading()` can never fire again on a restored site, so a
// snapshot from another Moodle produces no upgrade screen, no warning and no
// boot failure — just "Error reading from database" on whichever page first
// touches a column that is not there. The version rows themselves are NOT
// rewritten, so they still describe the snapshot: comparing them with the
// running code's version.php is the only remaining way to see it. Exit 74.
//
// WHAT THE IDENTITY CHECK IS FOR. The swap rewrites exactly four config values
// — wwwroot, dirroot, dataroot, allversionshash — and unsets adminsetuppending.
// `siteidentifier` is untouched, which makes it a usable fingerprint for "the
// database in this browser is the file we hashed at build time". It is the only
// check that covers a snapshot whose bytes changed between the build and the
// reviewer opening the link, because the digest is NOT re-checked in the
// browser and cannot be (the swap rewrites the file before any code of ours
// runs). Exits 71 and 72.
//
// HOW A PHP STEP SIGNALS FAILURE: `define('CLI_SCRIPT',true)` before
// requiring config.php, then a non-zero `exit()`. See restore-assert.mjs for
// the measurements. A throw does fail under CLI_SCRIPT, but reports a bare
// "exit code 1" that names no cause, so every branch below exits its own code.
//
// EVERY VALUE IS READ WITH RAW `$DB->get_field`, never `get_config()`.
// get_config() answers from the MUC cache, and the step purges and re-seeds
// caches around the swap; an assertion reading a cache seeded before the
// restore would compare the pre-restore value with itself and pass. The point
// of this program is to look at the database that is actually installed.

/** Exit codes. Distinct so the boot log's "exit code N" names the failure. */
export const DB_ASSERT_CODES = {
  0: "the restored database is the one that was checked, and it is usable",
  71: "the restored database has no siteidentifier — nothing identifies it",
  72: "the database in the browser is not the snapshot that was checked at build time",
  73: "the database was replaced but never adapted to this site — the step reported success anyway",
  74: "the snapshot is from a different Moodle than the one running, which Moodle can no longer detect",
  75: "the account the preview signs in as is not in the restored database",
  76: "the assertion could not read the database at all",
};

// There is deliberately NO code for "this is not a Moodle database". config.php
// cannot be required against one — setup.php's initialise_cfg() reads the
// config table during the require, so a file with no schema throws before the
// first line of this program runs. It lands in 76, which is where it belongs.

/** A Moodle site identifier as it may be embedded in single-quoted PHP. */
const IDENTITY = /^[A-Za-z0-9._-]+$/;
/** Moodle usernames are lowercased and restricted; anything else is not one. */
const USERNAME = /^[a-z0-9._@-]+$/;
/** The branch rows Moodle writes are digits ("500", "403"). */
const BRANCH = /^[0-9]+$/;
/**
 * Short identities make the comparison meaningless — a 3-character value
 * collides by accident. The reader refuses these at build time too; this is
 * the second line, because an assertion is the one thing that must never be
 * able to pass vacuously.
 */
const MIN_IDENTITY = 20;

/**
 * Build the post-restore assertion step.
 *
 * @param {{identity: string, branch: string, loginAs: string}} expected
 *   Taken from the snapshot the builder actually downloaded and hashed — never
 *   hand-typed, or it becomes a second source of truth that stops matching.
 * @returns {{step: string, code: string, critical: boolean}}
 */
export function buildDatabaseAssertion(expected) {
  const identity = String(expected?.identity ?? "");
  const branch = String(expected?.branch ?? "");
  const loginAs = String(expected?.loginAs ?? "admin");

  if (identity.length < MIN_IDENTITY || !IDENTITY.test(identity)) {
    throw new Error(
      `database assertion: unusable siteidentifier ${JSON.stringify(identity)} — ` +
        `refusing to build an assertion that would compare nothing`,
    );
  }
  if (!BRANCH.test(branch)) {
    throw new Error(`database assertion: unusable Moodle branch ${JSON.stringify(branch)}`);
  }
  if (!USERNAME.test(loginAs)) {
    throw new Error(`database assertion: unusable username ${JSON.stringify(loginAs)}`);
  }

  // ONE LINE, and no `//` comments: every generated program is collapsed onto a
  // single physical line, so a `//` would comment out the rest of the program.
  // preflight also refuses control characters anywhere in a blueprint string.
  //
  // THE VERSION COMPARISON IS GUARDED ON BOTH SIDES BEFORE IT IS MADE. If
  // version.php did not set `$branch` and the config row were also absent,
  // `(string)null !== (string)false` compares "" with "" and PASSES — the
  // assertion would report a matching Moodle having read neither value. Each
  // side is therefore required to exist first, and an absent one is 76 (could
  // not read) rather than 74 (mismatch), because they are different facts.
  //
  // `is_readable` before the require for the same reason: a missing require is
  // a PHP fatal, and a fatal's exit status under CLI_SCRIPT has never been
  // measured here. A named exit does not depend on the answer.
  //
  // `$cfg` is the raw config reader. `IGNORE_MISSING` is get_field's strictness
  // argument: it returns `false` for an absent row rather than throwing, so a
  // missing row is a value this program can test and name, not an exception
  // that lands in 76 and hides which row was missing.
  const code =
    `<?php define('CLI_SCRIPT',true); require('/www/moodle/config.php'); global $DB, $CFG; ` +
    `try { ` +
    `$cfg = function($n) use ($DB) { return $DB->get_field('config','value',array('name'=>$n),IGNORE_MISSING); }; ` +
    `$id = $cfg('siteidentifier'); ` +
    `if($id === false || $id === null || $id === '') exit(71); ` +
    `if($id !== '${identity}') exit(72); ` +
    `if($cfg('wwwroot') !== $CFG->wwwroot) exit(73); ` +
    `if(!is_readable('/www/moodle/version.php')) exit(76); ` +
    `$branch = null; require('/www/moodle/version.php'); ` +
    `$dbbranch = $cfg('branch'); ` +
    `if($branch === null || $dbbranch === false || $dbbranch === null || $dbbranch === '') exit(76); ` +
    `if((string)$branch !== (string)$dbbranch) exit(74); ` +
    `if(!$DB->record_exists('user',array('username'=>'${loginAs}','deleted'=>0))) exit(75); ` +
    `} catch (Throwable $e) { exit(76); } ` +
    `exit(0);`;

  if (/[\x00-\x1f\x7f]/.test(code)) {
    throw new Error("database assertion: generated code contains a control character");
  }
  if (code.includes("//")) {
    throw new Error("database assertion: generated code contains a // comment on one line");
  }
  return { step: "runPhpCode", code, critical: true };
}

/** Turn a boot-log exit code back into a sentence, for the summary. */
export function explainDatabaseAssertionExit(code) {
  return (
    DB_ASSERT_CODES[Number(code)] ??
    `the database assertion exited ${code}, which it has no meaning for`
  );
}
