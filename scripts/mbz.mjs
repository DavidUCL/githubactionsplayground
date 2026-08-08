// Read a Moodle backup (.mbz) far enough to answer "is this the course backup
// we think it is, and what is in it".
//
// Why this exists, measured: a `.mbz` that is not a single-course backup boots
// a completely normal-looking site with no course in it. The reviewer
// concludes the plugin does nothing. `restoreCourse` cannot report it either —
// its handler catches and bare-returns (moodle-restore.js:75-84), so the boot
// carries on and the run reports success.
//
// It also supplies the EXPECTED CONTENT for the post-restore assertion. Those
// numbers must be derived from the archive, never hand-typed: a hand-typed
// count is a second source of truth that silently stops matching the fixture.
//
// STDLIB ONLY. Gate check 1d pins the lockfile to the playwright tree, so a
// zip/tar dependency is not available — and would be a supply-chain addition
// to a security gate for the sake of ~150 lines. `node:zlib` provides both
// primitives needed: gunzip for tar.gz, raw inflate for zip.
//
// BOTH container formats really occur. Measured across 5 core 4.4 fixtures:
// 4 are tar.gz, 1 (admin/tool/uploadcourse) is a zip. A reader that assumed
// either one would reject a real backup.

import { gunzipSync, inflateRawSync } from "node:zlib";

/** Cap on what we will decompress. A .mbz is untrusted input from a URL. */
const MAX_DECOMPRESSED = 512 * 1024 * 1024;
/** moodle_backup.xml is a manifest, not content. Anything vastly larger is not it. */
const MAX_MANIFEST = 32 * 1024 * 1024;

const MANIFEST = "moodle_backup.xml";

/** tar: 512-byte headers, name at 0, size (octal) at 124, type flag at 156. */
function readTar(buf) {
  const files = new Map();
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    // Two consecutive zero blocks end the archive; one is enough to stop.
    if (header.every((b) => b === 0)) break;
    let name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    if (prefix) name = `${prefix}/${name}`;
    const sizeField = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = parseInt(sizeField, 8);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`tar entry ${JSON.stringify(name)} has an unreadable size`);
    }
    const type = String.fromCharCode(header[156]);
    off += 512;
    // '0' and '\0' are regular files; everything else (dirs, links, pax) is skipped.
    if ((type === "0" || type === "\0") && name) {
      files.set(name.replace(/^\.\//, ""), buf.subarray(off, off + size));
    }
    off += Math.ceil(size / 512) * 512;
  }
  return files;
}

/**
 * zip: walk the central directory backwards from the End Of Central Directory
 * record. Only the entries we ask for are inflated.
 */
function readZipEntry(buf, wanted) {
  // EOCD is at the end, but may be followed by a comment of up to 65535 bytes.
  let eocd = -1;
  const from = Math.max(0, buf.length - 65535 - 22);
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip: no end-of-central-directory record");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("zip central directory is corrupt");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    if (name.replace(/^\.\//, "") === wanted) {
      // The local header repeats the name/extra lengths, and they can differ
      // from the central directory's — read the data offset from the local one.
      if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error("zip local header is corrupt");
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(start, start + compSize);
      if (compSize > MAX_MANIFEST) throw new Error(`${wanted} is implausibly large`);
      if (method === 0) return raw;
      if (method === 8) return inflateRawSync(raw, { maxOutputLength: MAX_MANIFEST });
      throw new Error(`${wanted} uses unsupported zip compression method ${method}`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/**
 * @param {Buffer} bytes the whole .mbz
 * @returns {{ok: boolean, reason?: string, format?: string, type?: string,
 *            modulenames?: string[], activityCount?: number, sectionCount?: number,
 *            includesUsers?: boolean, originalCourseShortname?: string}}
 */
export function inspectMbz(bytes) {
  if (!bytes || bytes.length < 4) return { ok: false, reason: "the .mbz is empty or truncated" };

  let manifest = null;
  let format;
  try {
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      format = "tar.gz";
      const tar = gunzipSync(bytes, { maxOutputLength: MAX_DECOMPRESSED });
      manifest = readTar(tar).get(MANIFEST) ?? null;
    } else if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
      format = "zip";
      manifest = readZipEntry(bytes, MANIFEST);
    } else {
      // A 404 page, an HTML error, an LFS pointer — all plausible at a URL.
      const head = bytes.subarray(0, 16).toString("utf8").replace(/[^\x20-\x7e]/g, ".");
      return {
        ok: false,
        reason:
          `not a .mbz: it is neither gzip nor zip (starts "${head}"). A 404 page or an ` +
          `HTML error page served with status 200 looks exactly like this.`,
      };
    }
  } catch (err) {
    return { ok: false, reason: `could not read the .mbz (${format}): ${err.message}` };
  }

  if (!manifest) {
    return { ok: false, reason: `the ${format} archive contains no ${MANIFEST}` };
  }
  const xml = manifest.toString("utf8");

  // <type> distinguishes a course backup from an activity or section backup.
  // Measured: it appears exactly once, in moodle_backup.xml, and an
  // activity-only backup says "activity" — Wasi booted one and got a normal
  // site with no course.
  const type = /<type>(\w+)<\/type>/.exec(xml)?.[1] ?? null;
  // One <modulename> per activity in <contents>. NOT <activity>, which also
  // appears as a leaf reference inside the settings block — measured 3 for a
  // backup holding a single assign, while the restore produced exactly 1
  // course_module (confirmed by booting it). Counting <activity> would have
  // put a permanently-unreachable number into the post-restore assertion.
  const allModulenames = [...xml.matchAll(/<modulename>(\w+)<\/modulename>/g)].map((m) => m[1]);
  const modulenames = [...new Set(allModulenames)].sort();
  const activityCount = allModulenames.length;
  const sectionCount = (xml.match(/<section>/g) || []).length;
  const usersSetting = /<name>users<\/name>\s*<value>(\d+)<\/value>/.exec(xml)?.[1];
  const originalCourseShortname = /<original_course_shortname>([^<]*)<\/original_course_shortname>/.exec(xml)?.[1];

  return {
    ok: true,
    format,
    type,
    modulenames,
    activityCount,
    sectionCount,
    includesUsers: usersSetting === "1",
    originalCourseShortname,
  };
}

/**
 * The gate: is this usable as the review course?
 *
 * @returns {{ok: boolean, reason?: string, info?: object}}
 */
export function checkCourseBackup(bytes) {
  const info = inspectMbz(bytes);
  if (!info.ok) return info;
  if (info.type !== "course") {
    return {
      ok: false,
      info,
      reason:
        `the supplied .mbz is a "${info.type}" backup, not a course backup. Restoring it ` +
        `leaves a working-looking Moodle with no course in it, and nothing reports that.`,
    };
  }
  if (!info.activityCount) {
    return {
      ok: false,
      info,
      reason:
        `the .mbz declares no activities, so the restored course would be empty — ` +
        `which is indistinguishable from a restore that silently failed.`,
    };
  }
  return { ok: true, info };
}
