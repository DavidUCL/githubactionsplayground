// Make the offline suite actually offline.
//
// WHAT THIS EXISTS TO FIX, measured. The unit suite reached
// raw.githubusercontent.com 47 times per run across 10 URLs, and the mutation
// harness reruns the whole suite once per mutant — so one gate run made on the
// order of 16,000 requests to one host. The consequences were not theoretical:
//
//   - GitHub started answering HTTP 429, and six tests FAILED on a clean tree.
//   - The first fix gave them skip guards. That traded a red suite for a worse
//     lie: a skipped test kills no mutants, so `restore: allow a backup whose
//     users collide with ours` SURVIVED and the harness reported a "vacuous or
//     unpinned assertion" about code that was fine.
//   - Wall time was 4m03s for 4.2s of CPU. With fetch served from disk the same
//     suite runs in under a second.
//
// So: every URL the suite needs is captured to disk once, by
// `scripts/capture-net-fixtures.mjs`, and served from there.
//
// THE MAP THROWS ON AN UNKNOWN URL. It never falls through to the real network
// and never returns a plausible empty body. A test that reaches for a URL
// nobody captured is a test whose dependency changed, and it must say so loudly
// — falling through would restore exactly the flakiness this replaces, and
// returning an empty 200 would be the silent-success failure this repo keeps
// paying for. `verify.sh` additionally asserts the offline suite makes ZERO
// outbound requests, so a fall-through cannot hide.
//
// Installed via `NODE_OPTIONS=--import=...`, which propagates into `node --test`
// children AND into the builder subprocesses those tests spawn — measured,
// after a comment in this repo claimed the opposite.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// Overridable so verify.sh can point this at an EMPTY manifest and require the
// suite to notice. A check nobody has seen fail is a check nobody knows works,
// and the first version of that check was itself vacuous.
export const FIXTURE_DIR =
  process.env.BV_NET_FIXTURE_DIR || join(HERE, "..", "fixtures", "net");
const MANIFEST = join(FIXTURE_DIR, "manifest.json");

/** @returns {{url: string, file: string, status: number, sha256: string}[]} */
export function loadManifest() {
  if (!existsSync(MANIFEST)) {
    throw new Error(
      `net fixtures are missing (${MANIFEST}). Run:\n` +
        `  node scripts/capture-net-fixtures.mjs\n` +
        `The offline suite refuses to touch the network, so it cannot run without them.`,
    );
  }
  return JSON.parse(readFileSync(MANIFEST, "utf8")).entries;
}

/**
 * Replace global fetch with one that serves the captured bodies and refuses
 * everything else.
 *
 * @returns {() => number} a function returning how many requests were served,
 *   so a test can assert it really used the fixtures.
 */
export function installNetFixtures() {
  const entries = loadManifest();
  const byUrl = new Map(entries.map((e) => [e.url, e]));
  let served = 0;

  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input?.url ?? String(input));
    const hit = byUrl.get(url);
    if (!hit) {
      // Named, with the whole list, because the usual cause is a test that
      // changed a pinned SHA and the usual wrong fix is to widen the matcher.
      throw new Error(
        `net-fixtures: no captured response for ${url}\n` +
          `The offline suite must not reach the network. Either point the test at ` +
          `a captured URL, or add this one to scripts/capture-net-fixtures.mjs and ` +
          `re-capture.\nCaptured URLs:\n` +
          entries.map((e) => `  ${e.status} ${e.url}`).join("\n"),
      );
    }
    served += 1;
    const body = hit.status === 0 ? null : readFileSync(join(FIXTURE_DIR, hit.file));
    if (hit.status === 0) {
      // A captured NETWORK ERROR, not an HTTP response. Some tests exist to
      // prove the builder copes when a fetch throws; serving them a 404 would
      // quietly test a different path.
      throw new TypeError(`fetch failed (captured network error for ${url})`);
    }
    const res = new Response(body, { status: hit.status, headers: hit.headers ?? {} });
    // ALWAYS set `url`, as a real fetch does. A constructed Response has an
    // empty one, and code that checks where a fetch ENDED UP reads it —
    // fetchBlueprint refuses on the post-redirect host, so an empty value made
    // it fail with "unparseable URL" on a perfectly good response, and would
    // have made the redirect test pass for the wrong reason. `finalUrl` is only
    // recorded when it differs from the request.
    Object.defineProperty(res, "url", {
      value: hit.finalUrl ?? hit.url,
      configurable: true,
    });
    return res;
  };

  return () => served;
}

// Auto-install when used as a preload (`--import`), which is how the suite runs.
// Imported directly by a test that wants the helpers, it does nothing.
if (process.env.BV_NET_FIXTURES === "1") installNetFixtures();
