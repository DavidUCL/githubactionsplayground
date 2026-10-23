import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchHostVersion, checkVersionRecord, describeHostVersion } from "../scripts/host-version.mjs";
import { renderComment } from "../scripts/render-comment.mjs";
import { compareHostVersion } from "../scripts/check-host-version.mjs";

const LIVE_SHAPE = {
  buildVersion: "20260820T070625Z-ab13283da6dd-dirty",
  generatedAt: "2026-08-20T07:06:25.942Z",
  gitSha: "ab13283da6dd",
  dirty: true,
};

const fakeFetch = (status, body) => async (url) => {
  fakeFetch.lastUrl = url;
  return { ok: status >= 200 && status < 300, status, text: async () => body };
};

test("reads the record from assets/build-version.json under the host, slash or not", async () => {
  for (const host of ["https://h.example.org/moodle-playground", "https://h.example.org/moodle-playground/"]) {
    const v = await fetchHostVersion(host, { fetchImpl: fakeFetch(200, JSON.stringify(LIVE_SHAPE)) });
    assert.deepEqual(v, { buildVersion: LIVE_SHAPE.buildVersion, gitSha: "ab13283da6dd", dirty: true });
    assert.equal(fakeFetch.lastUrl, "https://h.example.org/moodle-playground/assets/build-version.json");
  }
});

test("a missing, unreadable or malformed record is unknown, never thrown", async () => {
  assert.match((await fetchHostVersion("https://h.example.org", { fetchImpl: fakeFetch(404, "") })).unknown, /HTTP 404/);
  assert.match((await fetchHostVersion("https://h.example.org", { fetchImpl: fakeFetch(200, "<html>") })).unknown, /could not read/);
  const boom = async () => {
    throw new Error("network down");
  };
  assert.match((await fetchHostVersion("https://h.example.org", { fetchImpl: boom })).unknown, /network down/);
});

test("checkVersionRecord refuses fields it cannot trust", () => {
  assert.match(checkVersionRecord(null).unknown, /not a JSON object/);
  assert.match(checkVersionRecord({ ...LIVE_SHAPE, buildVersion: "x`y" }).unknown, /buildVersion/);
  assert.match(checkVersionRecord({ ...LIVE_SHAPE, gitSha: "not-hex" }).unknown, /gitSha/);
  assert.match(checkVersionRecord({ ...LIVE_SHAPE, dirty: "true" }).unknown, /dirty/);
});

test("the summary line names the build, says when it was dirty, and never claims a check", () => {
  const line = describeHostVersion(checkVersionRecord(LIVE_SHAPE));
  assert.match(line, /20260820T070625Z-ab13283da6dd-dirty/);
  assert.match(line, /uncommitted changes/);
  assert.match(line, /not opened by this run/);
  assert.doesNotMatch(line, /verified|passed/i);
  assert.doesNotMatch(describeHostVersion(checkVersionRecord({ ...LIVE_SHAPE, dirty: false })), /uncommitted/);
  assert.match(describeHostVersion({ unknown: "HTTP 404 reading x" }), /could not be read \(HTTP 404 reading x\)/);
});

const COMMENT = {
  url: "https://daviducl.github.io/moodle-playground/?blueprint=abc",
  plugin: "mod_attendance",
  headSha: "d0638b39df1c28fd93c27778ae2cbada7cc1660f",
};

test("the comment names the playground build, or says it was not recorded", () => {
  assert.match(
    renderComment({ ...COMMENT, playgroundVersion: LIVE_SHAPE.buildVersion }),
    /Built against playground build `20260820T070625Z-ab13283da6dd-dirty`; this run did not open the link\./,
  );
  assert.match(renderComment({ ...COMMENT, playgroundVersion: "" }), /build record could not be read/);
  // Not ours to trust blindly: a value that is not a build version is not echoed.
  assert.match(renderComment({ ...COMMENT, playgroundVersion: "x](https://evil.tld)" }), /could not be read/);
  // An older caller that passes nothing gets the old comment.
  assert.doesNotMatch(renderComment(COMMENT), /playground build/);
});

const HEAD = "ab13283da6dd" + "0".repeat(28);

test("compareHostVersion: clean build of the branch head passes", () => {
  assert.deepEqual(compareHostVersion({ buildVersion: "b", gitSha: "ab13283da6dd", dirty: false }, HEAD), []);
});

test("compareHostVersion: a dirty deploy, a different commit and an unreadable record all fail", () => {
  assert.match(compareHostVersion({ buildVersion: "b-dirty", gitSha: "ab13283da6dd", dirty: true }, HEAD)[0], /uncommitted/);
  assert.match(compareHostVersion({ buildVersion: "b", gitSha: "0123456789ab", dirty: false }, HEAD)[0], /serves 0123456789ab/);
  assert.match(compareHostVersion({ unknown: "HTTP 404" }, HEAD)[0], /could not be read: HTTP 404/);
  assert.match(compareHostVersion({ buildVersion: "b", gitSha: "ab13283da6dd", dirty: false }, "")[0], /no usable expected/);
});
