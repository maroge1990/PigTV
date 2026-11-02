# Apple guide batch (Apple 106–113): the TV Guide and its pages, before and after

Simulator screenshots (T3) from `GuideScreensUITests` on the offline library fixture (`PIGTV_UI_TEST_SCREEN=tab-guide`,
`programme`, `programme-later`, `channel`, `search`; dark), JPEG at most 1600 px. Its data is the fixture's, not a feed.

- `before-*`: Apple 105 (42856e1). `after-*`: Apple 110 (fe766dc), except `after-iphone-guide-sideways`: Apple 113.
- `*-guide`: the strip above the grid, the chips and the tools on one row (106). `*-menu`: the long-press menu: the
  card beside the programme on tvOS and iPad (107), the system context menu with a preview on the iPhone's On now list.
- `*-programme`, `*-programme-later`: programme details, a hero card and "Also on <channel>" (108; pushed in the app,
  shown here through the fixture screen). `*-channel`: the one channel page, hero with Up next, then the days (109).
- `*-search`: Search and Jump to on one page, side by side (110; the iPhone stacks them, without Jump to upright).
- `iphone-guide-sideways`: an iPhone 17 turned sideways showed the On now list (it stays compact width, so only a
  Plus/Max got the grid); since 111 every iPhone sideways shows the grid, as DESIGN.md says.
- Devices: Apple TV 4K (3rd generation), iPad Pro 13-inch (M5), iPhone 17; tvOS/iOS 27.0 simulators.

Tests: `Tools/test.sh push` passed on 110 and again on 113 (contract checks, unit tests, regression UI tests); the iOS build passed at
every commit. Failing before: the new UI tests (`GuidePagesUITests`, five tests, and the updated
`GuideGridNavigationUITests.testLongPressMenuAndFocusAfterDetails`) were built against 105 in one run and all failed
(no strip; the system menu instead of the card; no Also on; no channel page; Search a cover without Jump to). The
unit tests use types the batch adds. `testJumpToOpensFullyAndReturnsFocusToTheGrid` passes on both: it now proves focus
returns to the grid without the old timed retries.

Not run: device checks (T5); light appearance; VoiceOver and Dynamic Type were not checked on screen; the "focus after
closing the player" path has no offline test (the fixture cannot play).

**Codex** (base 42856e1). Round 1: high, a cancel whose Undo ran out while another change was being sent was dropped
(fixed in 112, `RecordingCancelCommittedTests`); medium, the iPhone's On now menu acted on the programme on now when an
item was chosen, not the one it showed (fixed in 113, `OnNowMenuChoiceTests`). Round 2: no high; one medium, a failed
iPhone menu action closes the menu without saying so, left for batch 5 as #219.
