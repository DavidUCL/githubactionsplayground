# action-moodle-playground-verify

Boot-verify a [moodle-playground](https://github.com/ateeducacion/moodle-playground)
blueprint headlessly and emit a closed-schema verdict. Built for Moodle
plugin PR CI: phase 1 is manual (`workflow_dispatch`); the commented
`pull_request` trigger is phase 2. Design: `docs/design.md`,
contract: `SPEC.md`.

## What a PASS means

"The blueprint boots and every step — including each plugin install from
its ZIP — completed in a real (headless) browser against the target
playground." It does **not** run `db/upgrade.php` upgrade paths, page
logic, or cross-DB checks (see design §6 — comment wording is "installs
cleanly", never "verified").

## How it works

```
preflight.mjs     fetch blueprint (host allowlist, redirect-pinned)
                  → step-gate: default-deny step registry incl. nested names,
                    every URL host-checked by PARSING (not a prefix test),
                    control characters refused anywhere, plugin steps must
                    carry explicit pluginType/pluginName, proxy keys banned
                  → blueprint.json + expectations.json (derived from the
                    blueprint, never from caller inputs)
boot-capture.mjs  playwright chromium → ?blueprint-url= boot, with the gated
                  bytes ALWAYS served by route interception (never re-fetched)
                  → MutationObserver captures EVERY #log-panel line
                    (panel prunes at 500 entries; snapshots lose evidence)
                  → boot-log.txt, console.txt, final.png, meta.json
assert.mjs        16 structural assertions (SPEC.md §4 anchors, pinned by
                  golden fixtures from live boots); all of them always run,
                  precedence only names the failure → verdict.json
render-summary.mjs  closed-schema validation → job summary + outputs
                  (only validated enums/integers ever leave the verify job;
                   the raw log is an artifact, never output)
```

The action **never fails the job** (except under `pull_request_target`,
which hard-fails by design). Callers upload the evidence artifact first,
then gate on the `status` output — see `.github/workflows/boot-verify-manual.yml`.

Key trick the live runs proved necessary: an out-of-date playground
deployment rejected the blueprint and **silently booted its own starter
blueprint to a green-looking finish** — six steps, zero failures, boot
anchor present. The identity assertions (`a3_resolver_line`,
`a3_no_fallback`, `a3_step_names`) are what catch that, yielding
`verify_fail/resolver_fallback`. Observed in CI on 2026-07-30 against
`moodle-playground.com`, which runs an older build; the default host
(`daviducl.github.io/moodle-playground`) parses the same blueprint fine.

That is why `playground-host` defaults to the up-to-date deployment: point
it at a stale one and you get `resolver_fallback` for every blueprint it
cannot parse.

## Statuses

`pass` · `verify_fail` (the blueprint is at fault) · `infra_fail`
(browser/host/harness — retry once) · `rejected` (pre-flight policy:
banned step, off-allowlist host). Full enum + precedence: `SPEC.md` §2.

## The pipeline contract

`assert.mjs` is the only writer of `verdict.json`; preflight signals its own
outcome through `preflight.json` and wipes stale artifacts first. `OUT_DIR`
sits inside the workspace, so a PR can commit files there — anything that
treated a pre-existing `verdict.json` as decided would hand out a pass with
no boot at all.

## Loopback serving (always on)

The blueprint the browser boots is always the local copy preflight gated
and hashed, fulfilled via Playwright route interception. Without this the
gate would be advisory: a branch-ref URL can be swapped in the seconds
between "gate the JSON" and "navigate", so the verdict would certify bytes
that never ran. The verdict requires both a hash match *and* proof the
route fired. Phase 2 extends the same mechanism to plugin ZIPs built from
the PR checkout (design §4).

## Development

```
npm ci
npm test                  # unit + pipeline + contract tests
node test/mutations.mjs   # every mutant must be killed
./verify.sh           # deterministic gate (offline checks)
LIVE=1 ./verify.sh    # + real boot of the production playground (full gate)
```

`test/mutations.mjs` is the anti-vacuity check and part of the gate: it
deletes each assertion term in turn and requires the suite to notice. A
green suite without it means little — the first version of these tests let
13 of 14 terms be deleted silently.

`npm run capture-fixtures` re-captures the golden and fallback fixtures from
a live playground (both cases, or pass a name). It refuses to install a
fixture whose verdict is not the expected one, so an unexpected outcome can
never get baked into the gate.

Local WSL note (no sudo): chromium needs NSS libs. Create a dir of
symlinks to `libnspr4.so`, `libnss3.so`, `libnssutil3.so`, `libasound.so.2`
(a JetBrains `selfcontained/lib` dir has them all) and pass
`NSS_LIBS=<dir>` to `verify.sh`. Don't put that dir on `LD_LIBRARY_PATH`
for node itself — its `libstdc++` is older than node needs.

Anchor drift: if a playground deploy changes a log string, the nightly canary
goes red with `error_class=anchor_drift`. Fix the parser and re-capture with
`npm run capture-fixtures` — never loosen an assertion to "contains".

The `PLUGIN_TYPE_DIRS` map in `assert.mjs` is a hand copy of playground
source. `test/contract.test.mjs` compares them, but only with a checkout to
compare against: pass `PLAYGROUND_SRC=<path to moodle-playground
src/blueprint/steps/moodle-plugins.js>`. `verify.sh` prints check 1e as
WAIVED when it cannot run, and a waived check is not a pass.
