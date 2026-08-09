// Archive builders for tests.
//
// Shared so the .mbz reader tests and the fixture-checker tests use the SAME
// construction — if these were duplicated, a bug in one copy would make one
// suite agree with itself while disagreeing with reality.
//
// Deliberately hand-rolled: check 1d pins the lockfile to the playwright tree,
// so there is no tar or zip library available, and adding one to a security
// gate for test convenience is the wrong trade.

import { gzipSync, deflateRawSync } from "node:zlib";

/** A tar entry: 512-byte header (with checksum) + content padded to 512. */
export function tarEntry(name, content) {
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

export const tarGz = (files) =>
  gzipSync(Buffer.concat([...files.map(([n, c]) => tarEntry(n, c)), Buffer.alloc(1024)]));

/** A zip with one entry, DEFLATE or STORED, built by hand. */
export function zip(files, { stored = false } = {}) {
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

