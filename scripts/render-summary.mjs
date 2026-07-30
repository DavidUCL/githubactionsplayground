// Validate verdict.json through the closed-schema validator, then render
// the job summary and set action outputs. ONLY validated enum/integer
// values ever reach $GITHUB_OUTPUT or the summary — never log text (the
// boot log is attacker-influenced; it ships as an artifact only).
//
// Never fails the job: if the verdict is missing/invalid it emits
// status=infra_fail so the caller's gate step decides.

import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { validateVerdict } from "./validate-verdict.mjs";
import { sanitiseForLog } from "./sanitise.mjs";

const STATUS_LABEL = {
  pass: "✅ PASS",
  verify_fail: "❌ VERIFY FAIL",
  infra_fail: "⚠️ INFRA FAIL",
  rejected: "🚫 REJECTED",
};

// Outputs are enum/path values only: a value carrying a newline would
// inject a second `name=value` line into $GITHUB_OUTPUT, so refuse anything
// outside this shape rather than trusting the caller-supplied path.
const SAFE_OUTPUT_RE = /^[A-Za-z0-9._/-]{0,200}$/;

function setOutput(name, value) {
  const safe = SAFE_OUTPUT_RE.test(String(value)) ? String(value) : "";
  if (!safe && value) {
    console.error(sanitiseForLog(`refusing to emit unsafe output ${name}=${JSON.stringify(String(value))}`));
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${safe}\n`);
  } else {
    console.log(`output ${name}=${safe}`);
  }
}

function main() {
  const outDir = process.env.OUT_DIR || "boot-verify-out";
  const verdictPath = join(outDir, "verdict.json");

  let verdict = null;
  let problems = ["verdict.json missing"];
  if (existsSync(verdictPath)) {
    try {
      verdict = JSON.parse(readFileSync(verdictPath, "utf8"));
      problems = validateVerdict(verdict);
    } catch (err) {
      problems = [`verdict.json unparseable: ${err.message}`];
    }
  }
  if (problems.length) {
    // Problem text quotes rejected values, which are attacker-controlled
    // whenever a verdict was planted — sanitise before it reaches the log.
    console.error(sanitiseForLog(`verdict invalid: ${problems.join("; ")}`));
    setOutput("status", "infra_fail");
    setOutput("error-class", "browser_launch_failed");
    setOutput("verdict-path", verdictPath);
    return;
  }

  setOutput("status", verdict.status);
  setOutput("error-class", verdict.error_class);
  setOutput("verdict-path", verdictPath);

  // A `rejected` verdict says WHAT was refused but not WHICH url/step, which
  // leaves the operator with nothing actionable. The detail is read from
  // preflight.json rather than the verdict, so the verdict envelope stays
  // closed; preflight has already sanitised and capped it.
  let rejectionDetail = "";
  if (verdict.status === "rejected") {
    try {
      const pf = JSON.parse(readFileSync(join(outDir, "preflight.json"), "utf8"));
      rejectionDetail = String(pf.detail || "")
        .replace(/[\r\n]+/g, " ")
        .replaceAll("|", "\\|")
        .slice(0, 300);
    } catch {
      /* detail is a nicety, never a requirement */
    }
  }

  const lines = [
    `## Boot verify: ${STATUS_LABEL[verdict.status]}`,
    "",
    ...(rejectionDetail ? [`**Refused because:** ${rejectionDetail}`, ""] : []),
    "| field | value |",
    "|---|---|",
    `| status | \`${verdict.status}\` |`,
    `| error_class | \`${verdict.error_class}\` |`,
    `| boot_ms | ${verdict.boot_ms} |`,
    `| steps | ${verdict.steps_ok} ok / ${verdict.steps_failed} failed |`,
    `| blueprint sha256 | \`${verdict.blueprint_sha256 || "(none)"}\` |`,
    `| head sha | \`${verdict.head_sha || "(none)"}\` |`,
    "",
    "### Assertions",
    "",
    "| assertion | result |",
    "|---|---|",
    ...verdict.assertions.map((a) => `| \`${a.id}\` | ${a.ok ? "✅" : "❌"} |`),
    "",
    "_Raw boot log, console log and screenshot are in the uploaded artifact._",
  ];
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  } else {
    console.log(lines.join("\n"));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
