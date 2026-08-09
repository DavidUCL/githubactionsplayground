// Does the produced .mbz match what fixtures/fixture-spec.json declares?
//
// This is the HONESTY PROOF for make-fixture, and it has to run INSIDE that
// workflow rather than as a check on the pull request it opens. GitHub's own
// documentation: when a workflow using GITHUB_TOKEN creates a pull request, the
// resulting `pull_request` event "creates workflow runs in an approval-required
// state". They sit greyed behind an "Approve workflows to run" banner, which a
// reviewer can merge straight past. A check nobody is forced to look at is not
// a check.
//
// So the workflow verifies its own output before it ever opens the PR, and the
// PR carries the verification in its body as a record.
//
// Usage:  node scripts/check-fixture.mjs <fixture.mbz> [spec.json]

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectMbz } from "./mbz.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * @returns {{ok: boolean, problems: string[], info: object|null}}
 */
export function checkFixture(bytes, spec) {
  const problems = [];
  const info = inspectMbz(bytes);
  if (!info.ok) return { ok: false, problems: [info.reason], info: null };

  if (info.type !== "course") {
    problems.push(`it is a "${info.type}" backup, not a course backup`);
  }

  const want = [...(spec.modules ?? [])].sort();
  const got = [...(info.modulenames ?? [])].sort();
  if (JSON.stringify(want) !== JSON.stringify(got)) {
    const missing = want.filter((m) => !got.includes(m));
    const extra = got.filter((m) => !want.includes(m));
    problems.push(
      `activities do not match the spec` +
        (missing.length ? `; missing ${missing.join(", ")}` : "") +
        (extra.length ? `; unexpected ${extra.join(", ")}` : ""),
    );
  }
  // Count as well as names: two instances of one module and none of another
  // would satisfy a name-only check.
  if (info.activityCount !== want.length) {
    problems.push(`it declares ${info.activityCount} activities, the spec declares ${want.length}`);
  }

  // The failure this exists to prevent, measured by booting: a fixture carrying
  // `student1` restored fine, the post-restore assertion passed, and
  // createUsers then died five steps in.
  if (Boolean(spec.includesUsers) !== Boolean(info.usernames?.length)) {
    problems.push(
      spec.includesUsers
        ? `the spec says it carries users but it carries none`
        : `it carries user(s) ${info.usernames.join(", ")} but the spec says it must carry none`,
    );
  }

  // A fixture owning REVIEW would leave the restored content in a course named
  // something else, because phpRestoreCourse only takes a free shortname.
  if (info.originalCourseShortname === "REVIEW") {
    problems.push(`its shortname is REVIEW, which the preview needs to be free`);
  }
  if (spec.shortname && info.originalCourseShortname && info.originalCourseShortname !== spec.shortname) {
    problems.push(
      `its shortname is "${info.originalCourseShortname}", the spec declares "${spec.shortname}"`,
    );
  }

  return { ok: problems.length === 0, problems, info };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const file = process.argv[2];
  const specPath = process.argv[3] || join(HERE, "..", "fixtures", "fixture-spec.json");
  if (!file) {
    console.error("usage: node scripts/check-fixture.mjs <fixture.mbz> [spec.json]");
    process.exit(2);
  }
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  const { ok, problems, info } = checkFixture(readFileSync(file), spec);
  if (!ok) {
    console.error(`the fixture does not match ${specPath}:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(
    `fixture OK: ${info.format}, ${info.activityCount} activities ` +
      `(${info.modulenames.join(", ")}), shortname ${info.originalCourseShortname}, ` +
      `${info.usernames.length} users`,
  );
}
