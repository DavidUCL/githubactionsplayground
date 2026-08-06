// Render the pull-request comment body.
//
// This lives in the action, not in the workflow a consumer copies, because it
// is the one piece that would otherwise fork once per adopting repo: a wording
// fix or a safety correction could never reach a repo that copied last year's
// version. The consumer supplies facts; we own the prose.
//
// Everything interpolated here is a validated scalar from the builder's own
// outputs or a GitHub-generated field. Nothing derived from a branch name, PR
// title or commit message — all of which the PR author controls — is used.

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { DEFAULT_ORIGINS } from "./build-preview.mjs";

const MARKER = "<!-- moodle-playground-preview -->";
const SHA_RE = /^[0-9a-f]{40}$/;
const COMPONENT_RE = /^[a-z][a-z0-9_]*$/;
const USER_RE = /^[a-z][a-z0-9_]*$/;
const BLUEPRINT_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Last gate before a link is posted under the bot's name.
 *
 * Was a single regex that assumed the blueprint param followed the HOST
 * directly. That silently forbade any playground served from a subpath — so
 * pointing the default at `daviducl.github.io/moodle-playground` made every
 * run fail with "malformed preview URL". Parse it instead of matching it: the
 * structure is what matters, and a parser cannot be fooled by a shape nobody
 * anticipated.
 */
function isPostablePreviewUrl(value, allowedOrigins) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  // `https://good.example@evil.tld/` reads as the playground and is not.
  if (url.username || url.password) return false;
  if (url.hash) return false;
  if (!allowedOrigins.includes(url.origin)) return false;
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 1 || keys[0] !== "blueprint") return false;
  return BLUEPRINT_RE.test(url.searchParams.get("blueprint") || "");
}

/** @returns {string} markdown for the sticky comment */
export function renderComment({ url, plugin, headSha, runUrl, user = "admin", allowedOrigins = DEFAULT_ORIGINS }) {
  const short = String(headSha).slice(0, 7);
  if (!SHA_RE.test(String(headSha))) throw new Error(`bad head sha: ${headSha}`);
  if (!COMPONENT_RE.test(String(plugin))) throw new Error(`bad plugin: ${plugin}`);
  if (!USER_RE.test(String(user))) throw new Error(`bad user: ${user}`);

  // No link means the build failed. Say so plainly rather than leaving an
  // older commit's link sitting there looking current.
  if (!url) {
    return [
      MARKER,
      `### Playground preview unavailable for \`${short}\``,
      "",
      `The preview link could not be built for this commit${runUrl ? ` — see the [workflow run](${runUrl})` : ""}.`,
    ].join("\n");
  }
  if (!isPostablePreviewUrl(url, allowedOrigins)) {
    throw new Error(`refusing to post a malformed preview URL`);
  }

  return [
    MARKER,
    `### ▶ [Open this pull request in Moodle Playground](${url})`,
    "",
    `Boots a throwaway Moodle **in your browser tab**, with \`${plugin}\` built`,
    `from commit \`${short}\`. Nothing is deployed and nothing is installed on`,
    "your machine — but it **runs this pull request's PHP in your browser**, so",
    "treat it like checking the branch out.",
    "",
    `You arrive already signed in as **\`${user}\`**. \`admin\`, \`teacher\` and`,
    "`student1` all exist, password **`password`**, so you can switch to check",
    "a different role.",
    ...(user === "teacher"
      ? [
          "",
          "**Deliberately not admin.** A site admin passes every capability",
          "check regardless of what the code says, so a permissions fix would",
          "look identical whether or not it worked.",
        ]
      : []),
    "",
    "<details><summary>First open, and what to do if the plugin isn't there</summary>",
    "",
    "- First open downloads about 45 MB and takes 30–90 seconds, and keeps",
    "  roughly 120 MB in browser storage afterwards. Opening it again in a new",
    "  tab re-boots but reuses the download. Chromium or Edge recommended.",
    `- The course heading names this PR and commit. **If it does not say`,
    `  \`${short}\`, you are not looking at this code.**`,
    "- Yellow debug boxes are deliberate — debugging is set to DEVELOPER so",
    "  deprecation notices show. They are not crashes.",
    "- **If the plugin seems missing, open the Logs panel.** The plugin",
    "  download goes through a third-party CORS proxy; when it fails you get a",
    "  Moodle without your plugin. Reload to retry.",
    "",
    "</details>",
    "",
    "Smoke test only: it shows whether the plugin installs and renders, not",
    "whether it is correct. This comment is rewritten in place on every push.",
  ].join("\n");
}

function main() {
  const body = renderComment({
    url: process.env.PREVIEW_URL || "",
    plugin: process.env.PLUGIN || "",
    headSha: process.env.HEAD_SHA || "",
    runUrl: process.env.RUN_URL || "",
    user: process.env.PREVIEW_USER || "admin",
  });
  if (process.env.GITHUB_OUTPUT) {
    // Multi-line outputs need a delimiter that cannot appear in the body.
    const delim = `EOF_${process.env.HEAD_SHA.slice(0, 12)}`;
    appendFileSync(process.env.GITHUB_OUTPUT, `comment-body<<${delim}\n${body}\n${delim}\n`);
  } else {
    process.stdout.write(body + "\n");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
