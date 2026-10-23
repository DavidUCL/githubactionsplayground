#!/usr/bin/env node
// The gate's closing tally: how many checks ran, passed, were waived or
// skipped, and which never reported at all.
//
// verify.sh used to end on a bare `=== GATE PASS ===`. A check that was
// waived on every run for weeks read as green to anyone who did not scroll
// two thousand lines, and a check that crashed before printing anything was
// simply absent. This reads the gate's own log and names both.
//
// The list of checks comes from verify.sh itself, so a new check is counted
// without anyone remembering to register it here. A check that is in the file
// but never printed a verdict is a FAILURE: silence is exactly how a broken
// check hides.
//
// Usage: node scripts/gate-tally.mjs <verify.sh> <gate log>
// Exit 0 when every check reported, none failed and the scan knew them all;
// 1 when not; 2 on its own error.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Verdicts verify.sh prints, longest first so "WAIVED IN PART" is not read as "WAIVED". */
const VERDICTS = ["WAIVED IN PART", "WAIVED", "PASS", "FAIL", "SKIP"];

/** Worst first: the verdict a check gets when it printed more than one. */
const SEVERITY = ["FAIL", "WAIVED IN PART", "WAIVED", "SKIP", "PASS"];

/**
 * Every check id verify.sh can report, read from its source: literal
 * `echo "CHECK <id> ...` lines and `check $? <id> ...` calls.
 */
export function expectedIds(source) {
  const ids = new Set();
  for (const m of source.matchAll(/CHECK ([0-9][0-9a-z-]*) (?:PASS|FAIL|WAIVED|SKIP)/g)) ids.add(m[1]);
  // The code may be quoted: `check "$UNIT_RC" 1 ...` is check 1.
  for (const m of source.matchAll(/^\s*check "?\$[^\s"]+"? ([0-9][0-9a-z-]*)\s/gm)) ids.add(m[1]);
  return [...ids].sort(byId);
}

/** Every verdict line in a gate log, as { id, verdict, reason }. */
export function parseLog(log) {
  const out = [];
  for (const line of log.split("\n")) {
    const m = line.match(/^CHECK ([0-9][0-9a-z-]*) (.*)$/);
    if (!m) continue;
    const verdict = VERDICTS.find((v) => m[2] === v || m[2].startsWith(v + ":") || m[2].startsWith(v + " "));
    if (!verdict) continue;
    const reason = m[2].slice(verdict.length).replace(/^:\s*/, "").trim();
    out.push({ id: m[1], verdict, reason });
  }
  return out;
}

/**
 * Group the expected checks by the verdict they got. A check that printed
 * several verdicts keeps the worst. Ids the log reports but the source scan
 * missed are listed as `unlisted`, so the scan cannot quietly drift.
 */
export function tally(expected, entries) {
  const got = new Map();
  for (const e of entries) {
    const prev = got.get(e.id);
    if (!prev || SEVERITY.indexOf(e.verdict) < SEVERITY.indexOf(prev.verdict)) got.set(e.id, e);
  }
  const groups = { PASS: [], FAIL: [], "WAIVED IN PART": [], WAIVED: [], SKIP: [], MISSING: [] };
  for (const id of expected) {
    const e = got.get(id);
    if (e) groups[e.verdict].push(e);
    else groups.MISSING.push({ id, verdict: "MISSING", reason: "" });
  }
  const unlisted = [...got.keys()].filter((id) => !expected.includes(id)).sort(byId);
  return { total: expected.length, groups, unlisted };
}

/** The lines printed at the end of the gate. */
export function render({ total, groups, unlisted }) {
  const n = (k) => groups[k].length;
  const waived = n("WAIVED") + n("WAIVED IN PART");
  const lines = [
    `GATE TALLY — ${total} checks: ${n("PASS")} passed, ${n("FAIL")} failed, ${waived} waived` +
      `${n("WAIVED IN PART") ? ` (${n("WAIVED IN PART")} in part)` : ""}, ${n("SKIP")} skipped, ` +
      `${n("MISSING")} did not report`,
  ];
  const list = (label, items) => {
    if (!items.length) return;
    lines.push(`  ${label}:`);
    for (const e of items) lines.push(`    ${e.id}${e.reason ? ` — ${clip(e.reason)}` : ""}`);
  };
  list("FAILED", groups.FAIL);
  list("DID NOT REPORT (counted as a failure)", groups.MISSING);
  list("waived in part", groups["WAIVED IN PART"]);
  list("waived", groups.WAIVED);
  list("skipped", groups.SKIP);
  if (unlisted.length) {
    lines.push(`  REPORTED BUT NOT FOUND IN verify.sh (counted as a failure; fix the scan): ${unlisted.join(", ")}`);
  }
  return lines.join("\n");
}

function clip(s, max = 110) {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** Natural order: 1a2 < 1b < 1o-self < 2 < 10. */
function byId(a, b) {
  return a.localeCompare(b, "en", { numeric: true });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [source, log] = process.argv.slice(2);
    if (!source || !log) throw new Error("usage: gate-tally.mjs <verify.sh> <gate log>");
    const expected = expectedIds(readFileSync(source, "utf8"));
    if (expected.length === 0) throw new Error(`found no checks in ${source}`);
    const result = tally(expected, parseLog(readFileSync(log, "utf8")));
    console.log(render(result));
    // An id the scan missed is a failure too: it means a check could go
    // silent without this noticing. This is what keeps the scan honest, run
    // against the real verify.sh on every gate run.
    // A FAIL line also fails the tally. verify.sh adds every FAIL to its own
    // list too, so today this only matters if a check prints FAIL and forgets
    // to; then the gate must not exit 0 on the strength of the list alone.
    process.exit(result.groups.MISSING.length || result.unlisted.length || result.groups.FAIL.length ? 1 : 0);
  } catch (err) {
    // Neither a verdict nor a tally: the tally itself broke.
    console.log(`GATE TALLY ERROR: ${err.message}`);
    process.exit(2);
  }
}
