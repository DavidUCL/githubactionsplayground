#!/usr/bin/env node
// Nightly: is the live playground running the build we think it is?
//
// The playground is deployed from a repo branch, but nothing checked that the
// site serves that branch's head, or that it was deployed from a clean tree.
// A deploy from a working copy with uncommitted changes is not any commit, so
// a bug in it cannot be found by reading the repo. Measured on 2026-10-20: the
// live default host reports `dirty: true`.
//
// Reads the host's assets/build-version.json and the expected branch head
// from the GitHub API, and fails when they differ, when the build was dirty,
// or when either cannot be read.
//
// Env: PLAYGROUND_HOST, EXPECTED_REPO (owner/name), EXPECTED_BRANCH,
//      GITHUB_TOKEN (optional, raises the API rate limit),
//      GITHUB_STEP_SUMMARY (optional).

import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fetchHostVersion } from "./host-version.mjs";

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]+$/;

/**
 * Compare a host's build record with the expected commit.
 * @returns {string[]} problems; empty means the host serves exactly that commit, clean.
 */
export function compareHostVersion(version, expectedSha) {
  if (!version || version.unknown) return [`the host's build record could not be read: ${version?.unknown || "no record"}`];
  const problems = [];
  if (!expectedSha || !/^[0-9a-f]{40}$/.test(expectedSha)) problems.push(`no usable expected commit (${expectedSha})`);
  else if (!expectedSha.startsWith(version.gitSha)) {
    problems.push(`the host serves ${version.gitSha}, but the branch head is ${expectedSha.slice(0, 12)}`);
  }
  if (version.dirty) problems.push(`the host was deployed with uncommitted changes (${version.buildVersion})`);
  return problems;
}

async function branchHead(repo, branch, token, fetchImpl = fetch) {
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(branch)}`, {
    headers: { accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} reading ${repo}@${branch}`);
  return (await res.json()).sha;
}

async function main() {
  const host = process.env.PLAYGROUND_HOST || "";
  const repo = process.env.EXPECTED_REPO || "";
  const branch = process.env.EXPECTED_BRANCH || "";
  if (!host.startsWith("https://")) throw new Error(`PLAYGROUND_HOST must be https: ${host}`);
  if (!REPO_RE.test(repo)) throw new Error(`EXPECTED_REPO must be owner/name: ${repo}`);
  if (!BRANCH_RE.test(branch)) throw new Error(`EXPECTED_BRANCH is not a branch name: ${branch}`);

  const [version, expected] = await Promise.all([
    fetchHostVersion(host),
    branchHead(repo, branch, process.env.GITHUB_TOKEN).catch((err) => `ERR ${err.message}`),
  ]);
  const problems = String(expected).startsWith("ERR ")
    ? [`the expected commit could not be read: ${expected.slice(4)}`]
    : compareHostVersion(version, expected);

  const lines = [
    "## Playground version",
    "",
    `Host: ${host}`,
    `Build: ${version.buildVersion ?? "unreadable"}`,
    `Expected: ${repo}@${branch} = ${String(expected).slice(0, 12)}`,
    "",
    problems.length ? `**FAIL**\n\n${problems.map((p) => `- ${p}`).join("\n")}` : "**PASS**: the host serves the branch head, deployed clean.",
  ];
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  process.exit(problems.length ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.log(`::error title=playground version::the check did not run — ${err.message}`);
    process.exit(2);
  });
}
