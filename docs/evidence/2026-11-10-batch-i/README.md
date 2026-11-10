# Batch I (#277): Sport generations 1 and 2 and other unused Apple code removed

10 Nov 2026. Server 0503; Apple 192 to 197.

## Checks

- Server: `npm test` 1791 of 1795 (the 4 known local `recording-segments-media` failures), `verify-build.sh` passed;
  `test/sport-front-scores-off.test.js` failed on 0502 (404 for 200). CI green, 4 min 6 s.
- Apple, on the Mac (tvOS 27 simulator): `Tools/test.sh fast` on each build (314 contract checks and the unit tests on
  197), `RealPlaybackTests` on 196, the iOS simulator build on each. `Tools/test.sh push` on 197: all passed but two
  `GuideGridNavigationUITests`, whose expected tile label was old (196 shows the fixture's channel number); after the
  test fix the four guide UI suites pass (16 tests). The whole tier was not run again after that test-only change.
  CI green, 10 min 1 s.
- Not run: T3 on iPad and iPhone simulators against the rig; T5.

## Reviews

- Codex adversarial review, server (base `98454f3`): approve, no findings.
- Codex adversarial review, Apple (base `3b9fe8f`, builds 192 to 197): approve, no findings.
- Opus review of Apple 192 to 196 before Codex: no high, 2 medium, 4 low.
  - Medium, fixed in 197 (inside the Codex round): Settings › Sport drew a broken Score delay row with scores off on the
    server. A 404 from `sports/preferences` now hides the row; test failed before.
  - Medium, recorded as a limit (`PRODUCT.md`, `CLIENT-CONTRACT.md`): servers 0476 to 0502 with scores off show the Sport
    front page's error state.
  - Lows: two stale lines in the Apple `ARCHITECTURE.md` and the contract's wording on optional flags, corrected; fixture
    screens show recording-rule items (test-only, left).
