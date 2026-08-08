<?php
// Fixture for check 1o's plugin-root probe ONLY. Not a real plugin.
//
// plugin-root is otherwise unobservable: with no version.php under the root,
// every value of it produces a byte-identical blueprint, so the probe could
// not tell "wired correctly" from "wired to nothing". Pointing the probe at a
// root that DOES declare a component makes the wiring visible.
defined('MOODLE_INTERNAL') || die();
$plugin->component = 'mod_probeplugin';
$plugin->version   = 2024050100;
$plugin->requires  = 2022041900;
