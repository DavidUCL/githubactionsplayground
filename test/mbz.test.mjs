// Tests for the .mbz reader.
//
// Two kinds of archive here, deliberately.
//
// SYNTHETIC ones, built in memory, prove the PARSING — and let a test ask
// "what if moodle_backup.xml is missing" or "what if the tar size field is
// garbage" without hand-editing a binary.
//
// VENDORED ones (test/fixtures/mbz, see COPYRIGHT) prove the reader against
// bytes Moodle actually produced, in both container formats, OFFLINE. Check 1t
// verifies they still match upstream, so a stale vendored fixture is caught
// rather than quietly becoming the only thing we test against.

import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { tarEntry, tarGz, zip } from "./helpers/archive.mjs";
import { inspectMbz, checkCourseBackup } from "../scripts/mbz.mjs";

/** A manifest shaped like the real thing, including the leaf <activity> refs
 * that made a naive count wrong. */
const manifest = ({ type = "course", mods = ["assign"], users = "1" } = {}) => `
<moodle_backup><information><name>backup.mbz</name>
<original_course_shortname>C1</original_course_shortname>
<details><detail><type>${type}</type></detail></details>
<contents><activities>
${mods.map((m, i) => `<activity><moduleid>${i + 1}</moduleid><modulename>${m}</modulename><title>t${i}</title></activity>`).join("\n")}
</activities><sections><section><sectionid>1</sectionid></section></sections></contents>
<settings>
<setting><level>root</level><name>users</name><value>${users}</value></setting>
${mods.map((m, i) => `<setting><level>activity</level><activity>${m}_${i}</activity><name>${m}_${i}_included</name><value>1</value></setting>`).join("\n")}
</settings></information></moodle_backup>`;

test("reads a tar.gz course backup", () => {
  const r = inspectMbz(tarGz([["moodle_backup.xml", manifest()]]));
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.format, "tar.gz");
  assert.equal(r.type, "course");
  assert.deepEqual(r.modulenames, ["assign"]);
  assert.equal(r.includesUsers, true);
  assert.equal(r.originalCourseShortname, "C1");
});

test("reads a zip course backup — both container formats really occur", () => {
  const r = inspectMbz(zip([["moodle_backup.xml", manifest()]]));
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.format, "zip");
  assert.equal(r.type, "course");
});

test("reads a STORED zip entry as well as a deflated one", () => {
  const r = inspectMbz(zip([["moodle_backup.xml", manifest()]], { stored: true }));
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.type, "course");
});

// The count that matters. `<activity>` also appears as a leaf reference in the
// settings block — measured 3 for a backup holding ONE assign, whose restore
// produced exactly 1 course_module. A count of 3 in the post-restore assertion
// could never be reached.
// Two instances of ONE module: the count must see both, the name list must
// carry one. Every other fixture here has distinct modules, so de-duplication
// changed nothing and looked covered when it was not.
test("repeated activities count twice but name once", () => {
  const r = inspectMbz(tarGz([["moodle_backup.xml", manifest({ mods: ["assign", "assign", "quiz"] })]]));
  assert.equal(r.activityCount, 3);
  assert.deepEqual(r.modulenames, ["assign", "quiz"]);
});

test("the activity count counts activities, not every <activity> tag", () => {
  const xml = manifest({ mods: ["assign", "quiz"] });
  assert.ok((xml.match(/<activity>/g) || []).length > 2, "fixture must contain leaf refs");
  const r = inspectMbz(tarGz([["moodle_backup.xml", xml]]));
  assert.equal(r.activityCount, 2);
  assert.deepEqual(r.modulenames, ["assign", "quiz"]);
});

test("finds the manifest among many entries", () => {
  const r = inspectMbz(
    tarGz([
      ["files.xml", "<files/>"],
      ["activities/assign_1/assign.xml", "<activity/>"],
      ["moodle_backup.xml", manifest()],
      ["course/course.xml", "<course/>"],
    ]),
  );
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.modulenames, ["assign"]);
});

// --- refusals ---------------------------------------------------------------
// A URL can serve anything. Each of these renders as a working-looking Moodle
// with no course if it is not caught here.

test("an activity backup is refused, naming what it actually is", () => {
  const r = checkCourseBackup(tarGz([["moodle_backup.xml", manifest({ type: "activity" })]]));
  assert.equal(r.ok, false);
  assert.match(r.reason, /"activity" backup, not a course backup/);
});

test("a course backup with no activities is refused", () => {
  const r = checkCourseBackup(tarGz([["moodle_backup.xml", manifest({ mods: [] })]]));
  assert.equal(r.ok, false);
  assert.match(r.reason, /no activities/);
});

test("an HTML error page served with status 200 is refused", () => {
  const r = checkCourseBackup(Buffer.from("<!DOCTYPE html><html>404 Not Found</html>"));
  assert.equal(r.ok, false);
  assert.match(r.reason, /neither gzip nor zip/);
  // The reason must show what arrived, or the author cannot tell a 404 from a
  // wrong path.
  assert.match(r.reason, /DOCTYPE/);
});

test("an archive with no moodle_backup.xml is refused", () => {
  const r = checkCourseBackup(tarGz([["files.xml", "<files/>"]]));
  assert.equal(r.ok, false);
  assert.match(r.reason, /contains no moodle_backup\.xml/);
});

test("empty and truncated inputs are refused, not crashed on", () => {
  assert.equal(checkCourseBackup(Buffer.alloc(0)).ok, false);
  assert.equal(checkCourseBackup(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00])).ok, false);
  assert.equal(checkCourseBackup(null).ok, false);
});

test("zip magic followed by garbage is refused, not crashed on", () => {
  const r = checkCourseBackup(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(300)]));
  assert.equal(r.ok, false);
  assert.match(r.reason, /zip/);
});

test("a tar with an unreadable size field is refused, not looped on", () => {
  const bad = tarEntry("moodle_backup.xml", "x");
  bad.write("!!!!!!!!!!!\0", 124, 12, "utf8");
  const r = checkCourseBackup(gzipSync(Buffer.concat([bad, Buffer.alloc(1024)])));
  assert.equal(r.ok, false);
  assert.match(r.reason, /unreadable size/);
});

// --- vendored real Moodle backups ------------------------------------------
// Synthetic archives prove the PARSING; these prove it against bytes Moodle
// actually produced — offline, rather than only when check 1t reaches the
// network. Vendored under the same licence as this repo (see COPYRIGHT);
// check 1t verifies they still match upstream.

const VENDORED = [
  ["legacy_course_completion.mbz", "tar.gz", "course", ["assign"], 1, true],
  ["backup.mbz", "zip", "course", ["glossary"], 1, true],
  // The one that matters: restoring an activity backup leaves a working-looking
  // site with no course, and restoreCourse cannot report it.
  ["moodle_311_quiz.mbz", "tar.gz", "activity", ["quiz"], 1, false],
];

for (const [file, format, type, mods, acts, usable] of VENDORED) {
  test(`real Moodle backup ${file} reads as ${format}/${type}`, async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const bytes = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mbz", file),
    );
    const info = inspectMbz(bytes);
    assert.equal(info.ok, true, info.reason);
    assert.equal(info.format, format);
    assert.equal(info.type, type);
    assert.deepEqual(info.modulenames, mods);
    // Cross-checked against a real boot: legacy_course_completion restores
    // exactly 1 course_module, and this count must agree with that.
    assert.equal(info.activityCount, acts);
    assert.equal(checkCourseBackup(bytes).ok, usable);
  });
}

// A backup that carries users CREATES them on restore. Measured by booting:
// the restore succeeded, the assertion passed, and createUsers then died with
// exit code 1 five steps in because the backup already had `student1`.
test("usernames the backup will create are reported", async () => {
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = dirname(fileURLToPath(import.meta.url));
  const withUsers = inspectMbz(readFileSync(join(here, "fixtures/mbz/legacy_course_completion.mbz")));
  assert.deepEqual(withUsers.usernames, ["student1", "student2", "teacher1"]);
  const without = inspectMbz(readFileSync(join(here, "fixtures/mbz/backup.mbz")));
  assert.deepEqual(without.usernames, [], "a users=0 backup creates nobody");
});

test("a backup with no users.xml reports no usernames rather than failing", () => {
  const r = inspectMbz(tarGz([["moodle_backup.xml", manifest()]]));
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.usernames, []);
});
