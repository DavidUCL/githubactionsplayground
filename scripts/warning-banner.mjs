// A warning the reviewer sees on every page of the preview.
//
// The comment on the pull request is not enough: the reviewer is looking at
// Moodle, and the course page's Review brief is not where most previews land
// (an "add activity" form, an admin page). Tested 2026-10-21 against a real
// preview (CTP-6907/progress.md, "Spike"): of the standard Moodle ways to show
// a message, only Moodle's own "additional HTML, top of body" setting reaches
// every page from a setup step. A page notification needs the reviewer's
// session; a bell notification is only seen if they open the bell. Placed
// normally the box hides behind Boost's fixed navbar, so it is pinned to the
// bottom of the window. David chose this style for errors that must be shown.
//
// Written by runPhpCode, not setConfig: the gate refuses setConfig on the raw-
// HTML settings (preflight.mjs RAW_HTML_CONFIGS), and rightly, because a
// blueprint author could put a script there. Here the builder writes the HTML
// itself, every message HTML-escaped, and passes it to PHP as base64 so no
// quoting in the text can break out of the PHP string.

import { ownStep } from "./own-steps.mjs";

/** HTML-escape a message for the banner. */
export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The banner's HTML: a standard Bootstrap warning box, pinned to the bottom. */
export function bannerHtml(messages) {
  const items = messages.map((m) => escapeHtml(m));
  return (
    '<div class="alert alert-warning m-0 rounded-0 text-center" role="alert" ' +
    'style="position:fixed;left:0;right:0;bottom:0;z-index:1100">' +
    `<strong>Preview warning:</strong> ${items.join(" &middot; ")}</div>`
  );
}

/**
 * A blueprint step that turns the banner on, or null when there is nothing to
 * say. Not critical: a banner that fails to appear must not stop the preview.
 */
export function buildWarningBannerStep(messages) {
  const list = (messages || []).map((m) => String(m).trim()).filter(Boolean);
  if (!list.length) return null;
  const b64 = Buffer.from(bannerHtml(list), "utf8").toString("base64");
  return ownStep({
    step: "runPhpCode",
    code:
      "<?php define('CLI_SCRIPT', true); require('/www/moodle/config.php'); " +
      `set_config('additionalhtmltopofbody', base64_decode('${b64}')); exit(0);`,
  });
}
