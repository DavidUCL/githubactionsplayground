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

# The Moodle-version table in plugin-version.mjs is a snapshot of core's own
# $version per branch. Core only ever increases it, so a stale entry can only
# cause a FALSE REFUSAL of a valid plugin — annoying, and invisible until an
# adopter reports it. Re-derive from moodle/moodle and say so out loud.
# Same shape as check 1e: real source when reachable, loud waiver when not.
if [[ -z "${SKIP_NET:-}" ]]; then
    DRIFT=$(node -e '
import("./scripts/plugin-version.mjs").then(async (m) => {
  const problems = [];
  for (const [branch, recorded] of Object.entries(m.MOODLE_BRANCH_VERSIONS)) {
    const url = `https://raw.githubusercontent.com/moodle/moodle/${branch}/version.php`;
    let text;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) { console.log(`SKIP ${branch}: HTTP ${res.status}`); continue; }
      text = await res.text();
    } catch (e) { console.log(`SKIP ${branch}: ${e.message}`); continue; }
    const found = /\$version\s*=\s*([0-9]+)/.exec(text);
    if (!found) { console.log(`SKIP ${branch}: no $version found`); continue; }
    const actual = Number(found[1]);
    if (actual !== recorded) {
      problems.push(`${branch}: table says ${recorded}, core says ${actual}`);
    }
  }
  if (problems.length) { console.log("DRIFT " + problems.join("; ")); process.exit(3); }
  console.log("OK");
});
' 2>&1) || true
    if [[ "$DRIFT" == *DRIFT* ]]; then
        echo "CHECK 1h FAIL: Moodle version table is stale — $DRIFT"
        echo "               Update MOODLE_BRANCH_VERSIONS in scripts/plugin-version.mjs."
        FAILED+=("1h: Moodle version table is stale")
    elif [[ "$DRIFT" == *"SKIP"* && "$DRIFT" != *"OK"* ]]; then
        echo "CHECK 1h WAIVED: could not reach moodle/moodle — version table UNCHECKED"
        echo "                 ($DRIFT)"
    else
        echo "CHECK 1h PASS: Moodle version table matches core"
    fi
else
    echo "CHECK 1h SKIP: SKIP_NET set"
fi

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
