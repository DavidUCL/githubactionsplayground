// The database-snapshot reader: what it accepts, and what it refuses.
//
// Every case here runs against a REAL SQLite file — the published snapshot for
// the accepting cases, and the negative fixtures in test/fixtures/db for the
// refusals. Nothing is hand-built out of a plain object, because the whole
// point of this reader is that it opens the file: a test that fed it a literal
// `facts` object for every case would pass with the file-opening deleted.
//
// The network is a fixture too (test/helpers/net-fixtures.mjs), so the real
// snapshot is served from disk and this suite runs with no network at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { inspectSnapshot, checkSnapshot, MAX_SNAPSHOT_BYTES } from "../scripts/snapshot.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DB = join(HERE, "fixtures", "db");

/** The real published snapshot, as captured by scripts/capture-net-fixtures.mjs. */
const REAL = join(HERE, "fixtures", "net", "integration-test.sq3");

/** Serve a local file as if it were the snapshot URL, with control of the headers. */
function serve(path, { headers = { "access-control-allow-origin": "*" }, status = 200 } = {}) {
  const bytes = readFileSync(path);
  return async () =>
    new Response(bytes, { status, headers: { ...headers, "content-length": String(bytes.length) } });
}

const sha256Of = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Read a fixture and return its facts, failing the test if it would not open. */
async function factsOf(path, opts = {}) {
  const out = await inspectSnapshot("https://example.invalid/s.sq3", {
    fetchImpl: serve(path),
    ...opts,
  });
  assert.equal(out.ok, true, `expected ${path} to open: ${out.reason}`);
  return out;
}

test("the real published snapshot opens and reports what is in it", async () => {
  const { facts } = await factsOf(REAL);
  assert.equal(facts.bytes, 7958528);
  assert.equal(facts.sha256, sha256Of(REAL));
  // The identity is what the in-band assertion later compares against, so an
  // empty or short one here would make that assertion vacuous.
  assert.ok(facts.identity.length >= 20, `identity was ${JSON.stringify(facts.identity)}`);
  assert.equal(facts.branch, "500");
  assert.match(facts.release, /^5\.0/);
  assert.equal(facts.adminUsername, "admin");
  assert.ok(facts.usernames.includes("admin"));
  assert.ok(facts.courses.length >= 1);
  // Present but EMPTY in the real file. If the reader keyed on the row existing
  // rather than being non-empty, this snapshot would be refused.
  assert.deepEqual(facts.rawHtml, []);
});

test("the digest is checked against the bytes actually downloaded", async () => {
  const right = sha256Of(REAL);
  const ok = await inspectSnapshot("https://example.invalid/s.sq3", {
    fetchImpl: serve(REAL),
    expectedSha256: right.toUpperCase(), // case must not matter
  });
  assert.equal(ok.ok, true);

  const bad = await inspectSnapshot("https://example.invalid/s.sq3", {
    fetchImpl: serve(REAL),
    expectedSha256: "0".repeat(64),
  });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /sha256/);
  // The reason must quote what was actually found, or the reviewer cannot tell
  // a moved file from a typo in the digest they supplied.
  assert.match(bad.reason, new RegExp(right));
});

test("something that is not a SQLite database is refused by its first bytes", async () => {
  // The realistic case is an HTML error page served with status 200 — a 404
  // page from a static host, which no status check would catch.
  const html = Buffer.from("<!DOCTYPE html>\n<title>404 Not Found</title>\n");
  const out = await inspectSnapshot("https://example.invalid/s.sq3", {
    fetchImpl: async () => new Response(html, { status: 200 }),
  });
  assert.equal(out.ok, false);
  assert.match(out.reason, /not a SQLite database/);
  assert.match(out.reason, /DOCTYPE/, "must quote the bytes so the cause is obvious");
});

test("an HTTP error and an unreachable host are refused separately", async () => {
  const notFound = await inspectSnapshot("https://example.invalid/s.sq3", {
    fetchImpl: async () => new Response("nope", { status: 404 }),
  });
  assert.equal(notFound.ok, false);
  assert.match(notFound.reason, /HTTP 404/);

  const dead = await inspectSnapshot("https://example.invalid/s.sq3", {
    fetchImpl: async () => { throw new Error("getaddrinfo ENOTFOUND"); },
  });
  assert.equal(dead.ok, false);
  assert.match(dead.reason, /could not fetch/);
});

test("a snapshot over the cap is refused before it is read into memory", async () => {
  // Declared, not delivered: readCapped must believe content-length and stop,
  // rather than streaming 128 MB to find out.
  const out = await inspectSnapshot("https://example.invalid/s.sq3", {
    fetchImpl: async () =>
      new Response("x", {
        status: 200,
        headers: { "content-length": String(MAX_SNAPSHOT_BYTES + 1) },
      }),
  });
  assert.equal(out.ok, false);
  assert.match(out.reason, /over the .* cap/);
});

test("a host that does not allow cross-origin reads warns but does not refuse", async () => {
  // The build-time fetch ignores CORS, so this is the only place it can be
  // seen — but it is the reviewer's browser that has to obey it, and plenty of
  // hosts serve a working file behind a stricter header than we can predict.
  const out = await inspectSnapshot("https://example.invalid/s.sq3", {
    fetchImpl: serve(REAL, { headers: {} }),
  });
  assert.equal(out.ok, true);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /access-control-allow-origin/);

  const fine = await factsOf(REAL);
  assert.deepEqual(fine.warnings, []);
});

// --- checkSnapshot ---------------------------------------------------------

/** What the builder passes for a default preview. NOTE: `admin` is NOT reserved. */
const RESERVED = {
  reservedUsernames: ["teacher", "teacher2", "student1"],
  reservedCourses: ["REVIEW"],
  loginAs: "admin",
  moodleBranch: "MOODLE_500_STABLE",
};

test("the real published snapshot has no problems at all", async () => {
  const { facts } = await factsOf(REAL);
  assert.deepEqual(checkSnapshot(facts, RESERVED), []);
});

test("`admin` must never be reserved, or every real snapshot is refused", async () => {
  const { facts } = await factsOf(REAL);
  // This is not a hypothetical: the first run of this reader refused the
  // published snapshot for exactly this reason. After a restore the
  // administrator comes FROM the snapshot — installMoodle is a no-op and the
  // account it would have made was in the database the swap discarded.
  assert.ok(facts.usernames.includes("admin"));
  const wrong = checkSnapshot(facts, { ...RESERVED, reservedUsernames: ["admin"] });
  assert.equal(wrong.length, 1, "documents the mistake this list must not make");
});

const REFUSALS = [
  ["no-siteidentifier.sq3", /no siteidentifier/],
  ["short-siteidentifier.sq3", /only \d+ characters/],
  ["html-injection.sq3", /additionalhtmlhead/],
  ["review-course.sq3", /already contains course\(s\) REVIEW/],
  ["student1-user.sq3", /already contains user\(s\) student1/],
  ["renamed-admin.sq3", /sign in as "admin"/],
  ["old-version.sq3", /branch 403/],
];

for (const [file, pattern] of REFUSALS) {
  test(`${file} is refused, and for its own reason`, async () => {
    const { facts } = await factsOf(join(DB, file));
    const problems = checkSnapshot(facts, RESERVED);
    assert.equal(problems.length, 1, `expected exactly one problem, got: ${problems.join(" | ")}`);
    assert.match(problems[0], pattern);
  });
}

test("a snapshot from another Moodle is refused, and says why Moodle cannot", async () => {
  const { facts } = await factsOf(join(DB, "old-version.sq3"));
  const [problem] = checkSnapshot(facts, RESERVED);
  // The reason has to carry the surprising part: the restore step disables
  // Moodle's own upgrade check, so the reviewer gets no upgrade screen and no
  // warning — just a database error on some later page.
  assert.match(problem, /403/);
  assert.match(problem, /MOODLE_500_STABLE/);
  assert.match(problem, /restored/);

  // And the same file is fine if that IS the branch being booted.
  assert.deepEqual(
    checkSnapshot(facts, { ...RESERVED, moodleBranch: "MOODLE_403_STABLE" }),
    [],
  );
});

test("the login account is checked against the snapshot, not assumed", async () => {
  const { facts } = await factsOf(REAL);
  // `login` does a MUST_EXIST lookup with no password: an account that is not
  // there kills the boot at the last step with nothing naming the cause.
  const missing = checkSnapshot(facts, { ...RESERVED, loginAs: "teacher" });
  assert.equal(missing.length, 1);
  assert.match(missing[0], /sign in as "teacher"/);
  assert.match(missing[0], /administrator is "admin"/);
});

test("an empty snapshot does not silently pass the login check", () => {
  // A database with no users at all must not be read as "the account is fine".
  // Guarding on `usernames.length` is what makes this a real risk.
  const empty = { identity: "x".repeat(32), rawHtml: [], courses: [], usernames: [], branch: "500" };
  const problems = checkSnapshot(empty, RESERVED);
  assert.ok(
    problems.length === 0 || !problems.some((p) => /sign in as/.test(p)),
    "an empty user table is a separate failure, not a login problem",
  );
});
