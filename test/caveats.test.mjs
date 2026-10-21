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
  assert.doesNotMatch(renderComment({ ...COMMENT, caveats: ["HTTP 403 for @someone"] }), /@someone/);
  const bare = renderComment({ ...COMMENT, caveats: ["HTTP 404 reading https://evil.tld/x"] });
  assert.doesNotMatch(bare.slice(bare.indexOf("Not checked")), /https:\/\/evil/);
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

test("the comment step reads playground-origins: a link to a listed host is posted", () => {
  // The env wiring in main(), which no unit call of renderComment reaches. With
  // the built-in list instead, this link would be refused and nothing posted.
  const run = (env) =>
    execFileSync(process.execPath, ["scripts/render-comment.mjs"], {
      env: {
        ...process.env,
        PREVIEW_URL: "https://playground.example.ac.uk/?blueprint=abc",
        PLUGIN: "mod_attendance",
        HEAD_SHA: "d0638b39df1c28fd93c27778ae2cbada7cc1660f",
        GITHUB_OUTPUT: "",
        ...env,
      },
      encoding: "utf8",
      stdio: "pipe",
    });
  assert.match(run({ PLAYGROUND_ORIGINS: "https://playground.example.ac.uk" }), /Open this pull request in Moodle Playground/);
  assert.throws(() => run({ PLAYGROUND_ORIGINS: "" }), /refusing to post/);
});
