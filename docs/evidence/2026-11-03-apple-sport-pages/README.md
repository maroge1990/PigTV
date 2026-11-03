# Apple 142: D-44 batch 7, Apple sport (second part): the sport pages on iPad and iPhone

3 Nov 2026. Simulators (tvOS 27 Apple TV 4K, iPad Pro 13-inch in portrait, iPhone 17), dark, offline fixture
`PigTVTests/Fixtures/sport-pages-d43.json` with its times moved to the clock. No server, no provider. `before-*` is
Apple 139 (the pages are unchanged through 141), `after-*` is Apple 142; `<platform>-<page>.jpg` for the Motorsport,
Australian football (League), Cricket, Combat (UFC), Tennis and Golf pages, and `after-iphone-<page>-league-page.jpg`
for each league's own page on the iPhone.

**Changed (142, #177, #186, #205, #192):**
- iPhone: every sport page follows R5-*-iPhone: "‹ Sport", the sport and "Scores shown"; the sport's leagues as chips
  (Motorsport, Cricket); a 212 pt carousel of the league's games (yours, then live; with neither, the next to start;
  "1 of 1 · yours, then live"); the games as fixture rows under Live, Later today, Coming up and Earlier; then the
  league's own content behind its header ("Rounds and standings ›", "Weekend and standings ›", "Scoreboard and tour ›",
  "Leaderboard ›", "Order of play ›", "Fight card ›"), on a page of its own (#177). Before, the Apple TV page was drawn
  squeezed and cut off (`before-iphone-*.jpg`).
- iPad in portrait: a league's panels stack (the AFL standings under the round, F1's lists one under another with the
  session tiles scrolling sideways, golf's players and Also this week under the leaderboard, the cricket tour under the
  scoreboard) instead of running off the right edge (`before-ipad-league.jpg`, `before-ipad-cricket.jpg`).
- iPhone league pages: the cricket scoreboard's columns and actions fit; golf's leaderboard is position, player and to
  par (R5-Golf-iPhone).
- Apple TV: unchanged (`after-tv-*.jpg` match `before-tv-*.jpg` but for the clock). The R5 TV boards' layouts (round
  grid with standings right, scoreboard and tour, sessions strip and three lists, golf's players top right, tennis rails,
  main card and prelims as lists) are the ones drawn since D-43.

**Tests:** `SportPhonePageTests` (new); `SportPhoneFrontUITests` sport-page test fails on 141 (no league carousel) and
the iPad test fails on 141 (the standings ended at x 1064 in a 1033 pt window); both pass on 142.
`Tools/test.sh push` passed at 142; the iOS build at 141 and 142; tvOS `BrandDepthUITests` and `PigTVUITests` (visual)
passed.

**Codex round 1: one high (league pages ignored the page's spoiler-free decision), fixed in Apple 143** (#192): every
league panel now ORs the page's decision with its own preference (`testLeaguePagesHideScoresWhenTheAnswerIsSpoilerFree`,
failing on 142: the AFL page showed Geelong's 101 under "Scores hidden").

**Not covered:** the NFL page (the offline fixture has no NFL in C-R and its page answers unavailable, as in batch 7a's
shots); real data on the rig (T3, `StagingSportTVUITests`); the devices (T5); iPad landscape (side by side, as the TV).
