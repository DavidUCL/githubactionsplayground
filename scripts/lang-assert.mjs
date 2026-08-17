// Prove the language packs the link asked for are really installed, and that
// the site is really speaking the first of them.
//
// WHY THE OBVIOUS CHECK IS VACUOUS — the third control running where it is, so
// the trace is written down rather than left to be rediscovered.
// `get_string_manager()->translation_exists('es')` is
// `isset(get_list_of_translations()['es'])`, and that list keeps any directory
// whose `load_component_strings('langconfig', 'es')` returns a non-empty
// `thislanguage`. `load_component_strings()` LOADS ENGLISH FIRST — the source
// comment is literally "First load english pack" — and only then overlays the
// requested language if its own file is there. `lang/en/langconfig.php` sets
// `thislanguage = 'English'`. So an EMPTY `$CFG->dataroot/lang/es/` reports
// installed, listed as "English (es)". `is_dir` in a costume, and
// `get_list_of_translations()` has the same hole plus a `$CFG->langlist`
// filter. Neither is used here. The next tidy-up will reach for them; this
// comment is why it must not.
//
// What IS checked, per requested code: the pack's own `langconfig.php` exists
// on disk, AND the string it defines for `thislanguage` is not English. A pack
// that downloaded as an empty directory fails the first; one that unpacked
// without its langconfig fails the second.
//
// STEP PLACEMENT. The install step ends with `reset_caches()`, which bumps
// `$CFG->langrev` and so changes the string caches' key suffix. This assertion
// is a separate step that runs after it, which is what makes the read honest —
// `get_string_manager(true)` does NOT defeat the langmenu MUC cache, only the
// revision bump does.
//
// The step handler for `installLanguagePack` CANNOT FAIL: its PHP wraps
// everything in an empty `catch (\Throwable $e) {}` and its JS wraps that in a
// `catch (err) { publish(...); return; }`. `critical: true` on it is inert on
// both deployed hosts. So this file is the only thing standing between a failed
// download and a reviewer looking at an English site with a green boot log.
//
// See BOOT-MEASUREMENTS.md: `define('CLI_SCRIPT',true)` before
// `require(config.php)` then a non-zero `exit()` is the only thing that fails a
// step. A throw and a fatal error both report SUCCESS.

/** Exit codes this step can produce, for the boot-log explainer. Block 51-59. */
export const LANG_CODES = {
  51: "a language pack the link asked for is NOT installed — the site would " +
    "render in English with nothing in the boot log to say the download failed",
  52: "the language packs installed, but the site language is not the first " +
    "one asked for, so the reviewer would arrive in the wrong language",
  53: "a language pack's own configuration could not be read at all",
};

/**
 * Moodle language codes: `es`, `pt_br`, `en_us`. Same shape the playground's
 * own handler enforces before interpolating into PHP.
 */
const LANG_CODE = /^[a-z][a-z0-9_]*$/;

/** How many packs one preview may install. */
export const MAX_LANGUAGE_PACKS = 3;

/** Collapse to one line: a newline in any blueprint string is rejected. */
const oneLine = (s) => s.replace(/\s+/g, " ").trim();

/**
 * Parse the `language-packs` box.
 *
 * REFUSES, never drops. A silently-ignored element is the pattern this repo has
 * paid for repeatedly: `.split(",").filter(Boolean)` turns a typo into a
 * preview that boots happily without the thing that was asked for.
 *
 * @returns {{codes: string[], problems: string[]}}
 */
export function parseLanguagePacks(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { codes: [], problems: [] };
  const problems = [];
  const codes = [];
  const parts = text.split(",");
  for (const part of parts) {
    const code = part.trim();
    if (!code) {
      problems.push(
        `there is an empty entry in the list (${JSON.stringify(text)}) — a stray ` +
          `comma. Dropping it silently is how a preview boots without the language ` +
          `you asked for.`,
      );
      continue;
    }
    if (!LANG_CODE.test(code)) {
      problems.push(
        `${JSON.stringify(code)} is not a Moodle language code. They are lower case ` +
          `letters, digits and underscores, starting with a letter — "es", "fr", "pt_br".`,
      );
      continue;
    }
    if (code === "en") {
      // English is not a downloadable pack: it ships in `dirroot` and never
      // appears under `dataroot/lang/en/`, and its `thislanguage` IS "English",
      // so it would fail BOTH halves of the assertion on a perfectly healthy
      // site. Refusing is honest; special-casing it inside the assertion would
      // put a hole in the assertion for every other code too.
      problems.push(
        `"en" is not an installable language pack — English is built into Moodle ` +
          `and is what the preview already speaks. Remove it from the list.`,
      );
      continue;
    }
    if (codes.includes(code)) {
      problems.push(`${JSON.stringify(code)} is listed more than once.`);
      continue;
    }
    codes.push(code);
  }
  if (codes.length > MAX_LANGUAGE_PACKS) {
    problems.push(
      `${codes.length} language packs asked for, and the limit is ${MAX_LANGUAGE_PACKS}. ` +
        `Each one is a real download in the reviewer's browser before the page appears.`,
    );
  }
  return { codes, problems };
}

/**
 * @param {{codes: string[]}} opts
 * @returns {{step: string, code: string, critical: boolean}}
 */
export function buildLangAssertion({ codes }) {
  if (!Array.isArray(codes) || codes.length === 0) {
    throw new Error("internal: a language assertion needs at least one code");
  }
  for (const c of codes) {
    if (!LANG_CODE.test(String(c)) || c === "en") {
      // Refusing to BUILD an assertion that could not be trusted, rather than
      // emitting a weakened one. A refusal must never look like an absence.
      throw new Error(`internal: unsafe language code for an assertion: ${JSON.stringify(c)}`);
    }
  }
  const list = codes.map((c) => `'${c}'`).join(", ");
  const want = codes[0];

  // NO `//` COMMENTS INSIDE THIS STRING — `oneLine` collapses the program onto
  // one physical line, so the first one would comment out everything after it.
  const code = oneLine(`<?php
    define('CLI_SCRIPT',true);
    require('/www/moodle/config.php');
    $want = array(${list});
    $sm = get_string_manager();
    foreach ($want as $c) {
      $dir = $CFG->dataroot . '/lang/' . $c;
      if (!is_file($dir . '/langconfig.php')) { error_log('langpack: missing ' . $c); exit(51); }
      $name = $sm->get_string('thislanguage', 'langconfig', null, $c);
      if ($name === '' || $name === null) { error_log('langpack: unreadable ' . $c); exit(53); }
      if ($name === 'English') { error_log('langpack: english fallback for ' . $c); exit(51); }
    }
    $lang = $CFG->lang ?? 'en';
    error_log('langpack: installed=${codes.join("+")} sitelang=' . $lang);
    if ($lang !== '${want}') { exit(52); }
    exit(0);
  `);

  // THE ORDER OF THE TWO CHECKS IS LOAD-BEARING. Every code is verified before
  // `$CFG->lang` is compared, so a request for a language that does not exist
  // exits 51 (the pack is missing) rather than 52. That matters because the
  // playground's own `setDefault` block sets `$CFG->lang` to the FIRST code
  // unconditionally while only gating the install on success — so asking for a
  // nonexistent `sp` leaves the site pointed at `sp`, and 52 would describe
  // that as "the site language is wrong" when the real fault is that no such
  // pack exists. 52 is left to mean exactly one thing.
  //
  // `error_log` is for a human reading console.txt; the gate never depends on
  // it, because that is the only channel a step exiting 0 can reach and a check
  // built on log text is a check built on a courtesy.
  return { step: "runPhpCode", code, critical: true };
}
