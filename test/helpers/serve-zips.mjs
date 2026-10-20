// Serve plugin ZIPs to a LIVE boot from local files, instead of through the
// playground's download proxy.
//
// WHY. The playground fetches every github.com plugin ZIP through
// github-proxy.exelearning.dev, and the browser on a GitHub runner cannot reach
// it. So the gate's plugin-install arms (checks 7 and 12) never passed on CI:
// they waived as a "proxy outage" on every run, and the action's central job,
// installing the plugin under review, was proved on one laptop only.
//
// HOW. Loaded with `node --import` by verify.sh only, never by the action:
// it wraps Playwright's chromium.launch so every browser context gets a route
// on the proxy host. A proxied request whose `?url=` is in the map is answered
// from the local file, after checking its sha256; anything else falls through.
// Measured on Playwright 1.61.1 (spike, 2026-10-20): the route does see this
// request, which the playground's service worker makes; with the real proxy
// unreachable both the service worker's request and the PHP worker's finished
// 200, and serving random bytes instead left the plugin uninstalled.
//
// Kept out of scripts/ on purpose. Check 1c requires every env var the
// action's scripts read to be declared in action.yml, so that nothing the
// action runs can be steered by the environment alone. This file is not part
// of the action.
//
// Env:
//   BV_SERVE_ZIPS        JSON file: { "<zip url>": { "file": "<path>", "sha256": "<hex>" } }
//   BV_SERVED_COUNT_FILE a line is appended here for every ZIP served (the
//                        caller requires at least one, so an interception that
//                        never fires fails instead of passing)
//   BV_BLOCK_PROXY=1     make the real proxy host unreachable, so a request this
//                        does not answer fails instead of reaching the network
//   BV_PROXY_HOST        defaults to github-proxy.exelearning.dev

import { readFileSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import pw from "playwright";

const PROXY_HOST = process.env.BV_PROXY_HOST || "github-proxy.exelearning.dev";
const map = process.env.BV_SERVE_ZIPS ? JSON.parse(readFileSync(process.env.BV_SERVE_ZIPS, "utf8")) : {};
const block = process.env.BV_BLOCK_PROXY === "1";

// Read and verify every file up front: a wrong file must stop the run, not be
// served and then explained away.
const bodies = new Map();
for (const [url, { file, sha256 }] of Object.entries(map)) {
  const body = readFileSync(file);
  const got = createHash("sha256").update(body).digest("hex");
  if (got !== sha256) throw new Error(`serve-zips: ${file} has sha256 ${got}, expected ${sha256}`);
  bodies.set(url, body);
}

const launch = pw.chromium.launch.bind(pw.chromium);
pw.chromium.launch = async (options = {}) => {
  const args = [...(options.args || [])];
  if (block) args.push(`--host-resolver-rules=MAP ${PROXY_HOST} 127.0.0.1:9`);
  const browser = await launch({ ...options, args });
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (contextOptions) => {
    const context = await newContext(contextOptions);
    await context.route(
      (u) => u.hostname === PROXY_HOST,
      (route) => {
        const inner = new URL(route.request().url()).searchParams.get("url");
        const body = inner && bodies.get(inner);
        if (!body) return route.fallback();
        if (process.env.BV_SERVED_COUNT_FILE) appendFileSync(process.env.BV_SERVED_COUNT_FILE, `${inner}\n`);
        return route.fulfill({
          status: 200,
          contentType: "application/zip",
          headers: { "access-control-allow-origin": "*" },
          body,
        });
      },
    );
    return context;
  };
  return browser;
};
