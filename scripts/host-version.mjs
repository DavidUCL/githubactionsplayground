// Which playground build a link was made against.
//
// Nothing in this repo used to ask the deployed host what it was. So every
// host regression meant an afternoon of reading deploy history by hand to
// find out which build reviewers had been running, and a host deployed from
// uncommitted changes ("dirty") was invisible unless someone fetched the file
// with curl. The playground publishes `assets/build-version.json` on every
// deploy; reading it costs one small request and turns that into a line in
// the comment.
//
// This RECORDS the build. It does not prove the link boots on it: nothing in
// the preview action opens the link. The comment says "built against", never
// "verified on", for that reason.

import { sanitiseForLog } from "./sanitise.mjs";

export const BUILD_VERSION_PATH = "assets/build-version.json";

const GIT_SHA_RE = /^[0-9a-f]{7,40}$/;
const BUILD_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,79}$/;

/**
 * Read the deployed playground's build record.
 *
 * @returns {Promise<{buildVersion: string, gitSha: string, dirty: boolean} | {unknown: string}>}
 *   `unknown` carries why it could not be read. Never throws: a host that has
 *   no build record is still a host a link can point at, and refusing on it
 *   would break every run the day the playground moves the file.
 */
export async function fetchHostVersion(playgroundHost, { fetchImpl = fetch } = {}) {
  let url;
  try {
    const base = String(playgroundHost).endsWith("/") ? String(playgroundHost) : `${playgroundHost}/`;
    url = new URL(BUILD_VERSION_PATH, base).toString();
  } catch (err) {
    return { unknown: `could not form the build-version URL for ${playgroundHost}: ${err.message}` };
  }
  let record;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(20000), redirect: "follow" });
    if (!res.ok) return { unknown: `HTTP ${res.status} reading ${url}` };
    record = JSON.parse(await res.text());
  } catch (err) {
    return { unknown: `could not read ${url}: ${err.message}` };
  }
  return checkVersionRecord(record, url);
}

/** Validate the record's shape; anything unexpected is `unknown`, not trusted. */
export function checkVersionRecord(record, url = BUILD_VERSION_PATH) {
  if (!record || typeof record !== "object") return { unknown: `${url} is not a JSON object` };
  const { buildVersion, gitSha, dirty } = record;
  if (typeof buildVersion !== "string" || !BUILD_VERSION_RE.test(buildVersion)) {
    return { unknown: `${url} has no usable buildVersion` };
  }
  if (typeof gitSha !== "string" || !GIT_SHA_RE.test(gitSha)) {
    return { unknown: `${url} has no usable gitSha` };
  }
  if (typeof dirty !== "boolean") return { unknown: `${url} does not say whether the build was dirty` };
  return { buildVersion, gitSha, dirty };
}

/** One line for the comment and the summary. */
export function describeHostVersion(v) {
  if (!v || v.unknown) {
    return `Playground build: could not be read (${sanitiseForLog(v?.unknown || "no record").replace(/\r?\n/g, " ")}).`;
  }
  return (
    `Built against playground \`${v.buildVersion}\` (commit \`${v.gitSha}\`` +
    `${v.dirty ? ", deployed with uncommitted changes" : ""}). The link was not opened by this run.`
  );
}
