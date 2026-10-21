import { test } from "node:test";
import assert from "node:assert/strict";
import { checkBranchOnHost } from "../scripts/host-branch.mjs";
import { buildWarningBannerStep, bannerHtml, escapeHtml } from "../scripts/warning-banner.mjs";

const HOST = "https://h.example.org/moodle-playground";
const respond = (status, body = "") => async (url) => {
  respond.lastUrl = url;
  return { ok: status >= 200 && status < 300, status, text: async () => body };
};

test("a version the playground has: exists, with its release", async () => {
  const v = await checkBranchOnHost(HOST, "MOODLE_501_STABLE", {
    fetchImpl: respond(200, JSON.stringify({ channel: "MOODLE_501_STABLE", release: "5.1.6+" })),
  });
  assert.deepEqual(v, { exists: true, release: "5.1.6+" });
  assert.equal(respond.lastUrl, `${HOST}/assets/manifests/MOODLE_501_STABLE.json`);
});

test("a typo the playground does not have: a definite no, naming the version", async () => {
  const v = await checkBranchOnHost(HOST, "MOODLE_50_STABLE", { fetchImpl: respond(404) });
  assert.equal(v.exists, false);
  assert.match(v.reason, /has no Moodle "MOODLE_50_STABLE"/);
});

test("a name that could not be a version is refused without a request", async () => {
  let asked = false;
  const v = await checkBranchOnHost(HOST, "../../etc", { fetchImpl: async () => { asked = true; } });
  assert.equal(v.exists, false);
  assert.equal(asked, false);
});

test("an unreadable host is unknown, never a refusal", async () => {
  assert.match((await checkBranchOnHost(HOST, "MOODLE_500_STABLE", { fetchImpl: respond(503) })).unknown, /HTTP 503/);
  const down = async () => { throw new Error("network down"); };
  assert.match((await checkBranchOnHost(HOST, "MOODLE_500_STABLE", { fetchImpl: down })).unknown, /network down/);
  // A 200 that is not this version's manifest (a host serving an HTML page for
  // every path) proves nothing either way.
  assert.match(
    (await checkBranchOnHost(HOST, "MOODLE_500_STABLE", { fetchImpl: respond(200, "<html>") })).unknown,
    /not JSON/,
  );
  assert.match(
    (await checkBranchOnHost(HOST, "MOODLE_500_STABLE", { fetchImpl: respond(200, '{"channel":"main"}') })).unknown,
    /does not describe/,
  );
});

test("the banner escapes every message and decodes to exactly that HTML", () => {
  const msg = `Moodle "x" <script>alert(1)</script> & 'y'`;
  assert.equal(escapeHtml(msg), "Moodle &quot;x&quot; &lt;script&gt;alert(1)&lt;/script&gt; &amp; &#39;y&#39;");
  const step = buildWarningBannerStep([msg]);
  assert.equal(step.step, "runPhpCode");
  assert.equal(step.critical, undefined, "a banner that fails must not stop the preview");
  const b64 = /base64_decode\('([A-Za-z0-9+/=]+)'\)/.exec(step.code)[1];
  const html = Buffer.from(b64, "base64").toString("utf8");
  assert.equal(html, bannerHtml([msg]));
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /position:fixed;left:0;right:0;bottom:0/);
  assert.match(step.code, /set_config\('additionalhtmltopofbody'/);
});

test("no messages, no banner step", () => {
  assert.equal(buildWarningBannerStep([]), null);
  assert.equal(buildWarningBannerStep(["", "  "]), null);
});
