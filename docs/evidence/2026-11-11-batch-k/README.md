# Batch K (#279): Apple TV brand 1.8, Apple 198 to 203, PigBrand 1.8.1 (11 Nov 2026)

All in `PigTV-Swift` (base `c001e61`, build 197) plus one commit in `PigBrand`. Simulator only (tvOS 27, Apple TV 4K;
iPad Pro 13-inch): nothing here is a device check. Mark's picks are on the issue: focus B (lift, ring and pink tint),
the Sport banner as three bigger rows, guide rows with one-line titles, Settings as a summary on focus.

| Build | What changed |
|---|---|
| 198 | One focus treatment (`PigFocus.swift`): a drawn lift, a 3 pt pink ring 4 pt outside the control, the 22 % focus fill. Every tvOS focus style and the guide's cells use it. A followed game is marked by its star, not a pink outline. |
| 199 | No Apple TV text under 23 pt. Guide cells show the time over a one-line title; the Sport banner's Following list is three 56 pt rows. |
| 200 | Everything the remote can land on is at least 56 pt; the score-delay −10 / +10 are real buttons. |
| 201 | Settings: focus shows a read-only summary; a press opens the page and moves focus into it; Menu returns to the same row. |
| 202 | A followed game whose side is unknown (servers 0476 to 0492) stars its first line. Brand labels read guide 1.8.1; `docs/brand-tokens.json` deleted (unused). |
| 203 | Review fixes (below). |

PigBrand 1.8.1: the app's larger Apple TV icon is now the kit's source (six PNGs and the manifest), so
`Tools/sync-brand.sh` changes nothing when run; the guide allows the small pig mark beside a page title.

## Tests

- `Tools/test.sh fast`, the iOS build and `Tools/test.sh push` (the regression UI tests) pass on the final tree (203).
- Failing before: `settings-failing-before.txt` (the Settings UI test on build 200). `BrandRulesTests` gained
  `testTelevisionTextIsAtLeastTwentyThreePoints`, `testTelevisionFocusTargetsAreAtLeastFiftySixPoints` and the focus
  checks; `SportBannerTests.testAFocusedListRowsRingFitsInsideTheList` fails on 202.
- Reduce Motion: the focused card's ring is 708 px wide with the lift and 684 px with Reduce Motion on (no lift).

## Screenshots (1280 px JPEGs of the simulator)

`tv-sport-card-focused-{dark,light}`, `tv-guide-cell-focused-{dark,light}`, `tv-banner-unfocused-dark`,
`tv-banner-row-focused-{dark,light}`, `ipad-sport-followed-outline-dark` (the iPad keeps the pink outline; it comes out
rotated). The Settings screenshots are not here because the fixture's Account row shows an address.

## Reviews

- **Opus, 198 to 200:** 2 high, 2 medium, all fixed in 203. High: the followed outline had been removed on iPad and
  iPhone too; the long-press card's subtitle had become two lines on touch. Medium: four shared styles lost the iPad
  keyboard-focus ring; a focused banner row's ring was cut left and right (the row now lifts 1 pt). Two test blind
  spots closed.
- **Codex, 198 to 203, one round:** no high. Two mediums, not fixed, on #293: some controls get the lift and ring
  without the pink tint (`drawSurface: false` surfaces and the guide's channel tile); `BrandRulesTests` passes a style
  that calls the treatment with a constant `false`.
- Unfixed lows and what was not seen on screen: #293. The kit's remaining 1.7.0 icon sources: #294.
