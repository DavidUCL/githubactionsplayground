import { test } from "node:test";
import assert from "node:assert/strict";
import { parseShard, takeShard } from "../scripts/shard.mjs";

test("no shard means the whole list", () => {
  assert.deepEqual(parseShard(undefined), { index: 0, count: 1 });
  assert.deepEqual(parseShard(""), { index: 0, count: 1 });
  assert.deepEqual(takeShard([1, 2, 3], parseShard("")), [1, 2, 3]);
});

test("the shards of a list cover every item exactly once", () => {
  const items = Array.from({ length: 23 }, (_, k) => k);
  for (const n of [1, 2, 3, 4, 7]) {
    const seen = [];
    for (let i = 1; i <= n; i++) seen.push(...takeShard(items, parseShard(`${i}/${n}`)));
    assert.deepEqual(seen.sort((a, b) => a - b), items, `n=${n}`);
  }
});

test("round-robin: neighbours go to different shards", () => {
  assert.deepEqual(takeShard(["a", "b", "c", "d", "e"], parseShard("2/2")), ["b", "d"]);
});

test("a malformed or impossible shard is refused, not read as 'all'", () => {
  for (const bad of ["0/3", "4/3", "3", "1/0", "a/b", "1/3/4", "-1/3"]) {
    assert.throws(() => parseShard(bad), /MUTATIONS_SHARD/, bad);
  }
});
