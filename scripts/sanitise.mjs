// Shared by every script that echoes blueprint- or verdict-derived text to
// stdout/stderr. Kept dependency-free so the privileged side (summary
// rendering, and any future workflow_run consumer) can import it alone.

/**
 * Strip anything that could become a runner workflow command or forge an
 * annotation: newlines start a new command line, `::` opens one.
 */
export function sanitiseForLog(detail) {
  return String(detail).replace(/[\r\n]+/g, " ").replaceAll("::", "∷").slice(0, 500);
}
