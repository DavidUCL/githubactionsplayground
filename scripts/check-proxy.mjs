#!/usr/bin/env node
// Is the plugin download proxy alive? A separate check from the gate.
//
// The playground downloads every github.com plugin ZIP through a proxy, because
// github.com does not let a web page read its ZIPs directly. The gate's plugin
// install checks are being moved to a ZIP served locally, which no longer
// touches the proxy, so on its own that would delete the only signal that a
// real runtime dependency of every preview has gone away. This keeps it, as its
// own line in the nightly canary.
//
// Asks the proxy for a small public plugin ZIP, exactly as the playground does
// (`<proxy>?url=<zip>`), and checks what a browser would need: HTTP 200, a CORS
// header that lets a page read it, and a body that is really a ZIP.
//
// Env: PROXY_URL (default the playground's current proxy; point it at UCL's
// proxy once CTP-6878 is live), TEST_ZIP_URL, GITHUB_STEP_SUMMARY (optional).

import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const DEFAULT_PROXY_URL = "https://github-proxy.exelearning.dev/";
// The origin the request claims, as the playground page would send it.
export const PAGE_ORIGIN = "https://daviducl.github.io";
// A public plugin at a fixed commit, so the bytes never change under the check.
export const DEFAULT_TEST_ZIP_URL =
  "https://github.com/danmarsden/moodle-mod_attendance/archive/8b217b1807bc0d33b3ac3b50ba516a7aaa7f367c.zip";

/** The URL the playground would fetch for `zipUrl` through `proxyUrl`. */
export function proxiedUrl(proxyUrl, zipUrl) {
  const u = new URL(proxyUrl);
  u.searchParams.set("url", zipUrl);
  return u.toString();
}

/**
 * Judge a proxy response the way a browser page would experience it.
 * @returns {string[]} problems; empty means a page could download the ZIP.
 */
export function judgeProxyResponse({ status, allowOrigin, firstBytes, origin = PAGE_ORIGIN }) {
  const problems = [];
  if (status !== 200) problems.push(`HTTP ${status}, not 200`);
  if (allowOrigin !== "*" && allowOrigin !== origin) {
    problems.push(`Access-Control-Allow-Origin is ${JSON.stringify(allowOrigin)}, so a page on ${origin} cannot read it`);
  }
  const zip = firstBytes && firstBytes.length >= 4 && firstBytes[0] === 0x50 && firstBytes[1] === 0x4b &&
    firstBytes[2] === 0x03 && firstBytes[3] === 0x04;
  if (status === 200 && !zip) problems.push("the body is not a ZIP");
  return problems;
}

async function main() {
  const proxy = process.env.PROXY_URL || DEFAULT_PROXY_URL;
  const zipUrl = process.env.TEST_ZIP_URL || DEFAULT_TEST_ZIP_URL;
  const url = proxiedUrl(proxy, zipUrl);
  let problems;
  try {
    const res = await fetch(url, {
      headers: { origin: PAGE_ORIGIN },
      signal: AbortSignal.timeout(60000),
    });
    const body = new Uint8Array(await res.arrayBuffer());
    problems = judgeProxyResponse({
      status: res.status,
      allowOrigin: res.headers.get("access-control-allow-origin"),
      firstBytes: body.slice(0, 4),
    });
  } catch (err) {
    problems = [`the request failed: ${err.message}`];
  }
  const lines = [
    "## Plugin download proxy",
    "",
    `Proxy: ${proxy}`,
    `Fetched: ${zipUrl}`,
    "",
    problems.length ? `**FAIL**\n\n${problems.map((p) => `- ${p}`).join("\n")}` : "**PASS**: a page could download the plugin ZIP through it.",
  ];
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  process.exit(problems.length ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.log(`::error title=proxy::the check did not run — ${err.message}`);
    process.exit(2);
  });
}
