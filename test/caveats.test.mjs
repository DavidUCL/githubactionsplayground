import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { renderComment } from "../scripts/render-comment.mjs";

const COMMENT = {
  url: "https://daviducl.github.io/moodle-playground/?blueprint=abc",
  plugin: "mod_attendance",
  headSha: "d0638b39df1c28fd93c27778ae2cbada7cc1660f",
};

test("the comment lists what was not checked", () => {
  const body = renderComment({ ...COMMENT, caveats: ["Moodle-version compatibility: no version.php could be read."] });
  assert.match(body, /\*\*Not checked in this run:\*\*\n- Moodle-version compatibility: no version\.php could be read\./);
  assert.doesNotMatch(renderComment(COMMENT), /Not checked/);
});

test("a caveat cannot make a link, image or HTML in the comment, and is bounded", () => {
  const body = renderComment({
    ...COMMENT,
    caveats: ["x [click](https://evil.tld) ![i](https://evil.tld/i.png) <img src=x> `code`", "y".repeat(1000)],
  });
  const block = body.slice(body.indexOf("Not checked"));
  assert.doesNotMatch(block, /\]\(|<img|`code`/);
  assert.ok(!block.includes("y".repeat(301)), "each caveat is cut to 300 characters");
});

test("a check that could not run reaches the outputs and the summary, end to end", () => {
  // MOODLE_501_STABLE has no captured component list, so the fetch is refused
  // and the core-collision and dependency checks cannot run: the case where the
  // comment used to look like every other green one.
  const dir = mkdtempSync(join(tmpdir(), "caveat-"));
  execFileSync(process.execPath, ["scripts/build-preview.mjs"], {
    env: {
      ...process.env,
      HEAD_REPO: "DavidUCL/moodle-mod_attendance",
      HEAD_SHA: "a".repeat(40),
      PLUGIN_TYPE: "mod",
      PLUGIN_NAME: "attendance",
      MOODLE_BRANCH: "MOODLE_501_STABLE",
      PLUGIN_ROOT: join(dir, "no-such-checkout"),
      OUT_DIR: dir,
      GITHUB_OUTPUT: join(dir, "gho"),
      GITHUB_STEP_SUMMARY: join(dir, "sum"),
    },
    encoding: "utf8",
    stdio: "pipe",
  });
  const outputs = readFileSync(join(dir, "gho"), "utf8");
  const caveatLine = outputs.split("\n").find((l) => l.startsWith("caveats="));
  assert.ok(caveatLine, "a caveats output is written");
  assert.match(caveatLine, /component list did not load/);
  const summary = readFileSync(join(dir, "sum"), "utf8");
  assert.match(summary, /\*\*Not checked in this run:\*\*/);
  assert.match(summary, /component list did not load/);
});
