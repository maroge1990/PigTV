# Apple 114–115 (D-44 batch 5a): the record page and the Sport card's record menu, before and after

Simulator screenshots (T3) on the offline fixtures (`DesignTestScreen`, no server), dark, JPEG at most 1400 px.
Devices: Apple TV 4K (3rd generation), iPad Pro 13-inch (M5), iPhone 17; tvOS/iOS 27.0 simulators.

- `before/`: Apple 113 (d1f674e). `record`: the old RecordSheet; `programme-later`: a scheduled programme with the
  batch 4 stopgap "Cancel recording"; `sport-event` / `sport-channels`: the event page and the channel picker that
  led to "Record on which channel?" and "Record every game of".
- `after/`: Apple 115. `record`: the record page for a guide programme (What, When it stops, Start early / Finish
  late from "Usual"); `record-sport`: a game on three channels with its game id (When the game ends (ESPN), What
  with every <team> / <league> game, Record on best first); `record-change`: Change recording on a scheduled
  programme (its own padding, Save changes off until something changes, Cancel recording); `programme-later`: the
  programme page's Change recording. TV only, from the UI tests: `tv-sport-card-record-menu` (a Sport card's long
  press, RECORD first), `tv-sport-card-record-page` (its More options…), `tv-undo-toast` (Cancel recording, then the
  10 s Undo).

Tests on 115: `Tools/test.sh push` passed (contract checks, unit tests, regression UI tests); the iOS build passed at 114 and 115; the visual suites the change touches
(`BrandDepthUITests`, `GuideScreensUITests`) passed on tvOS (the three player checks skip without the review media).
Failing before: `RecordPageUITests`, `GuidePagesUITests.testMoreOptionsOpensTheRecordPage` and
`SportFrontUITests.testRecordOffersEveryChannelBestFirst` fail on 113; `testALongPressOnACardOffersTheRecordMenu`
fails on 114.

Not covered here: Change recording's Save changes against a real server (`PUT /api/recordings/scheduled/:id`, server
0444) is tested only against a local fake (`RecordPageTests`); a game's real team logos need the live sport feed.
