// Does the playground we are linking to have the Moodle version asked for?
//
// A plugin workflow types `moodle-branch` by hand. A typo such as
// MOODLE_50_STABLE is not refused by the playground: it quietly boots its
// default Moodle, while everything the action prints names the typo. David
// decided (2026-10-21): a version the playground does not have STOPS the
// build; a real version the action holds no compatibility data for is
// ALLOWED, with a warning banner inside the preview (see warning-banner.mjs).
//
// The playground publishes one manifest per Moodle version it can boot, at
// assets/manifests/<branch>.json. Present means the version is real on THIS
// host; 404 means it is not. Asking the host, rather than keeping a list here,
// is what lets a new version, or a UCL production base on its own host, work
// without changing the action.

const BRANCH_SHAPE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * @returns {Promise<{exists: true, release: string} | {exists: false, reason: string} | {unknown: string}>}
 *   `exists: false` only on a definite 404. Anything else that stops the
 *   answer (network, another status, a malformed manifest) is `unknown`: not
 *   a refusal, because a host we cannot read says nothing about the version.
 */
export async function checkBranchOnHost(playgroundHost, branch, { fetchImpl = fetch } = {}) {
  if (!BRANCH_SHAPE.test(String(branch))) {
    return { exists: false, reason: `"${branch}" is not a Moodle version name` };
  }
  let url;
  try {
    const base = String(playgroundHost).endsWith("/") ? String(playgroundHost) : `${playgroundHost}/`;
    url = new URL(`assets/manifests/${branch}.json`, base).toString();
  } catch (err) {
    return { unknown: `could not form the manifest URL for ${playgroundHost}: ${err.message}` };
  }
  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(20000), redirect: "follow" });
  } catch (err) {
    return { unknown: `could not read ${url}: ${err.message}` };
  }
  if (res.status === 404) {
    return { exists: false, reason: `the playground at ${playgroundHost} has no Moodle "${branch}"` };
  }
  if (!res.ok) return { unknown: `HTTP ${res.status} reading ${url}` };
  let manifest;
  try {
    manifest = JSON.parse(await res.text());
  } catch (err) {
    return { unknown: `${url} is not JSON: ${err.message}` };
  }
  if (!manifest || manifest.channel !== branch) {
    return { unknown: `${url} does not describe "${branch}"` };
  }
  return { exists: true, release: typeof manifest.release === "string" ? manifest.release : "" };
}
