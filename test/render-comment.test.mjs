// The comment is the only part of this system a reviewer reads. It is also
// the part that would have forked once per adopting repo, so it lives in the
// action and is tested here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderComment } from "../scripts/render-comment.mjs";

const SHA = "8b217b1807bc0d33b3ac3b50ba516a7aaa7f367c";
const URL = "https://moodle-playground.com/?blueprint=H4sIAAAAAAAAA31T";
const ok = { url: URL, plugin: "mod_attendance", headSha: SHA, runUrl: "https://x/y/runs/1" };

test("the link is the first thing after the marker", () => {
  const lines = renderComment(ok).split("\n");
  assert.match(lines[0], /^<!-- moodle-playground-preview -->$/);
  assert.match(lines[1], /^### ▶ \[Open this pull request in Moodle Playground\]\(/);
});

test("it names the commit the reviewer can cross-check", () => {
  const body = renderComment(ok);
  assert.match(body, /from commit `8b217b1`/);
  assert.match(body, /If it does not say\n {2}`8b217b1`, you are not looking at this code/);
});

test("it gives credentials for all three accounts, so a reviewer can switch role", () => {
  const body = renderComment(ok);
  assert.match(body, /signed in as \*\*`admin`\*\*/);
  assert.match(body, /`admin`, `teacher` and/);
  assert.match(body, /`student1`/);
  assert.match(body, /password \*\*`password`\*\*/);
});

test("it warns that absence is quiet and names the proxy as the cause", () => {
  // A failed download still boots a working Moodle — the reviewer needs to
  // know that before concluding the plugin does nothing.
  const body = renderComment(ok);
  assert.match(body, /If the plugin seems missing, open the Logs panel/);
  assert.match(body, /third-party CORS proxy/);
});

test("it explains the yellow debug boxes", () => {
  assert.match(renderComment(ok), /deprecation notices show\. They are not crashes/);
});

test("it never claims the PR is verified or working", () => {
  const body = renderComment(ok).toLowerCase();
  for (const word of ["verified", "passed", "works correctly", "safe to merge"]) {
    assert.equal(body.includes(word), false, `must not claim "${word}"`);
  }
  assert.match(renderComment(ok), /Smoke test only/);
});

test("no link renders an honest unavailable notice, not a stale one", () => {
  const body = renderComment({ ...ok, url: "" });
  assert.match(body, /Playground preview unavailable for `8b217b1`/);
  assert.equal(body.includes("Open this pull request"), false);
  assert.match(body, /workflow run/);
});

test("it refuses to render a malformed or off-shape URL", () => {
  for (const bad of [
    "https://moodle-playground.com/?blueprint=abc&ref=evil",
    "http://moodle-playground.com/?blueprint=abc",
    "https://evil.example/?blueprint=abc#x",
    "javascript:alert(1)",
  ]) {
    assert.throws(() => renderComment({ ...ok, url: bad }), /malformed preview URL/);
  }
});

test("it refuses inputs that are not what they claim to be", () => {
  assert.throws(() => renderComment({ ...ok, headSha: "main" }), /bad head sha/);
  assert.throws(() => renderComment({ ...ok, plugin: "mod attendance" }), /bad plugin/);
  // Markdown/HTML in the plugin name would render into the comment.
  assert.throws(() => renderComment({ ...ok, plugin: "[x](https://evil)" }), /bad plugin/);
});

test("the marker is present in both shapes, so the sticky upsert can find it", () => {
  assert.match(renderComment(ok), /^<!-- moodle-playground-preview -->/);
  assert.match(renderComment({ ...ok, url: "" }), /^<!-- moodle-playground-preview -->/);
});

test("the comment names the user the reviewer actually arrives as", () => {
  const body = renderComment({ url: URL, plugin: "mod_attendance", headSha: SHA, user: "teacher" });
  assert.match(body, /signed in as \*\*`teacher`\*\*/);
  // And explains why, because "why am I not admin?" is the first question.
  assert.match(body, /Deliberately not admin/);
});

test("an admin landing does not carry the not-admin explanation", () => {
  const body = renderComment({ url: URL, plugin: "local_myplugin", headSha: SHA, user: "admin" });
  assert.match(body, /signed in as \*\*`admin`\*\*/);
  assert.doesNotMatch(body, /Deliberately not admin/);
});

test("a malformed username is refused rather than rendered", () => {
  assert.throws(
    () => renderComment({ url: URL, plugin: "mod_attendance", headSha: SHA, user: "a`b</script>" }),
    /bad user/,
  );
});
