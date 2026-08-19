// The comment is the only part of this system a reviewer reads. It is also
// the part that would have forked once per adopting repo, so it lives in the
// action and is tested here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderComment } from "../scripts/render-comment.mjs";
import { buildBlueprint, buildPreviewUrl } from "../scripts/build-preview.mjs";

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
  // The "if it does not say <sha> you are not looking at this code" line was
  // dropped deliberately: the review course heading shows the same SHA on
  // screen, so the cross-check survives without a second copy in the comment.
  assert.match(body, /from commit `8b217b1`/);
});

test("it gives the password and points at the roster, without enumerating it", () => {
  const body = renderComment(ok);
  assert.match(body, /logs you in as \*\*`admin`\*\*/);
  // The password sits at a line break, so match the token not the sentence.
  assert.match(body, /\*\*`password`\*\*/);
  assert.match(body, /review brief on the course/);
  // It used to say "`admin`, `teacher` and `student1` all exist". That is FALSE
  // when the preview has no teacher and INCOMPLETE when it has two, and this
  // comment has no access to the counts — keeping it correct would mean a
  // second contract carrying the roster. The brief on the course page is built
  // from the blueprint itself, so it cannot disagree with what was created.
  assert.equal(body.includes("`admin`, `teacher` and"), false);
  assert.equal(body.includes("all exist"), false);
});

test("arriving as admin carries the caveat that admin is not a teacher", () => {
  // This paragraph used to exist ONLY for `teacher` and simply vanished for
  // admin — the one case where it matters, and now a reachable one, because
  // teachers: 0 signs the reviewer in as admin by design.
  const body = renderComment({ ...ok, user: "admin" });
  assert.match(body, /You are an administrator here/);
  assert.match(body, /not enrolled/);
  const asTeacher = renderComment({ ...ok, user: "teacher" });
  assert.match(asTeacher, /Deliberately not admin/);
  assert.equal(asTeacher.includes("You are an administrator here"), false);
});

test("it warns that absence is quiet and names the proxy as the cause", () => {
  // A failed download still boots a working Moodle — the reviewer needs to
  // know that before concluding the plugin does nothing.
  const body = renderComment(ok);
  assert.match(body, /If the plugin seems missing, open the Logs panel/);
  assert.match(body, /third-party CORS proxy/);
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
  assert.match(body, /logs you in as \*\*`teacher`\*\*/);
  // And explains why, because "why am I not admin?" is the first question.
  assert.match(body, /Deliberately not admin/);
});

test("an admin landing does not carry the not-admin explanation", () => {
  const body = renderComment({ url: URL, plugin: "local_myplugin", headSha: SHA, user: "admin" });
  assert.match(body, /logs you in as \*\*`admin`\*\*/);
  assert.doesNotMatch(body, /Deliberately not admin/);
});

test("a malformed username is refused rather than rendered", () => {
  assert.throws(
    () => renderComment({ url: URL, plugin: "mod_attendance", headSha: SHA, user: "a`b</script>" }),
    /bad user/,
  );
});

// THE SEAM THAT BROKE. Every test above hands renderComment a hand-written
// URL, so none of them noticed that its validator required the blueprint
// param to follow the HOST directly. The moment the default host gained a
// path (daviducl.github.io/moodle-playground) every CI run failed with
// "malformed preview URL" while the whole local gate stayed green.
// Compose the real thing instead of describing it.
test("a link built with the ACTION'S OWN DEFAULT host can be posted", async () => {
  const yaml = await import("node:fs").then((fs) =>
    fs.readFileSync(new global.URL("../preview/action.yml", import.meta.url), "utf8"));
  const host = /default: "(https:\/\/[^"]+)"/.exec(yaml)[1];
  const bp = buildBlueprint({
    headRepo: "DavidUCL/moodle-mod_attendance",
    headSha: SHA,
    prNumber: "1",
    type: "mod",
    name: "attendance",
  });
  const built = buildPreviewUrl({ playgroundHost: host, blueprint: bp });
  const body = renderComment({ url: built, plugin: "mod_attendance", headSha: SHA, user: "teacher" });
  assert.ok(body.includes(built), "the built link must survive into the comment");
});

test("it refuses a link on an origin outside the allowlist", () => {
  assert.throws(
    () => renderComment({ url: "https://evil.tld/p?blueprint=abc", plugin: "mod_x", headSha: SHA }),
    /malformed preview URL/,
  );
});

test("it refuses a link carrying anything besides the blueprint", () => {
  assert.throws(
    () => renderComment({
      url: "https://daviducl.github.io/moodle-playground?blueprint=abc&repo=evil%2Fx",
      plugin: "mod_x", headSha: SHA,
    }),
    /malformed preview URL/,
  );
});

test("it refuses userinfo that makes the host read as the playground", () => {
  assert.throws(
    () => renderComment({
      url: "https://daviducl.github.io@evil.tld/x?blueprint=abc",
      plugin: "mod_x", headSha: SHA,
    }),
    /malformed preview URL/,
  );
});

// A reviewer looking at a site that was rewritten after the install has no way
// to tell from the screen. These steps are allowed — they are reported.
test("the comment says so when the blueprint modifies Moodle itself", () => {
  const body = renderComment({ ...ok, riskySteps: ["runPhpCode", "writeFile"] });
  assert.match(body, /modifies Moodle itself/);
  assert.match(body, /`runPhpCode`, `writeFile`/);
});

test("an ordinary preview carries no such warning", () => {
  assert.doesNotMatch(renderComment(ok), /modifies Moodle itself/);
});

test("the comment's administrator caveat follows the role, not the name", async () => {
  const { renderComment } = await import("../scripts/render-comment.mjs");
  const body = (opts) =>
    renderComment({
      url: "https://daviducl.github.io/moodle-playground?blueprint=x",
      plugin: "mod_attendance", headSha: "a".repeat(40),
      runUrl: "https://github.com/o/r/actions/runs/1", ...opts,
    });
  // An administrator bypasses the capability checks a plugin relies on and is
  // not enrolled — the one caveat the comment exists to carry. A preview that
  // restores a database signs in as that snapshot's administrator, which Moodle
  // does not require to be called `admin`, and this simply disappeared.
  assert.match(body({ user: "siteadmin", isAdmin: true }), /You are an administrator here/);
  assert.ok(!/You are an administrator here/.test(body({ user: "siteadmin" })),
    "with nothing said, a non-admin name is not an administrator");
  // The default reads the name, so every caller that predates the flag is
  // unchanged.
  assert.match(body({ user: "admin" }), /You are an administrator here/);
  assert.ok(!/You are an administrator here/.test(body({ user: "teacher" })));
  // ...and an explicit false wins over a name that says otherwise.
  assert.ok(!/You are an administrator here/.test(body({ user: "admin", isAdmin: false })));
});
