// `extra-plugins`: the other plugins a preview needs before the one under
// review can be judged at all.
//
// WHY THIS IS THE FIRST OF THE REMAINING CONTROLS. A plugin that depends on
// another plugin does not install. Moodle skips it, the boot reports success,
// and the reviewer gets a Moodle with the plugin simply absent — which reads as
// "this pull request is broken". That is worse than no answer: it is a WRONG
// answer, and nothing on the screen says so.
//
// Four things have to be true before an extra can be added to a blueprint, and
// each one is a refusal here rather than a silent failure in the reviewer's
// browser:
//
//  1. the ref names a real commit           — resolveCoordinates()
//  2. the archive for that commit exists    — checkArchives()
//  3. it really is the plugin it claims     — checkExtraPlugin()
//  4. its own dependencies are present, and installed FIRST — orderInstalls()
//
// (4) is the one Moodle will not do for you. MEASURED in Moodle 5.0's
// lib/upgradelib.php: `upgrade_plugins()` reads `$plugin->requires` and
// `$plugin->incompatible` and throws on both, but the only mention of
// dependencies is `unset($module->dependencies)` (line 828) and
// `unset($block->dependencies)` (line 992) — the field is DISCARDED before the
// record is written. The only code that enforces it,
// `core_plugin_manager::are_dependencies_satisfied()`, belongs to the admin
// UI's installer, and a scripted install never goes near it. So an unsatisfied
// dependency installs quietly and fails later, at whatever moment the plugin
// first calls the code that is not there.

import {
  parseVersionPhp,
  checkMoodleCompatibility,
  MAX_VERSION_PHP_BYTES,
} from "./plugin-version.mjs";
import { COMMIT_RE, coordinateZipUrl } from "./coordinates.mjs";

/** Every request this module makes, so a slow host cannot hang a job. */
const TIMEOUT_MS = 10000;
/** A ref advertisement for a busy repository is tens of kilobytes; moodle/moodle
 * is a few megabytes. Past this something is wrong and PARSING it — a regex per
 * packet — is what costs the job. The body has already been read by the time
 * this is checked; the timeout above is what bounds the download. */
const MAX_ADVERTISEMENT_BYTES = 8 * 1024 * 1024;

/**
 * Decode a git ref advertisement (`/info/refs?service=git-upload-pack`).
 *
 * WHY THIS RATHER THAN THE GITHUB API. api.github.com allows 60 requests an
 * hour to unauthenticated callers, counted per source address — and every
 * GitHub-hosted runner shares a small pool of them, so resolving a ref that way
 * fails intermittently for reasons the user cannot see or fix. The ref
 * advertisement is the plain git protocol over https: no token, no API quota,
 * public repositories only, and it is what `git ls-remote` reads. We fetch it
 * directly instead of shelling out to git, because `git ls-remote` honours
 * `--upload-pack=` inside the ref argument and the ref here is typed by a human.
 *
 * The wire format is pkt-line: four hex digits of LENGTH (counting themselves),
 * then that many bytes of payload; `0000` is a flush packet. The first ref line
 * carries the server's capabilities after a NUL byte.
 *
 * Lengths are in BYTES, so the input is decoded as latin1 — one byte, one
 * character. Decoding as UTF-8 would make a multi-byte ref name shorter in
 * characters than the length says and walk the parser off the end of every
 * subsequent packet.
 *
 * @param {Buffer|Uint8Array} bytes
 * @returns {{ok: boolean, reason?: string, refs?: Map<string,string>}}
 */
export function parseRefAdvertisement(bytes) {
  const text = Buffer.from(bytes).toString("latin1");
  const refs = new Map();
  let i = 0;
  while (i + 4 <= text.length) {
    const head = text.slice(i, i + 4);
    if (!/^[0-9a-f]{4}$/i.test(head)) {
      return { ok: false, reason: `not a git ref advertisement (unexpected ${JSON.stringify(head)})` };
    }
    const len = parseInt(head, 16);
    // 0000 flush, 0001/0002 delimiters (protocol v2). All are length-less.
    if (len < 4) {
      i += 4;
      continue;
    }
    const payload = text.slice(i + 4, i + len);
    if (payload.length < len - 4) {
      return { ok: false, reason: "the ref advertisement ends mid-packet" };
    }
    i += len;
    // Capabilities follow a NUL on the first ref line only; everything after it
    // describes the SERVER, not the ref.
    const line = payload.split("\0")[0].trim();
    const m = /^([0-9a-f]{40}) (.+)$/.exec(line);
    if (m && m[2].startsWith("refs/")) refs.set(m[2], m[1]);
  }
  if (!refs.size) {
    // An empty repository advertises no refs, and so does a response that is
    // not an advertisement at all. Either way there is nothing to resolve, and
    // saying "no such branch" would blame the user for the wrong thing.
    return { ok: false, reason: "the repository advertises no branches or tags" };
  }
  return { ok: true, refs };
}

/**
 * Pick the commit a ref names.
 *
 * An ANNOTATED tag points at a tag object, not a commit; git advertises the
 * commit it wraps as `refs/tags/<name>^{}`. Taking the unpeeled SHA would build
 * an archive URL for an object GitHub does not serve — a 404, i.e. a preview
 * with the plugin missing.
 *
 * A name that is BOTH a branch and a tag is refused rather than resolved by
 * precedence. git itself only warns, and a link that boots whichever of the two
 * a rule picked is exactly the ambiguity this whole design exists to remove.
 *
 * @returns {{ok: boolean, reason?: string, sha?: string, via?: string}}
 */
export function resolveRefIn(refs, ref) {
  const exact = ref.startsWith("refs/");
  const branch = exact ? null : `refs/heads/${ref}`;
  const tag = exact ? ref : `refs/tags/${ref}`;
  const peeled = `${tag}^{}`;

  const branchSha = branch ? refs.get(branch) : undefined;
  const tagSha = refs.get(peeled) ?? refs.get(tag);
  if (exact) {
    const sha = refs.get(peeled) ?? refs.get(ref);
    return sha ? { ok: true, sha, via: ref } : { ok: false, reason: `no ref ${JSON.stringify(ref)}` };
  }
  if (branchSha && tagSha && branchSha !== tagSha) {
    return {
      ok: false,
      reason:
        `is both a branch and a tag in that repository, pointing at different ` +
        `commits — say refs/heads/${ref} or refs/tags/${ref}`,
    };
  }
  if (branchSha) return { ok: true, sha: branchSha, via: branch };
  if (tagSha) return { ok: true, sha: tagSha, via: tag };
  return {
    ok: false,
    reason:
      `is not a branch or a tag in that repository. A 7-character commit is not ` +
      `enough either — give a branch name, a tag, or a full 40-character commit`,
  };
}

const advertisementCache = new Map();

/**
 * Resolve every coordinate's ref to a commit, one request per repository.
 *
 * Cached per repo because two coordinates naming the same repository at two
 * refs are a legitimate thing to ask for, and the advertisement carries every
 * ref in one response.
 *
 * @returns {Promise<{items: object[], problems: string[]}>} items carry `ref`
 *   replaced by a commit, and `requestedRef` recording what was typed.
 */
export async function resolveCoordinates(items, { fetchImpl = fetch, label = "extra-plugins" } = {}) {
  const problems = [];
  const out = [];
  for (const item of items) {
    if (COMMIT_RE.test(item.ref)) {
      // Already a commit. Nothing to look up — but it is NOT yet known to
      // exist, which is what checkArchives() is for.
      out.push({ ...item, requestedRef: item.ref });
      continue;
    }
    const slug = `${item.owner}/${item.repo}`;
    if (!advertisementCache.has(slug)) {
      advertisementCache.set(slug, await fetchAdvertisement(slug, fetchImpl));
    }
    const ad = advertisementCache.get(slug);
    if (!ad.ok) {
      problems.push(`${label} ${item.component}: ${ad.reason}`);
      continue;
    }
    const resolved = resolveRefIn(ad.refs, item.ref);
    if (!resolved.ok) {
      problems.push(`${label} ${item.component}: "${item.ref}" ${resolved.reason}`);
      continue;
    }
    out.push({ ...item, ref: resolved.sha, requestedRef: item.ref });
  }
  return { items: out, problems };
}

async function fetchAdvertisement(slug, fetchImpl) {
  const url = `https://github.com/${slug}/info/refs?service=git-upload-pack`;
  try {
    // redirect: "error" on purpose. GitHub redirects a RENAMED repository to
    // its new name, and silently following that would resolve a ref in a
    // repository the coordinate does not name.
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
    if (!res.ok) {
      // MEASURED: GitHub answers 401 for a repository that does not exist, not
      // 404 — it cannot tell you whether it is missing or private without
      // telling you which, so it asks for credentials either way. Both answers
      // mean the same thing here, because the reviewer's browser will fetch
      // the archive anonymously too.
      const missing = res.status === 401 || res.status === 404;
      return {
        ok: false,
        reason: missing
          ? `there is no public repository ${slug} (HTTP ${res.status}). GitHub answers ` +
            `the same way for one that does not exist and one that is private, and a ` +
            `private repository cannot be previewed: the reviewer's browser downloads ` +
            `the archive with no credentials`
          : `HTTP ${res.status} asking ${slug} for its branches`,
      };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_ADVERTISEMENT_BYTES) {
      return { ok: false, reason: `${slug} advertised ${buf.length} bytes of refs, over the cap` };
    }
    return parseRefAdvertisement(buf);
  } catch (err) {
    return { ok: false, reason: `could not read the branches of ${slug}: ${err.message}` };
  }
}

/**
 * Prove each resolved archive is really there.
 *
 * Wasi booted a preview whose plugin URL 404'd: the install step failed, the
 * blueprint carried on, and the reviewer was dumped — logged out — on a DML
 * stack trace. A HEAD costs one request and turns that into a refusal with a
 * reason.
 *
 * It is NOT redundant with resolving the ref. The common coordinate form pins a
 * full commit, which skips resolution entirely, so without this nothing has
 * checked that the commit exists at all. MEASURED: HEAD on
 * github.com/<o>/<r>/archive/<sha>.zip answers 302 to codeload and then 200 for
 * a real commit, 404 for one that does not exist — so the redirect must be
 * followed for the answer to mean anything.
 *
 * @returns {Promise<string[]>} problems
 */
export async function checkArchives(items, { fetchImpl = fetch, label = "extra-plugins" } = {}) {
  const problems = [];
  for (const item of items) {
    const url = coordinateZipUrl(item);
    try {
      const res = await fetchImpl(url, {
        method: "HEAD",
        redirect: "follow",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        problems.push(
          `${label} ${item.component}: no archive at ${url} (HTTP ${res.status}). The ` +
            `install step would fail and the reviewer would land on a stack trace`,
        );
      }
    } catch (err) {
      problems.push(`${label} ${item.component}: could not reach ${url} — ${err.message}`);
    }
  }
  return problems;
}

/**
 * Read an extra's own version.php at the resolved commit.
 *
 * ABSENT IS A REFUSAL, and that is the whole point of this function. Quinn
 * measured the alternative: GitHub serves a styled 404 PAGE with status 200 for
 * some paths, it parses to a version.php with every field empty, and empty
 * satisfies every downstream check. Meanwhile the archive really does extract —
 * into a directory with no version.php, which `upgrade_plugins()` skips with
 * `if (!is_readable($fullplug.'/version.php')) continue;`. No error, no plugin.
 *
 * @returns {Promise<{ok: boolean, reason?: string, declared?: object}>}
 */
export async function fetchExtraVersion(item, { fetchImpl = fetch } = {}) {
  const url = `https://raw.githubusercontent.com/${item.owner}/${item.repo}/${item.ref}/version.php`;
  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
  } catch (err) {
    return { ok: false, reason: `could not read ${url} — ${err.message}` };
  }
  if (!res.ok) {
    return {
      ok: false,
      reason:
        `has no version.php at the root of ${item.owner}/${item.repo} at that commit ` +
        `(HTTP ${res.status}). Moodle's upgrade skips a directory it cannot read a ` +
        `version.php in, without a word, so the plugin would simply not be there`,
    };
  }
  const text = (await res.text()).slice(0, MAX_VERSION_PHP_BYTES);
  const declared = parseVersionPhp(text);
  if (!declared.ok) return { ok: false, reason: declared.reason };
  if (declared.component == null && declared.version == null && declared.requires == null) {
    return {
      ok: false,
      reason:
        `has a version.php at that commit with no readable $plugin fields in it. A ` +
        `404 page parses to exactly this, and every check below would pass on the ` +
        `strength of nothing`,
    };
  }
  return { ok: true, declared: { ...declared, path: url } };
}

/**
 * Everything decidable about ONE extra once its version.php has been read.
 *
 * @returns {string[]} problems, each naming the coordinate
 */
export function checkExtraPlugin(item, declared, { moodleBranch, core, label = "extra-plugins" }) {
  const problems = [];
  const say = (msg) => problems.push(`${label} ${item.component}: ${msg}`);

  if (declared.component && declared.component !== item.component) {
    say(
      `declares itself to be "${declared.component}", not "${item.component}". The ` +
        `archive would be extracted where the coordinate says, and Moodle reads the ` +
        `version.php inside — so it would install as something other than the name ` +
        `written here, or not at all`,
    );
  }
  // NOT the core-component check. That one needs only the coordinate, so the
  // caller runs it BEFORE any request — measured reason: with it here,
  // `moodle/moodle@MOODLE_500_STABLE#mod_assign` was refused by the version.php
  // fetch first, which is true (core's root version.php declares no $plugin)
  // but says nothing about the real problem.
  const compat = checkMoodleCompatibility(declared, moodleBranch);
  if (!compat.ok) say(compat.reason);

  return problems;
}

/**
 * Are every plugin's declared dependencies actually going to be there?
 *
 * Satisfied by a core component, or by another plugin this preview installs.
 * Nothing else exists in the bundle to satisfy them.
 *
 * A core dependency's VERSION is not compared: core components carry their own
 * version numbers and the bundle publishes only Moodle's, so a comparison here
 * would be invented rather than measured. Every other case is compared.
 *
 * Skipped entirely when Moodle's component list could not be fetched — a check
 * that guesses is worse than one that says it did not run.
 *
 * @param {Array<{component: string, version: number|null, dependencies: object}>} nodes
 * @param {{ok: boolean, standard: Set<string>}} core
 * @returns {string[]} problems
 */
export function checkDependenciesSatisfied(nodes, core) {
  if (!core?.ok) return [];
  const problems = [];
  const installed = new Map(nodes.map((n) => [n.component, n]));
  for (const node of nodes) {
    for (const [dep, want] of Object.entries(node.dependencies || {})) {
      if (core.standard.has(dep)) continue;
      const supplier = installed.get(dep);
      if (!supplier) {
        problems.push(
          `${node.component} depends on ${dep}, which is neither part of Moodle nor ` +
            `installed by this preview. Moodle does NOT enforce dependencies during a ` +
            `scripted install — upgrade_plugins() discards the field — so ${node.component} ` +
            `would install, look fine, and fail the moment it uses ${dep}. Add ` +
            `${dep} to extra-plugins`,
        );
        continue;
      }
      if (want !== "ANY_VERSION" && supplier.version != null && supplier.version < want) {
        problems.push(
          `${node.component} needs ${dep} version ${want} or later, and the commit ` +
            `given for ${dep} is version ${supplier.version}`,
        );
      }
    }
  }
  return problems;
}

/**
 * Install order: a plugin's dependencies go in before it does.
 *
 * The preview installs each plugin as its own step, and each step runs Moodle's
 * upgrade. A plugin's install code (db/install.php, db/upgrade.php) may call the
 * API of something it depends on, so arriving first is not cosmetic.
 *
 * Kahn's algorithm, with a deliberate tie-break: among the plugins whose
 * dependencies are already satisfied, take the EXTRAS first, in the order they
 * were typed, and the plugin under review last. That keeps the spec's rule —
 * extras before the commit under review — while still letting an extra that
 * depends on the plugin under review sit after it, which is the one case where
 * the rule and the mechanism disagree.
 *
 * A cycle is refused. It cannot be installed in any order, and left alone it
 * would silently drop whichever plugins the sort could not place.
 *
 * @param {Array<{component: string, isSelf?: boolean, dependencies: object}>} nodes
 * @returns {{ok: boolean, reason?: string, order?: object[]}}
 */
export function orderInstalls(nodes) {
  const byComponent = new Map(nodes.map((n) => [n.component, n]));
  const remaining = new Map(
    nodes.map((n) => [
      n.component,
      new Set(Object.keys(n.dependencies || {}).filter((d) => byComponent.has(d) && d !== n.component)),
    ]),
  );
  const order = [];
  const placed = new Set();
  while (placed.size < nodes.length) {
    const ready = nodes.filter(
      (n) => !placed.has(n.component) && [...remaining.get(n.component)].every((d) => placed.has(d)),
    );
    if (!ready.length) {
      const stuck = nodes.filter((n) => !placed.has(n.component)).map((n) => n.component);
      return {
        ok: false,
        reason:
          `these plugins depend on each other in a circle and cannot be installed in ` +
          `any order: ${stuck.sort().join(", ")}`,
      };
    }
    // Extras first, in the order typed; the plugin under review last.
    const next = ready.find((n) => !n.isSelf) ?? ready[0];
    order.push(next);
    placed.add(next.component);
  }
  return { ok: true, order };
}

/** Reset between runs. Exported for tests; a run is short-lived and the
 * advertisement is a snapshot, so caching within one is the correct scope. */
export function clearAdvertisementCache() {
  advertisementCache.clear();
}
