// Build a preview link from a blueprint someone else wrote.
//
// The sibling of build-preview.mjs, for the case where the blueprint is given
// rather than constructed. It fetches, gates and INLINES it — it never emits a
// `?blueprint-url=` link, because that path is fetched by a bare `fetch()`
// whose catch falls through to the playground's own starter blueprint: a 429,
// CDN skew, a private repo or schema drift all end as a clean vanilla Moodle
// with no error, which is the failure this project keeps closing.
//
// WHAT THIS CANNOT DO, and says so. There is no commit under review, so
// `requireSelfUrl` does not apply and the review course carries whatever name
// the blueprint chose. A link from here proves nothing was gated out; it does
// not prove anything booted. Only the verify half boots.

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { fetchBlueprint, gateBlueprint } from "./preflight.mjs";
import {
  buildPreviewUrl,
  DEFAULT_DATA_HOSTS,
  DEFAULT_ORIGINS,
  setOutput,
} from "./build-preview.mjs";
import { sanitiseForLog } from "./sanitise.mjs";

const DEFAULT_BLUEPRINT_HOSTS = ["raw.githubusercontent.com"];

function writeSummary(lines) {
  const body = lines.join("\n") + "\n";
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, body);
  else process.stdout.write(body);
}

const csv = (v, fallback) => {
  const out = String(v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return out.length ? out : fallback;
};

async function main() {
  const blueprintUrl = process.env.BLUEPRINT_URL || "";
  const playgroundHost =
    process.env.PLAYGROUND_HOST || "https://daviducl.github.io/moodle-playground";
  const blueprintHosts = csv(process.env.BLUEPRINT_HOSTS, DEFAULT_BLUEPRINT_HOSTS);
  const dataHosts = csv(process.env.DATA_HOSTS, DEFAULT_DATA_HOSTS);
  if (!blueprintUrl) throw new Error("blueprint-url is required");

  // Host-allowlisted before AND after redirects, and size-capped — the shared
  // helper, so this cannot drift from the verify half's behaviour.
  const { bytes, finalUrl } = await fetchBlueprint(blueprintUrl, blueprintHosts);
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  let blueprint;
  try {
    blueprint = JSON.parse(bytes.toString("utf8"));
  } catch (err) {
    throw new Error(`blueprint is not valid JSON: ${err.message}`);
  }

  // The same gate the verify half runs: unknown step names, placeholder
  // syntax, off-allowlist URLs, duplicate install targets, raw-HTML configs.
  // requireSelfUrl is deliberately NOT passed — there is no commit under
  // review here, and claiming otherwise would be the lie this exists to avoid.
  const { stepErrors, urlErrors, unsafeStrings, bindErrors, riskySteps } = gateBlueprint(
    blueprint,
    dataHosts,
  );
  const problems = [...stepErrors, ...unsafeStrings, ...urlErrors, ...bindErrors];
  if (problems.length) {
    throw new Error(`blueprint refused by the gate:\n  - ${problems.join("\n  - ")}`);
  }

  const url = buildPreviewUrl({
    playgroundHost,
    blueprint,
    allowedOrigins: DEFAULT_ORIGINS,
    dataHosts,
  });
  setOutput("preview-url", url);
  setOutput("blueprint-sha256", sha256);
  setOutput("risky-steps", (riskySteps || []).join(","));

  const steps = Array.isArray(blueprint.steps) ? blueprint.steps : [];
  writeSummary([
    "## ▶ Playground preview — from a supplied blueprint",
    "",
    `### [Open this blueprint](${url})`,
    "",
    "| | |",
    "|---|---|",
    `| blueprint | \`${sanitiseForLog(finalUrl)}\` |`,
    `| sha256 | \`${sha256}\` |`,
    `| steps | ${steps.length} |`,
    `| link size | ${url.length} chars |`,
    "",
    ...((riskySteps || []).length
      ? [
          `> **This blueprint can rewrite Moodle after installing:** ${riskySteps
            .map((r) => `\`${r}\``)
            .join(", ")}.`,
          "",
        ]
      : []),
    "**Nothing was booted.** This link was built and gated, not run — the",
    "blueprint is someone else's and there is no commit under review, so the",
    "review course carries whatever name the blueprint chose. To find out",
    "whether it actually boots, run the boot-verify workflow against the same",
    "URL.",
  ]);
  console.log(`blueprint preview: ${steps.length} steps, ${url.length} chars`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (err) {
    writeSummary([
      "## 🚫 No preview link for this blueprint",
      "",
      `**${sanitiseForLog(err?.message ?? String(err))}**`,
      "",
      "No link was built. A blueprint the gate refuses would have booted",
      "something other than it claims, or something the playground cannot run.",
    ]);
    console.error(err?.stack ?? String(err));
    process.exit(1);
  }
}
