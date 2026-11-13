# Apple 1 (Apple 219 to 239): Mark's layout faults, #278's five, #298, #293, #203, #301; reviews and gates

The Apple apps only (`PigTV-Swift`, pushed at `2e4ddf7`). Five builders worked in parallel copies; the lead merged them,
numbered the builds and ran the gates. Each fix has a test that fails on the code before it (shown on the tvOS
simulator; for three, the old code does not compile against the new test).

## What the batch did

- 219 to 221 (#301): a playing recording rests the pages and the minute pass beneath it; the Top Shelf is written once
  as the app goes to the background; unfollowing a team settles its rule's open Undo first.
- 222 to 225 (#278): the cricket Hide scores chip and its save path removed (Mark, 14 Nov); the iPhone strip's LIVE pill
  keeps its word; a suspended game says "Suspended"; Settings › Sport no longer asks for `sports/preferences` when the
  server says both sport flags are off. Test-only: the ChannelWarmer flake (10 of 10 runs green).
- 226 (#293): every focused Apple TV surface takes the pink fill (Mark, 14 Nov: tint everywhere); test-only: the brand
  test checks a named list of focus styles, with negative fixtures.
- 227, 231 (#203): `onAir` decoded (absent: not on air); "On air · starts 8:10 am" with the live dot; a session card's
  bottom line says just "On air", its start already on the line above.
- 228 to 230 (#310, #311): a record mark is an icon in the card's corner (a marked card measured 145 pt tall against
  126.5 before, on the iPad; equal after); Apple TV Recordings with nothing recorded shows Coming up on the first screen
  (it sat at y 1048 of 1080 before).
- 232 (#312): the Sport strip is drawn over the page; the page's frame no longer moves (217 to 301 pt before), so the
  focused row holds still.
- 233 to 235 (#298): Formula 1's tiles fit an 11-inch iPad (1,310 pt needed in 1,146 before); the banner's buttons keep
  their words whole on an iPad; the iPhone's Sport header and section titles at the largest text sizes.
- 236 to 239: review and gate fixes, below.

## Reviews and gates

- **Codex round one:** 1 medium: a server whose `/api/info` leaves out both sport flags lost its Score delay row
  without being asked. Fixed in 236.
- **Opus:** no high; 2 mediums. A session that ended with a recording's cover up left the pages at rest for good:
  fixed in 238. The strip fix depends on tvOS focus scrolling honouring a top margin: covered by
  `SportHeaderPinUITests.testTheFocusedCardHoldsStillWhenTheStripShows` (passes) and the Apple TV check. Lows: #313.
- **Codex sign-off on 236 to 238:** approve, no material findings.
- **Gates:** the first full run failed two brand rules on the batch's own code (a literal offset, a split line):
  fixed in 237 and 239. `sh Tools/test.sh all` then passed on 239 (build, contract checks, unit, regression UI, visual
  UI), from a copy without `.git`, so it does not unlock a TestFlight upload. CI on the push: green (run 43517610038, build-and-test success).

## Not run here

- No device check (T5): the steps are on each issue. No TestFlight upload (Mark away; it needs his Mac password).
- #301 item 1's request log while a recording plays; the Top Shelf write on backgrounding on a real Apple TV.
- The golf player card's focused look (it never took focus in the scratch test); its Leaderboard card shows the tint.
