# Web 3 (server 0650 to 0664): the web Sport section ported from the Apple apps (#323)

Mark approved one set of mocks on 14 Nov (comment on #323); the build follows them, with 16 px text and 44 px targets.

| build | step | change |
|---|---|---|
| 0650 | 1 | Settings › Sport has a Score delay row under Hide scores (the old page's dialog was its only home) |
| 0651 | 1 | the Sport front page on C-R: banner with the hero and follows, a section per sport with league rails, phone carousel; the old C-O page and its tests are gone |
| 0652 | 2 | a page per sport (`#sports/Football`): leagues list or chips and carousel, games under Live, Later today, Coming up, Earlier |
| 0653 | review | Codex high: a refresh whose preference read says hidden, fails or is unknown takes the scores off at once |
| 0654 | review | Remind me ends for good when cancelled or when Sport is left |
| 0655 | review | Remind me in the last minute waits for the start instead of failing to Watch |
| 0656 | review | the game menu gives focus back to its card after a redraw and on Tab |
| 0657 | review | sign-off: scores are shown only from a refresh whose own answer came, never after a failed one |
| 0658 | 3 | league pages (C-T, C-Q): rounds, the round's games, standings (a "Standings hidden" card when hidden) |
| 0659 | 4 | Formula 1 (C-P) and cricket (C-S) |
| 0660 | 5 | event pages (C-V): golf, tennis, UFC, racing |
| 0661 | 5 | Apple's record menu on every card (⋯ and right-click on a computer, a sheet on a phone) |
| 0662 | review | More options on a game already recording changes that recording (PUT), never a second schedule |
| 0663 | review | "Record every <team> game" uses the game's own sport |
| 0664 | review | with scores hidden, followed golfers are in follow order, not leaderboard order |

Each has a test that failed before it; every view has a hidden-scores test that renders it and finds no score, result,
standing or position anywhere in the markup or attributes, and one with scores shown.

## Reviews

- Step 1: Codex 1 high (scores left on screen during a slow refresh after Hide scores turned on), fixed in 0653; Opus no
  high, 3 mediums (Remind me and menu focus), fixed in 0654 to 0656. The sign-off found a medium on hidden scores (a
  failed refresh re-showing cached scores), fixed in 0657 and approved.
- Steps 2, 3 and 4: Codex approve, no findings. Step 5: Codex 3 mediums (recording padding, team rule sport, golf order
  when hidden), fixed in 0662 to 0664 (they touch recording rules and hidden scores) and approved.
- Lows left (web rule), on #323: the clash toast names schedule ids; the Score delay Save button is small and has no
  `type`.

## Gates

`npm test` on the final tree: only the four AAC-LC tests that fail on the WSL machine fail. `verify-build.sh`: all
checks passed.

## The rig (fake providers and fake scores, PIGTV_RIG_SCORES=fake), steps 1 to 3

| check | result |
|---|---|
| front page, a live game | banner hero and the Football card with its live clock and score ([`sport-before.png`](sport-before.png), [`sport-after.png`](sport-after.png), [`sport-phone.png`](sport-phone.png)) |
| Hide scores on | no score in `document.documentElement.outerHTML` or the accessibility tree, desktop and phone ([`sport-hidden.png`](sport-hidden.png)); off again, scores back |
| Hide scores changed in another tab | the open Sport tab dropped the scores within 13 s, without a reload |
| sport page and Back | `#sports/Football` with its groups; Back returns to `#sports` |
| Watch, Remind me, Record this game | play the fake channel; the reminder notice; a schedule made (deleted after) |
| Score delay | saved 30, read back after a reload, restored |
| league page hidden | "Standings hidden", no score, FT or table ([`league-hidden-phone.png`](league-hidden-phone.png)) |

The fake scores script one Premier League game, so F1, cricket, events, the standings table and the record menu were
checked in a real Chromium on the golden fixture answers instead ([`f1-fixture.png`](f1-fixture.png),
[`cricket-fixture.png`](cricket-fixture.png), [`golf-fixture.png`](golf-fixture.png),
[`record-menu-fixture.png`](record-menu-fixture.png)). Not checked: a phone's long press, real ESPN data.
