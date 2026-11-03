# Apple 135–140: D-44 batch 7, Apple sport (first part)

3 Nov 2026. Simulators (tvOS 27 Apple TV 4K, iPad Pro 13-inch, iPhone 17), dark, offline fixture
`PigTVTests/Fixtures/sport-pages-d43.json` with its times moved to the clock (NFL: the `nfl` fixture). No server, no
provider. `before-*` is Apple 134, `after-*` is Apple 139; `<platform>-<page>.jpg` for the front page and the Motorsport,
Australian football (League), Cricket, Combat (UFC), Tennis, Golf and NFL pages.

**Changed:**
- 135 (#202): Follow a driver lists C-P's whole grid (`drivers`), alphabetical; an older server keeps the top ten.
- 136 (#210): a cricket match is filed under C-S's own `league` first.
- 137 (#218): a next-round game reads "Next round · <date>", with no channel, Watch or Remind me.
- 138 (#211): the AFL % to one decimal; standings values never cut (NFL W-L-T); a live card's clock is short ("Q4 0:17",
  "OT1 10:00"; the down and distance stay in the banner); the cricket lead line wraps; tennis's "Not on your channels" is
  whole. Not shot here: the cut lines need the rig's real data (`StagingSportTVUITests`, orchestrator's T3).
- 139: the iPhone front page follows R5-Front-iPhone (`after-iphone-front.jpg`: header with "Scores shown", the
  follows' carousel, one card per sport of fixture rows with the teams' badges); the iPad draws the Apple TV front page
  (`after-ipad-front.jpg`, D-44). The sport pages themselves are unchanged on iPad and iPhone in this part.

**Codex round 1 (base Apple 134): one high, fixed in-batch as 140 (#49).** With both opponents followed, "Record every
game" on the second follow's carousel card made a rule for the first (the request guessed the first followed side).
Now the card, and the TV hero, name their follow's team ("Record every Man City game"); without a named team nothing is
guessed: a card's long-press menu offers no team rule and the record page offers both teams.

**Tests:** each new test failed on the commit before it (135–138 with the change's logic reverted; 139's
`SportPhoneFrontUITests` on Apple 138, no carousel) and passes after. `Tools/test.sh push` passed at 139; the iOS build at
every commit; tvOS `BrandDepthUITests` and `PigTVUITests` (visual) passed.

**Not covered:** real data on the rig (T3), the devices (T5), the per-sport pages' iPad/iPhone layouts from the R5 boards.
