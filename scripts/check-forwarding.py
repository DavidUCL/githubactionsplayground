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

It ALSO catches a cross-wiring, but only the kind it can see without an exempt
list: when a `with:` key is itself the name of a declared input, its value must
be that input. `theme: ${{ inputs.extra-plugins }}` is refused; `head-repo:
${{ inputs.plugin-repo }}` is not even considered, because `head-repo` is not a
box on this form. That needs no allowlist and no maintenance.

Do NOT read this as "cross-wiring is covered". A `with:` key that is not also an
input name — every renamed one — can still be wired to the wrong input and pass.
Check 1o is what catches that class inside the ACTION (it runs the builder twice
per input and requires a distinct blueprint), but 1o reads `preview/action.yml`
and never opens `.github/workflows/`, so at the FORM layer the renamed keys are
genuinely unguarded. Said plainly here because a comment claiming a guard that
does not exist is worse than no comment, and this repo has shipped two of those.

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
    # Exit 2, not 0. The docstring above promises this check never silently
    # passes, and an environment that cannot parse YAML has not checked
    # anything. Nothing pip-installs pyyaml — the ubuntu-latest image ships it
    # and this workstation has it — so if this ever fires it is a broken
    # environment to fix, not something to wave through. NOTE: verify.sh's four
    # OTHER yaml blocks still `exit(0)` on ImportError and would pass having
    # checked nothing. That is pre-existing and logged as a follow-up; it is not
    # a reason to make this one lie too.
    print("1u: pyyaml unavailable — the check did not run", file=sys.stderr)
    sys.exit(2)


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


# `          theme: ${{ inputs.theme }}` — a `with:` entry, indented under a
# step. Read from the TEXT rather than the parsed YAML because the parse loses
# which mapping a key came from once several steps have `with:` blocks, and this
# only needs the pairs.
#
# `[ \t]`, NOT `\s`. Measured: `\s{6,}` matches newlines, so the block-opening
# `with:` swallowed the line after it and the FIRST key of every `with:` block
# was never cross-checked — a crossed pair placed at the top of the block passed
# green. The key class is deliberately wide: an input named `theme_repo` or
# `Theme` is legal, and a narrow class silently exempts it.
WITH_ENTRY = re.compile(r"^[ \t]{6,}([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*\$\{\{.*)$", re.M)
# A whole line commented out. Not a general YAML comment stripper: a `#` can
# appear inside a value, and this only needs to stop a commented-out forwarding
# line from satisfying the reference search. Measured before it existed:
# `# sections: ${{ inputs.sections }}` left the box wired to nothing and green.
COMMENT_LINE = re.compile(r"^[ \t]*#.*$", re.M)


def live_text(text):
    """The file with wholly-commented lines blanked, offsets preserved."""
    return COMMENT_LINE.sub(lambda m: " " * len(m.group(0)), text)


def with_keys(text):
    """Every `<key>: <value containing ${{ }}>` line, as pairs."""
    return WITH_ENTRY.findall(text)


def scan(path):
    """@returns (declared_input_count, problems). Raises on an unusable file."""
    raw = path.read_text()
    # Everything below reads the LIVE text. A commented-out line is not wiring.
    text = live_text(raw)
    try:
        doc = yaml.safe_load(raw)
    except yaml.YAMLError as err:
        raise RuntimeError(f"{path}: will not parse as YAML — {err}") from err
    if not isinstance(doc, dict):
        raise RuntimeError(f"{path}: parsed to {type(doc).__name__}, not a workflow")

    inputs = dispatch_inputs(doc)
    if inputs is None:
        return 0, []

    problems = []

    # The cross-wiring this CAN see without an exempt list: a `with:` key that is
    # itself the name of a box on this form must carry that box's value. Keys
    # that are renamed on the way through (`head-repo:`) are not input names, so
    # they are skipped automatically rather than listed.
    for key, value in with_keys(text):
        if key not in inputs:
            continue
        referenced = set(re.findall(r"inputs\.([A-Za-z0-9_-]+)", value))
        if referenced and key not in referenced:
            problems.append(
                f'{path}: the step passes "{key}" the value of '
                f'{", ".join(sorted(referenced))} — two boxes are crossed, so each '
                f"silently does the other's job"
            )

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
        # Both spellings. GitHub accepts `.yaml` and a form saved that way
        # would be unscanned while the pass line still claimed every form.
        d = pathlib.Path(".github/workflows")
        paths = sorted(set(d.glob("*.yml")) | set(d.glob("*.yaml")))

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
