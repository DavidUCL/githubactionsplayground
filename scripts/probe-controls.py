#!/usr/bin/env python3
"""Check 1o — every declared input reaches the artifact it claims to, at its own field.

The hole this closes is structural, and it was proved twice: gutting
writeSummary left 230/230 tests and 118/118 mutants green, and rewiring two env
vars in action.yml still passed the entire gate. Every other check reads either
a hand-made fixture or calls buildBlueprint() directly, so the real path

    form input -> action.yml env: -> main() -> blueprint / URL / summary

is never traversed. Mutants test FUNCTIONS. This tests WIRING.

Each input is run twice as a SUBPROCESS — baseline env and probe env — and the
artifacts are compared. An input with no probe row is a failure, not a skip:
that is what stops this table fossilising the way REMOVED_PLUGIN_TYPES and
RISKY_STEPS both did.
"""

import json
import os
import re
import subprocess
import sys
import tempfile

import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Overridable so verify.sh can prove this checker actually FIRES, by pointing
# it at a deliberately broken copy. A check nobody has seen fail is a check
# nobody knows works.
ACTION = os.environ.get("PROBE_ACTION") or os.path.join(ROOT, "preview", "action.yml")
TABLE = os.environ.get("PROBE_TABLE") or os.path.join(ROOT, "test", "fixtures", "control-probes.json")

problems = []


def fail(msg):
    problems.append(msg)


def diff_paths(a, b, path=""):
    """JSON paths whose value differs, with list indices normalised to [*].

    Indices are normalised because expect_paths describes SHAPE, not position:
    a blueprint that grows a step would otherwise renumber every path after it
    and fail every row at once.
    """
    out = set()
    if type(a) is not type(b):
        out.add(path or "$")
        return out
    if isinstance(a, dict):
        for k in set(a) | set(b):
            sub = f"{path}.{k}" if path else k
            if k not in a or k not in b:
                out.add(sub)
            else:
                out |= diff_paths(a[k], b[k], sub)
    elif isinstance(a, list):
        if len(a) != len(b):
            out.add(f"{path}[*]")
        for i in range(min(len(a), len(b))):
            out |= diff_paths(a[i], b[i], f"{path}[*]")
    elif a != b:
        out.add(path or "$")
    return out


def changed_values(a, b, path=""):
    """(path, before, after) triples, for the overlap comparison below."""
    out = []
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) & set(b)):
            out += changed_values(a[k], b[k], f"{path}.{k}" if path else k)
    elif isinstance(a, list) and isinstance(b, list):
        for i in range(min(len(a), len(b))):
            out += changed_values(a[i], b[i], f"{path}[*]")
    elif a != b:
        out.append((path, json.dumps(a, sort_keys=True), json.dumps(b, sort_keys=True)))
    return out


def run_builder(env_overrides, baseline):
    d = tempfile.mkdtemp()
    env = dict(os.environ)
    env.update(baseline)
    env.update(env_overrides)
    env["OUT_DIR"] = os.path.join(d, "out")
    env["GITHUB_OUTPUT"] = os.path.join(d, "gho")
    env["GITHUB_STEP_SUMMARY"] = os.path.join(d, "sum")
    open(env["GITHUB_OUTPUT"], "w").close()
    open(env["GITHUB_STEP_SUMMARY"], "w").close()
    proc = subprocess.run(
        ["node", "scripts/build-preview.mjs"],
        cwd=ROOT, env=env, capture_output=True, text=True,
    )
    blueprint = None
    bp_path = os.path.join(env["OUT_DIR"], "preview-blueprint.json")
    if os.path.exists(bp_path):
        with open(bp_path) as fh:
            blueprint = json.load(fh)
    return {
        "rc": proc.returncode,
        "blueprint": blueprint,
        "output": open(env["GITHUB_OUTPUT"]).read(),
        "summary": open(env["GITHUB_STEP_SUMMARY"]).read(),
        "stderr": proc.stderr,
        "stdout": proc.stdout,
    }


def preview_url(output):
    for line in output.splitlines():
        if line.startswith("preview-url="):
            return line
    return None


def main():
    with open(TABLE) as fh:
        table = json.load(fh)
    with open(ACTION) as fh:
        action = yaml.safe_load(fh)

    declared = set(action.get("inputs", {}) or {})
    rows = {r["input"]: r for r in table["probes"]}

    # 1. Coverage, both directions. A new control with no row must FAIL.
    for missing in sorted(declared - set(rows)):
        fail(f"input '{missing}' is declared in preview/action.yml but has no probe row")
    for extra in sorted(set(rows) - declared):
        fail(f"probe row '{extra}' names an input preview/action.yml does not declare")

    # 2. The env mapping itself — the rewiring hole, closed directly.
    env_block = {}
    for step in action.get("runs", {}).get("steps", []) or []:
        if isinstance(step, dict) and isinstance(step.get("env"), dict):
            for k, v in step["env"].items():
                env_block.setdefault(k, str(v))
    for name, row in sorted(rows.items()):
        want = row["env"]
        got = env_block.get(want)
        if got is None:
            fail(f"{name}: action.yml sets no env var {want}")
        elif not re.search(r"inputs\." + re.escape(name) + r"\s*}}", got):
            fail(f"{name}: env {want} is wired to '{got.strip()}', not inputs.{name}")

    # Coverage and wiring are decidable by reading two files. If either is
    # already wrong, the 30-odd subprocess builds below cannot add anything —
    # and stopping here makes the self-test in verify.sh nearly free.
    if problems:
        return

    baseline_env = table["baseline"]
    base = run_builder({}, baseline_env)
    if base["rc"] != 0:
        fail(f"the baseline build itself failed (rc={base['rc']}): {base['stderr'][-300:]}")
        return

    signatures = {}
    for name, row in sorted(rows.items()):
        res = run_builder({row["env"]: row["probe"]}, baseline_env)
        target = row["target"]

        if target == "refusal":
            if res["rc"] == 0:
                fail(f"{name}: probe value {row['probe']!r} was accepted; expected a refusal")
            elif row["expect_error"] not in (res["stderr"] + res["stdout"]):
                fail(f"{name}: refused, but not with {row['expect_error']!r}")
            continue

        if res["rc"] != 0:
            fail(f"{name}: probe build failed (rc={res['rc']}): {res['stderr'][-200:]}")
            continue

        if target == "url":
            if preview_url(res["output"]) == preview_url(base["output"]):
                fail(f"{name}: preview-url is unchanged — the input reaches nothing")
        elif target == "blueprint":
            changed = diff_paths(base["blueprint"], res["blueprint"])
            if not changed:
                # Declared, documented, printed — and wired to nothing.
                fail(f"{name}: the blueprint is byte-identical — the input reaches nothing")
                continue
            allowed = set(row["expect_paths"])
            stray = {c for c in changed if c not in allowed}
            if stray:
                fail(f"{name}: changed fields it does not declare: {sorted(stray)}")
            signatures[name] = (frozenset(changed), tuple(sorted(changed_values(base["blueprint"], res["blueprint"]))))
        else:
            fail(f"{name}: unknown target {target!r}")

        if row.get("expect_in_summary") and row["probe"] not in res["summary"]:
            # This is the assertion that catches a gutted writeSummary.
            fail(f"{name}: probe value {row['probe']!r} never reaches GITHUB_STEP_SUMMARY")

    # 5. Two controls producing the identical diff are two names for one thing —
    # the exact shape of the env-swap bug. Compared on VALUES, not path sets:
    # `students` and `teachers` legitimately touch the same paths, so requiring
    # distinct path sets (as originally specified) would fail on a correct repo.
    names = sorted(signatures)
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            if signatures[a] == signatures[b]:
                fail(f"{a} and {b} produce an identical blueprint diff — are they wired to the same thing?")

    return


main()
if problems:
    print(f"CHECK 1o: {len(problems)} problem(s)")
    for p in problems:
        print(f"  - {p}")
    sys.exit(1)
print("CHECK 1o: every declared input reaches its own artifact")
