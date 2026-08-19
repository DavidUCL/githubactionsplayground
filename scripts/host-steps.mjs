// Does the playground we are about to link to actually implement the steps
// this blueprint uses?
//
// WHY THIS EXISTS. The deployed playgrounds are not all the same build, and an
// unknown step name does not skip that step — the executor rejects the WHOLE
// blueprint against its schema and boots the starter site instead. The reviewer
// gets a working Moodle with no plugin, no course and nothing in the log saying
// why, which is the single failure mode this action exists to prevent, arriving
// through a door nothing was watching.
//
// MEASURED 2026-08-19, the same file on both hosts:
//   daviducl.github.io/moodle-playground     KNOWN_STEP_NAMES has restoreDatabase
//   ateeducacion.github.io/moodle-playground it does not
// So a `restore-database-url` preview pointed at the second host would publish
// a link to a Moodle with none of this preview in it.
//
// INCONCLUSIVE IS NOT A REFUSAL. The check reads a source file at a path we do
// not control, so it can fail for reasons that say nothing about the host: a
// runner with no egress, a reorganised layout, a new bundling step. Refusing on
// any of those would break every run the day the playground is restructured. A
// positive determination — we read the list and the step is not in it — is a
// refusal; anything else is reported and the build continues. That is also why
// this returns a reason rather than a boolean: a caller cannot tell the two
// apart from `false`.

/** Where each deployed playground publishes its step schema, relative to the host. */
const SCHEMA_PATH = "src/blueprint/schema.js";

/**
 * The step list is a plain `new Set([...])` of string literals. Parsed with a
 * regex rather than by importing it: this is a third party's source, fetched at
 * build time, and evaluating it would be running their code on the runner to
 * find out what their code does.
 */
const STEP_SET_RE = /KNOWN_STEP_NAMES\s*=\s*new Set\(\s*\[([^\]]*)\]/;
const STRING_RE = /"([A-Za-z][A-Za-z0-9_]*)"|'([A-Za-z][A-Za-z0-9_]*)'/g;

/**
 * Read the step names a playground deployment says it understands.
 *
 * @returns {{known: Set<string>} | {unknown: string}} `unknown` carries the
 *   reason the list could not be read, for reporting rather than refusing.
 */
export async function fetchHostSteps(playgroundHost, { fetchImpl = fetch } = {}) {
  let url;
  try {
    // A host may be given with or without a trailing slash, and `new URL`
    // drops the last path segment without one — which would ask
    // github.io/src/... and 404 for a host that is perfectly fine.
    const base = String(playgroundHost).endsWith("/")
      ? String(playgroundHost)
      : `${playgroundHost}/`;
    url = new URL(SCHEMA_PATH, base).toString();
  } catch (err) {
    return { unknown: `could not form the schema URL for ${playgroundHost}: ${err.message}` };
  }

  let text;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(20000), redirect: "follow" });
    if (!res.ok) return { unknown: `HTTP ${res.status} reading ${url}` };
    text = await res.text();
  } catch (err) {
    return { unknown: `could not read ${url}: ${err.message}` };
  }

  const block = STEP_SET_RE.exec(text);
  if (!block) return { unknown: `${url} does not declare KNOWN_STEP_NAMES in the expected shape` };

  const known = new Set();
  for (const m of block[1].matchAll(STRING_RE)) known.add(m[1] ?? m[2]);
  // A parse that produced a handful of names is a parse that went wrong, and an
  // almost-empty allowed-list would refuse every blueprint we build. Every
  // deployment has dozens; this is the floor that turns a bad parse into
  // "inconclusive" rather than into a wall of false refusals.
  if (known.size < 10) {
    return { unknown: `${url} yielded only ${known.size} step name(s), so it was not understood` };
  }
  return { known };
}

/**
 * Which of a blueprint's steps the host does not implement.
 *
 * @returns {{ok: true} | {ok: false, missing: string[]} | {ok: true, unknown: string}}
 */
export function stepsHostCannotRun(steps, hostSteps) {
  if (hostSteps?.unknown) return { ok: true, unknown: hostSteps.unknown };
  const used = [...new Set((steps || []).map((s) => String(s?.step ?? "")).filter(Boolean))];
  const missing = used.filter((name) => !hostSteps.known.has(name)).sort();
  return missing.length ? { ok: false, missing } : { ok: true };
}

/** The refusal text, which has to explain a failure the reviewer would never diagnose. */
export function explainMissingSteps(playgroundHost, missing) {
  return (
    `the playground at ${playgroundHost} does not implement ${missing.join(", ")}. ` +
    `An unrecognised step does not get skipped: the executor rejects the WHOLE ` +
    `blueprint and boots its starter site instead, so the link would open a Moodle ` +
    `with no plugin, no course and nothing saying why. Use the default playground ` +
    `host, or drop the input that adds ${missing.length === 1 ? "this step" : "these steps"}.`
  );
}
