import { test } from "node:test";
import assert from "node:assert/strict";
import { expectedIds, parseLog, tally, render } from "../scripts/gate-tally.mjs";

const SOURCE = `
check() { :; }
echo "CHECK 1a PASS: a"
check $? 1b "b"
    check $RC 2 "two"
check "$UNIT_RC" 1 "unit suite"
echo "CHECK 1c WAIVED: no source"
echo "CHECK 1c PASS: source present"
echo "CHECK 7 WAIVED IN PART: theme ZIP would not install"
`;

test("expectedIds reads echo lines and check calls, in natural order", () => {
  assert.deepEqual(expectedIds(SOURCE), ["1", "1a", "1b", "1c", "2", "7"]);
});

test("parseLog keeps WAIVED IN PART whole and ignores lines that are not verdicts", () => {
  const entries = parseLog(
    [
      "CHECK 7 WAIVED IN PART: the theme ZIP would not install",
      "CHECK 1a PASS: fine",
      "CHECK 1b FAIL: broke",
      "   CHECK 1c PASS: indented, so it is someone else's output",
      "CHECK 2 PASSED: not a verdict word",
      "CHECK 1c SKIP: not on Actions",
    ].join("\n"),
  );
  assert.deepEqual(
    entries.map((e) => [e.id, e.verdict, e.reason]),
    [
      ["7", "WAIVED IN PART", "the theme ZIP would not install"],
      ["1a", "PASS", "fine"],
      ["1b", "FAIL", "broke"],
      ["1c", "SKIP", "not on Actions"],
    ],
  );
});

test("a check that never printed a verdict is counted as did-not-report", () => {
  const r = tally(["1a", "1b", "2"], parseLog("CHECK 1a PASS: ok\nCHECK 2 PASS: ok"));
  assert.deepEqual(r.groups.MISSING.map((e) => e.id), ["1b"]);
  assert.match(render(r), /3 checks: 2 passed, 0 failed, 0 waived, 0 skipped, 1 did not report/);
  assert.match(render(r), /DID NOT REPORT \(counted as a failure\):\n {4}1b/);
});

test("a check that printed several verdicts keeps the worst", () => {
  const r = tally(["1c"], parseLog("CHECK 1c PASS: first\nCHECK 1c FAIL: then broke"));
  assert.deepEqual(r.groups.FAIL.map((e) => e.reason), ["then broke"]);
  assert.equal(r.groups.PASS.length, 0);
});

test("waived and skipped checks are named with their reasons", () => {
  const r = tally(
    ["1e", "7", "4"],
    parseLog("CHECK 1e WAIVED: no playground source\nCHECK 7 WAIVED IN PART: zip\nCHECK 4 SKIP: set LIVE=1"),
  );
  const out = render(r);
  assert.match(out, /3 checks: 0 passed, 0 failed, 2 waived \(1 in part\), 1 skipped, 0 did not report/);
  assert.match(out, /waived:\n {4}1e — no playground source/);
  assert.match(out, /skipped:\n {4}4 — set LIVE=1/);
});

test("an id the log reports but the scan missed is flagged, so the scan cannot drift", () => {
  const r = tally(["1a"], parseLog("CHECK 1a PASS: ok\nCHECK 9z PASS: new check the scan does not know"));
  assert.deepEqual(r.unlisted, ["9z"]);
  assert.match(render(r), /REPORTED BUT NOT FOUND IN verify\.sh \(counted as a failure; fix the scan\): 9z/);
});
