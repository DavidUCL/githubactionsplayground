// Blueprint ORDERING and REFERENTIAL integrity.
//
// Three orderings that must never ship were ACCEPTED by the gate before this
// file existed (measured 2026-08-07, all five):
//
//   setTheme-with-no-install   activate a theme nobody installed
//   setTheme-before-anything   setTheme at index 0
//   restoreDatabase-last       wipes every user and course just created
//   installMoodle-not-first    steps against a Moodle that does not exist
//   login-before-createUsers   phpLogin does MUST_EXIST and dies
//
// The ordering coverage that existed was three hand-written assertions in
// test/preview-snapshot.test.mjs ("install first, log in last"). Those test
// the builder's CURRENT OUTPUT, not an invariant — insert a step in the wrong
// place and they still pass. This is a table instead, consumed by
// gateBlueprint, so it also covers foreign `blueprint-url` runs.
//
// It lives in its own module rather than in build-preview.mjs (where the panel
// put it) because preflight.mjs must import it, and preflight.mjs is imported
// BY build-preview.mjs — siting it there would be a cycle.
//
// DELIBERATELY CONSERVATIVE. These rules also judge foreign blueprints written
// by other people, so a rule with no nameable breakage is not a safety
// improvement, it is a false refusal of someone's valid input. Every rule below
// cites the mechanism that breaks. Orderings that are merely unusual are
// allowed.

/**
 * Step names that mean the same thing for ordering. The registry has singular
 * and plural forms of most creators, and a rule naming only the plural would
 * be silently unenforced against the singular — the exact silent-gap shape
 * this project keeps paying for.
 */
export const STEP_GROUPS = {
  installMoodle: ["installMoodle"],
  restoreDatabase: ["restoreDatabase"],
  installTheme: ["installTheme"],
  setTheme: ["setTheme"],
  addModule: ["addModule"],
  setConfigs: ["setConfig", "setConfigs"],
  createCourse: ["createCourse", "createCourses"],
  createUsers: ["createUser", "createUsers"],
  enrolUsers: ["enrolUser", "enrolUsers"],
  login: ["login"],
  setLandingPage: ["setLandingPage"],
};

/**
 * `before` must precede `after`. `"*"` means every step that is not on the
 * other side of the rule and not named in `except`.
 *
 * `id` exists so a test can be tied to a rule: the suite refuses to run if any
 * rule has no case, and each case is written out by hand rather than generated
 * from this table. A generated case would VANISH with the rule it covers, so
 * deleting a rule would leave the suite green — the table would be testing
 * itself into vacuity.
 */
export const ORDER_RULES = [
  {
    id: "install-moodle-first",
    before: "installMoodle",
    after: "*",
    // restoreDatabase legitimately comes FIRST: mchef emits it at index 0
    // (BlueprintConverter.php:62 array_unshift), and the published canary
    // blueprint is restoreDatabase -> installMoodle -> login -> plugins. The
    // swap happens inside PHP before config.php loads, so it does not need an
    // installed Moodle. Without this exception the gate refuses the project's
    // own nightly canary and every blueprint mchef publishes.
    except: ["restoreDatabase"],
    why: "nothing exists before Moodle is installed",
  },
  {
    id: "restore-database-early",
    before: "restoreDatabase",
    after: "*",
    // installMoodle has to have run: there is no database to replace before it.
    except: ["installMoodle"],
    why:
      "restoreDatabase REPLACES the whole database and runs no upgrade, so " +
      "anything created before it is destroyed without a word — a later login " +
      "dies on MUST_EXIST, and a plugin installed before it is WORSE: its " +
      "files survive the swap while its rows do not, and the restore re-runs " +
      "the config normalizer, which sets allversionshash to the current " +
      "codebase hash (moodle-database.js:148, bootstrap.js:820). Moodle then " +
      "believes the plugin is installed and never creates its tables",
  },
  {
    id: "install-theme-before-set-theme",
    before: "installTheme",
    after: "setTheme",
    why: "a theme cannot be activated before it is installed",
  },
  {
    id: "users-before-enrol",
    before: "createUsers",
    after: "enrolUsers",
    why: "an enrolment needs the account it enrols",
  },
  {
    id: "users-before-login",
    before: "createUsers",
    after: "login",
    why: "phpLogin does MUST_EXIST on the username and dies if it is absent",
  },
  {
    id: "course-before-enrol",
    before: "createCourse",
    after: "enrolUsers",
    why: "an enrolment needs the course it enrols into",
  },
  {
    id: "landing-page-last",
    before: "*",
    after: "setLandingPage",
    why: "the landing page is where the reviewer arrives, so nothing follows it",
  },
];

const namesFor = (spec) => {
  const group = STEP_GROUPS[spec];
  if (!group) throw new Error(`ORDER_RULES names an unknown step group: ${spec}`);
  return new Set(group);
};

/**
 * @param {Array<{step?: string}>} steps
 * @returns {string[]} one message per violated rule
 */
export function checkOrder(steps) {
  const names = steps.map((s) => s?.step);
  const errors = [];
  for (const rule of ORDER_RULES) {
    if (rule.before === "*" && rule.after === "*") {
      throw new Error(`ORDER_RULES rule ${rule.id} has a wildcard on both sides`);
    }
    const except = new Set(rule.except || []);
    const beforeSet = rule.before === "*" ? null : namesFor(rule.before);
    const afterSet = rule.after === "*" ? null : namesFor(rule.after);
    const isBefore = (n) =>
      beforeSet ? beforeSet.has(n) : Boolean(n) && !afterSet.has(n) && !except.has(n);
    const isAfter = (n) =>
      afterSet ? afterSet.has(n) : Boolean(n) && !beforeSet.has(n) && !except.has(n);

    const firstAfter = names.findIndex(isAfter);
    if (firstAfter < 0) continue;
    // Walk back from the end: report the LAST offender, which is the one a
    // reader has to move furthest.
    for (let j = names.length - 1; j > firstAfter; j--) {
      if (isBefore(names[j])) {
        errors.push(
          `step[${j}] ${names[j]} must come before step[${firstAfter}] ` +
            `${names[firstAfter]} — ${rule.why}`,
        );
        break;
      }
    }
  }
  return errors;
}

/** Steps after which the database contains rows this gate cannot enumerate. */
const OPAQUE_SOURCES = new Set(["restoreDatabase", "restoreCourse"]);

/**
 * Names referenced by one step must be created by an earlier one.
 *
 * Waived from the first restoreDatabase/restoreCourse onwards: those bring in
 * users and courses this gate cannot see, so enforcing the rules past that
 * point would refuse valid blueprints — including every blueprint step 6 of
 * the build plan is meant to produce.
 *
 * @param {Array<object>} steps
 * @param {{ok: boolean, standard: Set<string>}} [coreComponents]
 * @returns {string[]}
 */
export function checkReferences(steps, coreComponents) {
  const errors = [];
  const users = new Set();
  const courses = new Set();
  const themes = new Set();
  const mods = new Set();
  let coursesCreatedAt = -1;
  let opaqueFrom = steps.findIndex((s) => OPAQUE_SOURCES.has(s?.step));
  if (opaqueFrom < 0) opaqueFrom = Infinity;

  const listOf = (v) => (Array.isArray(v) ? v : []);

  for (const [i, step] of steps.entries()) {
    const name = step?.step;
    // --- collect ---
    // installMoodle CREATES the admin account, defaulting the name to "admin"
    // (moodle-install.js:35 for login, :24 for setAdminAccount). Without this
    // the rule refuses `login: admin` — which is what the real vendored
    // blueprint in test/fixtures does, and it is correct.
    if (name === "installMoodle") users.add(step.username || "admin");
    if (name === "setAdminAccount" && step.username) users.add(step.username);
    if (name === "createUser") users.add(step.username);
    if (name === "createUsers") for (const u of listOf(step.users)) users.add(u?.username);
    if (name === "createCourse") courses.add(step.shortname);
    if (name === "createCourses") for (const c of listOf(step.courses)) courses.add(c?.shortname);
    // A theme arrives by EITHER step. mchef emits themes as installMoodlePlugin
    // with pluginType "theme" (see the vendored fixture, which installs
    // theme_boost_union that way and then activates it), so collecting only
    // from installTheme would refuse a blueprint that works.
    if (name === "installTheme") themes.add(step.pluginName);
    if (name === "installMoodlePlugin" && step.pluginType === "theme") themes.add(step.pluginName);
    if (name === "installMoodlePlugin" && step.pluginType === "mod") mods.add(step.pluginName);
    if ((name === "createCourse" || name === "createCourses") && coursesCreatedAt < 0) {
      coursesCreatedAt = i;
    }

    // --- check ---
    if (name === "setTheme" && step.name) {
      // A CORE theme needs no install step: `setTheme: boost` is valid input,
      // and the panel's rule as written ("must match some installed theme")
      // would have refused it. Only checkable when the core list loaded; when
      // it did not, this rule is skipped rather than guessed at.
      const isCore = coreComponents?.ok && coreComponents.standard.has(`theme_${step.name}`);
      if (!isCore && !themes.has(step.name) && coreComponents?.ok) {
        errors.push(
          `step[${i}] setTheme: "${step.name}" is neither a core theme nor installed ` +
            `by an earlier installTheme — the step succeeds and the site keeps the ` +
            `old theme, so the reviewer sees no change and no error`,
        );
      }
    }
    // Replaces a blanket "every plugin install precedes every addModule" rule,
    // which refused an unrelated language pack or block installed afterwards —
    // orderings with no nameable breakage. What actually breaks is adding an
    // instance of a module that does not exist, so check THAT.
    if (name === "addModule" && step.module && coreComponents?.ok) {
      const isCore = coreComponents.standard.has(`mod_${step.module}`);
      if (!isCore && !mods.has(step.module)) {
        errors.push(
          `step[${i}] addModule: "${step.module}" is neither a core activity nor ` +
            `installed by an earlier step — the module cannot be added`,
        );
      }
    }
    // Replaces a blanket "no setConfig after createCourse" rule, which refused
    // ordinary blueprints. The breakage is specific: enrol_manual COPIES this
    // one setting into the course at creation time, so setting it afterwards
    // silently does not reach any course already made.
    if ((name === "setConfig" || name === "setConfigs") && coursesCreatedAt >= 0) {
      const rows = name === "setConfig" ? [step] : listOf(step.configs);
      for (const c of rows) {
        if (c?.name === "sendcoursewelcomemessage") {
          errors.push(
            `step[${i}] ${name}: sendcoursewelcomemessage is copied into a course ` +
              `by enrol_manual when the course is CREATED, and step[${coursesCreatedAt}] ` +
              `already created one — setting it here reaches no existing course`,
          );
        }
      }
    }

    if (i > opaqueFrom) continue;
    if (name === "login" && step.username && !users.has(step.username)) {
      errors.push(
        `step[${i}] login: no earlier step creates the user "${step.username}" — ` +
          `phpLogin does MUST_EXIST and the boot dies here`,
      );
    }
    if (name === "enrolUser" || name === "enrolUsers") {
      const rows = name === "enrolUser" ? [step] : listOf(step.enrolments);
      for (const [k, e] of rows.entries()) {
        if (e?.username && !users.has(e.username)) {
          errors.push(
            `step[${i}] ${name}[${k}]: no earlier step creates the user "${e.username}"`,
          );
        }
        if (e?.course && !courses.has(e.course)) {
          errors.push(
            `step[${i}] ${name}[${k}]: no earlier step creates the course "${e.course}"`,
          );
        }
      }
    }
  }
  return errors;
}
