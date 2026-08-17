#!/usr/bin/env bash
set -uo pipefail
#
# verify.sh — deterministic gate for the boot-verify action (personas.md
# protocol v2: this script, not persona judgment, is the exit condition).
#
#   1. Unit suite passes (parser pinned to golden fixtures)
#   2. Golden fixture assesses to pass AND validates against the closed schema
#   3. Fallback fixture assesses to verify_fail/resolver_fallback
#   1b. No surviving mutants (every assertion term is pinned by a test)
#   1c. action.yml supplies every env var the scripts read
#   4. LIVE (opt-in, LIVE=1): loopback boot of the known-good blueprint
#      against the production playground ends status=pass
#   5. LIVE: a swapped local blueprint is refused by the hash binding
#   6. LIVE: the post-restore assertion passes when right and fails when wrong
#   7. LIVE: a real theme installs, activates and builds its CSS — and all
#      three silent-Boost failures are caught
#
# Local env note (WSL, no sudo): chromium needs NSS libs; point
# NSS_LIBS at a dir of symlinks (see README "Local testing").

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
# ---------------------------------------------------------------------------
# ISOLATE THE RUNNER'S OUTPUT FILES.
#
# This is a TEST HARNESS, and much of what it runs exists to append to
# $GITHUB_OUTPUT / $GITHUB_STEP_SUMMARY. On a laptop those are unset and
# nothing happens. On a runner they point at the REAL files, so the suite
# appended 38000 bytes of probe output into them — including a bare `b` line,
# which GitHub rejected with:
#
#     Invalid format 'b'
#     Unable to process file command 'output' successfully.
#
# The gate itself exited 0. The JOB still went red, for output it merely
# passed through. Measured on the first CI run of this file (5d56651).
#
# Remember the originals so the check at the end can prove we left them alone.
GATE_REAL_OUTPUT="${GITHUB_OUTPUT:-}"
GATE_REAL_SUMMARY="${GITHUB_STEP_SUMMARY:-}"
GATE_REAL_OUTPUT_SIZE=0
GATE_REAL_SUMMARY_SIZE=0
[[ -f "$GATE_REAL_OUTPUT" ]] && GATE_REAL_OUTPUT_SIZE=$(wc -c <"$GATE_REAL_OUTPUT")
[[ -f "$GATE_REAL_SUMMARY" ]] && GATE_REAL_SUMMARY_SIZE=$(wc -c <"$GATE_REAL_SUMMARY")
export GITHUB_OUTPUT="$(mktemp)"
export GITHUB_STEP_SUMMARY="$(mktemp)"

FAILED=()
check() {
    local rc=$1 num=$2 label=$3
    if [[ $rc -eq 0 ]]; then echo "CHECK $num PASS: $label";
    else echo "CHECK $num FAIL: $label"; FAILED+=("$num: $label"); fi
}

echo "=== verify.sh — boot-verify action gate ==="

# THE OFFLINE SUITE IS OFFLINE, and this asserts it rather than hoping.
#
# It used to make 47 requests to raw.githubusercontent.com per run — and the
# mutation harness reruns the whole suite once per mutant, so a gate run made
# on the order of 16,000. GitHub started answering 429, six tests went red on a
# clean tree, and the first fix (skip guards) was worse: a skipped test kills no
# mutants, so the harness reported a "vacuous assertion" about correct code.
# Every URL is now captured to test/fixtures/net by
# `node scripts/capture-net-fixtures.mjs`. MEASURED: 4m03s -> 1.9s, 47 -> 0.
# SCOPED TO THE UNIT SUITE, never exported. Check 1o runs the real builder as a
# subprocess precisely to exercise the real wiring — including its real network
# fetches — so serving it fixtures makes it test something else. Exporting these
# broke 1o and 1o-shape the first time this landed.
BV_NET_FIXTURES=1 NODE_OPTIONS="--import=file://$PWD/test/helpers/net-fixtures.mjs" \
    node --test test/*.test.mjs >/tmp/bv-verify-unit.log 2>&1
UNIT_RC=$?
# A skip asserts nothing, so any skip at all is now worth seeing: with fixtures
# there should be none, and one appearing means a test started opting out.
UNIT_SKIPPED=$(grep -cE '^ok .* # SKIP' /tmp/bv-verify-unit.log 2>/dev/null || true)
UNIT_SKIPPED=${UNIT_SKIPPED:-0}
check "$UNIT_RC" 1 "unit suite, $UNIT_SKIPPED skipped (log: /tmp/bv-verify-unit.log)"
if [[ "$UNIT_SKIPPED" -gt 0 ]]; then
    echo "  note: $UNIT_SKIPPED test(s) skipped — with net fixtures in place this should be zero:"
    grep -E '^ok .* # SKIP' /tmp/bv-verify-unit.log | sed 's/^/    /' | head -8
fi

# ...and prove the suite really is being served by those fixtures, by BREAKING
# them and requiring it to notice.
#
# The first version of this check counted outbound requests from a preload that
# wrapped `fetch` — and it was VACUOUS: net-fixtures.mjs replaces globalThis.fetch
# after that preload runs, so the counter was overwritten and its zero meant
# nothing. Counting egress honestly needs socket-level interception, which is
# more machinery than the risk deserves. What actually matters is the property
# the fixtures exist for: the suite must DEPEND on them, so that a missing or
# fallen-through fixture is loud rather than a silent return to the network.
#
# So: point the helper at an empty manifest. Every test that needs a URL must
# fail. If the suite still passes, the fixtures are not being used and the tests
# have found the network another way.
FIXPLANT=$(mktemp -d)
mkdir -p "$FIXPLANT/net"
echo '{"capturedAt":"plant","entries":[]}' > "$FIXPLANT/net/manifest.json"
if BV_NET_FIXTURES=1 BV_NET_FIXTURE_DIR="$FIXPLANT/net" \
        NODE_OPTIONS="--import=file://$PWD/test/helpers/net-fixtures.mjs" \
        node --test test/*.test.mjs >"$FIXPLANT/out.log" 2>&1; then
    echo "CHECK 1a3 FAIL: the suite PASSED with every net fixture removed — it is not using them"
    FAILED+=("1a3: the suite does not depend on its net fixtures")
elif ! grep -q 'no captured response for' "$FIXPLANT/out.log"; then
    echo "CHECK 1a3 FAIL: the suite failed without fixtures, but not because they were missing"
    FAILED+=("1a3: failed for an unrelated reason")
else
    echo "CHECK 1a3 PASS: removing the net fixtures breaks the suite, so it is really served by them"
fi
rm -rf "$FIXPLANT"

# Every mutant's anchor must still match its source line — 2.5s, and it runs
# FIRST because it is the failure the slow run reports worst. A stale anchor is
# not a weak test, it is a mutant that never executed: the assertion it guards
# has been unguarded since the line moved. That has happened three times here,
# always because of the author's own edit, and the full run only says so after
# twenty minutes. Same code, same list, no second definition to drift.
MUTATIONS_ANCHORS_ONLY=1 node test/mutations.mjs >/tmp/bv-verify-anchors.log 2>&1
check $? 1a2 "every mutation anchor still matches (log: /tmp/bv-verify-anchors.log)"

# Anti-vacuity: every assertion term must be pinned by some test. Without
# this, a green suite proves nothing:
# the first version of these tests let 13 of 14 terms be deleted silently.
node test/mutations.mjs >/tmp/bv-verify-mutations.log 2>&1
check $? 1b "no surviving mutants (log: /tmp/bv-verify-mutations.log)"

# Contract: every env var the scripts read must be supplied by action.yml.
# Checks 2-3 use hand-made fixtures, so a renamed env var would otherwise
# keep the gate green while every real run wrote its artifacts nowhere.
python3 - <<'PY'
import re, sys, pathlib
root = pathlib.Path('.')
action = (root / 'action.yml').read_text()
declared = set(re.findall(r'^\s{6,}([A-Z][A-Z0-9_]*):\s', action, re.M))
used = set()
# Only the scripts action.yml invokes; capture-fixtures.mjs is a local dev
# tool and reads NSS_LIBS, which no CI runner supplies.
for name in ('preflight.mjs', 'boot-capture.mjs', 'assert.mjs',
             'render-summary.mjs', 'validate-verdict.mjs', 'sanitise.mjs'):
    used |= set(re.findall(r'process\.env\.([A-Z][A-Z0-9_]*)',
                           (root / 'scripts' / name).read_text()))
# The preview action is a second action.yml with its own script; without this
# a renamed PLAYGROUND_HOST would silently revert every link to the default.
preview_declared = set(re.findall(r'^\s{6,}([A-Z][A-Z0-9_]*):\s',
                                  (root / 'preview' / 'action.yml').read_text(), re.M))
preview_used = set(re.findall(r'process\.env\.([A-Z][A-Z0-9_]*)',
                              (root / 'scripts' / 'build-preview.mjs').read_text()))
declared |= preview_declared
runner_provided = {'GITHUB_OUTPUT', 'GITHUB_STEP_SUMMARY', 'GITHUB_EVENT_NAME',
                   'GITHUB_SHA', 'GITHUB_EVENT_PATH'}
missing = (used | preview_used) - declared - runner_provided
if missing:
    print('env vars read by scripts but never set in action.yml:', sorted(missing))
    sys.exit(1)
PY
check $? 1c "action.yml supplies every env var the scripts read"

# Supply chain: the lockfile must contain nothing but the declared dependency
# tree. This check exists because it once didn't — a symlinked node_modules
# produced a lock with 216 unrelated packages, all of which `npm ci` would
# have installed into the job that renders the boot we assert on.
python3 - <<'PY'
import json, sys
lock = json.load(open('package-lock.json'))
allowed = {'', 'node_modules/playwright', 'node_modules/playwright-core', 'node_modules/fsevents'}
extra = sorted(set(lock.get('packages', {})) - allowed)
if extra:
    print(f'lockfile carries {len(extra)} unexpected packages, e.g.', extra[:8])
    sys.exit(1)
pw = lock['packages']['node_modules/playwright']['version']
if pw != '1.61.1':
    print('playwright pin drifted:', pw)
    sys.exit(1)
PY
check $? 1d "lockfile contains only the pinned playwright tree"

# The preview link relies on moodle-playground.com redirecting to the Pages
# site WITH the query string intact — the whole blueprint rides in it. A silent
# CDN rule change would drop the payload and every preview would boot a vanilla
# Moodle. Verified live because nothing else would notice.
if [[ -z "${SKIP_NET:-}" ]]; then
    RAW=$(curl -sS -o /dev/null -D - --max-time 20 \
          "https://moodle-playground.com/?blueprint=REDIRECTPROBE123" 2>/dev/null)
    if [[ $? -ne 0 ]]; then
        # Offline or DNS-blocked: report it, do not fail. A gate that goes red
        # on a train is a gate people start skipping.
        echo "CHECK 1f SKIP: no network (redirect behaviour UNCHECKED in this run)"
    else
        LOC=$(printf '%s' "$RAW" | tr -d '\r' | awk 'tolower($1)=="location:"{print $2}')
        [[ "$LOC" == https://ateeducacion.github.io/* && "$LOC" == *"blueprint=REDIRECTPROBE123"* ]]
        check $? 1f "moodle-playground.com redirect keeps the blueprint param AND lands on the expected origin (got: ${LOC:-none})"
    fi
else
    echo "CHECK 1f SKIP: SKIP_NET set"
fi

# The Moodle-version table in plugin-version.mjs decides whether a plugin's
# $plugin->requires is satisfiable. It must match the Moodle the reviewer
# ACTUALLY BOOTS — the playground's bundled image — not moodle/moodle's branch
# tip, which runs ahead of it.
#
# This check used to compare against the tip, with a comment claiming a stale
# entry could only cause a FALSE REFUSAL. That was wrong, and backwards. Core
# only ever increases $version, so gating on the tip pushes the table ABOVE the
# bundle: when core cuts 5.0.9 this check FAILS until the table says
# 2025041409, while the bundle is still 5.0.8. A plugin requiring 5.0.9 then
# passes the gate, boots, and installs NOTHING — the silent empty-Moodle
# failure the requires check exists to prevent. The check was manufacturing the
# bug it was meant to catch.
#
# Neither number here is hand-maintained:
#   base  (first 8 digits, fixed for the life of a branch) from core's version.php
#   point (the .N release) from the bundle's own manifest `release` field
# base + point = the version running in the browser.
#
# Prior art: WordPress's is_wp_version_compatible() reads wp_get_wp_version();
# Composer resolves against the live platform. Read what is running.
PLAYGROUND_HOST_URL="${PLAYGROUND_HOST:-https://daviducl.github.io/moodle-playground}"
if [[ -z "${SKIP_NET:-}" ]]; then
    DRIFT=$(HOST="$PLAYGROUND_HOST_URL" node -e '
import("./scripts/plugin-version.mjs").then(async (m) => {
  const problems = [];
  let checked = 0;
  const branches = Object.keys(m.MOODLE_BRANCH_VERSIONS);
  for (const [branch, recorded] of Object.entries(m.MOODLE_BRANCH_VERSIONS)) {
    let base, point;
    try {
      const res = await fetch(`https://raw.githubusercontent.com/moodle/moodle/${branch}/version.php`,
        { signal: AbortSignal.timeout(20000) });
      if (!res.ok) { console.log(`SKIP ${branch}: core HTTP ${res.status}`); continue; }
      const found = /\$version\s*=\s*([0-9]+)/.exec(await res.text());
      if (!found) { console.log(`SKIP ${branch}: no $version in core version.php`); continue; }
      // Point releases occupy the last two digits, so flooring to 100 gives the
      // branch base whatever point release the tip happens to sit on.
      base = Math.floor(Number(found[1]) / 100) * 100;
    } catch (e) { console.log(`SKIP ${branch}: ${e.message}`); continue; }
    try {
      const res = await fetch(`${process.env.HOST}/assets/manifests/${branch}.json`,
        { signal: AbortSignal.timeout(20000) });
      if (!res.ok) { console.log(`SKIP ${branch}: manifest HTTP ${res.status}`); continue; }
      const rel = (await res.json()).release;
      const parts = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(rel));
      if (!parts) { console.log(`SKIP ${branch}: unparseable release ${JSON.stringify(rel)}`); continue; }
      point = Number(parts[3] || 0);
    } catch (e) { console.log(`SKIP ${branch}: ${e.message}`); continue; }
    const running = base + point;
    if (running !== recorded) {
      problems.push(`${branch}: table says ${recorded}, the bundle runs ${running}`);
    }
    checked++;
  }
  if (problems.length) { console.log("DRIFT " + problems.join("; ")); process.exit(3); }
  // ALLOK only when every branch was actually checked. A bare "OK" after a
  // per-branch SKIP used to fall through to PASS and claim otherwise.
  console.log(checked === branches.length ? "ALLOK" : `PARTIAL ${checked}/${branches.length} branches checked`);
});
' 2>&1) || true
    if [[ "$DRIFT" == *DRIFT* ]]; then
        echo "CHECK 1h FAIL: version table does not match the bundle — $DRIFT"
        echo "               Update MOODLE_BRANCH_VERSIONS in scripts/plugin-version.mjs"
        echo "               to the version the BUNDLE runs, not moodle/moodle's tip."
        FAILED+=("1h: version table does not match the bundle")
    elif [[ "$DRIFT" != *"ALLOK"* && "$DRIFT" != *"PARTIAL"* && "$DRIFT" != *"SKIP"* ]]; then
        # Neither a verdict nor a waiver: the probe itself broke. This used to
        # fall through to PASS, certifying a check that never ran.
        echo "CHECK 1h FAIL: the check did not run — $DRIFT"
        FAILED+=("1h: the check did not run")
    elif [[ "$DRIFT" != *"ALLOK"* ]]; then
        echo "CHECK 1h WAIVED: could not reach core or the bundle manifest — table UNCHECKED"
        echo "                 ($DRIFT)"
    else
        echo "CHECK 1h PASS: version table matches the Moodle the bundle actually runs"
    fi
else
    echo "CHECK 1h SKIP: SKIP_NET set"
fi

# The vendored .mbz fixtures must still be what upstream serves.
#
# The unit suite now reads real Moodle backups from test/fixtures/mbz offline,
# which is better coverage — but it means a vendored copy that drifts from
# upstream would quietly become the only thing we ever test against. This
# compares byte-for-byte against moodle/moodle and fails if they differ, so the
# offline fixtures cannot rot into fiction.
#
# Both container formats are represented on purpose: 4 of 5 core 4.4 fixtures
# are tar.gz and one is a zip, so a reader that assumed either would pass a
# one-format check and reject a real backup.
if [[ -z "${SKIP_NET:-}" ]]; then
    MBZOUT=$(node -e '
import("./scripts/mbz.mjs").then(async (m) => {
  const RAW = "https://raw.githubusercontent.com/moodle/moodle/MOODLE_404_STABLE";
  // [path, expected format, expected type, expected modulenames, must be usable]
  const CASES = [
    ["completion/tests/fixtures/legacy_course_completion.mbz", "tar.gz", "course", ["assign"], true],
    ["admin/tool/uploadcourse/tests/fixtures/backup.mbz", "zip", "course", ["glossary"], true],
    ["mod/quiz/tests/fixtures/moodle_311_quiz.mbz", "tar.gz", "activity", ["quiz"], false],
  ];
  const problems = [];
  let checked = 0;
  for (const [path, format, type, mods, usable] of CASES) {
    let bytes;
    try {
      const res = await fetch(`${RAW}/${path}`, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) { console.log(`SKIP ${path}: HTTP ${res.status}`); continue; }
      bytes = Buffer.from(await res.arrayBuffer());
    } catch (e) { console.log(`SKIP ${path}: ${e.message}`); continue; }
    // Byte-for-byte against the vendored copy.
    try {
      const fs = await import("node:fs");
      const local = fs.readFileSync(`test/fixtures/mbz/${path.split("/").pop()}`);
      if (!local.equals(bytes)) {
        problems.push(`${path}: the vendored copy no longer matches upstream`);
      }
    } catch (e) {
      problems.push(`${path}: no vendored copy to compare (${e.code || e.message})`);
    }
    const info = m.inspectMbz(bytes);
    if (!info.ok) { problems.push(`${path}: unreadable — ${info.reason}`); continue; }
    if (info.format !== format) problems.push(`${path}: read as ${info.format}, expected ${format}`);
    if (info.type !== type) problems.push(`${path}: type ${info.type}, expected ${type}`);
    if (JSON.stringify(info.modulenames) !== JSON.stringify(mods)) {
      problems.push(`${path}: modules ${JSON.stringify(info.modulenames)}, expected ${JSON.stringify(mods)}`);
    }
    // The one that matters: an activity backup must be REFUSED, because
    // restoring it leaves a normal-looking site with no course.
    const verdict = m.checkCourseBackup(bytes);
    if (verdict.ok !== usable) {
      problems.push(`${path}: checkCourseBackup said ${verdict.ok}, expected ${usable}`);
    }
    checked++;
  }
  if (problems.length) { console.log("DRIFT " + problems.join("; ")); process.exit(3); }
  console.log(checked === CASES.length ? "ALLOK" : `PARTIAL ${checked}/${CASES.length} fixtures checked`);
});
' 2>&1) || true
    if [[ "$MBZOUT" == *DRIFT* ]]; then
        echo "CHECK 1t FAIL: the .mbz reader disagrees with real Moodle backups — $MBZOUT"
        FAILED+=("1t: .mbz reader disagrees with real backups")
    elif [[ "$MBZOUT" != *"ALLOK"* && "$MBZOUT" != *"PARTIAL"* && "$MBZOUT" != *"SKIP"* ]]; then
        echo "CHECK 1t FAIL: the check did not run — $MBZOUT"
        FAILED+=("1t: the check did not run")
    elif [[ "$MBZOUT" != *"ALLOK"* ]]; then
        echo "CHECK 1t WAIVED: could not fetch every core fixture — reader UNCHECKED against real backups"
        echo "                 ($MBZOUT)"
    else
        echo "CHECK 1t PASS: vendored .mbz fixtures match upstream, and the reader agrees"
    fi
else
    echo "CHECK 1t SKIP: SKIP_NET set"
fi

# The PHP-per-branch tables. Two comments in build-preview.mjs claimed these
# were covered — one named check 1m (which is the accepted-origins check) and
# one named "check 1n", WHICH DID NOT EXIST. Nothing checked PHP_FOR_BRANCH or
# PHP_BY_BRANCH at all. A comment asserting a guard exists is worse than no
# comment, because the next person trusts it. This is that check.
#
# Source is Moodle's own admin/environment.xml, and the block is chosen by the
# release the BUNDLE runs (from the manifest, as check 1h does) — not the
# newest block in the file, which is a future Moodle: on MOODLE_404_STABLE the
# newest block is 5.2 and demands PHP 8.3, while Moodle 4.4 itself needs 8.1.
if [[ -z "${SKIP_NET:-}" ]]; then
    PHPDRIFT=$(HOST="$PLAYGROUND_HOST_URL" node -e '
import("./scripts/build-preview.mjs").then(async (bp) => {
  const pv = await import("./scripts/plugin-version.mjs");
  const problems = [];
  let checked = 0;
  const branches = Object.keys(pv.MOODLE_BRANCH_VERSIONS);
  // Both tables must cover exactly the branches we offer, or a branch silently
  // has no PHP policy at all.
  for (const b of branches) {
    if (!bp.PHP_BY_BRANCH[b]) problems.push(`${b}: absent from PHP_BY_BRANCH`);
    if (!bp.PHP_FOR_BRANCH[b]) problems.push(`${b}: absent from PHP_FOR_BRANCH`);
  }
  for (const b of Object.keys(bp.PHP_BY_BRANCH)) {
    if (!branches.includes(b)) problems.push(`${b}: in PHP_BY_BRANCH but not an offered branch`);
  }
  for (const b of branches) {
    const list = bp.PHP_BY_BRANCH[b];
    const dflt = bp.PHP_FOR_BRANCH[b];
    if (!list || !dflt) continue;
    // The default must be selectable, or the summary names a PHP the form
    // cannot produce.
    if (!list.includes(dflt)) problems.push(`${b}: default ${dflt} is not in ${JSON.stringify(list)}`);
    let release;
    try {
      const res = await fetch(`${process.env.HOST}/assets/manifests/${b}.json`, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) { console.log(`SKIP ${b}: manifest HTTP ${res.status}`); continue; }
      release = /^(\d+)\.(\d+)/.exec(String((await res.json()).release));
      if (!release) { console.log(`SKIP ${b}: unparseable release`); continue; }
    } catch (e) { console.log(`SKIP ${b}: ${e.message}`); continue; }
    const want = `${release[1]}.${release[2]}`;
    let xml;
    try {
      const res = await fetch(`https://raw.githubusercontent.com/moodle/moodle/${b}/admin/environment.xml`, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) { console.log(`SKIP ${b}: environment.xml HTTP ${res.status}`); continue; }
      xml = await res.text();
    } catch (e) { console.log(`SKIP ${b}: ${e.message}`); continue; }
    // The <MOODLE version="X.Y"> block for the release the bundle runs.
    const block = new RegExp(`<MOODLE[^>]*version="${want.replace(".", "\\.")}"[\\s\\S]*?</MOODLE>`).exec(xml);
    if (!block) { console.log(`SKIP ${b}: no MOODLE block for ${want}`); continue; }
    const req = /<PHP[^>]*version="([0-9.]+)"/.exec(block[0]);
    if (!req) { console.log(`SKIP ${b}: no PHP requirement in the ${want} block`); continue; }
    const [rMaj, rMin] = req[1].split(".").map(Number);
    const lowest = list.map((v) => v.split(".").map(Number)).sort((a, z) => a[0] - z[0] || a[1] - z[1])[0];
    if (lowest[0] < rMaj || (lowest[0] === rMaj && lowest[1] < rMin)) {
      problems.push(`${b}: offers PHP ${lowest.join(".")} but Moodle ${want} requires >= ${req[1]}`);
    }
    // The UPPER bound. Moodle declares unsupported majors in the same <PHP>
    // block as `<RESTRICT function="restrict_php_version_84">` — measured: 4.4
    // and 4.5 restrict 8.4, 5.0 restricts nothing. Without this, adding "8.4"
    // to the 4.4 list stayed GREEN while Moodle 4.4 rejects it and the
    // playground silently substitutes 8.3 — the exact substitution the
    // php-version input promises to refuse rather than perform.
    const phpBlock = /<PHP[^>]*>[\s\S]*?<\/PHP>/.exec(block[0]);
    const restricted = new Set(
      [...(phpBlock ? phpBlock[0] : "").matchAll(/restrict_php_version_(\d)(\d)/g)].map(
        (mm) => `${mm[1]}.${mm[2]}`,
      ),
    );
    for (const v of list) {
      if (restricted.has(v)) {
        problems.push(`${b}: offers PHP ${v}, which Moodle ${want} declares unsupported`);
      }
    }
    checked++;
  }
  if (problems.length) { console.log("DRIFT " + problems.join("; ")); process.exit(3); }
  // ALLOK only when every branch was actually checked. A bare "OK" after a
  // per-branch SKIP used to fall through to PASS and claim otherwise.
  console.log(checked === branches.length ? "ALLOK" : `PARTIAL ${checked}/${branches.length} branches checked`);
});
' 2>&1) || true
    if [[ "$PHPDRIFT" == *DRIFT* ]]; then
        echo "CHECK 1n FAIL: PHP-per-branch tables are wrong — $PHPDRIFT"
        FAILED+=("1n: PHP-per-branch tables are wrong")
    elif [[ "$PHPDRIFT" != *"ALLOK"* && "$PHPDRIFT" != *"PARTIAL"* && "$PHPDRIFT" != *"SKIP"* ]]; then
        echo "CHECK 1n FAIL: the check did not run — $PHPDRIFT"
        FAILED+=("1n: the check did not run")
    elif [[ "$PHPDRIFT" != *"ALLOK"* ]]; then
        echo "CHECK 1n WAIVED: could not reach core or the manifest — PHP tables UNCHECKED"
        echo "                 ($PHPDRIFT)"
    else
        echo "CHECK 1n PASS: every offered PHP satisfies the Moodle the bundle runs"
    fi
else
    echo "CHECK 1n SKIP: SKIP_NET set"
fi

# The core-component list is fetched per branch at build time rather than
# shipped as a table (see fetchCoreComponents). This proves the real fetch
# still works and still returns a list Moodle would recognise — a silent
# failure would fail OPEN and stop refusing core collisions altogether.
if [[ -z "${SKIP_NET:-}" ]]; then
    CORE=$(node -e '
import("./scripts/plugin-version.mjs").then(async (m) => {
  const problems = [];
  let checked = 0;
  const branches = Object.keys(m.MOODLE_BRANCH_VERSIONS);
  for (const branch of Object.keys(m.MOODLE_BRANCH_VERSIONS)) {
    const core = await m.fetchCoreComponents(branch);
    if (!core.ok) { console.log(`SKIP ${branch}: ${core.reason}`); continue; }
    // Anchors: components core has shipped for over a decade. If these are
    // missing the file moved or changed shape and the check is not checking.
    for (const c of ["mod_assign", "mod_quiz", "theme_boost", "block_html"]) {
      if (!core.standard.has(c)) problems.push(`${branch}: ${c} missing from standard`);
    }
    if (m.checkNotCoreComponent("mod", "assign", core).ok) {
      problems.push(`${branch}: mod_assign was NOT refused`);
    }
    if (!m.checkNotCoreComponent("mod", "coursework", core).ok) {
      problems.push(`${branch}: mod_coursework was wrongly refused`);
    }
    checked++;
  }
  if (problems.length) { console.log("DRIFT " + problems.join("; ")); process.exit(3); }
  // ALLOK only when every branch was actually checked. A bare "OK" after a
  // per-branch SKIP used to fall through to PASS and claim otherwise.
  console.log(checked === branches.length ? "ALLOK" : `PARTIAL ${checked}/${branches.length} branches checked`);
});
' 2>&1) || true
    if [[ "$CORE" == *DRIFT* ]]; then
        echo "CHECK 1p FAIL: core-component list is not usable — $CORE"
        FAILED+=("1p: core-component list is not usable")
    elif [[ "$CORE" != *"ALLOK"* && "$CORE" != *"PARTIAL"* && "$CORE" != *"SKIP"* ]]; then
        # Neither a verdict nor a waiver: the probe itself broke. This used to
        # fall through to PASS, certifying a check that never ran.
        echo "CHECK 1p FAIL: the check did not run — $CORE"
        FAILED+=("1p: the check did not run")
    elif [[ "$CORE" != *"ALLOK"* ]]; then
        echo "CHECK 1p WAIVED: could not reach lib/plugins.json — core collisions UNCHECKED"
        echo "                 ($CORE)"
    else
        echo "CHECK 1p PASS: core-component list fetches and refuses core collisions"
    fi
else
    echo "CHECK 1p SKIP: SKIP_NET set"
fi

# A `choice` input has no unset state, so one option has to MEAN "unset". That
# token is now a single reserved string resolved in JS (DEFAULT_SENTINEL), not
# an English sentence compared inside a `${{ }}` ternary. The ternaries are
# gone; this stops them coming back, and stops the YAML token drifting away
# from the JS one — nothing else would notice, because a `${{ }}` expression is
# not reachable by the test suite or the mutation harness.
SENTINEL=$(node -e 'import("./scripts/build-preview.mjs").then(m=>process.stdout.write(m.DEFAULT_SENTINEL))')
SENT_PROBLEMS=""
if [[ -z "$SENTINEL" ]]; then
    SENT_PROBLEMS="build-preview.mjs exports no DEFAULT_SENTINEL"
else
    # Every choice input whose default is not a real value must use the token.
    while IFS= read -r line; do
        SENT_PROBLEMS+="a choice input still defaults to prose, not $SENTINEL: $line; "
    done < <(grep -rnE '^ *default: *(default for|derive from|none|blank|unset|auto)' .github/workflows/*.yml || true)
    # And the token the YAML uses must be the token the JS resolves — in BOTH
    # directions. The first version hardcoded "(default)" in the grep, so
    # editing the YAML token while leaving DEFAULT_SENTINEL alone matched
    # nothing and passed: exactly the drift the check exists to prevent.
    # Every choice input that offers an unset option must offer THIS token.
    while IFS= read -r f; do
        # Options that look like a reserved token: parenthesised, not a value.
        # sed, not `tr -d ' -"'` — in tr that dash is a RANGE (space to \"), so it
        # strips nothing and every token keeps its leading "- ", never matching.
        STRAY=$(grep -oE '^ *- *"?\([a-z-]+\)"?' "$f" | sed -E 's/^ *- *"?//; s/"?$//' | sort -u || true)
        for tok in $STRAY; do
            [[ "$tok" == "$SENTINEL" ]] || SENT_PROBLEMS+="$f offers option '$tok' but JS resolves '$SENTINEL'; "
        done
        # And if the JS token is offered nowhere, the resolution is dead code.
        grep -qF -- "$SENTINEL" "$f" && SENTINEL_SEEN=1
    done < <(ls .github/workflows/*.yml)
    [[ -n "${SENTINEL_SEEN:-}" ]] || SENT_PROBLEMS+="no workflow offers '$SENTINEL', so opt() resolves a token nothing sends; "
fi
if [[ -n "$SENT_PROBLEMS" ]]; then
    echo "CHECK 1q FAIL: $SENT_PROBLEMS"
    FAILED+=("1q: default-sentinel drift")
else
    echo "CHECK 1q PASS: the unset-choice token is '$SENTINEL' in both the YAML and the JS"
fi

# No `${{ }}` inside a `run:` block, anywhere. GitHub pastes the expression into
# the shell BEFORE the shell parses it, so a value containing a quote or a
# backtick is executed on the runner. With free-text fields on the dispatch
# form that is an injection surface, and it is also where the sentinel
# ternaries used to live. Inputs reach `run:` through `env:` instead.
RUN_INTERP=$(node -e '
import("node:fs").then(async (fs) => {
  // Composite actions have run: blocks too, and the same injection risk. The
  // first version of this check scanned only .github/workflows and would have
  // passed a compromised action.yml.
  const files = fs
    .readdirSync(".github/workflows")
    .filter((f) => f.endsWith(".yml"))
    .map((f) => `.github/workflows/${f}`)
    .concat(["action.yml", "preview/action.yml"].filter((f) => fs.existsSync(f)));
  const bad = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, "utf8").split("\n");
    let indent = -1;
    for (const [i, line] of lines.entries()) {
      if (indent >= 0) {
        const here = line.search(/\S/);
        // Blank lines belong to the block; a line at or left of the `run:` key
        // ends it.
        if (here >= 0 && here <= indent) indent = -1;
        else if (line.includes("${{")) bad.push(`${f}:${i + 1}: ${line.trim().slice(0, 60)}`);
      }
      if (indent < 0 && /^\s*run: *[|>]/.test(line)) indent = line.search(/\S/);
      else if (indent < 0 && /^\s*run: /.test(line) && line.includes("${{")) {
        bad.push(`${f}:${i + 1}: ${line.trim().slice(0, 60)}`);
      }
    }
  }
  console.log(bad.length ? "BAD " + bad.join(" | ") : "OK");
});
' 2>&1) || true
if [[ "$RUN_INTERP" == BAD* ]]; then
    echo "CHECK 1r FAIL: \${{ }} interpolated into a run: block — ${RUN_INTERP#BAD }"
    echo "               Pass the value through env: and read it as a shell variable."
    FAILED+=("1r: \${{ }} inside a run: block")
else
    echo "CHECK 1r PASS: no \${{ }} is interpolated into any run: block"
fi

# The gate does not run the program. Every other check here reads a hand-made
# fixture or calls buildBlueprint() directly, so the real path
#   form input -> action.yml env: -> main() -> blueprint / URL / summary
# is never traversed. It was proved twice that this matters: gutting
# writeSummary left the whole suite green, and rewiring two env vars in
# action.yml passed the entire gate. Mutants test FUNCTIONS; this tests WIRING.
# Output is held back unless it fails: check() prints the verdict, and the
# script's own success line would just duplicate it.
PROBE_OUT=$(python3 scripts/probe-controls.py 2>&1); PROBE_RC=$?
[[ $PROBE_RC -eq 0 ]] || echo "$PROBE_OUT"
check $PROBE_RC 1o "every declared input reaches the artifact it claims to, at its own field"

# ...and prove the probe harness itself fires. Point it at a copy of the action
# that declares a control with no probe row; if that passes, 1o is decoration.
PROBE_TMP=$(mktemp -d)
python3 - "$PROBE_TMP/action.yml" <<'PY_PROBE'
import sys
src = open("preview/action.yml").read()
# A new control, declared and documented, wired to nothing and covered by no row.
open(sys.argv[1], "w").write(
    src.replace("  data-hosts:", "  probe-selftest-control:\n    description: \"planted\"\n    required: false\n  data-hosts:", 1)
)
PY_PROBE
# Assert on WHAT it says, not merely that it exited non-zero: an ImportError or
# a syntax error also exits non-zero, and would have read as "the check fires"
# while check 1o was hard-failing for an unrelated reason.
SELF_OUT=$(PROBE_ACTION="$PROBE_TMP/action.yml" python3 scripts/probe-controls.py 2>&1)
SELF_RC=$?
if [[ $SELF_RC -eq 0 ]]; then
    echo "CHECK 1o-self FAIL: the probe harness PASSED an action with an uncovered control"
    FAILED+=("1o-self: the probe harness does not fire")
elif [[ "$SELF_OUT" != *"probe-selftest-control"* ]]; then
    echo "CHECK 1o-self FAIL: the harness failed for the WRONG reason — $SELF_OUT"
    FAILED+=("1o-self: harness failed for an unrelated reason")
else
    echo "CHECK 1o-self PASS: the probe harness names the uncovered control"
fi
rm -rf "$PROBE_TMP"

# ...and prove the SHAPE branch of the harness fires, which is a different code
# path from the one above. 1o-self plants an uncovered control and proves the
# table is complete; this plants a WRONG expectation in a row that exists, and
# proves the comparison behind it. Three controls now depend on that branch
# (extra-plugins, sample-content, theme) and until this it had never been seen
# to fail. Uses PROBE_TABLE, which was already there and unused.
SHAPE_TMP=$(mktemp -d)
python3 - "$SHAPE_TMP/probes.json" <<'PY_SHAPE'
import json, sys
table = json.load(open("test/fixtures/control-probes.json"))
for row in table["probes"]:
    if row["input"] == "theme":
        # The theme is installed, activated, and proved active. Claim it is
        # merely installed: a harness that is not really comparing the step
        # list will accept that.
        row["expect_steps_added"] = ["installMoodlePlugin"]
        break
else:
    sys.exit("1u/shape plant: no theme row to break")
json.dump(table, open(sys.argv[1], "w"))
PY_SHAPE
if [[ $? -ne 0 ]]; then
    echo "CHECK 1o-shape FAIL: the plant could not be built"
    FAILED+=("1o-shape: the plant could not be built")
else
    SHAPE_OUT=$(PROBE_TABLE="$SHAPE_TMP/probes.json" python3 scripts/probe-controls.py 2>&1)
    SHAPE_RC=$?
    if [[ $SHAPE_RC -eq 0 ]]; then
        echo "CHECK 1o-shape FAIL: the harness ACCEPTED a row declaring the wrong steps"
        FAILED+=("1o-shape: the step-list comparison does not fire")
    elif [[ "$SHAPE_OUT" != *"theme"* || "$SHAPE_OUT" != *"setTheme"* ]]; then
        echo "CHECK 1o-shape FAIL: it failed for the WRONG reason — $SHAPE_OUT"
        FAILED+=("1o-shape: failed for an unrelated reason")
    else
        echo "CHECK 1o-shape PASS: the step-list comparison names the row and the missing step"
    fi
fi
rm -rf "$SHAPE_TMP"

# ...and prove the third branch: `expect_paths` is now a floor as well as a
# ceiling. It used to be a ceiling only, so a row could declare a field the
# control had stopped touching and still pass — the table would read as the
# record of what each control changes while no longer being one. The check and
# this plant ship together: an unverified checker is this project's own recorded
# failure mode, twice.
#
# BOTH the table and the action are trimmed to the single row under test. The
# coverage check runs first and returns early, so a trimmed table against the
# real action would fail with "has no probe row" for nineteen other inputs —
# the wrong reason, and a plant that fails for the wrong reason proves nothing.
# Trimming also takes this plant from ~13s to under 1s; the mutation harness has
# already made CI time the scarce thing here.
UNMET_TMP=$(mktemp -d)
if python3 - "$UNMET_TMP" <<'PY_UNMET'
import json, sys, yaml
out = sys.argv[1]
table = json.load(open("test/fixtures/control-probes.json"))
row = next((r for r in table["probes"] if r["input"] == "sections"), None)
if row is None:
    sys.exit("1o-unmet plant: no sections row")
# A field `sections` demonstrably does not touch. Declared but never observed is
# exactly the stale-row shape.
row["expect_paths"] = sorted(set(row["expect_paths"]) | {"steps[*].bogusField"})
table["probes"] = [row]
json.dump(table, open(f"{out}/probes.json", "w"))
# Derived from the real action, never hand-written: a hand-written copy drifts
# from the file it stands in for and the plant starts testing a fiction.
action = yaml.safe_load(open("preview/action.yml"))
action["inputs"] = {k: v for k, v in action["inputs"].items() if k == "sections"}
yaml.safe_dump(action, open(f"{out}/action.yml", "w"))
PY_UNMET
then
    UNMET_OUT=$(PROBE_TABLE="$UNMET_TMP/probes.json" PROBE_ACTION="$UNMET_TMP/action.yml" \
        python3 scripts/probe-controls.py 2>&1)
    UNMET_RC=$?
    if [[ $UNMET_RC -eq 0 ]]; then
        echo "CHECK 1o-unmet FAIL: the harness ACCEPTED a row declaring a field the control never changes"
        FAILED+=("1o-unmet: expect_paths is still a ceiling only")
    # The field name deliberately shares no substring with the row name, so
    # each half of this assertion is earned separately. It used to be
    # "numsectionsXX", which contains "sections" — the row-naming half passed
    # even with the row name stripped out of the message.
    elif [[ "$UNMET_OUT" != *"sections: declares fields"* || "$UNMET_OUT" != *"bogusField"* ]]; then
        echo "CHECK 1o-unmet FAIL: it failed for the WRONG reason — $UNMET_OUT"
        FAILED+=("1o-unmet: failed for an unrelated reason")
    else
        echo "CHECK 1o-unmet PASS: a declared-but-unchanged field names the row and the field"
    fi
else
    echo "CHECK 1o-unmet FAIL: the plant could not be built"
    FAILED+=("1o-unmet: the plant could not be built")
fi
rm -rf "$UNMET_TMP"

# ...and the fourth branch: two controls that produce the IDENTICAL blueprint
# diff are two names for one thing. That is the env-swap bug — `MOODLE_BRANCH:
# ${{ inputs.built-by }}` — which once passed a 17-check gate.
#
# `teachers` and `students` are the first pair whose paths legitimately OVERLAP
# (both write steps[*].users and steps[*].enrolments), which is why the
# comparison is on diffed VALUES rather than path sets. Until this control
# landed, that branch had never been exercised by a real pair and had never been
# seen to fail. Plant the bug it exists to catch: make TEACHERS drive the
# student count, so both inputs produce the same diff.
#
# The plant asserts on the WORDING, not the exit code. The theme round cost two
# red gates by matching an error's phrasing in one place and its step in
# another; here the requirement is that the message NAMES BOTH INPUTS, because
# a reader who is told only "two controls collide" has to guess which.
OVERLAP_TMP=$(mktemp -d)
if python3 - "$OVERLAP_TMP" <<'PY_OVERLAP'
import json, shutil, sys, yaml
out = sys.argv[1]
table = json.load(open("test/fixtures/control-probes.json"))
keep = {"teachers", "students"}
rows = [r for r in table["probes"] if r["input"] in keep]
if len(rows) != 2:
    sys.exit(f"1o-overlap plant: expected rows for {keep}, found {[r['input'] for r in rows]}")
table["probes"] = rows
json.dump(table, open(f"{out}/probes.json", "w"))
action = yaml.safe_load(open("preview/action.yml"))
action["inputs"] = {k: v for k, v in action["inputs"].items() if k in keep}
yaml.safe_dump(action, open(f"{out}/action.yml", "w"))
# THE BUG: `teachers` stops driving the teacher count and drives the STUDENT
# count instead, landing on the same 5 the students row probes with. Both
# substitutions are needed. With only the second, the teachers probe still
# changes the teacher count too, the two diffs differ, and the plant passes
# while proving nothing — which is what the first draft of it did.
shutil.copytree("scripts", f"{out}/scripts")
src = open("scripts/build-preview.mjs").read()
for old, new in [
    ('  const teachers = count("teachers");',
     "  const teachers = COUNT_INPUTS.teachers.fallback;"),
    ('  const students = count("students");',
     '  const students = count("teachers") > 1 ? 5 : count("students");'),
]:
    if src.count(old) != 1:
        sys.exit(f"1o-overlap plant: anchor moved, update the plant: {old}")
    src = src.replace(old, new, 1)
open(f"{out}/scripts/build-preview.mjs", "w").write(src)
PY_OVERLAP
then
    # Run the checker FROM the patched copy: ROOT comes from __file__ and the
    # builder is invoked with cwd=ROOT, so this needs no new hook in the
    # checker itself — the copy is the repo as far as it is concerned.
    OVERLAP_OUT=$(PROBE_TABLE="$OVERLAP_TMP/probes.json" PROBE_ACTION="$OVERLAP_TMP/action.yml" \
        python3 "$OVERLAP_TMP/scripts/probe-controls.py" 2>&1)
    OVERLAP_RC=$?
    if [[ $OVERLAP_RC -eq 0 ]]; then
        echo "CHECK 1o-overlap FAIL: the harness ACCEPTED two controls wired to the same thing"
        FAILED+=("1o-overlap: the identical-diff comparison does not fire")
    # ONE line, not three greps over the whole output. The plant also provokes
    # two unrelated problems that mention "teachers", so asserting on the tokens
    # separately passed even when the message named a single control.
    elif [[ "$OVERLAP_OUT" != *"students and teachers produce an identical blueprint diff"* ]]; then
        echo "CHECK 1o-overlap FAIL: it failed for the WRONG reason — $OVERLAP_OUT"
        FAILED+=("1o-overlap: failed for an unrelated reason")
    else
        echo "CHECK 1o-overlap PASS: two controls with one wiring are named, both of them"
    fi
else
    echo "CHECK 1o-overlap FAIL: the plant could not be built"
    FAILED+=("1o-overlap: the plant could not be built")
fi
rm -rf "$OVERLAP_TMP"

# Every action/workflow file must parse, and every output the preview script
# sets must be DECLARED by the action — an undeclared output silently arrives
# as an empty string in the caller's comment. (The action itself is only truly
# exercised by .github/workflows/preview-selftest.yml, which needs a runner.)
python3 - <<'PY_YAML'
import sys, re, pathlib
try:
    import yaml
except ImportError:
    print('pyyaml unavailable — skipping YAML contract check'); sys.exit(0)
root = pathlib.Path('.')
for f in list(root.glob('.github/workflows/*.yml')) + [root/'action.yml', root/'preview'/'action.yml']:
    yaml.safe_load(f.read_text())
declared = set(yaml.safe_load((root/'preview'/'action.yml').read_text())['outputs'])
emitted = set(re.findall(r'setOutput\("([a-z-]+)"',
                         (root/'scripts'/'build-preview.mjs').read_text()))
missing = emitted - declared
if missing:
    print('outputs set by build-preview.mjs but not declared in preview/action.yml:', sorted(missing))
    sys.exit(1)

# The other direction: a workflow that reads steps.<id>.outputs.<name> for a
# name the action does not declare gets an EMPTY STRING, not an error. That is
# how a status ends up reading "... as " with nothing after it, or a comment
# step posts an empty body. Catch the typo here rather than on a real commit.
bad = []
for f in list(root.glob('.github/workflows/*.yml')) + list(root.glob('examples/*.yml')):
    text = f.read_text()
    for name in set(re.findall(r'steps\.preview\.outputs\.([A-Za-z0-9_-]+)', text)):
        if name not in declared:
            bad.append(f'{f}: steps.preview.outputs.{name}')
if bad:
    print('workflows read outputs preview/action.yml does not declare:')
    for b in sorted(bad):
        print('   ', b)
    sys.exit(1)
PY_YAML
check $? 1g "every action/workflow parses and declares the outputs it emits"

# A box on a dispatch form is declared in one place and consumed in another, by
# hand. Drop the consuming line and the box still renders, the run still goes
# green, and what the reviewer typed is discarded without a word — the same
# normal-looking-Moodle symptom that every other silent failure here produces.
# Nothing read .github/workflows/ for this before: probe-controls.py opens
# preview/action.yml and stops, and 1g checks OUTPUTS. See the script header for
# why the rule is "referenced somewhere" rather than "forwarded as a `with:` key
# of the same name" — the narrow rule needs an exempt list on day one.
FWD_OUT=$(python3 scripts/check-forwarding.py 2>&1); FWD_RC=$?
echo "$FWD_OUT"
check $FWD_RC 1u "every box on a dispatch form is read by its workflow"

# ...and prove 1u itself fires. Plant a copy of the plugin form with one
# forwarding line deleted and require the check to FAIL NAMING that input.
# Asserting on what it says, not merely on a non-zero exit: a syntax error also
# exits non-zero and would read as "the check fires" while it was broken.
FWD_TMP=$(mktemp -d)
python3 - "$FWD_TMP/planted.yml" <<'PY_FWD'
import sys
src = open(".github/workflows/preview-a-plugin.yml").read()
# `sections` is forwarded in exactly one place, so deleting that line leaves the
# box declared and read by nothing — the precise bug 1u exists to catch.
planted = src.replace("          sections: ${{ inputs.sections }}\n", "", 1)
if planted == src:
    sys.exit("1u-self: could not plant — the sections forwarding line has moved")
open(sys.argv[1], "w").write(planted)
PY_FWD
if [[ $? -ne 0 ]]; then
    echo "CHECK 1u-self FAIL: the plant could not be built"
    FAILED+=("1u-self: the plant could not be built")
else
    SELF_FWD=$(FORWARD_WORKFLOWS="$FWD_TMP/planted.yml" python3 scripts/check-forwarding.py 2>&1)
    SELF_FWD_RC=$?
    if [[ $SELF_FWD_RC -eq 0 ]]; then
        echo "CHECK 1u-self FAIL: 1u PASSED a form whose input is wired to nothing"
        FAILED+=("1u-self: the forwarding check does not fire")
    elif [[ "$SELF_FWD" != *'"sections"'* ]]; then
        echo "CHECK 1u-self FAIL: it failed for the WRONG reason — $SELF_FWD"
        FAILED+=("1u-self: failed for an unrelated reason")
    else
        echo "CHECK 1u-self PASS: 1u names the input that is wired to nothing"
    fi
fi

# ...and the second thing 1u claims: two boxes crossed. Plant a form that hands
# `theme` the value of `extra-plugins` — both names are still referenced, so the
# rule above is satisfied and only the cross-wiring rule can catch it.
python3 - "$FWD_TMP/crossed.yml" <<'PY_CROSS'
import sys
src = open(".github/workflows/preview-a-plugin.yml").read()
planted = src.replace(
    "          theme: ${{ inputs.theme }}\n",
    "          theme: ${{ inputs.extra-plugins }}\n          landing-path: ${{ inputs.theme }}\n",
    1,
)
if planted == src:
    sys.exit("1u-self: could not plant — the theme forwarding line has moved")
open(sys.argv[1], "w").write(planted)
PY_CROSS
if [[ $? -ne 0 ]]; then
    echo "CHECK 1u-cross FAIL: the plant could not be built"
    FAILED+=("1u-cross: the plant could not be built")
else
    CROSS_OUT=$(FORWARD_WORKFLOWS="$FWD_TMP/crossed.yml" python3 scripts/check-forwarding.py 2>&1)
    CROSS_RC=$?
    if [[ $CROSS_RC -eq 0 ]]; then
        echo "CHECK 1u-cross FAIL: 1u PASSED a form with two boxes crossed"
        FAILED+=("1u-cross: the cross-wiring check does not fire")
    elif [[ "$CROSS_OUT" != *"crossed"* ]]; then
        echo "CHECK 1u-cross FAIL: it failed for the WRONG reason — $CROSS_OUT"
        FAILED+=("1u-cross: failed for an unrelated reason")
    else
        echo "CHECK 1u-cross PASS: 1u names the two boxes that were crossed"
    fi
fi
rm -rf "$FWD_TMP"

# A push workflow that defines ONLY tags/tags-ignore never runs on a branch
# push. GitHub: "If you define only tags/tags-ignore or only branches/
# branches-ignore, the workflow won't run for events affecting the undefined
# Git ref." There is no error and no run — the workflow is simply silent,
# which is indistinguishable from "nothing changed". Shipped exactly that in
# commit-preview.yml and only noticed because the dogfood produced no run.
python3 - <<'PY_TRIG'
import sys, pathlib
try:
    import yaml
except ImportError:
    print('pyyaml unavailable — skipping trigger check'); sys.exit(0)
bad = []
for f in list(pathlib.Path('.').glob('.github/workflows/*.yml')) + list(pathlib.Path('.').glob('examples/*.yml')):
    doc = yaml.safe_load(f.read_text()) or {}
    # `on:` parses as the boolean True in YAML 1.1.
    on = doc.get('on', doc.get(True)) or {}
    push = on.get('push') if isinstance(on, dict) else None
    if not isinstance(push, dict):
        continue
    has_tags = any(k in push for k in ('tags', 'tags-ignore'))
    has_branches = any(k in push for k in ('branches', 'branches-ignore'))
    if has_tags and not has_branches:
        bad.append(f'{f}: on.push defines {sorted(k for k in push if "tag" in k)} '
                   f'but no branches filter — will NOT run on branch pushes')
if bad:
    print('workflows that silently never run on a branch push:')
    for b in bad:
        print('   ', b)
    sys.exit(1)
PY_TRIG
check $? 1i "no push workflow disables itself with a tags-only filter"

# The default playground host is written twice — preview/action.yml (what a
# consumer gets) and build-preview.mjs (what a direct `node scripts/...` run
# gets). If they drift, local testing and CI silently target different builds.
python3 - <<'PY_HOST'
import sys, re, pathlib
try:
    import yaml
except ImportError:
    print('pyyaml unavailable — skipping host default check'); sys.exit(0)
action = yaml.safe_load(pathlib.Path('preview/action.yml').read_text())
declared = action['inputs']['playground-host']['default']
m = re.search(r'PLAYGROUND_HOST \|\| "([^"]+)"', pathlib.Path('scripts/build-preview.mjs').read_text())
if not m:
    print('could not find the PLAYGROUND_HOST fallback in build-preview.mjs'); sys.exit(1)
if m.group(1) != declared:
    print(f'default host drift: action.yml={declared!r} build-preview.mjs={m.group(1)!r}')
    sys.exit(1)
# Third place the host can hide: a workflow that hardcodes it. preview-selftest.yml
# asserted a literal `https://moodle-playground.com/?blueprint=` and so began
# failing the moment the default moved to a playground on a SUBPATH — invisible
# to this gate, because a composite action only runs on a runner.
root = pathlib.Path('.')
bad = []
for f in list(root.glob('.github/workflows/*.yml')) + list(root.glob('examples/*.yml')):
    text = f.read_text()
    for host in re.findall(r'https://[A-Za-z0-9.-]+(?:/[A-Za-z0-9._-]+)*(?=[/?"\s])', text):
        if 'playground' not in host:
            continue          # not a playground reference
        if host.rstrip('/') == declared.rstrip('/'):
            continue          # the current default, stated deliberately
        bad.append(f'{f}: hardcodes {host}')
if bad:
    print('workflows hardcode a playground host that is not the default:')
    for b in sorted(set(bad)):
        print('   ', b)
    print(f'    (default is {declared} — derive it from preview/action.yml instead)')
    sys.exit(1)
print(f'default host: {declared}')
PY_HOST
check $? 1j "the default playground host is the same in the action and the script"

# `accepted-origins` WIDENS a1_nav: the boot may finish on playground-host OR
# anything listed there (assert.mjs:142-147). It once defaulted to the
# ateeducacion origin, from when playground-host defaulted to
# moodle-playground.com which 301s there. After the host default moved to our
# own build, every default run was quietly accepting a boot that ended on a
# third party's origin — exactly what a1_nav exists to catch. The two defaults
# must stay coherent: extra origins are only ever needed for a host that
# redirects.
python3 - <<'PY_ORIGINS'
import sys, pathlib
try:
    import yaml
except ImportError:
    print('pyyaml unavailable — skipping origin-default check'); sys.exit(0)
inputs = yaml.safe_load(pathlib.Path('action.yml').read_text())['inputs']
host = (inputs['playground-host'].get('default') or '').strip()
extra = [o.strip() for o in (inputs['accepted-origins'].get('default') or '').split(',') if o.strip()]
# A host that does NOT redirect needs no extra origins. Only the public apex is
# known to 301 elsewhere; anything else defaulting to extras is drift.
REDIRECTS = ('https://moodle-playground.com',)
if extra and not host.startswith(REDIRECTS):
    print(f'accepted-origins defaults to {extra} but playground-host defaults to {host},')
    print('which does not redirect — every default run would accept a boot ending elsewhere.')
    sys.exit(1)
print(f'host {host or "(none)"}, extra origins {extra or "(none)"}')
PY_ORIGINS
check $? 1m "the default accepted-origins does not widen the origin check"

# The silent failure the default exists to avoid: a link built for a step the
# TARGET host does not implement boots a Moodle without it, with no error.
# Both deployments serve their schema as a plain file, so ask the host what it
# supports. Fetched content is checked to BE a schema first — moodle-playground.com
# 301s to another origin and STRIPS THE PATH, so a naive fetch gets the
# homepage with HTTP 200 and every step looks unsupported.
if [[ -z "${SKIP_NET:-}" ]]; then
    STEPCHECK=$(node -e '
import("./scripts/build-preview.mjs").then(async (m) => {
  const yamlish = (await import("node:fs")).readFileSync("preview/action.yml", "utf8");
  const host = /default: "(https:\/\/[^"]+)"/.exec(yamlish)[1];
  const bp = m.buildBlueprint({
    headRepo: "o/moodle-mod_x", headSha: "d0638b39df1c28fd93c27778ae2cbada7cc1660f",
    prNumber: "1", type: "mod", name: "x",
  });
  const emitted = [...new Set(bp.steps.map((s) => s.step))];
  let text;
  try {
    const res = await fetch(new URL("src/blueprint/schema.js", host + "/"),
                            { signal: AbortSignal.timeout(20000) });
    if (!res.ok) { console.log("SKIP HTTP " + res.status); return; }
    text = await res.text();
  } catch (e) { console.log("SKIP " + e.message); return; }
  if (!/KNOWN_STEP_NAMES/.test(text)) { console.log("SKIP not a schema (redirect?)"); return; }
  const missing = emitted.filter((s) => !text.includes(`"${s}"`));
  console.log(missing.length ? "MISSING " + missing.join(",") : "OK " + emitted.length + " steps");
});
' 2>&1) || true
    if [[ "$STEPCHECK" == MISSING* ]]; then
        echo "CHECK 1k FAIL: default host does not implement every emitted step — $STEPCHECK"
        FAILED+=("1k: default host missing steps")
    elif [[ "$STEPCHECK" == SKIP* ]]; then
        echo "CHECK 1k WAIVED: could not read the host schema ($STEPCHECK)"
    else
        echo "CHECK 1k PASS: default host implements every step we emit ($STEPCHECK)"
    fi
else
    echo "CHECK 1k SKIP: SKIP_NET set"
fi


# The plugin-directory map is a hand copy of playground source; the test that
# compares them can only run with a checkout to compare against. Never let a
# waived drift check read as a pass.
# A URL param the playground READS is a param that can override the blueprint —
# versions, proxies, refs. Every one of them must either be forbidden in an
# emitted link or be a deliberate exception. If the playground gains a new one,
# notice it here rather than when a link starts behaving differently.
RESOLVER_SRC="${RESOLVER_SRC:-$SCRIPT_DIR/../moodle-playground/src/shared/version-resolver.js}"
if [[ -f "$RESOLVER_SRC" ]]; then
    RESOLVER_SRC="$RESOLVER_SRC" node -e '
import("./scripts/build-preview.mjs").then(async (m) => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(process.env.RESOLVER_SRC, "utf8");
  const read = [...new Set([...src.matchAll(/params\.get\("([^"]+)"\)/g)].map((x) => x[1]))];
  // Deliberate exceptions: these change logging verbosity, not what code runs
  // or where it is fetched from.
  const BENIGN = new Set(["debug", "profile"]);
  const unguarded = read.filter((p) => !m.FORBIDDEN_PARAMS.includes(p) && !BENIGN.has(p));
  if (unguarded.length) {
    console.log("UNGUARDED " + unguarded.join(","));
    process.exit(1);
  }
  console.log("OK " + read.length + " params read, all guarded or deliberately benign");
});
' >/tmp/bv-verify-params.log 2>&1
    if grep -q UNGUARDED /tmp/bv-verify-params.log; then
        echo "CHECK 1l FAIL: the playground reads URL params our links do not forbid —"
        sed 's/^/               /' /tmp/bv-verify-params.log
        echo "               Add them to FORBIDDEN_PARAMS, or to BENIGN in verify.sh if"
        echo "               they cannot change what code runs or where it comes from."
        FAILED+=("1l: unguarded playground URL params")
    else
        echo "CHECK 1l PASS: $(cat /tmp/bv-verify-params.log)"
    fi
else
    echo "CHECK 1l WAIVED: no playground source at $RESOLVER_SRC —"
    echo "                 URL-param drift is UNCHECKED in this run."
fi

PLAYGROUND_SRC="${PLAYGROUND_SRC:-$SCRIPT_DIR/../moodle-playground/src/blueprint/steps/moodle-plugins.js}"
if [[ -f "$PLAYGROUND_SRC" ]]; then
    export PLAYGROUND_SRC
    echo "CHECK 1e PASS: plugin-directory drift check ran against $PLAYGROUND_SRC"
else
    echo "CHECK 1e WAIVED: no playground source at $PLAYGROUND_SRC —"
    echo "                 PLUGIN_TYPE_DIRS drift is UNCHECKED in this run."
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

stage_preflight() { # stage_preflight <dir> <expectations file>
    python3 -c "
import json, sys
sha = json.load(open(sys.argv[2]))['blueprintSha256']
json.dump({'outcome': 'ok', 'error_class': 'none', 'blueprintSha256': sha},
          open(sys.argv[1] + '/preflight.json', 'w'))
" "$1" "$2"
}

cp test/fixtures/golden-boot-log.txt "$WORK/boot-log.txt"
cp test/fixtures/golden-console.txt "$WORK/console.txt"
cp test/fixtures/golden-expectations.json "$WORK/expectations.json"
cp test/fixtures/golden-meta.json "$WORK/meta.json"
stage_preflight "$WORK" test/fixtures/golden-expectations.json
OUT_DIR="$WORK" ACCEPTED_ORIGINS=https://ateeducacion.github.io node scripts/assert.mjs >/dev/null 2>&1 \
    && node scripts/validate-verdict.mjs "$WORK/verdict.json" >/dev/null 2>&1 \
    && python3 -c "import json,sys; v=json.load(open('$WORK/verdict.json')); sys.exit(0 if v['status']=='pass' else 1)"
check $? 2 "golden fixture → pass + schema-valid"

rm -f "$WORK"/*
cp test/fixtures/fallback-boot-log.txt "$WORK/boot-log.txt"
cp test/fixtures/fallback-console.txt "$WORK/console.txt"
cp test/fixtures/fallback-expectations.json "$WORK/expectations.json"
cp test/fixtures/fallback-meta.json "$WORK/meta.json"
stage_preflight "$WORK" test/fixtures/fallback-expectations.json
OUT_DIR="$WORK" ACCEPTED_ORIGINS=https://ateeducacion.github.io node scripts/assert.mjs >/dev/null 2>&1 \
    && python3 -c "import json,sys; v=json.load(open('$WORK/verdict.json')); sys.exit(0 if (v['status'],v['error_class'])==('verify_fail','resolver_fallback') else 1)"
check $? 3 "fallback fixture → verify_fail/resolver_fallback (silent-fallback detector)"

if [[ -n "${LIVE:-}" ]]; then
    # Real boot of the production playground. The blueprint served into the
    # browser is the gated local copy (mandatory loopback), so this check
    # also proves the hash-binding path works end to end.
    LIVE_OUT="$WORK/live"
    LIVE_URL="https://raw.githubusercontent.com/DavidUCL/mchef-urls/integrationtest/blueprints/integration-test-nodb.json"
    mkdir -p "$LIVE_OUT"
    cp test/fixtures/blueprint-nodb.json "$LIVE_OUT/blueprint.json"
    cp test/fixtures/golden-expectations.json "$LIVE_OUT/expectations.json"
    stage_preflight "$LIVE_OUT" test/fixtures/golden-expectations.json
    LD_LIBRARY_PATH="${NSS_LIBS:-}" BLUEPRINT_URL="$LIVE_URL" OUT_DIR="$LIVE_OUT" \
        node scripts/boot-capture.mjs >/tmp/bv-verify-live.log 2>&1 \
        && OUT_DIR="$LIVE_OUT" ACCEPTED_ORIGINS=https://ateeducacion.github.io node scripts/assert.mjs >>/tmp/bv-verify-live.log 2>&1 \
        && python3 -c "import json,sys; v=json.load(open('$LIVE_OUT/verdict.json')); sys.exit(0 if v['status']=='pass' else 1)"
    check $? 4 "LIVE loopback boot → pass (log: /tmp/bv-verify-live.log)"

    # LIVE 6 — the post-restore assertion must be able to FAIL.
    #
    # This is the only proof that matters for gate 2, and nothing offline can
    # give it: no mock of Moodle's DB would tell us whether the PHP actually
    # detects an empty or incomplete course. Measured behaviour being pinned
    # here — correct expectations complete the blueprint, a module name the
    # backup does not contain exits 23, an inflated count exits 22.
    #
    # An assertion that passes on an empty course is worse than no assertion,
    # so a green LIVE 6 is what licenses trusting gate 2 at all.
    RA_MBZ="https://raw.githubusercontent.com/moodle/moodle/MOODLE_404_STABLE/completion/tests/fixtures/legacy_course_completion.mbz"
    ra_boot() { # $1=label $2=modules-json $3=count -> echoes the observed outcome
        local RA_OUT="$WORK/ra_$1"
        mkdir -p "$RA_OUT"
        RA_DIR="$RA_OUT" RA_MODS="$2" RA_CNT="$3" RA_URL="$RA_MBZ" node -e '
import("./scripts/restore-assert.mjs").then(async (m) => {
  const fs = await import("node:fs");
  const c = await import("node:crypto");
  const step = m.buildRestoreAssertion({
    shortname: "REVIEW",
    modulenames: JSON.parse(process.env.RA_MODS),
    activityCount: Number(process.env.RA_CNT),
  });
  const bp = { preferredVersions: { moodle: "MOODLE_404_STABLE" }, steps: [
    { step: "installMoodle" },
    { step: "restoreCourse", url: process.env.RA_URL, shortname: "REVIEW", category: "Review" },
    step,
    { step: "setLandingPage", path: "/course/view.php?name=REVIEW" }] };
  const body = JSON.stringify(bp, null, 2);
  fs.writeFileSync(`${process.env.RA_DIR}/blueprint.json`, body);
  const sha = c.createHash("sha256").update(body).digest("hex");
  fs.writeFileSync(`${process.env.RA_DIR}/preflight.json`,
    JSON.stringify({ outcome: "ok", error_class: "none", blueprintSha256: sha }));
  fs.writeFileSync(`${process.env.RA_DIR}/expectations.json`, JSON.stringify({
    blueprintUrl: "loopback", blueprintSha256: sha, stepCount: 4,
    stepNames: ["installMoodle", "restoreCourse", "runPhpCode", "setLandingPage"], pluginSteps: [] }));
});
' >/dev/null 2>&1
        LD_LIBRARY_PATH="${NSS_LIBS:-}" OUT_DIR="$RA_OUT"             BLUEPRINT_URL="https://raw.githubusercontent.com/DavidUCL/mchef-urls/integrationtest/blueprints/ra-$1.json"             node scripts/boot-capture.mjs >>/tmp/bv-verify-assert.log 2>&1
        grep -oE 'failed with exit code [0-9]+|Blueprint step 4/4: setLandingPage' \
            "$RA_OUT/boot-log.txt" 2>/dev/null | head -1
    }
    : >/tmp/bv-verify-assert.log
    RA_GOOD=$(ra_boot correct '["assign"]' 1)
    RA_BADMOD=$(ra_boot wrongmod '["quiz"]' 1)
    RA_BADCNT=$(ra_boot wrongcount '["assign"]' 9)
    RA_PROBLEMS=""
    [[ "$RA_GOOD" == *"setLandingPage"* ]] || RA_PROBLEMS+="correct expectations did not complete (got: ${RA_GOOD:-nothing}); "
    [[ "$RA_BADMOD" == *"exit code 23"* ]] || RA_PROBLEMS+="a missing activity type was not caught (got: ${RA_BADMOD:-nothing}); "
    [[ "$RA_BADCNT" == *"exit code 22"* ]] || RA_PROBLEMS+="an inflated activity count was not caught (got: ${RA_BADCNT:-nothing}); "
    if [[ -n "$RA_PROBLEMS" ]]; then
        echo "CHECK 6 FAIL: the post-restore assertion is not doing its job — $RA_PROBLEMS"
        FAILED+=("6: post-restore assertion cannot fail")
    else
        echo "CHECK 6 PASS: the post-restore assertion passes when right and fails when wrong"
    fi

    # LIVE 8 — the course-format assertion must be able to FAIL, and must fail
    # for the RIGHT reason.
    #
    # This one needs NO download: the whole blueprint is createCourse plus the
    # assertion, all core. Unlike LIVE 7's theme arms — which waive on GitHub
    # runners because the plugin ZIP proxy is unreachable from Actions — both
    # arms here run everywhere, so neither is waivable and a red is always ours.
    #
    # 8b asserts exit 41 SPECIFICALLY, and that is the standing measurement, not
    # a detail: 41 means "the resolved format is not what we asked for AND the
    # course row still holds what we asked for". It is the proof that Moodle
    # stores a bogus format verbatim and substitutes only at render time — which
    # is WHY the assertion cannot be written as a read-back of the column. If
    # someone collapses 41 and 43 into one code in a tidy-up, that proof is gone
    # and the obvious-but-vacuous assertion looks correct again.
    cf_boot() { # $1=label $2=format -> echoes the observed outcome
        local CF_OUT="$WORK/cf_$1"
        mkdir -p "$CF_OUT"
        CF_DIR="$CF_OUT" CF_FMT="$2" node -e '
import("./scripts/course-assert.mjs").then(async (m) => {
  const fs = await import("node:fs");
  const c = await import("node:crypto");
  const step = m.buildCourseAssertion({ format: process.env.CF_FMT, shortname: "REVIEW" });
  const bp = { preferredVersions: { moodle: "MOODLE_500_STABLE" }, steps: [
    { step: "installMoodle" },
    { step: "createCategory", name: "Review" },
    { step: "createCourse", fullname: "Review", shortname: "REVIEW",
      category: "Review", format: process.env.CF_FMT, numsections: 3 },
    step,
    { step: "setLandingPage", path: "/course/view.php?name=REVIEW" }] };
  const body = JSON.stringify(bp, null, 2);
  fs.writeFileSync(`${process.env.CF_DIR}/blueprint.json`, body);
  const sha = c.createHash("sha256").update(body).digest("hex");
  fs.writeFileSync(`${process.env.CF_DIR}/preflight.json`,
    JSON.stringify({ outcome: "ok", error_class: "none", blueprintSha256: sha }));
  fs.writeFileSync(`${process.env.CF_DIR}/expectations.json`, JSON.stringify({
    blueprintUrl: "loopback", blueprintSha256: sha, stepCount: 5,
    stepNames: ["installMoodle", "createCategory", "createCourse", "runPhpCode", "setLandingPage"],
    pluginSteps: [] }));
});
' >/dev/null 2>&1
        LD_LIBRARY_PATH="${NSS_LIBS:-}" OUT_DIR="$CF_OUT" \
            BLUEPRINT_URL="https://raw.githubusercontent.com/DavidUCL/mchef-urls/integrationtest/blueprints/cf-$1.json" \
            node scripts/boot-capture.mjs >>/tmp/bv-verify-format.log 2>&1
        grep -oE 'failed with exit code [0-9]+|Blueprint step 5/5: setLandingPage|Blueprint failed at step [0-9]+:[a-zA-Z]+.*' \
            "$CF_OUT/boot-log.txt" 2>/dev/null | head -1
    }
    : >/tmp/bv-verify-format.log
    # `weeks` rather than `topics`: topics is the site default, so it would pass
    # even if the assertion compared against the fallback instead of the ask.
    CF_GOOD=$(cf_boot weeks weeks)
    CF_BAD=$(cf_boot bogus nosuchformat)
    CF_PROBLEMS=""
    [[ "$CF_GOOD" == *"setLandingPage"* ]] || CF_PROBLEMS+="a real format did not complete (got: ${CF_GOOD:-nothing}); "
    if [[ "$CF_BAD" != *"exit code 41"* ]]; then
        if [[ "$CF_BAD" == *"exit code 43"* ]]; then
            CF_PROBLEMS+="a format Moodle does not have exited 43, not 41 — 43 means the course row NO LONGER holds the format we asked for, so Moodle has started rewriting it. If that is now true, the assertion may read the column after all and this whole design should be revisited; "
        else
            CF_PROBLEMS+="a format Moodle does not have was NOT caught (got: ${CF_BAD:-nothing}) — a preview would render an ordinary topics course and say nothing; "
        fi
    fi
    if [[ -n "$CF_PROBLEMS" ]]; then
        echo "CHECK 8 FAIL: the course-format assertion is not doing its job — $CF_PROBLEMS"
        FAILED+=("8: course-format assertion cannot fail")
    else
        echo "CHECK 8 PASS: a real format boots and a format Moodle does not have exits 41 (not 43 — the row keeps the bogus value)"
    fi

    # LIVE 9 — the language-pack assertion must be able to FAIL, and must not be
    # satisfiable by the thing that LOOKS like success.
    #
    # NOTHING HERE DOWNLOADS A LANGUAGE PACK. The packs are FABRICATED on disk by
    # a runPhpCode step, the same move LIVE 6 makes with a .mbz. That keeps all
    # four arms unwaivable on a GitHub runner — unlike LIVE 7's theme arms, which
    # waive because the ZIP proxy is unreachable from Actions — and it lets 9c
    # build a state a real download could never be relied on to produce.
    #
    # 9d is the GREEN arm and it is not optional: an assertion that can never
    # exit 0 would pass 9a, 9b and 9c while killing every real preview. A set of
    # failing arms alone cannot tell those two apart.
    #
    # 9c is the one that earns its place. It writes a langconfig.php with NO
    # `thislanguage`, which is exactly the state where `is_file()` says yes AND
    # `translation_exists()` says yes — because Moodle loads lang/en first and
    # English's own `thislanguage` survives. The assertion must still exit 51.
    # If someone "simplifies" it to translation_exists, this arm goes green-to-
    # red and says why.
    lp_boot() { # $1=label $2=mode -> echoes the observed outcome
        local LP_OUT="$WORK/lp_$1"
        mkdir -p "$LP_OUT"
        LP_DIR="$LP_OUT" LP_MODE="$2" node -e '
import("./scripts/lang-assert.mjs").then(async (m) => {
  const fs = await import("node:fs");
  const c = await import("node:crypto");
  const mode = process.env.LP_MODE;
  const parts = ["<?php define(\"CLI_SCRIPT\",true); require(\"/www/moodle/config.php\");"];
  if (mode !== "missing") {
    parts.push("$d = $CFG->dataroot . \"/lang/zz\"; @mkdir($d, 0777, true);");
    const body = mode === "nothislanguage"
      ? "<?php $string[\u0027firstdayofweek\u0027] = \u00271\u0027;"
      : "<?php $string[\u0027thislanguage\u0027] = \u0027Fabricated\u0027; $string[\u0027thislanguageint\u0027] = \u0027Fabricated\u0027;";
    const php = "\u0027" + body.replace(/\\/g, "\\\\").replace(/\u0027/g, "\\\u0027") + "\u0027";
    parts.push(`if (@file_put_contents($d . "/langconfig.php", ${php}) === false) { exit(61); }`);
  }
  if (mode === "good") parts.push("set_config(\"lang\", \"zz\");");
  parts.push("get_string_manager()->reset_caches(); exit(0);");
  const fabricate = { step: "runPhpCode", code: parts.join(" "), critical: true };
  const bp = { preferredVersions: { moodle: "MOODLE_500_STABLE" }, steps: [
    { step: "installMoodle" },
    fabricate,
    m.buildLangAssertion({ codes: ["zz"] }),
    { step: "setLandingPage", path: "/" }] };
  const body = JSON.stringify(bp, null, 2);
  fs.writeFileSync(`${process.env.LP_DIR}/blueprint.json`, body);
  const sha = c.createHash("sha256").update(body).digest("hex");
  fs.writeFileSync(`${process.env.LP_DIR}/preflight.json`,
    JSON.stringify({ outcome: "ok", error_class: "none", blueprintSha256: sha }));
  fs.writeFileSync(`${process.env.LP_DIR}/expectations.json`, JSON.stringify({
    blueprintUrl: "loopback", blueprintSha256: sha, stepCount: 4,
    stepNames: ["installMoodle", "runPhpCode", "runPhpCode", "setLandingPage"], pluginSteps: [] }));
});
' >/dev/null 2>&1
        LD_LIBRARY_PATH="${NSS_LIBS:-}" OUT_DIR="$LP_OUT" \
            BLUEPRINT_URL="https://raw.githubusercontent.com/DavidUCL/mchef-urls/integrationtest/blueprints/lp-$1.json" \
            node scripts/boot-capture.mjs >>/tmp/bv-verify-lang.log 2>&1
        grep -oE 'failed with exit code [0-9]+|Blueprint step 4/4: setLandingPage|Blueprint failed at step [0-9]+:[a-zA-Z]+.*' \
            "$LP_OUT/boot-log.txt" 2>/dev/null | head -1
    }
    : >/tmp/bv-verify-lang.log
    LP_MISSING=$(lp_boot missing missing)
    LP_NOTSET=$(lp_boot notset installed)
    LP_NOSTRING=$(lp_boot nothislanguage nothislanguage)
    LP_GOOD=$(lp_boot good good)
    LP_PROBLEMS=""
    [[ "$LP_MISSING" == *"exit code 51"* ]] || LP_PROBLEMS+="a pack that never installed was NOT caught (got: ${LP_MISSING:-nothing}); "
    [[ "$LP_NOTSET" == *"exit code 52"* ]] || LP_PROBLEMS+="packs installed but the site left in English was NOT caught (got: ${LP_NOTSET:-nothing}); "
    [[ "$LP_NOSTRING" == *"exit code 51"* ]] || LP_PROBLEMS+="a langconfig.php with no thislanguage was NOT caught (got: ${LP_NOSTRING:-nothing}) — that is the state where is_file AND translation_exists both report success, so the assertion has become the vacuous one; "
    [[ "$LP_GOOD" == *"setLandingPage"* ]] || LP_PROBLEMS+="a CORRECTLY installed and selected pack did not complete (got: ${LP_GOOD:-nothing}) — an assertion that can never pass would satisfy every other arm here; "
    if [[ -n "$LP_PROBLEMS" ]]; then
        echo "CHECK 9 FAIL: the language-pack assertion is not doing its job — $LP_PROBLEMS"
        FAILED+=("9: language-pack assertion cannot fail, or cannot pass")
    else
        echo "CHECK 9 PASS: a real pack boots, and missing / unselected / English-fallback packs exit 51, 52, 51"
    fi

    # LIVE 7 — the theme control, in a real browser.
    #
    # Nothing offline can prove any of this. The failures the `theme` control
    # exists to prevent are all invisible: `setTheme` never checks the theme
    # exists, Moodle falls back to Boost with a debugging() this runtime does
    # not display, and whether a third-party theme's SCSS compiles at all in
    # WASM is a question only a boot can answer. A unit test asserts the PHP we
    # generate; this asserts what Moodle does with it.
    #
    # Measured 2026-08-13, each row a separate boot of the real host:
    #   theme installed + activated   all steps, no CSS-failure marker    ~34s
    #   theme never installed         exit 31 at the assertion            ~39s
    #   site left on another theme    exit 32 at the assertion            ~34s
    #   theme dir with no parents     exit 33 at the assertion            ~35s
    #
    # The first row is the acceptance evidence for the control: it is the only
    # thing showing a real theme's SCSS builds here rather than crashing or
    # timing out. The last is the one no cheap test reaches — the directory
    # exists, it has a config.php, and $CFG->theme names it. Only asking Moodle
    # what it actually loaded reveals that it loaded Boost.
    tb_boot() { # $1=case -> echoes the observed outcome
        local TB_OUT="$WORK/tb_$1"
        mkdir -p "$TB_OUT"
        TB_DIR="$TB_OUT" TB_CASE="$1" node -e '
import("./scripts/theme-assert.mjs").then(async (m) => {
  const fs = await import("node:fs");
  const c = await import("node:crypto");
  const kase = process.env.TB_CASE;
  // A real, public theme pinned to a full commit. boost_union deliberately: it
  // is the most-installed third-party theme there is, and the one whose parent
  // themes are decided at runtime.
  const zip = "https://github.com/moodle-an-hochschulen/moodle-theme_boost_union/archive/649c2d7b22fee1de767d145b7ec5a95543e9a305.zip";
  const steps = [{ step: "installMoodle" }];
  if (kase === "badparents") {
    // The PHP lives in a fixture because it needs single quotes and this whole
    // script is a single-quoted shell argument. See that file for what it does.
    const { _comment, ...step } = JSON.parse(fs.readFileSync("test/fixtures/preview/faketheme-step.json", "utf8"));
    steps.push(step);
  } else if (kase !== "notinstalled") {
    steps.push({ step: "installMoodlePlugin", url: zip, pluginType: "theme", pluginName: "boost_union", critical: true });
  }
  const want = kase === "badparents" ? "faketheme" : "boost_union";
  steps.push({ step: "setTheme", name: kase === "wrongtheme" ? "classic" : want });
  steps.push(m.buildThemeAssertion(want));
  // Same order the builder uses, minus the login this bare blueprint has no
  // users for: the assertion aborts on failure, the CSS build is last and
  // non-critical, and setLandingPage completing is what "it all worked" means.
  steps.push(m.buildThemeCssWarmup(want));
  steps.push({ step: "setLandingPage", path: "/" });
  const body = JSON.stringify({ preferredVersions: { moodle: "MOODLE_500_STABLE" }, steps }, null, 2);
  fs.writeFileSync(`${process.env.TB_DIR}/blueprint.json`, body);
  const sha = c.createHash("sha256").update(body).digest("hex");
  fs.writeFileSync(`${process.env.TB_DIR}/preflight.json`,
    JSON.stringify({ outcome: "ok", error_class: "none", blueprintSha256: sha }));
  fs.writeFileSync(`${process.env.TB_DIR}/expectations.json`, JSON.stringify({
    blueprintUrl: "loopback", blueprintSha256: sha, stepCount: steps.length,
    stepNames: steps.map((s) => s.step),
    pluginSteps: (kase === "notinstalled" || kase === "badparents") ? []
      : [{ url: zip, pluginType: "theme", pluginName: "boost_union" }] }));
});
' >/dev/null 2>&1
        LD_LIBRARY_PATH="${NSS_LIBS:-}" OUT_DIR="$TB_OUT" \
            BLUEPRINT_URL="https://raw.githubusercontent.com/DavidUCL/mchef-urls/integrationtest/blueprints/tb-$1.json" \
            node scripts/boot-capture.mjs >>/tmp/bv-verify-theme.log 2>&1
        # TWO files, deliberately. Step outcomes are in boot-log.txt; the
        # CSS-failure marker is written with error_log and lands in console.txt
        # (measured: on a step that exits 0, `echo` reaches NEITHER file). The
        # marker is grepped at all because it exits 0 by design — without it, a
        # boot that produced an unstyled site would read here as a clean pass.
        # EVERY terminal state, not just the two happy ones. This grep once
        # matched only an exit code or the last step, so a boot that died at the
        # download reported "nothing" — and "nothing" read as a check that had
        # not been written properly rather than as the failure it was. It cost a
        # red gate on main to notice. Silence is not success.
        grep -oE 'failed with exit code [0-9]+|Blueprint step 6/6: setLandingPage|Blueprint failed at step [0-9]+:[a-zA-Z]+.*' \
            "$TB_OUT/boot-log.txt" 2>/dev/null | head -1
        # The marker grep is only evidence if the file it reads exists. Without
        # this, a run that never wrote console.txt would report "no CSS-failure
        # marker" — an absence of a file reading as an absence of a problem,
        # which is the shape this repo keeps paying for.
        if [[ ! -s "$TB_OUT/console.txt" ]]; then
            echo "no-console-capture"
        else
            grep -o 'theme-css-build-failed' "$TB_OUT/console.txt" | head -1
        fi
    }
    : >/tmp/bv-verify-theme.log
    TB_GOOD=$(tb_boot correct)
    TB_MISSING=$(tb_boot notinstalled)
    TB_WRONG=$(tb_boot wrongtheme)
    TB_PARENTS=$(tb_boot badparents)
    # TWO OF THE FOUR ARMS DEPEND ON A THIRD PARTY, AND THAT IS NOT OUR
    # REGRESSION TO GO RED FOR. `correct` and `wrongtheme` download a real 2.6MB
    # theme, and this runtime routes every github.com ZIP through
    # github-proxy.exelearning.dev — a courtesy service with no SLA. Measured:
    # it answered 502 for both arms on a GitHub runner while both passed on a
    # workstation minutes earlier, and the boot log says
    # "Blueprint failed at step 2:installMoodlePlugin: Failed to download plugin
    # ZIP from https://github-proxy.exelearning.dev/...: 502".
    #
    # So those two arms WAIVE when the INSTALL STEP dies, loudly, and never
    # silently: a waiver prints what was not checked. The other two arms need no
    # network at all and are NOT waivable — they are what proves the assertion
    # can fail, and they still run when the proxy is down.
    #
    # The predicate is the STEP, not the error text, and that is deliberate. It
    # was written against the error wording first and missed on the very next
    # run: a workstation reproduction said "Failed to download plugin ZIP …:
    # 502" while the runner said "Failed to fetch", and matching the first
    # wording turned a proxy outage into a red gate for a second time. Matching
    # the step covers every wording there will ever be.
    #
    # It cannot hide a bug of ours. The URL this arm installs is a constant a
    # few lines above, not something the builder produced — nothing about it is
    # under test here. What IS under test is the assertion that runs afterwards,
    # and the two arms proving that need no download at all.
    tb_download_died() {
        [[ "$1" == *"Blueprint failed at step"* && "$1" == *"installMoodlePlugin"* ]]
    }
    TB_PROBLEMS=""
    TB_WAIVED=""
    if tb_download_died "$TB_GOOD"; then
        TB_WAIVED+="the installed-and-activated arm; "
    else
        [[ "$TB_GOOD" == *"setLandingPage"* ]] || TB_PROBLEMS+="an installed, activated theme did not complete (got: ${TB_GOOD:-nothing}); "
        [[ "$TB_GOOD" != *"theme-css-build-failed"* ]] || TB_PROBLEMS+="the theme's stylesheet did not build (got: ${TB_GOOD}); "
        [[ "$TB_GOOD" != *"no-console-capture"* ]] || TB_PROBLEMS+="nothing captured the browser console, so the stylesheet check proved nothing; "
    fi
    if tb_download_died "$TB_WRONG"; then
        TB_WAIVED+="the wrong-theme arm; "
    else
        [[ "$TB_WRONG" == *"exit code 32"* ]] || TB_PROBLEMS+="a site left on another theme was not caught (got: ${TB_WRONG:-nothing}); "
    fi
    # Not waivable: neither downloads anything.
    [[ "$TB_MISSING" == *"exit code 31"* ]] || TB_PROBLEMS+="a theme that was never installed was not caught (got: ${TB_MISSING:-nothing}); "
    [[ "$TB_PARENTS" == *"exit code 33"* ]] || TB_PROBLEMS+="a theme Moodle silently refused to initialise was not caught (got: ${TB_PARENTS:-nothing}); "
    if [[ -n "$TB_PROBLEMS" ]]; then
        echo "CHECK 7 FAIL: the theme check is not doing its job — $TB_PROBLEMS"
        FAILED+=("7: theme activation check cannot fail")
    elif [[ -n "$TB_WAIVED" ]]; then
        echo "CHECK 7 WAIVED IN PART: the theme ZIP would not install, so $TB_WAIVED"
        echo "                       were UNCHECKED in this run. The two arms needing no"
        echo "                       download still passed, so the assertion can still fail."
    else
        echo "CHECK 7 PASS: a real theme installs, activates and builds its CSS — and all three silent failures are caught"
    fi

    # A mutated local blueprint must break the hash binding.
    TAMPER_OUT="$WORK/tamper"
    mkdir -p "$TAMPER_OUT"
    python3 -c "
import json
bp = json.load(open('test/fixtures/blueprint-nodb.json'))
bp['steps'].append({'step': 'purgeMoodleCaches'})
json.dump(bp, open('$TAMPER_OUT/blueprint.json', 'w'))
"
    cp test/fixtures/golden-expectations.json "$TAMPER_OUT/expectations.json"
    cp "$LIVE_OUT/preflight.json" "$TAMPER_OUT/preflight.json"
    LD_LIBRARY_PATH="${NSS_LIBS:-}" BLUEPRINT_URL="$LIVE_URL" OUT_DIR="$TAMPER_OUT" \
        node scripts/boot-capture.mjs >/tmp/bv-verify-tamper.log 2>&1
    OUT_DIR="$TAMPER_OUT" ACCEPTED_ORIGINS=https://ateeducacion.github.io \
        node scripts/assert.mjs >>/tmp/bv-verify-tamper.log 2>&1
    grep -q 'hash mismatch' /tmp/bv-verify-tamper.log \
        && python3 -c "import json,sys; v=json.load(open('$TAMPER_OUT/verdict.json')); sys.exit(0 if v['status'] != 'pass' else 1)"
    check $? 5 "swapped local blueprint is refused by the hash binding (log: /tmp/bv-verify-tamper.log)"
else
    echo "CHECK 4-7 SKIP: live boot (set LIVE=1 to include — required for the gate)"
fi

# Prove the isolation held. Without this the fix is invisible: a future edit
# that runs a script before the export above would re-corrupt the runner's
# file, the gate would still exit 0, and the job would go red for a reason
# nothing here reports.
GATE_LEAK=""
if [[ -n "$GATE_REAL_OUTPUT" && -f "$GATE_REAL_OUTPUT" ]]; then
    NOW=$(wc -c <"$GATE_REAL_OUTPUT")
    [[ "$NOW" == "$GATE_REAL_OUTPUT_SIZE" ]] || GATE_LEAK+="GITHUB_OUTPUT grew ${GATE_REAL_OUTPUT_SIZE}->${NOW} bytes; "
fi
if [[ -n "$GATE_REAL_SUMMARY" && -f "$GATE_REAL_SUMMARY" ]]; then
    NOW=$(wc -c <"$GATE_REAL_SUMMARY")
    [[ "$NOW" == "$GATE_REAL_SUMMARY_SIZE" ]] || GATE_LEAK+="GITHUB_STEP_SUMMARY grew ${GATE_REAL_SUMMARY_SIZE}->${NOW} bytes; "
fi
if [[ -n "$GATE_LEAK" ]]; then
    echo "CHECK 1s FAIL: the harness wrote into the runner's own files — $GATE_LEAK"
    FAILED+=("1s: harness wrote into the runner's output files")
elif [[ -n "$GATE_REAL_OUTPUT$GATE_REAL_SUMMARY" ]]; then
    echo "CHECK 1s PASS: the runner's output files were left untouched"
else
    echo "CHECK 1s SKIP: not running under Actions (no output files to protect)"
fi

echo ""
if [[ ${#FAILED[@]} -eq 0 ]]; then
    echo "=== GATE PASS ==="
    exit 0
else
    echo "=== GATE FAIL (${#FAILED[@]}): ==="
    printf '  %s\n' "${FAILED[@]}"
    exit 1
fi
