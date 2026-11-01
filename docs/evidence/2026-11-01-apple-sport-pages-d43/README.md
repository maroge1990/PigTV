# Apple 95–100: the Apple TV Sport pages to D-43 (#200, #187, #201–#205, #52)

PigTV-Swift, 1 Nov 2026. Base `059885b` (Apple 94). Server 0432 found by the golden decode.

**95:** "Record on which channel?" when a game is on several; badges with a disc only without a logo. **96:** NFL badges
(#205); a later channel's live game offers "Watch at <time>" and its cancel (#187). **97:** the D-43 banner (250 pt hero,
a four-item list that scrolls in place, full width for one league); the F1 dark circuit map. **98:** the front page with
no sport tiles, rails headed by sport that open its page; a sport page lists its leagues in the banner. **99:** every
sport's layout under the banner: F1 weekend, circuit stats, last race and standings; IndyCar/NASCAR entry lists (C-V); the
NFL and C-T round grid and standings; the selected cricket league; UFC main card and prelims; tennis rails; golf
leaderboard and your players. Catalogue labels in banner rows; kickers YOUR DRIVER/PLAYER/FIGHTER/TEAM. The contract
checks decode the server's golden answers (26 of 36). **100:** the two Codex mediums below.

**Tests (T1–T3, tvOS 27 simulator, fixture `sport-pages-d43.json`):** `SportLabelsTests`, `SportMotorTests`,
`SportFixtureTests`, `CricketLeagueTests`, `SportEventsTests`, `SportPagesUITests`, `GoldenChecks`, plus 95–98's. Each
fails on the build before it. `Tools/test.sh push` and the iOS build pass for 99 and 100.

**Screenshots (offline fixtures):** `tv-d43-front.jpg`, `tv-d43-motorsport-f1.jpg`, `tv-d43-fixture-afl.jpg`,
`tv-d43-cricket-wbbl.jpg`, `tv-d43-ufc.jpg`, `tv-d43-tennis-followed.jpg`, `tv-d43-golf-followed.jpg`.

**Codex adversarial reviews:** 95–96 approve. 97–98: one *medium*, every cricket league showed the same page (fixed in 99).
99: two *mediums*, fixed in 100 with failing-before tests: a cricket match of no known league went to the first league
(now no league's; the server naming it is #210), and the NFL standings showed four of eight divisions (now AFC / NFC
buttons). No high, so one round each. The server's fallback `/api/info` lacked `version` (0432).

Differences from the mock-ups: a C-V event repeats its C-R card for Watch and Record; no "press for the whole field";
tennis's Tonight is the rest of today; spoiler-free hides C-T standings. Not exercised: the rig (T3) and devices (T5).
