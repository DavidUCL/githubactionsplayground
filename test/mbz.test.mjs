// Tests for the .mbz reader.
//
// The archives here are BUILT IN MEMORY rather than committed. Two reasons:
// core's real .mbz fixtures are GPL and this repo is MIT, which is not a
// licensing call to make casually; and a synthetic archive lets a test say
// "what if moodle_backup.xml is missing" without hand-editing a binary.
//
// The real-Moodle half is covered by the network gate check, which fetches
// actual core fixtures — so this file proves the PARSING and that one proves
// the parsing still matches what Moodle emits.

import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync, deflateRawSync } from "node:zlib";
import { inspectMbz, checkCourseBackup } from "../scripts/mbz.mjs";

/** A tar entry: 512-byte header (with checksum) + content padded to 512. */
function tarEntry(name, content) {
  const data = Buffer.from(content, "utf8");
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write("0000644\0", 100, 8, "utf8"); // mode
  h.write("0000000\0", 108, 8, "utf8"); // uid
  h.write("0000000\0", 116, 8, "utf8"); // gid
  h.write(data.length.toString(8).padStart(11, "0") + "\0", 124, 12, "utf8");
  h.write("00000000000\0", 136, 12, "utf8"); // mtime
  h.write("        ", 148, 8, "utf8"); // checksum placeholder: spaces
  h.write("0", 156, 1, "utf8"); // regular file
  h.write("ustar\0" + "00", 257, 8, "utf8");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "utf8");
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([h, data, pad]);
}

const tarGz = (files) =>
  gzipSync(Buffer.concat([...files.map(([n, c]) => tarEntry(n, c)), Buffer.alloc(1024)]));

/** A zip with one entry, DEFLATE or STORED, built by hand. */
function zip(files, { stored = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of files) {
    const raw = Buffer.from(content, "utf8");
    const body = stored ? raw : deflateRawSync(raw);
    const nameBuf = Buffer.from(name, "utf8");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(stored ? 0 : 8, 8);
    lh.writeUInt32LE(0, 14); // crc, unchecked by the reader
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    const local = Buffer.concat([lh, nameBuf, body]);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(stored ? 0 : 8, 10);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, nameBuf]));
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

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
