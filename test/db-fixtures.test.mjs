// The negative database fixtures must keep carrying the state they exist for.
//
// They are the only way to test the restore-database refusals: the published
// snapshot is a HEALTHY database, so it can demonstrate that a good file is
// accepted and nothing else. Each file here is one specific bad state.
//
// This suite is not about the reader — it is about the fixtures. A fixture that
// quietly stops holding its defect turns its refusal test green forever, which
// is the same silent-pass failure the refusals themselves exist to prevent.
// Regenerate with `node scripts/make-db-fixtures.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "db");
const open = (name) => new DatabaseSync(join(DIR, name), { readOnly: true });
const config = (db, name) =>
  db.prepare("SELECT value FROM mdl_config WHERE name = ?").get(name)?.value ?? null;
const seq = (db) =>
  db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'mdl_course'").get()?.seq ?? null;

test("every negative fixture exists and is a real SQLite database", () => {
  const names = [
    "no-siteidentifier.sq3", "short-siteidentifier.sq3", "html-injection.sq3",
    "review-course.sq3", "student1-user.sq3", "renamed-admin.sq3",
    "high-sequence.sq3", "old-version.sq3",
  ];
  for (const n of names) {
    assert.ok(existsSync(join(DIR, n)), `${n} is missing — run scripts/make-db-fixtures.mjs`);
    const db = open(n);
    // A file we can open and query, not just bytes with the right first line.
    assert.ok(db.prepare("SELECT count(*) c FROM mdl_config").get().c > 0, n);
    db.close();
  }
});

test("each fixture carries exactly the defect it is named for", () => {
  let db = open("no-siteidentifier.sq3");
  // Quinn's demonstrated vacuity: with no identity row the builder records "",
  // and `"" === ""` passes against any database at all.
  assert.equal(config(db, "siteidentifier"), null);
  db.close();

  db = open("short-siteidentifier.sq3");
  assert.equal(config(db, "siteidentifier").length < 10, true);
  db.close();

  db = open("html-injection.sq3");
  // Cass booted script execution on the playground origin from a row like this.
  assert.match(config(db, "additionalhtmlhead"), /<script>/);
  db.close();

  db = open("review-course.sq3");
  const shortnames = open("review-course.sq3")
    .prepare("SELECT shortname FROM mdl_course").all().map((r) => r.shortname);
  assert.ok(shortnames.includes("REVIEW"), "must collide with the preview's own course");
  db.close();

  db = open("student1-user.sq3");
  const users = db.prepare("SELECT username FROM mdl_user").all().map((r) => r.username);
  assert.ok(users.includes("student1"), "must collide with an account the preview creates");
  db.close();

  db = open("renamed-admin.sq3");
  const admins = db.prepare("SELECT username FROM mdl_user").all().map((r) => r.username);
  assert.equal(admins.includes("admin"), false, "the admin must NOT be called admin");
  db.close();

  db = open("high-sequence.sq3");
  // THE ONE NO OTHER FIXTURE CAN SHOW. mdl_course is AUTOINCREMENT, so the next
  // id is seq+1 and NOT max(id)+1 — a snapshot that deleted courses hands out a
  // high id while looking empty. Simple inserts cannot produce this state.
  assert.equal(seq(db), 40);
  assert.equal(db.prepare("SELECT count(*) c FROM mdl_course").get().c, 1);
  db.close();

  db = open("old-version.sq3");
  assert.equal(config(db, "branch"), "403");
  db.close();
});

test("the healthy published snapshot has none of those defects", () => {
  // The positive fixture is the REAL published file, not a synthesised one: a
  // hand-built "good" database shares every assumption with the reader and so
  // proves only that we can read what we wrote.
  const real = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "net", "integration-test.sq3");
  assert.ok(existsSync(real), "the real snapshot fixture is missing");
  const db = new DatabaseSync(real, { readOnly: true });
  assert.ok(config(db, "siteidentifier").length > 20);
  assert.equal(config(db, "branch"), "500");
  // MEASURED, and it is why the injection refusal keys on a NON-EMPTY value:
  // the published snapshot carries this row empty, so a refusal keyed on the
  // row's presence would reject the canary itself.
  assert.equal(config(db, "additionalhtmlhead"), "");
  const users = db.prepare("SELECT username FROM mdl_user").all().map((r) => r.username);
  assert.deepEqual(users.sort(), ["admin", "guest"]);
  assert.equal(seq(db), 1);
  db.close();
});
