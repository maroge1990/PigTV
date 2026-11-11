# #272 and #281, batch D (server 0542 to 0558): reviews, gates and the rig

Pushed 11 Nov 2026 as `8fb0648..00f1e50`. Sport only on the server, plus one web wording commit (0556: "Hide scores").

## What the batch did

- 0542: the fixture refresh and the sport pages honour ESPN's 429 cooldown under the collector's own on/off rule.
- 0543 (#281): a club ESPN lists twice no longer gets another club's badge. Cause: ESPN's AFL list names two teams "Sydney Swans", the second with a Gold Coast badge.
- 0544: one name fold for people's names, with the Nordic letters.
- 0545: the event list and fixture loops stop when nobody is looking and no recording rule needs them; `/api/status` reports it (`sportLoops`).
- 0546: one cache and route wrapper for the five sport pages (fixes a refresh that outlived a reset on NFL and F1).
- 0547: one fetch for every sport feed request: allow-list, size cap, no redirects, the cooldown.
- 0548, 0554: ESPN's game status is read in one place; each endpoint keeps its contract's words. Rare statuses that changed are listed in `docs/CLIENT-CONTRACT.md`.
- 0549, 0553: a score history row only when a game changes; the last-confirmed times live in a side table, so the history table keeps the shape older builds write to.
- 0550 to 0552: the score collector is the only fetcher and store of ESPN's scoreboards; the guide's live/replay check reads its store. `sport_fixtures` is kept, unread while the collector is on.
- 0555: a cricket series no longer drops out of the collector's coverage during a cooldown.
- 0557, 0558: the League pages and the NFL page take a game's status and score from the collector, with the account's delay, so they change with the front page.

Not done, by Mark's choice: the NFL page keeps its own channel matcher (#296); F1, Cricket and the Events pages still read ESPN themselves (#297).

## Reviews and findings

- **Opus on 0542 to 0552:** 1 high, 2 medium, 6 low. Clean: freshness, the fetch wrapper, the page cache, tests and docs.
- **Codex round one on 0542 to 0552:** 1 high, the same one: 0549 added a column to `sports_score_history`, and every earlier build writes to that table with three values, so a rollback to an earlier image against the upgraded database stopped the score store. Fixed in 0553, with a test that runs the store as it was at `8fb0648` against a database this build wrote.
- **Opus mediums, fixed** (the status mapping is contract-covered): a game suspended after ESPN marks it over was shown live or paused since 0548 (0554); the cricket coverage gap (0555).
- **Codex sign-off on 0553 to 0555:** approve; the previous build and v0502 initialise, ingest and prune against a database this build wrote.
- **Codex on 0557 and 0558:** approve, no material findings.
- **Lows left** (in #297 where they matter): with the collector off or a league never getting a whole window, the classifier falls back to `sport_fixtures`, which nothing refreshes while the collector is on.

## Gates

`npm test`: 2,152 tests, 2,140 pass, 8 skipped, 4 fail in `recording-segments-media` on the build machine only (its ffmpeg writes AAC-LC; the same four fail there on 0533). `verify-build.sh` passes. CI (run 43003734909, on `00f1e50`, with ffmpeg): green, including those four tests.

## The rig

`rig.md` holds the whole account: the agreement tables on 0552, the timings on 0556 and 0558, the rule and recording result, the idle and resume observations and what could not be shown. In short, on 0558 the front answer and the Premier League page answer changed state in the same 10-second poll at kick-off, at each goal and at the final (on 0556 the page was 50 seconds behind the front at kick-off and 80 seconds ahead at the final); the rule scheduled one recording on a channel showing the game, it overran to the final and completed; the database that 0552 had altered opened and served on 0556.

Not shown on the rig: the cooldown (the fake feed cannot answer 429: T1 only), #281's badge (no AFL teams in the fake feed: T1 only), the NFL page (no NFL game in the fake feed: T1 only), history row counts.

`shots/`: 16 JPGs of the web Sport page, the guide, Recordings and Status at the three moments, and the front and League answers rendered at kick-off and at the final.
