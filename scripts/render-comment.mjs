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
export function renderComment({
  url, plugin, headSha, runUrl, user = "admin",
  // WHETHER that account is an administrator, which the name no longer settles:
  // under a restored database the administrator comes from the snapshot and may
  // be called anything. Defaulted from the name so an older caller — and every
  // preview that restores nothing — behaves exactly as before.
  isAdmin = user === "admin",
  allowedOrigins = DEFAULT_ORIGINS, riskySteps = [],
}) {
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
    `from commit \`${short}\`.`,
    "",
    // The accounts are NOT enumerated here. This comment used to say "admin,
    // teacher and student1 all exist", which is false when the preview has no
    // teacher and incomplete when it has two — and keeping it correct would
    // mean threading the roster through a second contract. The review brief on
    // the course page lists what actually exists, and is built from the
    // blueprint itself, so point at it instead of duplicating it.
    `The link logs you in as **\`${user}\`**. The review brief on the course`,
    "page lists every account the preview created; the password is",
    "**`password`**, so you can switch to check a different role.",
    ...(user === "teacher"
      ? [
          "",
          "**Deliberately not admin.**",
        ]
      : []),
    // The admin arm. Without it this paragraph simply VANISHED whenever the
    // reviewer arrived as admin — the one case where the caveat matters, since
    // an administrator passes capability checks a plugin's own code relies on
    // and is not enrolled, so completion never evaluates for them.
    ...(isAdmin
      ? [
          "",
          "**You are an administrator here.** Admin bypasses the capability",
          "checks a plugin relies on and is not enrolled in the course, so some",
          "behaviour differs from a real teacher's.",
        ]
      : []),
    "",
    // Kept deliberately, against the instinct to trim. A failed plugin
    // download still boots a clean, working Moodle, and the log panel is
    // `is-hidden` by default — so without this the reviewer sees a normal
    // site, concludes the plugin does nothing, and never clicks again.
    "**If the plugin seems missing, open the Logs panel.** The download goes",
    "through a third-party CORS proxy; when it fails you get a Moodle without",
    "your plugin. Reload to retry.",
    "",
    // The sentence that stops a green tick plus a working site reading as an
    // endorsement. A test asserts this body never says verified / passed /
    // works correctly / safe to merge.
    // Only when present. A reviewer looking at a site that was rewritten after
    // the install should be told, because nothing on screen reveals it.
    ...(riskySteps.length
      ? [
          `**This preview modifies Moodle itself** (\`${riskySteps.join("`, `")}\`), so`,
          "what you see may not be the plugin alone.",
          "",
        ]
      : []),
    "Smoke test only: it shows whether the plugin installs and renders, not",
    "whether it is correct. Rewritten in place on every push.",
  ].join("\n");
}

function main() {
  const body = renderComment({
    url: process.env.PREVIEW_URL || "",
    plugin: process.env.PLUGIN || "",
    headSha: process.env.HEAD_SHA || "",
    runUrl: process.env.RUN_URL || "",
    user: process.env.PREVIEW_USER || "admin",
    // Absent means "fall back to the name", which is what every caller did
    // before this existed and is right for every preview without a restore.
    isAdmin: process.env.PREVIEW_USER_IS_ADMIN
      ? process.env.PREVIEW_USER_IS_ADMIN === "true"
      : (process.env.PREVIEW_USER || "admin") === "admin",
    riskySteps: (process.env.RISKY_STEPS || "").split(",").map((r) => r.trim()).filter(Boolean),
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
