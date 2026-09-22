/**
 * Small text-cleanup helpers applied at ingest, so every client and the webapp
 * see the same cleaned strings without each having to strip them itself.
 */

// Strips a trailing run of the small-capitals / modifier-letter badge some
// providers append to EPG titles and channel names (e.g. "NFL 16 ᴸɪᴠᴇ",
// "… ɴᴇᴡ"). It renders as a tacky superscript. The characters are real Unicode
// modifier / small-capital letters, not app styling, and never occur in
// ordinary English titles — so a trailing run of them (plus any surrounding
// spaces) can be removed without touching anything legitimate.
//
// The code-point ranges are kept identical to the Apple client's
// `String.strippingBadgeSuffix()` (PigTV-Swift/PigTV/DVRModels.swift), so the
// server stripping at ingest and the client's interim stripper agree exactly:
//   U+1D00–U+1DBF  phonetic extensions + supplement (small-cap forms)
//   U+02B0–U+02FF  spacing modifier letters
//   U+0250–U+02AF  IPA extensions (small-cap forms)
//   U+0020, U+00A0 space and non-breaking space
const BADGE_SUFFIX_RE = /[ᴀ-ᶿʰ-˿ɐ-ʯ  ]+$/;

/**
 * Remove a trailing decorative small-caps badge from a title or name.
 * @param {string|null|undefined} s
 * @returns {string|null|undefined} the input with any trailing badge removed;
 *   non-strings and empty strings are returned unchanged.
 */
function stripBadgeSuffix(s) {
    if (!s || typeof s !== 'string') return s;
    return s.replace(BADGE_SUFFIX_RE, '').trim();
}

module.exports = { stripBadgeSuffix };
