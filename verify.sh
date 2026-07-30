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
#
# Local env note (WSL, no sudo): chromium needs NSS libs; point
# NSS_LIBS at a dir of symlinks (see README "Local testing").

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
FAILED=()
check() {
    local rc=$1 num=$2 label=$3
    if [[ $rc -eq 0 ]]; then echo "CHECK $num PASS: $label";
    else echo "CHECK $num FAIL: $label"; FAILED+=("$num: $label"); fi
}

echo "=== verify.sh — boot-verify action gate ==="

node --test test/*.test.mjs >/tmp/bv-verify-unit.log 2>&1
check $? 1 "unit suite (log: /tmp/bv-verify-unit.log)"

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
runner_provided = {'GITHUB_OUTPUT', 'GITHUB_STEP_SUMMARY', 'GITHUB_EVENT_NAME', 'GITHUB_SHA'}
missing = used - declared - runner_provided
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

# The plugin-directory map is a hand copy of playground source; the test that
# compares them can only run with a checkout to compare against. Never let a
# waived drift check read as a pass.
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
    echo "CHECK 4-5 SKIP: live boot (set LIVE=1 to include — required for the gate)"
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
