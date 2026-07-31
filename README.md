# action-moodle-playground-verify

**Put a link on a Moodle plugin pull request that boots that PR's code in a
throwaway Moodle, in the reviewer's browser.** That is `preview/` — the part
a colleague actually sees. Copy `examples/pr-preview-workflow.yml` into a
plugin repo and every PR gets a link.

The repo also holds a **boot-verify** action at the root: it boots a blueprint
headlessly in CI and emits a closed-schema verdict. Be clear about what that
is today — it takes a `blueprint-url`, so it is a MANUAL (`workflow_dispatch`)
check for published blueprints, not something a plugin repo runs on its PRs.
It earns its place as infrastructure: the preview builder imports its blueprint
gate and plugin-directory map, and both share the mutation harness.

Design: `docs/design.md`, contract: `SPEC.md`.

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

## The preview link (`preview/`)

The other half, and the one a reviewer sees. `preview/action.yml` builds a
playground URL that boots a pull request's plugin code, and outputs it; the
caller posts it. It needs no token and no write permission.

```
scripts/build-preview.mjs   plugin identity (repo convention or explicit)
                            → blueprint: install Moodle, DEVELOPER debugging,
                              install the plugin from the head COMMIT, a review
                              course named for the PR + commit, a teacher and a
                              student, and a landing page per plugin type
                            → gzip + base64url into ?blueprint= (~1.1 KB)
```

Everything in it exists to stop the link lying about which code it opens:

- **Pinned to the head commit.** A branch ref shows later commits and 404s
  once the branch is deleted.
- **No `{{REPO}}`/`{{REF}}` placeholders, and no `repo`/`ref` params on the
  finished URL.** The playground resolver gives those parameters the highest
  precedence and substitutes them into plugin URLs, so a link can otherwise
  boot different code while looking correct — and while hashing identically.
- **The blueprint travels inside the link**, so it cannot rot or be swapped
  after posting, and it survives a playground redeploy.
- **The review course is named `PR #42 · <sha> · <plugin>`**, so the
  reviewer's own screen confirms the commit rather than the comment doing it.

Why the public playground is the default host: a preview runs unreviewed PHP
in the visitor's browser, and the playground renders the site in an
unsandboxed iframe with a service worker that outlives the tab. Browser
storage is origin-scoped, so previews must not share an origin with anything
you host.

**Every preview goes through a third party.** The playground proxies
`github.com` and `codeload.github.com` ZIP fetches through
`github-proxy.exelearning.dev` (a courtesy service, no SLA). That party sees
every repo and commit previewed, and could serve arbitrary bytes as the PHP a
reviewer's browser then executes. Vendoring the ZIP to
`raw.githubusercontent.com` would avoid it, but costs a write-scoped token in
a workflow that runs PR-authored code, and a permanent storage obligation —
judged the worse trade. Accepted, not overlooked. If it goes down, previews
boot a Moodle with no plugin (see "absence is quiet" above).

A copy-paste consumer workflow is in `examples/pr-preview-workflow.yml`.

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
