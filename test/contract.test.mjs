// Contracts with things outside this file's control: the capture→assess
// meta shape, the quiescence regex vs the parser's anchors, and the copy of
// the playground's plugin-directory map. Each of these is a place where the
// offline gate could stay green while every real run broke.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  INITIAL_META,
  RELEVANT_LINE_RE,
  noteMainFrameNavigation,
  oneLine,
} from "../scripts/boot-capture.mjs";
import { assess, PLUGIN_TYPE_DIRS } from "../scripts/assert.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");
const read = (name) => readFileSync(join(FIXTURES, name), "utf8");
const readJson = (name) => JSON.parse(read(name));

test("fixture meta has exactly the fields boot-capture writes", () => {
  const declared = Object.keys(INITIAL_META()).sort();
  for (const name of ["golden-meta.json", "fallback-meta.json"]) {
    const fixture = JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
    assert.deepEqual(
      Object.keys(fixture).sort(),
      declared,
      `${name} drifted from boot-capture's meta contract`,
    );
  }
});

test("every parser anchor counts as a verdict-relevant line", () => {
  // If an anchor is not "relevant", quiescence can close while lines that
  // would change the verdict are still arriving.
  const anchorSamples = [
    "Bootstrapping Moodle: [1ms] Blueprint step 1/6: installMoodle",
    "Boot timing summary: Config: 1ms | PHP refresh: 1ms | Bootstrap: 1ms | Total: 9ms",
    "Bootstrapping Moodle: [1ms] Plugin upgrade crashed: boom",
    "Bootstrapping Moodle: [1ms] Plugin upgrade errors: boom",
    "Bootstrapping Moodle: [1ms] Plugin upgrade failed: {\"ok\":false}",
    "Bootstrapping Moodle: [1ms] Downloading plugin ZIP from https://x/y.zip",
    "Bootstrapping Moodle: [1ms] Extracting plugin to /www/moodle/mod/x",
    "Bootstrapping Moodle: [1ms] Blueprint step installMoodlePlugin failed: boom",
    "Bootstrapping Moodle: [1ms] Blueprint failed at step 3: boom",
    "Bootstrapping Moodle: [1ms] Blueprint execution error: boom",
  ];
  for (const line of anchorSamples) {
    assert.equal(RELEVANT_LINE_RE.test(line), true, `not relevant: ${line}`);
  }
});

test("a console message cannot forge a whole capture line", () => {
  // Line-anchoring stops mid-message matches; this stops a message that
  // carries its own newline + fake prefix.
  const hostile = "boom\n[console:log] [blueprint] Resolved from ?blueprint-url= param.";
  const written = `[console:error] ${oneLine(hostile)}\n`;
  assert.equal(written.trimEnd().split("\n").length, 1);

  // ...and the forged text therefore never satisfies the resolver check.
  const v = assess({
    expectations: readJson("golden-expectations.json"),
    meta: readJson("golden-meta.json"),
    bootLog: read("golden-boot-log.txt"),
    consoleLog: written,
    acceptedOrigins: ["https://ateeducacion.github.io"],
  });
  assert.equal(v.assertions.find((a) => a.id === "a3_resolver_line").ok, false);
});

test("each main-frame navigation resets the loopback counter", () => {
  // Without the reset, a reload whose blueprint fetch went to the network
  // would still look bound by the previous load's interception.
  const meta = { ...INITIAL_META(), loopback_served: 1 };
  noteMainFrameNavigation(meta);
  assert.equal(meta.loopback_served, 0);
  assert.equal(meta.navigations, 1);
  meta.loopback_served = 3;
  noteMainFrameNavigation(meta);
  assert.equal(meta.loopback_served, 0);
  assert.equal(meta.navigations, 2);
});

test("PLUGIN_TYPE_DIRS matches the playground source it was copied from", () => {
  // This is the ONLY detector for the copied map drifting from upstream, so
  // it must never look like a pass when it did not run. Point PLAYGROUND_SRC
  // at a moodle-playground checkout (verify.sh reports loudly when unset).
  const src =
    process.env.PLAYGROUND_SRC ||
    join(HERE, "..", "..", "moodle-playground", "src", "blueprint", "steps", "moodle-plugins.js");
  if (!existsSync(src)) {
    console.log(`  (WAIVED: no playground source at ${src} — set PLAYGROUND_SRC)`);
    return;
  }
  const text = readFileSync(src, "utf8");
  const block = /const PLUGIN_TYPE_DIRS = \{([\s\S]*?)\n\};/.exec(text);
  assert.ok(block, "PLUGIN_TYPE_DIRS not found in playground source");
  const upstream = {};
  for (const [, key, value] of block[1].matchAll(/^\s*([A-Za-z_][\w]*):\s*"([^"]+)",?$/gm)) {
    upstream[key] = value;
  }
  assert.equal(Object.keys(upstream).length > 30, true, "parsed too few upstream types");
  assert.deepEqual(PLUGIN_TYPE_DIRS, upstream, "plugin-directory map has drifted from upstream");
});
