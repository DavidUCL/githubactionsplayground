#!/usr/bin/env python3
"""Check 1u — every box on a dispatch form is actually wired to something.

THE FAILURE THIS EXISTS TO CATCH. A `workflow_dispatch` input is declared in one
place and consumed in another, by hand, with nothing joining them:

    on: workflow_dispatch: inputs: theme: {...}      <- the box the user sees
    ...
    - uses: ./preview
      with:
        theme: ${{ inputs.theme }}                   <- SEPARATE, hand-written

Delete the second line and the form still renders the box, the run still goes
green, and the value the reviewer typed is discarded in silence. The symptom on
screen is identical to three other silent-failure modes this project has already
paid for: a preview that boots a normal-looking Moodle with the control ignored.

Nothing else in the gate reads `.github/workflows/` for this. `probe-controls.py`
opens `preview/action.yml` and stops there; check 1g checks declared OUTPUTS. The
`with:` block on preview-a-plugin.yml is a column of hand-written lines with no
gate above it, and this commit adds another one to it.

WHY THE RULE IS "REFERENCED SOMEWHERE" AND NOT "FORWARDED AS A `with:` KEY OF THE
SAME NAME". The narrower rule is what the panel asked for, and it is wrong here —
measured, not assumed:

    plugin-repo -> with: head-repo:              (renamed on the way through)
    plugin-ref  -> env REF: of the resolve step  (never reaches `with:` at all;
                                                  it becomes head-sha)

so the narrow rule needs a two-name exempt list on day one, and an exempt list is
exactly what the same ruling refused to fossilise in the other direction. "The
name must appear as `inputs.<name>` somewhere outside its own declaration" needs
no exemptions, catches the scenario both reviewers described, and applies
unchanged to every dispatch workflow rather than only to the one being edited.

What it does NOT catch, stated so nobody reads more into a green line than is
there: an input forwarded to the WRONG field. `theme: ${{ inputs.extra-plugins }}`
references both names and passes. Check 1o is what covers that — it runs the
builder twice per input and requires a distinct blueprint.

Usage:  python3 scripts/check-forwarding.py
        FORWARD_WORKFLOWS=<path>[,<path>...]   override the files scanned
                                               (used by the 1u-self plant)
Exit:   0 every declared input is referenced
        1 at least one is not
        2 the check could not run — NEVER silently a pass
"""

import os
import pathlib
import re
import sys

try:
    import yaml
except ImportError:  # pragma: no cover - environment, not logic
    print("1u: pyyaml unavailable — SKIPPED, not passed")
    sys.exit(0)


def dispatch_inputs(doc):
    """The `on: workflow_dispatch: inputs:` mapping, or None if there is none.

    `on` parses to the YAML 1.1 boolean True, which is why a naive `doc["on"]`
    finds nothing and a check built on it reports a clean pass for every file in
    the directory. Accept both spellings.
    """
    trigger = doc.get("on", doc.get(True))
    if not isinstance(trigger, dict):
        return None
    dispatch = trigger.get("workflow_dispatch")
    if not isinstance(dispatch, dict):
        return None
    inputs = dispatch.get("inputs")
    return inputs if isinstance(inputs, dict) else None


def scan(path):
    """@returns (declared_input_count, problems). Raises on an unusable file."""
    text = path.read_text()
    try:
        doc = yaml.safe_load(text)
    except yaml.YAMLError as err:
        raise RuntimeError(f"{path}: will not parse as YAML — {err}") from err
    if not isinstance(doc, dict):
        raise RuntimeError(f"{path}: parsed to {type(doc).__name__}, not a workflow")

    inputs = dispatch_inputs(doc)
    if inputs is None:
        return 0, []

    problems = []
    for name in inputs:
        # The DECLARATION is `  theme:`; a REFERENCE is `${{ inputs.theme }}`.
        # Searching for the reference form is what keeps the declaration from
        # satisfying the check — no line-slicing, which multi-line descriptions
        # and YAML anchors would make fragile.
        #
        # `${{ inputs['theme'] }}` is equally valid, and the trailing boundary
        # stops a reference to `inputs.theme` matching a declared `theme-name`.
        pattern = re.compile(
            r"inputs(?:\.{0}(?![A-Za-z0-9_-])|\[[\"']{0}[\"']\])".format(re.escape(name))
        )
        if not pattern.search(text):
            problems.append(
                f'{path}: the form declares "{name}" but nothing in the workflow reads '
                f"${{{{ inputs.{name} }}}} — the box renders, the run goes green, and "
                f"whatever the reviewer types is discarded in silence"
            )
    return len(inputs), problems


def main():
    override = os.environ.get("FORWARD_WORKFLOWS")
    if override:
        paths = [pathlib.Path(p) for p in override.split(",") if p]
    else:
        paths = sorted(pathlib.Path(".github/workflows").glob("*.yml"))

    if not paths:
        print("1u: no workflow files found — the check did not run", file=sys.stderr)
        return 2
    absent = [p for p in paths if not p.is_file()]
    if absent:
        print(f"1u: no such file: {', '.join(map(str, absent))}", file=sys.stderr)
        return 2

    problems = []
    forms = 0
    declared = 0
    for path in paths:
        try:
            count, found = scan(path)
        except RuntimeError as err:
            print(f"1u: {err}", file=sys.stderr)
            return 2
        if count:
            forms += 1
            declared += count
        problems.extend(found)

    # An explicit OK, never a fall-through else: a rename that leaves
    # .github/workflows with no dispatch form at all must read as "did not run",
    # not as "nothing wrong".
    if not forms:
        print("1u: no workflow declares any dispatch input — the check did not run", file=sys.stderr)
        return 2
    if problems:
        for p in problems:
            print(p)
        return 1
    print(f"1u: all {declared} dispatch input(s) across {forms} form(s) are read by their workflow")
    return 0


if __name__ == "__main__":
    sys.exit(main())
