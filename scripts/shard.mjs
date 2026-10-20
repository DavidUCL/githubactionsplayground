// Split a list across N parallel jobs: `MUTATIONS_SHARD=2/3` takes every third
// item starting with the second. Round-robin rather than in blocks, so the slow
// mutants (the ones in the long scripts, listed together) spread across jobs.
//
// Kept out of test/mutations.mjs so it can be unit-tested: that file runs the
// whole harness the moment it is imported.

/**
 * @param {string|undefined} spec "i/n", 1-based; empty or undefined means all.
 * @returns {{index: number, count: number}} 0-based index.
 */
export function parseShard(spec) {
  if (spec === undefined || spec === "") return { index: 0, count: 1 };
  const m = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(String(spec).trim());
  if (!m) throw new Error(`MUTATIONS_SHARD must look like 2/3, not ${JSON.stringify(spec)}`);
  const index = Number(m[1]) - 1;
  const count = Number(m[2]);
  if (index >= count) throw new Error(`MUTATIONS_SHARD ${spec}: the shard number is larger than the count`);
  return { index, count };
}

/** The items this shard owns. Every item belongs to exactly one shard. */
export function takeShard(items, { index, count }) {
  return items.filter((_, k) => k % count === index);
}
