// Capture, once, every URL the unit suite fetches, so the suite never has to.
//
// Run: node scripts/capture-net-fixtures.mjs
//      node scripts/capture-net-fixtures.mjs --verify    (re-fetch, compare, write nothing)
//
// WHY A FIXED LIST AND NOT A RECORDING PROXY. A recorder captures whatever the
// suite happened to ask for on the day, so a test that starts fetching a new
// URL silently gets recorded rather than noticed. This list is the contract:
// `test/helpers/net-fixtures.mjs` throws on anything not in it, and `verify.sh`
// asserts the offline suite makes zero outbound requests, so a new dependency
// has to be added here deliberately.
//
// PROVENANCE IS RECORDED, including when a body could not be fetched and was
// taken from a local checkout instead. GitHub was rate-limiting (HTTP 429) for
// the whole of the session that introduced this, which is precisely the
// condition the fixtures exist to survive — so "sourced locally" is a first
// class outcome with a reason attached, not a fudge.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "test", "fixtures", "net");

const RAW = "https://raw.githubusercontent.com";

/**
 * Every URL the offline suite touches, with a local fallback where one exists.
 *
 * `local` is a command that prints the bytes to stdout, used only when the URL
 * cannot be fetched. `expect` documents why the test wants this URL, so the
 * next person can tell a stale pin from a deliberate one.
 */
export const URLS = [
  {
    file: "moodle-500-plugins.json",
    url: `${RAW}/moodle/moodle/MOODLE_500_STABLE/lib/plugins.json`,
    expect: "core component list; feeds fetchCoreComponents and the core-collision refusals",
    local: ["git", ["-C", "/home/ccaeday/dev/moodle", "show", "v5.0.5:lib/plugins.json"]],
    localNote:
      "v5.0.5 rather than the MOODLE_500_STABLE tip. Pinning is BETTER here: the " +
      "branch moves, and a moving fixture makes the suite's answers change under it. " +
      "verify.sh check 1p still fetches the real branch, so drift is caught there.",
  },
  {
    file: "attendance-version.php",
    url: `${RAW}/danmarsden/moodle-mod_attendance/8b217b1807bc0d33b3ac3b50ba516a7aaa7f367c/version.php`,
    expect: "a real plugin version.php, fetched when none is checked out",
  },
  {
    file: "review-course.mbz",
    url: `${RAW}/DavidUCL/githubactionsplayground/4a0e7afcec0298462b9b28f5a93a65b164f84a56/fixtures/review-course-MOODLE_404_STABLE.mbz`,
    expect: "the sample course backup the `sample-content` menu restores",
    local: ["cat", [join(ROOT, "fixtures", "review-course-MOODLE_404_STABLE.mbz")]],
    localNote:
      "the same file this repo generated and committed; the URL is that file at a " +
      "pinned commit. Re-capture over the wire to confirm the bytes match.",
  },
  {
    file: "uploadcourse-backup.mbz",
    url: `${RAW}/moodle/moodle/MOODLE_404_STABLE/admin/tool/uploadcourse/tests/fixtures/backup.mbz`,
    expect: "a core .mbz fixture, to prove the reader agrees with what Moodle emits",
    local: ["git", ["-C", "/home/ccaeday/dev/moodle", "show",
      "origin/MOODLE_404_STABLE:admin/tool/uploadcourse/tests/fixtures/backup.mbz"]],
    localNote:
      "read from the SAME ref the URL names (origin/MOODLE_404_STABLE), so these " +
      "bytes are the ones the URL serves unless the branch has moved since the " +
      "local clone was fetched.",
  },
  {
    file: "integration-test.json",
    url: `${RAW}/DavidUCL/mchef-urls/a354757fde7c28aedafc9a8e6fd99d5f828a7359/blueprints/integration-test.json`,
    expect: "a real published blueprint, for fetchBlueprint's success path",
  },
  {
    file: "legacy-course-completion.mbz",
    url: `${RAW}/moodle/moodle/MOODLE_404_STABLE/completion/tests/fixtures/legacy_course_completion.mbz`,
    expect: "a core backup that CARRIES student1 — the username collision refusal",
    local: ["git", ["-C", "/home/ccaeday/dev/moodle", "show",
      "origin/MOODLE_404_STABLE:completion/tests/fixtures/legacy_course_completion.mbz"]],
    localNote: "read from the same ref the URL names.",
  },
  {
    file: "quiz-311.mbz",
    url: `${RAW}/moodle/moodle/MOODLE_404_STABLE/mod/quiz/tests/fixtures/moodle_311_quiz.mbz`,
    expect: "an ACTIVITY backup, not a course backup — must be refused",
    local: ["git", ["-C", "/home/ccaeday/dev/moodle", "show",
      "origin/MOODLE_404_STABLE:mod/quiz/tests/fixtures/moodle_311_quiz.mbz"]],
    localNote: "read from the same ref the URL names.",
  },
  {
    file: "playground-redirect.html",
    url: "https://moodle-playground.com/",
    expect:
      "a cross-origin 301 that also STRIPS THE PATH — the shape fetchBlueprint's " +
      "post-redirect host check exists for. Captured as the FINAL response, so the " +
      "test proves the check on the redirected URL rather than the redirect itself.",
    followRedirect: true,
  },
  // The rest are EXPECTED FAILURES. They are captured too, because "this URL
  // 404s" is an assertion the suite makes and a fixture that quietly turned
  // into a 200 would change what those tests prove.
  {
    file: "missing-attendance-version.php",
    url: `${RAW}/DavidUCL/moodle-mod_attendance/d0638b39df1c28fd93c27778ae2cbada7cc1660f/version.php`,
    expect: "404 — the fixture SHA is not a real commit; the builder must report NOT CHECKED",
    allowMissing: true,
  },
  {
    file: "missing-format-version.php",
    url: `${RAW}/DavidUCL/moodle-format_thing/d0638b39df1c28fd93c27778ae2cbada7cc1660f/version.php`,
    expect: "404 — same, for the course-format golden case",
    allowMissing: true,
  },
];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch with backoff, and space every request out.
 *
 * Capturing ten URLs from one host as fast as possible is what provokes the
 * rate limit this whole change exists to survive — measured: a first pass got
 * five of seven and tripped 429 on the rest. This runs ONCE, so being slow and
 * polite costs nothing and is the difference between a complete manifest and a
 * partial one.
 */
async function fetchOnce(url, attempts = 4) {
  let last = { status: 0, bytes: Buffer.alloc(0), error: "not attempted" };
  for (let i = 0; i < attempts; i += 1) {
    if (i) await sleep(3000 * 2 ** (i - 1));
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      const bytes = Buffer.from(await res.arrayBuffer());
      // res.url is the FINAL url after redirects. fetchBlueprint checks the
      // host AFTER following, so a fixture that loses this tests nothing —
      // moodle-playground.com 301s cross-origin AND strips the path, which is
      // the entire point of the test that uses it.
      last = { status: res.status, bytes, finalUrl: res.url };
      // 429/403/5xx are worth another go; a 404 is an answer, not a failure.
      if (![429, 403].includes(res.status) && res.status < 500) return last;
      console.error(`  retrying ${url} (HTTP ${res.status})`);
    } catch (err) {
      last = { status: 0, bytes: Buffer.alloc(0), error: String(err.message || err) };
      console.error(`  retrying ${url} (${last.error})`);
    }
  }
  return last;
}

async function main() {
  const verifyOnly = process.argv.includes("--verify");
  mkdirSync(OUT, { recursive: true });
  const entries = [];
  let live = 0;
  let fallback = 0;
  let failed = 0;

  for (const spec of URLS) {
    await sleep(1500);
    const got = await fetchOnce(spec.url);
    let bytes = got.bytes;
    let status = got.status;
    let source = "network";
    let note = "";

    const throttled = status === 429 || status === 403 || status === 0 || status >= 500;
    if (throttled) {
      if (spec.local) {
        try {
          bytes = execFileSync(spec.local[0], spec.local[1], { maxBuffer: 64 * 1024 * 1024 });
          status = 200;
          source = "local";
          note = spec.localNote || "";
          fallback += 1;
        } catch (err) {
          console.error(`FAILED ${spec.url}\n  network: ${status}${got.error ? " " + got.error : ""}\n  local: ${err.message}`);
          failed += 1;
          continue;
        }
      } else if (spec.allowMissing) {
        // A URL we only ever expect to 404. Recording it as a network error
        // while throttled would bake the WRONG failure in — the tests care that
        // it is absent, not that the host was busy.
        console.error(`SKIPPED ${spec.url} — host returned ${status}; cannot tell a 404 from a rate limit`);
        failed += 1;
        continue;
      } else {
        console.error(`FAILED ${spec.url} — host returned ${status}${got.error ? " " + got.error : ""}, no local fallback`);
        failed += 1;
        continue;
      }
    } else {
      live += 1;
    }

    const digest = sha256(bytes);
    const finalUrl = got.finalUrl && got.finalUrl !== spec.url ? got.finalUrl : undefined;
    const existing = entries.find((e) => e.url === spec.url);
    if (verifyOnly) {
      const prev = JSON.parse(readFileSync(join(OUT, "manifest.json"), "utf8"))
        .entries.find((e) => e.url === spec.url);
      const same = prev && prev.sha256 === digest && prev.status === status;
      console.log(`${same ? "SAME" : "DRIFT"}  ${status}  ${spec.url}`);
      continue;
    }
    writeFileSync(join(OUT, spec.file), bytes);
    entries.push({
      url: spec.url,
      file: spec.file,
      status,
      bytes: bytes.length,
      sha256: digest,
      expect: spec.expect,
      ...(finalUrl ? { finalUrl } : {}),
      source,
      ...(note ? { note } : {}),
    });
    console.log(`${source === "local" ? "local " : "live  "} ${status}  ${bytes.length
      .toString().padStart(8)}  ${spec.file}`);
    if (existing) throw new Error(`duplicate url in URLS: ${spec.url}`);
  }

  if (verifyOnly) return;
  if (failed) {
    console.error(
      `\n${failed} URL(s) could not be captured. The manifest is NOT written — a partial ` +
        `manifest would make the suite fail on a missing URL and read as a code bug. ` +
        `Re-run when the host stops throttling.`,
    );
    process.exit(1);
  }
  writeFileSync(
    join(OUT, "manifest.json"),
    JSON.stringify({ capturedAt: new Date().toISOString(), entries }, null, 2) + "\n",
  );
  console.log(`\n${entries.length} fixtures written (${live} live, ${fallback} from a local checkout).`);
}

main();
