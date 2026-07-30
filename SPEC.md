# boot-verify — day-0 spec (contract)

Fixes the four items the readiness review said would otherwise force
mid-build decisions. Parent plan: `docs/design.md`.
This file is the contract; `action.yml` and `scripts/` implement it.

## 1. Composite action inputs / outputs

Inputs (all cross into scripts via `env:`, never `${{ }}` in `run:`):

| input | required | default | meaning |
|---|---|---|---|
| `blueprint-url` | yes | — | HTTPS URL of the blueprint JSON to verify |
| `playground-host` | no | `https://moodle-playground.com` | playground deployment to boot against |
| `timeout-seconds` | no | `420` | how long the browser may run before the attempt is abandoned; expiry → `infra_fail`/`timeout`. Measured boot on a GitHub runner: 84 s for a 7-step blueprint with 3 plugins (26 s on a dev laptop), whole job 2m24s — size this off the runner figure, not a local one |
| `blueprint-hosts` | no | `raw.githubusercontent.com` | comma-separated allowlist for `blueprint-url` host |
| `data-hosts` | no | `raw.githubusercontent.com` | comma-separated allowlist for `restoreDatabase`/ZIP URL hosts inside the blueprint |
| `accepted-origins` | no | `https://ateeducacion.github.io` | extra origins the boot may legitimately finish on; the `playground-host` origin is always accepted. Needed because production `moodle-playground.com` redirects to its Pages origin — a custom deployment that redirects elsewhere must list it here or every run is `infra_fail/nav_fail` |
| `artifacts-dir` | no | `boot-verify-out` | where log/console/screenshots/verdict land. Must be relative and free of `..`: preflight recursively deletes it |

Outputs:

| output | values |
|---|---|
| `status` | `pass` \| `verify_fail` \| `infra_fail` \| `rejected` |
| `error-class` | enum below (`none` on pass) |
| `verdict-path` | path to `verdict.json` |

Phase-1 scope cuts (per readiness review): no PR comment posting (job
summary + artifact only); no `expected-plugins` input — expectations are
always derived by parsing the blueprint in the runner (verify.sh check-4
discipline).

## 2. Statuses and the closed `error_class` enum

`rejected` is new vs design §2 (schema stays v1): pre-flight policy
rejection — no browser ever launched, the blueprint itself was refused.
Retry policy: retry once on `infra_fail` only.

| error_class | status | meaning |
|---|---|---|
| `none` | pass | all assertions held |
| `blueprint_fetch_failed` | rejected | blueprint URL unreachable / not JSON |
| `blueprint_host_denied` | rejected | `blueprint-url` or internal URL host not in allowlist |
| `blueprint_step_banned` | rejected | foreign blueprint contains an RCE-class step (design §5) |
| `blueprint_unsafe_string` | rejected | a string carries control characters — it would forge log lines once echoed into the boot log |
| `blueprint_unbindable` | rejected | a plugin step lacks explicit `pluginType`/`pluginName`, so the extraction path could not be bound |
| `browser_launch_failed` | infra_fail | Playwright/chromium failed to start |
| `nav_fail` | infra_fail | navigation error, page crash, or final origin ≠ playground host |
| `logs_panel_missing` | infra_fail | `#log-panel` never appeared (never a fallback) |
| `timeout` | infra_fail | wall-clock expired before boot anchor |
| `anchor_drift` | infra_fail | boot completed by weak signals but strict anchors unmatched — playground log format changed (canary is the drift detector) |
| `resolver_fallback` | verify_fail | the boot did not run OUR blueprint: resolver console line absent, a fallback marker present, or executed step NAMES ≠ the gated blueprint's |
| `step_failed` | verify_fail | `Blueprint step … failed` / `Blueprint failed at step` present |
| `step_count_mismatch` | verify_fail | `Blueprint step k/N` sequence incomplete, out of order, or N ≠ parsed step count |
| `upgrade_soft_fail` | verify_fail | `Plugin upgrade crashed` / `Plugin upgrade errors` present (runtime returns success on these) |
| `plugin_binding_mismatch` | verify_fail | extraction paths / ZIP-URL download lines don't match the blueprint's installMoodlePlugin steps |

Precedence (implemented as one ordered list in `assert.mjs`):

```
browser_launch_failed > nav_fail > logs_panel_missing > timeout >
anchor_drift > resolver_fallback > step_failed > upgrade_soft_fail >
step_count_mismatch > plugin_binding_mismatch
```

`resolver_fallback` outranks step outcomes deliberately: if the boot ran
someone else's blueprint, a failure inside it would send the author hunting
a step they never wrote.

EVERY check runs regardless of earlier failures, and all results appear in
`assertions[]` — precedence chooses the *name*, it never hides evidence.

## 3. verdict.json (schema 1)

```json
{ "schema": 1,
  "status": "pass|verify_fail|infra_fail|rejected",
  "error_class": "<enum §2>",
  "head_sha": "<GITHUB_SHA or empty>",
  "blueprint_sha256": "<sha256 of fetched blueprint bytes, empty if fetch failed>",
  "boot_ms": 0,
  "steps_ok": 0,
  "steps_failed": 0,
  "assertions": [ { "id": "<a1..a6|preflight id>", "ok": true } ] }
```

Closed schema: unknown top-level keys are a validation error, and
`assertions[]` entries must have exactly the keys `id` and `ok` (no free
text — that is how log content would smuggle itself across).
`validate-verdict.mjs` is standalone and is used by our own summary step —
the same validator a future workflow_run consumer reuses (design §9.3).
The raw boot log NEVER reaches `$GITHUB_OUTPUT`/`$GITHUB_ENV`/comments;
it is an artifact only, and output values are additionally refused unless
they match `^[A-Za-z0-9._/-]{0,200}$` so nothing can inject a second
`name=value` line.

The assertion set. **Do not assume a fixed length** — a consumer must look
entries up by `id`. Fifteen are unconditional; three are conditional, so a
verdict carries 13-16 entries:

Always: `a1_browser`, `a2_boot_anchor`, `a3_resolver_line`, `a3_no_fallback`,
`a3_step_names`, `a4_no_step_failures`, `a5_no_upgrade_soft_fail`,
`a4_step_count`, `a6_urls_downloaded`, `a6_extraction_paths`,
`a6_extraction_count`, `a6_no_addon_proxy`.

Only when the browser launched (they are unassessable otherwise):
`a1_nav`, `a1_logs_panel`, `a0_loopback_binding`.
Only when the wall clock expired: `a2_complete`.
A `rejected` verdict carries exactly one `preflight_<error_class>` entry, and
a setup failure exactly one `setup_failed` entry.

## 4. Log anchors (ground truth, verified against sources 2026-07-29)

Shell log lines (`src/shell/main.js appendLog`): `[<ISO8601>] <message>\n`
into `#log-panel` (a `<pre>` inside section `#logs-panel`), pruned at
**500 entries → capture must poll incrementally**, not snapshot at exit.

| assertion | anchor (exact source) |
|---|---|
| a2 boot anchor | progress title `Boot timing summary`, detail `Config: <n>ms \| PHP refresh: <n>ms \| Bootstrap: <n>ms[ \| Bundle wait (post-refresh): <n>ms] \| Total: <n>ms` (php-worker.js:609) — proves boot, not success |
| a3 resolver | console: `[blueprint] Resolved from ?blueprint-url= param.` (resolver.js:79); fallback lines: `Resolved from defaultBlueprintUrl.` (110), `?blueprint= param (inline)` (55) |
| a4 steps | `Blueprint step ${i+1}/${N}: ${name}` (executor.js:52); failures: `Blueprint step ${name} failed: ${msg}` (executor.js:76), `Blueprint failed at step ${n}: ${err}` (bootstrap.js:3114) |
| a5 upgrade soft-fail | `Plugin upgrade crashed: …` (:333), `Plugin upgrade errors: …` (:341), `Plugin upgrade failed: …` (:344) — ALL THREE are non-fatal upstream. `failed` fires when the upgrade PHP returns `"ok":false`, i.e. the plugin's files installed but never registered: the most important one, and the one a two-word regex misses |
| a6 binding | `Downloading plugin ZIP from ${url}` (+ ` via addon proxy` variant, moodle-plugins.js:204-205); `Extracting plugin to ${targetDir}` (:225) where targetDir = `/www/moodle/<PLUGIN_TYPE_DIRS[type]>/<name>` (map mirrored in assert.mjs) |

Every anchor is matched **line-anchored** after stripping the `[ISO] `
prefix that `appendLog` adds. This matters: a multiline runtime message
renders as several panel lines, only the first of which carries a
timestamp, so an anchored parse ignores forged records embedded mid-message
— and preflight additionally rejects control characters in blueprint
strings so such a message cannot be constructed at all.

Drift policy: parser is unit-tested against `test/fixtures/golden-boot-log.txt`
(captured from the live playground); if weak boot signals fire but strict
anchors don't parse → `anchor_drift` (infra_fail), and the nightly canary
turns playground deploys that change these strings into a red canary, not a
silent false verdict.

## 3a. Who writes what (the pipeline contract)

`assert.mjs` is the SOLE writer of `verdict.json`. Preflight records its
outcome in `preflight.json` instead, and clears every artifact it is about
to produce before it starts. Reason: `OUT_DIR` lives inside the workspace,
so a PR can commit files there — a pre-placed `verdict.json` would
otherwise be read as "already decided" and skip the boot entirely. Nothing
downstream may treat a `verdict.json` as evidence of anything.

## 4a. Mandatory loopback (not optional)

The browser is ALWAYS served the blueprint bytes preflight fetched, gated
and hashed, via Playwright route interception; chromium never re-fetches
the URL. Otherwise a mutable ref (a branch) can be swapped in the seconds
between gate and boot, and the verdict would certify bytes that never ran.
Two independent facts must hold or the verdict is `infra_fail/nav_fail`:
sha256(local file) == `expectations.blueprintSha256`, **and**
`meta.loopback_served >= 1` (the route actually fired — the hash alone
compares the same file to itself and proves nothing).

Implementation details that are load-bearing, not incidental:

- The route is registered on the **browser context** rather than the page.
  Honest limit: Playwright documents that neither page- nor context-level
  routes intercept a fetch made *by* a service worker, and this shell has
  one. `serviceWorkers: "block"` is not available to us — the playground
  needs its worker to serve PHP, and blocking it means the boot never
  completes (measured: 420 s, no anchor). So the binding **fails closed**
  instead of being airtight: if the worker ever serves the blueprint fetch,
  `loopback_served` stays 0 and the verdict is `infra_fail` — never a pass
  on ungated bytes.
- **Positive control:** the gate's live check uses a blueprint URL that
  returns 404 on the public network, so that check can only pass if
  interception actually served our local bytes. Keep it that way; if you
  ever point the live check at a URL that resolves publicly, you lose the
  only standing proof that the loopback works.
- `loopback_served` **resets on every main-frame navigation**, so an
  earlier load's interception cannot vouch for a later load's network fetch.
- Route matching ignores query and fragment, so a cache-buster cannot slip
  the request past the route.

Defence in depth: even if interception were bypassed, the executed blueprint
must still match the gated one structurally (`a3_step_names`, `a4_*`,
`a6_*`). Residual risk is bytes differing only in ways no assertion
observes — e.g. an added `setConfig` value.

## 5. Step-gate (design §5, resolved scope)

Foreign blueprints (all phase-1 blueprints are foreign) are pre-flight
parsed. BANNED steps → `blueprint_step_banned`: `runPhpCode`,
`runPhpScript`, `writeFile(s)`, `unzip`, `applyPrOverlay`, `request`,
`copyFile`, `moveFile`, `deleteFile(s)`, `mkdir`, `rmdir`,
`setConfigFile(s)`. `restoreDatabase` IS allowed — published mchef snapshot
shares are the primary manual use case. Unknown step names → banned
(default deny), including names nested anywhere under a step.

Additional pre-flight rules, all default-deny:

- **URLs** (every string in the blueprint that is URL-shaped, scheme-relative,
  or carries control characters): HTTPS only, no userinfo, no query or
  fragment, host ∈ `data-hosts`. URL-ness is decided by parsing, not by a
  `^https://` prefix test — `fetch()` strips whitespace, so
  `" https://evil/x"` is a real URL that a prefix test misses.
- **Control characters** in ANY string → `blueprint_unsafe_string`
  (ordinary spaces are fine in human-readable values). A newline in, say,
  `pluginName` splits one runtime log message into two lines and forges an
  extraction record.
- **Plugin steps** must carry explicit `pluginType` (defaulted to `theme`
  for `installTheme`) and `pluginName`, both `^[a-z][a-z0-9_]*$`, plus a
  `url` → else `blueprint_unbindable`. Without them the extraction path
  cannot be bound and a pass would be unfalsifiable.
- **Proxy/host-override keys** anywhere in the blueprint → banned.

## 6. Pins

| dep | pin |
|---|---|
| playwright | `1.61.1` (exact, package.json + package-lock.json) |
| chromium | via playwright pin (`npx playwright install chromium`) — **no cache**: a cache entry is unsigned code that `playwright install` would then skip re-downloading, and the restored browser renders the boot we assert on |
| actions/checkout | `v5` tag at first release; SHA-pin before phase 2 |
| actions/upload-artifact | same policy |
| ateeducacion posting action | not used in phase 1 (posting cut); SHA-pin when phase 2 adds it |
| node | the runner's (ubuntu-latest ships 20+); scripts need ≥18 for `fetch`. No `setup-node` step — one fewer third-party action in a job that executes PR-influenced content |
| lockfile | must contain ONLY playwright + playwright-core (+ optional fsevents). Regenerate from `package.json`; `npm ci --ignore-scripts`. A lockfile carrying unrelated packages installs unrelated code into the verifier job — this actually happened during the build, from a symlinked `node_modules` |

## 7. Trust inversion in phase 2 (must be resolved before enabling it)

The workflows run `uses: ./` — the action code from the checkout. Under
`pull_request` from a fork that code belongs to the PR, which can delete the
`pull_request_target` refusal, make the assessor emit `pass`, or add a
lifecycle script. Only `permissions: {}` and the absence of secrets survive,
which reduces the impact to "a green check that means nothing" rather than a
compromise. Before phase 2, consumers must reference the action as
`owner/repo@<sha>` so the verifier is code the PR cannot edit.
