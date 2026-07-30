<!-- Design record for this action, committed so the contract in SPEC.md
     and the comments in scripts/ never point at a document a reader
     cannot open. Produced by a five-persona design panel before any code
     existed; §9 records the decisions that closed, §10 what the build
     learned. -->

# Design: Moodle plugin PR boot-verify + preview GitHub Actions

Status: PHASE 1 BUILT — 2026-07-29. The implementation lives in
`action-moodle-playground-verify/` (uncommitted); its contract is that
repo's `SPEC.md` and a copy of this document is committed there as
`docs/design.md`. Three adversarial review rounds plus a maintainer
readiness review are fixed; the deterministic gate runs 9 checks including a
live production boot. See "Build outcome" at the end of this file.

Originally: PANEL SYNTHESIS — 2026-07-28. Five-persona design panel (Otto/Actions,
Cass/security, Sandy/runtime, Quinn/QA, Gus/upstream), fresh-context, run
against the artifacts. Full reports in session transcript; this doc is the
converged plan. Supersedes the scope of the earlier PR-preview design (in the sponsor's notes)
(whose mchef-wrapper remains parked and is now DEPRIORITIZED — plugin repos
need no mchef; see §7).

Sponsor's goal: actions that run automatically on Moodle plugin PRs — but
manual-first (workflow_dispatch) — that boot-verify a playground blueprint
containing the PR's code AND post a preview link. Parameter: a JSON blueprint
URL hosted on GitHub.

## 1. Converged architecture

ONE new composite action — **boot-verify** — plus reuse of
`ateeducacion/action-moodle-playground-pr-preview@v1` for posting. No new
posting code. The action is event-agnostic (everything via inputs), so
manual→automatic is a caller-side trigger change only.

**Two trust domains, always** (unanimous, Cass hardens):

- `verify` job: executes PR-controlled code (plugin PHP inside WASM, and any
  build tooling on PR-controlled manifests) → `permissions: {}`, NO secrets,
  no cache saves, ephemeral hosted runners only, hard `timeout-minutes`.
- `post` job: `pull-requests: write`, executes NOTHING from the PR head,
  renders from validated data only.
- Fork PRs (phase 2): `pull_request` (verify) → artifact → `workflow_run`
  (post). **`pull_request_target` must never appear**; the action hard-fails
  if `github.event_name == 'pull_request_target'` (T1/T2/T3 in Cass's threat
  model: full-compromise class).
- All inputs cross into shell via `env:` + quoted vars, never `${{ }}`
  interpolation in `run:` (D2: script injection is the single worst available
  bug).

## 2. The verdict envelope (unanimous: Cass #1, Quinn, Sandy)

The ONLY thing that crosses from the verify job to any privileged context is
`verdict.json` with a fixed schema:

```json
{ "schema": 1, "head_sha": "...", "blueprint_sha256": "...",
  "status": "pass" | "verify_fail" | "infra_fail",
  "boot_ms": 0, "steps_ok": 0, "steps_failed": 0,
  "error_class": "<closed enum>" }
```

The raw runtime log is a downloadable artifact only — it is
attacker-influenced text (plugin PHP prints into it) and must never reach
`$GITHUB_ENV`/`$GITHUB_OUTPUT`/`::` commands or be echoed into comments
(P4: log injection is the one real sandbox escape available today). The
comment/summary renders from the enum. Screenshot on failure AND success
(success shot doubles as preview thumbnail).

## 3. Assertions (structural only — never free-text greps)

Current harness pass condition is spoofable both ways (Quinn): a plugin's
`install.php` can echo "Total: 1ms" (forged pass); an innocent plugin
containing "failed" forges a failure — and `Plugin download failed,
retrying…` appears on a transient 502 that then SUCCEEDS (Sandy G3). v1
asserts, with evidence lines from Sandy:

1. Navigation ok, no page crash, final origin == playground host
   (else INFRA_FAIL). `#logs-panel` missing = INFRA_FAIL, never a fallback.
2. Strict-format boot anchor: `Boot timing summary: … Total: NNNms` as a
   complete line (executor prints it even after blueprint failure — it
   proves boot, not success).
3. Console line `[blueprint] Resolved from ?blueprint-url= param.` —
   REQUIRED. Kills the silent starter-blueprint fallback false-green
   (resolver falls back to the default blueprint on schema rejection;
   Sandy G1 — this is also the "playground too old for this blueprint"
   detector, a distinct error_class).
4. Step accounting: `Blueprint step k/N` for k=1..N in order; zero
   `Blueprint step .* failed` / `Blueprint failed at step` lines.
5. Upgrade-soft-failure patterns: zero `Plugin upgrade crashed` /
   `Plugin upgrade errors` lines (these RETURN SUCCESS in the runtime —
   Sandy G2 — and match no naive grep).
6. Per-plugin binding: `Extracting plugin to /www/moodle/<type>/<name>`
   count and paths match the blueprint's steps; each expected ZIP URL
   appears in an exact-match `Downloading plugin ZIP from <url>` line.

Explicitly NOT asserted: any "failed"/"error" substring, timing thresholds,
proxy lines, anything from plugin-influenced free text.

Semantics: PASS / VERIFY_FAIL / INFRA_FAIL; retry once on INFRA_FAIL only;
v1 is a NON-REQUIRED informational check. Promotion criteria to required:
≥4 weeks informational, canary ≥98% pass, post-retry INFRA_FAIL <2%,
proxy off the CI path (§4), median wall <5 min.

## 4. Loopback ZIP serving — the panel's convergent idea

Independently proposed by Quinn, Sandy, AND Cass: in CI, build the plugin
ZIP from the runner's own PR checkout and serve it into the boot locally
(Playwright `page.route()` interception or a 127.0.0.1 server), rewriting
the blueprint's `installMoodlePlugin.url`. Effects:

- Removes `github-proxy.exelearning.dev` (third party, no SLA) from the
  pass/fail path — the biggest flake source and Cass's D4.
- CI verifies EXACTLY the reviewed tree, not whatever proxy/CDN returns
  (also fixes "branch archive URL is mutable after force-push", Sandy G4).
- Works for fork PRs before anything is pushed anywhere.
- Yields a publishable sha256 tying CI's verdict to the reviewer's preview.

Trade-off: CI exercises a different delivery path than the reviewer's
browser → one unintercepted nightly canary boot covers the proxy path.
The posted preview link still uses the public URL (head-SHA archive form).

## 5. Blueprint sources and the step-gate

One boot-capture-assert core, two producers (Sandy):

- **Manual (`workflow_dispatch`)**: arbitrary `blueprint-url` input —
  the published-share checker. Expectations derived by fetching/parsing the
  blueprint JSON in the runner (verify.sh check-4 discipline).
- **PR mode**: the action CONSTRUCTS the blueprint — explicit
  `pluginType`/`pluginName` (repo-name convention resolved in the runner
  where failure is a clear CI error) + head-SHA archive URL (or loopback
  URL per §4). Optional tier-3 probes appended BY THE ACTION: a
  `runPhpCode` step asserting the component's version is in config and
  classes autoload (exit 1 → hard step failure), and a `request` step
  hitting one plugin page. This is the realistic "actually installed" bar;
  PHPUnit-in-WASM is ruled out for v1 (trimmed bundle, Sandy G5).

**Provenance-gated step allowlist (Cass #3):** foreign blueprints (the
manual `blueprint-url` input) are pre-flight-parsed and REJECTED if they
contain `runPhpCode`, `runPhpScript`, `writeFile(s)`, `unzip`,
`restoreDatabase`, `applyPrOverlay`, `request`, or proxy/host overrides —
the step registry is a full RCE surface inside a runner-egress-bearing job.
Action-constructed (base-provenance) blueprints may include the probe steps.
This composes with host allowlists on `blueprint-url`/`playground-host`/
proxy params (default deny; https-only; no userinfo; redirect-pinned).

## 6. Honest value proposition (Quinn's table, abridged)

CAUGHT: install-path PHP fatals (version.php, lib.php, db/install.php,
autoloaded classes), version/dependency errors, broken ZIP packaging, wrong
extraction root, structurally invalid install.xml (SQLite-permissive),
theme SCSS compile failures.
MISSED: **`db/upgrade.php` (never runs — fresh-install path; the most
common real install-breakage class)**, runtime/page logic, JS/AMD, lang
strings, capabilities, cross-DB portability (SQLite-only false green).
FALSE RED possible: WASM environment divergence.

Comment wording: "installs cleanly from ZIP on Moodle <version>" — never
"verified". Phase-2+ high-value: **upgrade-path mode** (install latest
released version, then overlay PR and re-upgrade — makes db/upgrade.php
actually execute; no other cheap CI does this).

## 7. Packaging + relationship to prior design (Gus)

- Verify action belongs UPSTREAM as a sibling:
  `ateeducacion/action-moodle-playground-verify` — the preview action's
  "never executes PR head code" line is a load-bearing contract that a
  verify-mode input would break; and the boot-readiness logic versions
  against playground internals ateeducacion controls. Citricity's role:
  contribute it (with the upstream asks below). Interim: it can incubate in
  the fork/citricity org and move.
- Old doc §6 decisions: packaging → re-decided (sibling upstream);
  delivery → mooted (single-plugin blueprints are tiny; inline never 414s);
  PR ref → head SHA, hardened (upstream currently rewrites blueprint-file
  URLs to the BRANCH — becomes an upstream change request); snapshots → still
  phase-2 no. The mchef recipe→blueprint wrapper stays parked/deprioritized
  (it's a blueprint PRODUCER; verify is a CONSUMER — orthogonal, composes
  later via the same seam).
- Upstream asks to accompany the contribution (Gus + Sandy #2 + Quinn #3):
  (1) versioned machine-readable boot-status channel (`?headless=1` /
  `dataset.bootStatus` / final `Blueprint: n/n steps ok` epilogue) so
  verifiers stop scraping plugin-influenced text; (2) uniform hard wording
  (or hard failure) for plugin upgrade crashes; (3) branch→SHA rewrite in
  the preview action; (4) `pull_request_target` hard-fail guard.

## 8. Phasing

**Phase 1 — manual (the sponsor's v1):**
boot-verify composite action (harness + verdict envelope + structural
assertions + host allowlist + step-gate) · workflow_dispatch workflow with
Otto's input schema (blueprint-url required; pr-number optional → posts via
upstream action with verdict in `extra-text`; post-mode; timeout;
expected-plugins) · dual-trigger file with the pull_request block present
but commented · Playwright cache, 2-attempt INFRA retry, concurrency-cancel,
artifacts (log + trace + screenshots) · nightly canary on a known-good
blueprint (separates "host/proxy broke" from "PR broke"; generates the
flake-rate data for promotion).

**Phase 2 — automatic on same-repo PRs:** uncomment trigger; action-built
PR blueprint (explicit type/name, head-SHA URL); loopback ZIP serving;
sticky comment with "latest" + "verified at <sha>" links; boot-time delta
vs base branch in the comment.

**Phase 3 — forks + upstream:** workflow_run posting split (fork tokens are
read-only — the predictable `pull_request_target` "fix" is the trap);
upstream the action + the four asks; upgrade-path mode; Moodle-version
matrix (same blueprint boots against all built branches as parallel jobs).

## 9. Decisions — RESOLVED 2026-07-29

1. **Home**: David's own repos, no commitments to or coordination with
   ateeducacion (topic closed at David's direction — upstreaming is not a
   goal; §7's upstream framing is descriptive only).
2. **Phase-1 workflow host**: the action repo itself (`uses: ./` — one
   commit iterates action + workflow together). Phase-2 entry gate: one
   green SHA-pinned run from a real plugin repo before any pull_request
   trigger is uncommented.
3. **Fork posture**: DEFERRED to phase 3; default landing is the cheap
   option (fork PRs: unverified-labelled preview only; maintainers can
   verify any fork via workflow_dispatch). Phase-1 must-dos that keep the
   workflow_run door open (Cass+Otto): verdict.json uploaded as artifact
   unconditionally; standalone `validate-verdict` script (closed schema)
   used by phase 1's own post step; head_sha + blueprint_sha256 stay in the
   envelope; renderer is a separate step consuming only verdict path + sha;
   pull_request_target hard-fail guard.
4. **GO** — readiness review (Quinn+Gus): GO-WITH-NOTES, est. 4–6 focused
   days. Day-0 spec pass required first: (a) action.yml inputs/outputs
   table + closed error_class enum; (b) golden log fixture from the live
   playground + parser unit tests, anchor drift = INFRA_FAIL with its own
   error_class; (c) pin upstream action to a commit SHA, pin Playwright;
   (d) manual-mode scope: restoreDatabase allowed ONLY under the data-host
   allowlist (published mchef snapshot shares are the primary manual use
   case); RCE-class steps stay banned for foreign blueprints. Phase-1 cut:
   pr-number comment posting (job summary + artifact suffice; posting lands
   with phase 2). Never cut: assertion 3 (resolver anchor).


## 10. Build outcome (2026-07-29)

Phase 1 is built in `action-moodle-playground-verify/` and passes its own
9-check gate (93 tests, 48/48 mutants killed, live boot of the production
playground, tamper check). What the build changed about the plan:

- **The deployed playground is older than the checkout** it was designed
  against: it rejects `restoreDatabase` and then *silently boots its own
  starter blueprint to a green-looking finish*. §3's resolver assertion
  caught this on the first live run — the false-green the panel predicted,
  observed within an hour. It also redirects `moodle-playground.com` to its
  Pages origin, hence an `accepted-origins` input.
- **Loopback serving (§4) had to ship in phase 1, not phase 2.** Without it
  the gate is advisory: a branch-ref URL can be swapped between "gate the
  JSON" and "navigate", so the verdict would certify bytes that never ran.
  Honest limit: neither page- nor context-level routes intercept a service
  worker's fetch, and the playground needs its worker, so the binding fails
  *closed* rather than being airtight. The live check's URL 404s publicly,
  which is the standing proof interception really fires.
- **A third upgrade-failure wording exists** (`Plugin upgrade failed:`, on
  `"ok":false`) — the "files installed but never registered" case, which
  returns success to the executor. §3 listed only two.
- **Plugin steps must carry explicit `pluginType`/`pluginName`** or the
  extraction path cannot be bound and a pass is unfalsifiable; blueprints
  without them are `rejected`, not verified.
- **Anti-vacuity is now a gate property.** A green suite proved nothing: 13
  of 14 assertion terms could be deleted with every test still passing. The
  mutation harness is check 1b.
- **Phase 2 has a hard precondition** the plan did not state: `uses: ./`
  means a fork PR supplies the verifier's own code, so consumers must move
  to `owner/repo@<sha>` before any `pull_request` trigger is enabled.
