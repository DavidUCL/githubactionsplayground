// No source file may contain a literal control byte.
//
// WHY THIS IS WORTH A TEST. Two files here were written with real control
// characters where escapes were meant: `scripts/snapshot.mjs` carried the
// SQLite magic's trailing NUL as a raw byte, and `scripts/restore-assert.mjs`
// spelled `/[\x00-\x1f\x7f]/` with the three characters themselves. Both were
// CORRECT — the values and the regex matched exactly what the escaped forms
// match, every test passed, and the mutation harness was happy.
//
// What they cost was reviewability. Git decides a file is binary by looking for
// a NUL in its first 8000 bytes, so both files diffed as
// "Binary files a/... and b/... differ": no diff, no blame, no line numbers in
// a review, for as long as the byte was there. The restore-assert one had been
// like that since the day it was committed, and it hid in plain sight because
// the offending line RENDERS as `if (/[ -]/.test(code)) {` in a terminal —
// which reads like a typo rather than like three invisible characters.
//
// Tab, newline and carriage return are excluded: those are the control
// characters a text file is supposed to contain.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Directories with nothing of ours in them. */
const SKIP_DIRS = new Set(["node_modules", ".git"]);
/**
 * The extensions we WRITE. An allow-list rather than a deny-list because
 * test/fixtures is full of deliberate binaries — .mbz, .sq3, .zip — and a
 * deny-list would have to grow a new entry every time one is added, which is
 * how a scanner quietly stops covering the thing it was written for.
 */
const TEXT_EXT = new Set([".mjs", ".js", ".json", ".py", ".yml", ".yaml", ".md", ".sh"]);

function textFiles(dir = ROOT, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) textFiles(full, out);
    else if (TEXT_EXT.has(extname(name)) || name === "verify.sh") out.push(full);
  }
  return out;
}

/** @returns {number[]} offsets of every control byte, tab/LF/CR excepted. */
function controlBytes(buf) {
  const found = [];
  for (let i = 0; i < buf.length; i += 1) {
    const b = buf[i];
    if ((b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) || b === 0x7f) found.push(i);
  }
  return found;
}

test("the scanner finds a control byte when there is one", () => {
  // THE SELF-TEST, and the reason this file is not just a loop. A scanner with
  // an off-by-one in its byte range would pass every real file forever and
  // report nothing wrong on the day it mattered.
  assert.deepEqual(controlBytes(Buffer.from("clean text\n\tand a tab\r\n")), []);
  assert.deepEqual(controlBytes(Buffer.from([0x61, 0x00, 0x62])), [1], "a NUL must be found");
  assert.deepEqual(controlBytes(Buffer.from([0x1f])), [0], "0x1f is the top of the range");
  assert.deepEqual(controlBytes(Buffer.from([0x7f])), [0], "DEL is above the range and counts");
  assert.deepEqual(controlBytes(Buffer.from([0x20])), [], "space is not a control byte");
  // ...and it must survive the real thing: the exact line that hid in
  // restore-assert.mjs, rebuilt here rather than quoted, because quoting it
  // would put the bytes back into this file.
  const wasThere = Buffer.from(`  if (/[\x00-\x1f\x7f]/.test(code)) {`, "latin1");
  assert.equal(controlBytes(wasThere).length, 3);
});

test("no source file contains a literal control byte", () => {
  const files = textFiles();
  // A floor, so a broken walk reads as a failure rather than as a clean tree.
  assert.ok(files.length > 40, `only found ${files.length} source files to scan`);

  const offenders = [];
  for (const full of files) {
    const hits = controlBytes(readFileSync(full));
    if (hits.length) {
      const buf = readFileSync(full);
      const line = buf.subarray(0, hits[0]).toString("utf8").split("\n").length;
      offenders.push(
        `${relative(ROOT, full)}:${line} — ${hits.length} control byte(s). ` +
          `Write them as escapes (\\x00, \\u0000); git calls the whole file binary otherwise.`,
      );
    }
  }
  assert.deepEqual(offenders, []);
});
