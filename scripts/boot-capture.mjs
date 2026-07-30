// Boot the playground with ?blueprint-url=<url> under headless chromium and
// capture (a) every #log-panel line via a MutationObserver — the panel
// prunes at 500 entries, so a final snapshot is NOT sufficient — and
// (b) every console message. Writes boot-log.txt, console.txt, meta.json
// and final.png into OUT_DIR.
//
// This script produces EVIDENCE, not a verdict: it exits 0 whenever it
// managed to write meta.json (even for nav failures / timeouts) and
// assert.mjs turns the evidence into verdict.json. Non-zero exit means the
// harness itself crashed.

import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The meta contract with assert.mjs, exported so a test can pin it: the
// offline gate runs on hand-authored fixtures, so a renamed field here would
// otherwise leave every offline check green while real runs fail.
export const INITIAL_META = () => ({
  playground_host: "",
  target_url: "",
  loopback_sha256: "",
  loopback_served: 0,
  navigations: 0,
  browser_launched: false,
  nav_ok: false,
  page_crashed: false,
  final_url: "",
  logs_panel_found: false,
  anchor_seen: false,
  timed_out: false,
  duration_ms: 0,
});

/**
 * One captured console message must occupy exactly one line: assert.mjs
 * anchors the resolver checks to the `[console:<type>] ` prefix, so a message
 * carrying a literal newline plus its own fake prefix could forge a line.
 */
export function oneLine(s) {
  return String(s).replace(/\r?\n/g, "\\n");
}

/**
 * Called on every main-frame navigation. Resetting the served counter is the
 * point: the shell can reload (e.g. to let its service worker take control),
 * and a cumulative count would let load 1's interception vouch for load 2's
 * network fetch — the very hole mandatory loopback exists to close.
 */
export function noteMainFrameNavigation(meta) {
  meta.navigations += 1;
  meta.loopback_served = 0;
  return meta;
}

// Lines that can still change the verdict; quiescence is measured from the
// last of these, not from any log line at all. Must cover every anchor
// assert.mjs parses — pinned by a test.
export const RELEVANT_LINE_RE =
  /Blueprint step|Boot timing summary|Plugin upgrade|Extracting plugin|Downloading plugin|Blueprint (?:failed|execution error)/;

const NAV_TIMEOUT_MS = 60_000;
const PANEL_TIMEOUT_MS = 90_000;
const QUIET_MS = 15_000; // stop after boot anchor + this much log silence
const POLL_MS = 1_000;

async function main() {
  const host = (process.env.PLAYGROUND_HOST || "https://moodle-playground.com").replace(/\/$/, "");
  const blueprintUrl = process.env.BLUEPRINT_URL;
  const timeoutMs = 1000 * Number(process.env.TIMEOUT_SECONDS || 420);
  const outDir = process.env.OUT_DIR || "boot-verify-out";
  mkdirSync(outDir, { recursive: true });
  if (process.env.SETUP_FAILED_FILE && existsSync(process.env.SETUP_FAILED_FILE)) {
    console.error("setup failed earlier — skipping boot");
    return;
  }
  // Only preflight's own outcome file may short-circuit the boot — never a
  // verdict.json, which a PR could commit into the workspace.
  let preflight;
  try {
    preflight = JSON.parse(readFileSync(join(outDir, "preflight.json"), "utf8"));
  } catch {
    console.error("preflight.json missing — preflight did not run");
    return;
  }
  if (preflight.outcome !== "ok") {
    console.log(`preflight rejected (${preflight.error_class}) — skipping boot`);
    return;
  }

  // Expectations (and therefore the gated hash) are written by preflight;
  // without them there is nothing to bind the boot to.
  let expectedSha = "";
  try {
    expectedSha = JSON.parse(
      readFileSync(join(outDir, "expectations.json"), "utf8"),
    ).blueprintSha256 || "";
  } catch {
    console.error("expectations.json missing — preflight did not complete");
    return;
  }

  const meta = {
    ...INITIAL_META(),
    playground_host: host,
    target_url: `${host}/?blueprint-url=${encodeURIComponent(blueprintUrl)}`,
  };
  const bootLogPath = join(outDir, "boot-log.txt");
  const consolePath = join(outDir, "console.txt");
  writeFileSync(bootLogPath, "");
  writeFileSync(consolePath, "");
  const finish = (page) => writeMetaAndScreenshot(page, meta, outDir);

  if (!blueprintUrl) {
    await finish(null);
    return;
  }

  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch (err) {
    console.error(`playwright unavailable: ${err.message}`);
    await finish(null);
    return;
  }

  const started = Date.now();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    console.error(`browser launch failed: ${err.message}`);
    await finish(null);
    return;
  }
  meta.browser_launched = true;

  let page;
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();

    // Loopback serving (design §4) — MANDATORY, not an option. The browser
    // must boot the exact bytes preflight gated and hashed; letting chromium
    // re-fetch the URL leaves a TOCTOU window in which a mutable ref (a
    // branch) is swapped between gate and boot, so the gate would certify
    // bytes that never booted. The file is written by preflight
    // and its hash is re-checked here, so no env var can point elsewhere.
    const body = readFileSync(join(outDir, "blueprint.json"));
    const actualSha = createHash("sha256").update(body).digest("hex");
    if (expectedSha && actualSha !== expectedSha) {
      throw new Error(
        `gated blueprint hash mismatch: expected ${expectedSha}, got ${actualSha}`,
      );
    }
    meta.loopback_sha256 = actualSha;
    // Comparing two hashes of the same local file proves nothing;
    // what matters is whether the interception actually FIRED. Count it, and
    // match on the URL ignoring query/fragment so a cache-buster can't slip
    // the request past the route and out to the network.
    const blueprintNoQuery = blueprintUrl.split(/[?#]/)[0];
    // Routed on the CONTEXT rather than the page. Be precise about what this
    // does and does not buy: Playwright documents that NEITHER
    // page.route NOR context.route intercepts a fetch made BY a service
    // worker, and this shell has one. `serviceWorkers: "block"` was tried and
    // rejected — the playground needs its worker to serve PHP, so the boot
    // never completes (measured: 420s, no boot anchor).
    //
    // The binding therefore fails CLOSED rather than being airtight: if the
    // worker ever serves this fetch, loopback_served stays 0 and the verdict
    // is infra_fail, never a pass on ungated bytes. That interception does
    // fire today is proven by the gate's own live check, whose blueprint URL
    // 404s on the public network — it can only boot from our served bytes.
    await context.route(
      (url) => url.href.split(/[?#]/)[0] === blueprintNoQuery,
      (route) => {
        meta.loopback_served += 1;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "access-control-allow-origin": "*" },
          body,
        });
      },
    );
    // A cumulative counter would let load 1's interception vouch for load 2's
    // network fetch, so it resets whenever the main frame navigates: the
    // binding must hold for the navigation that actually booted.
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) noteMainFrameNavigation(meta);
    });
    page.on("crash", () => {
      meta.page_crashed = true;
    });
    // One console message must occupy exactly one line: assert.mjs anchors
    // the resolver checks to this `[console:<type>] ` prefix, so a message
    // containing a literal newline plus its own prefix could otherwise forge
    // a whole line. Escape newlines instead of writing them.
    page.on("console", (msg) => {
      appendFileSync(consolePath, `[console:${msg.type()}] ${oneLine(msg.text())}\n`);
    });
    page.on("pageerror", (err) => {
      appendFileSync(consolePath, `[pageerror] ${oneLine(err.message)}\n`);
    });

    try {
      await page.goto(meta.target_url, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT_MS,
      });
      meta.nav_ok = true;
    } catch (err) {
      console.error(`navigation failed: ${err.message}`);
      await finish(page);
      return;
    }

    try {
      await page.waitForSelector("#log-panel", { timeout: PANEL_TIMEOUT_MS, state: "attached" });
      meta.logs_panel_found = true;
    } catch {
      console.error("#log-panel never appeared");
      await finish(page);
      return;
    }

    // Observe every appended log span so pruning can't lose evidence.
    await page.evaluate(() => {
      const panel = document.querySelector("#log-panel");
      window.__bootCapture = [];
      for (const el of panel.children) window.__bootCapture.push(el.textContent);
      new MutationObserver((muts) => {
        for (const m of muts) {
          for (const n of m.addedNodes) window.__bootCapture.push(n.textContent);
        }
      }).observe(panel, { childList: true });
    });

    // Quiescence is measured from the last line that could still change the
    // verdict, NOT from any line at all: the page keeps logging service
    // worker traffic indefinitely, which would otherwise hold the loop open
    // until the wall clock and throw away a complete log.
    let lastRelevantAt = Date.now();
    let anchorSeen = false;
    while (Date.now() - started < timeoutMs) {
      let drained;
      try {
        drained = await page.evaluate(() => window.__bootCapture.splice(0));
      } catch (err) {
        // Renderer gone (OOM/crash): keep what we have, classify as infra.
        meta.page_crashed = true;
        appendFileSync(consolePath, `[harness] capture interrupted: ${err.message}\n`);
        break;
      }
      if (drained.length) {
        appendFileSync(bootLogPath, drained.join(""));
        if (drained.some((l) => RELEVANT_LINE_RE.test(l))) lastRelevantAt = Date.now();
        if (!anchorSeen && drained.some((l) => l.includes("Boot timing summary"))) {
          anchorSeen = true;
          meta.anchor_seen = true;
        }
      }
      if (anchorSeen && Date.now() - lastRelevantAt >= QUIET_MS) break;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    if (Date.now() - started >= timeoutMs) meta.timed_out = true;

    // Final drain in case the loop exited between mutations.
    const rest = await page.evaluate(() => window.__bootCapture.splice(0)).catch(() => []);
    if (rest.length) appendFileSync(bootLogPath, rest.join(""));

    try {
      meta.final_url = page.url();
    } catch {
      /* crashed page: leave whatever we recorded */
    }
    meta.duration_ms = Date.now() - started;
    await finish(page);
  } catch (err) {
    // Any unexpected harness error still has to leave evidence behind: this
    // action promises a verdict, so a throw here must become infra_fail via
    // meta.json rather than a red job with nothing in it.
    console.error(`capture error: ${err.message}`);
    meta.page_crashed = true;
    await finish(page ?? null);
  } finally {
    await browser.close().catch(() => {});
  }
}

async function writeMetaAndScreenshot(page, meta, outDir) {
  if (page) {
    meta.final_url = meta.final_url || page.url();
    try {
      await page.screenshot({ path: join(outDir, "final.png"), fullPage: false });
    } catch {
      /* screenshot is best-effort */
    }
  }
  writeFileSync(join(outDir, "meta.json"), JSON.stringify(meta, null, 2));
  console.log(
    `capture done: nav=${meta.nav_ok} panel=${meta.logs_panel_found} ` +
    `anchor=${meta.anchor_seen} timeout=${meta.timed_out} ${meta.duration_ms}ms`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
