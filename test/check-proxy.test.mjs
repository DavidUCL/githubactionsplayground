import { test } from "node:test";
import assert from "node:assert/strict";
import { proxiedUrl, judgeProxyResponse } from "../scripts/check-proxy.mjs";

const ZIP = Uint8Array.from([0x50, 0x4b, 0x03, 0x04]);

test("builds the proxied URL the way the playground does", () => {
  assert.equal(
    proxiedUrl("https://proxy.example.org/", "https://github.com/o/r/archive/abc.zip"),
    "https://proxy.example.org/?url=https%3A%2F%2Fgithub.com%2Fo%2Fr%2Farchive%2Fabc.zip",
  );
});

test("a 200 ZIP a page may read passes", () => {
  assert.deepEqual(judgeProxyResponse({ status: 200, allowOrigin: "*", firstBytes: ZIP }), []);
});

test("an error status, a missing CORS header and a non-ZIP body each fail", () => {
  assert.match(judgeProxyResponse({ status: 502, allowOrigin: "*", firstBytes: ZIP })[0], /HTTP 502/);
  assert.match(judgeProxyResponse({ status: 200, allowOrigin: null, firstBytes: ZIP })[0], /Access-Control-Allow-Origin/);
  assert.match(judgeProxyResponse({ status: 200, allowOrigin: "https://other.example", firstBytes: ZIP })[0], /cannot read it/);
  assert.deepEqual(judgeProxyResponse({ status: 200, allowOrigin: "https://daviducl.github.io", firstBytes: ZIP }), []);
  assert.match(
    judgeProxyResponse({ status: 200, allowOrigin: "*", firstBytes: Uint8Array.from([0x3c, 0x68, 0x74, 0x6d]) })[0],
    /not a ZIP/,
  );
});
