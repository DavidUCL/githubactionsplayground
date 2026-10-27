// Which steps in a blueprint did this action write itself?
//
// The action adds its own runPhpCode steps to every plugin preview: the
// assertions that prove a restore, the course, the theme and the language
// packs really took, and the warning banner. runPhpCode is in RISKY_STEPS
// because, as a step type, it can rewrite Moodle, so until 2026-10-27 every
// ordinary preview's comment said "This preview modifies Moodle itself". A
// warning on every comment teaches reviewers to skip it, including on the
// preview where someone else's step really does rewrite Moodle.
//
// Held by object identity in a WeakSet, never as a field on the step: a field
// would be written into the blueprint, and anyone could copy it onto their own
// step to hide it from the warning. Nothing parsed from JSON is ever in here.

const OWN = new WeakSet();

/** Mark a step this action generated, and return it. */
export function ownStep(step) {
  OWN.add(step);
  return step;
}

/** True only for the very object ownStep was given. */
export function isOwnStep(step) {
  return typeof step === "object" && step !== null && OWN.has(step);
}
