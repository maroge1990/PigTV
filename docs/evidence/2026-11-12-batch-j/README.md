# #278, batch J (Apple 209 to 218): requests nobody is waiting for, one owner per piece of state; reviews, gates and the simulators

The Apple apps only (`PigTV-Swift`). Ten commits: eight fixes from the 10 Nov audit, one test-only commit, one for review findings.

## What the batch did

- 209: the app's minute pass rests while the full-screen player is up and runs once when it closes; favourites are asked for every 5 minutes, not every minute; the Guide's own 15-minute loop is gone.
- 210: screens that ask for the Hide scores choice at the same moment share one request.
- 211: the Guide asks for the sport event list at most every 5 minutes (before: on every visit).
- 212: pages under the full-screen live player stop their own refresh loops and restart when it closes.
- 213: scrolling the Sport front page no longer redraws the whole page on every scroll step; only crossing the banner's edge does.
- 214: recording rules have one owner. Settings › Sport reads the same list as Recordings › Scheduled and sends its changes through the same queue, so a team's "Record every game" switch and Scheduled can no longer disagree.
- 215: one function decides whether scores are hidden; ten places that each worked it out now call it (a source test stops a new copy).
- 216: Hide scores has one writer (the follows list). The second save path, its queue and its on-device copy are deleted.
- test-only: a missing sport fixture fails its suite; five suites used to skip without saying so.
- 217: one definition of "a game is under way"; a league page with a suspended game keeps its 30-second refresh.
- 218: the review fixes below.

## Reviews and findings

- **Opus on 209 to 217:** no high, 1 medium, 8 low. Traced with nothing found: the rule queue (no two changes can pass the wait; the request sent is only for the rule the user was asked about), the shared read, every Hide scores path (none shows a score that should be hidden), the cover, the minute loop, older servers.
- **Codex round one:** 1 high, in 214: while the rule list had not loaded (or had failed to), a team's switch read Off and pressing it sent a new rule.
- **Fixed in 218**, each with a test that fails on 217:
  - the high: no rule request is chosen while the rules are unknown; the switch is disabled and the row says the rules didn't load;
  - the medium: the Hide scores chip's save read the whole Settings › Sport page first (rules, suggestions, a names request per league); it now reads only the follows;
  - a save could be built from an old follows list when another load overtook it: it now sends nothing unless its own read applied;
  - the chip's label could say "Scores shown" while scores were hidden during a save;
  - two tests: the favourites age test passed with the bug present; one timing margin was under 1 s.
- **Codex sign-off on 218:** approve, no material findings (a reading check; its sandbox runs no tests).
- **Left, filed as findings:** recordings playback uses its own player cover, so the pages under it keep refreshing (not new); the Top Shelf is not written while the player is up; unfollowing a team while its rule's Undo is open never asks about the rule.
- **Not reproduced:** the banner strip going stale when the banner's height changes without a scroll (rotation on the iPad, below).

## Gates

- `sh Tools/test.sh push` and an iOS build on the Mac, on 217 and again on 218: pass.
- Each fix's test was run against the code before it and failed there. No `git stash`: the old behaviour was put back by hand in a copy.
- Server: `docs/CLIENT-CONTRACT.md` only (C-P: the app reads `sports/pages/preferences` and no longer writes it).

## Simulators against the rig (Apple 218, server 0566, fake provider)

The server keeps no request log, so the simulator went through a pass-through on the Mac that recorded method, path and status. The rig was not changed. The rig has no games or scores, so the front-page checks use the app's fixture pages.

| check | seen | result |
|---|---|---|
| Sport front 2 min, then live TV full screen 3 min, then close (Apple TV) | under the player only playback requests; no sport, recordings, favourites or guide request; within 1 s of closing, the page and the minute pass asked again ([requests-under-the-player.txt](requests-under-the-player.txt)) | pass |
| Banner strip, Apple TV, three rounds down and up | the strip pins when the banner scrolls away and goes at the top; focus goes back up the way it came ([tv-strip-pinned.png](tv-strip-pinned.png)) | pass |
| Banner strip, iPad both ways up and iPhone | pins when scrolled; stays right after rotating while scrolled ([ipad-strip-pinned.png](ipad-strip-pinned.png), [iphone-strip-pinned.png](iphone-strip-pinned.png)) | pass |
| A team's "Record every game" against Scheduled (Apple TV) | on in Settings: Scheduled lists the rule at once; off in Scheduled: Settings says Off; Remove: during Undo the switch is Off and disabled, enabled after; one POST, two PUT, one DELETE ([rule-requests.txt](rule-requests.txt); the `ERR` line is the Mac's network dropping, repeated) | pass |
| Hide scores from Settings › Sport | the front page's chip follows it; with it on, no hero, card or strip on the fixture page shows a score | pass |
| Guide open 5 min 20 s | the sport event list is asked once per launch and not again ([guide-5-minutes.txt](guide-5-minutes.txt)) | pass |

**Could not run:** the cricket page's Hide scores chip. No screen draws it: the cricket page is only ever shown inside the Sport page, which leaves the chip's header out. That was already so on 208. The re-ask of the event list after 5 minutes, and the request counts on 208 for comparison, were not measured. Nothing here ran on a device.

**Seen on the way, not from this batch:** the iPhone strip's LIVE pill draws as a red bar with no word in it (first image of the iPhone above); Settings › Sport asks for `sports/preferences` and gets a 404 on the rig each time it opens (the app carries on); a league fixture card says "Played" or "Final" for a suspended game.

## Not built

The audit's larger merges are listed on #278: one generic page store, the date helper, the logo decode, the shared page prelude, the LIVE pill and quality badge, the touch player shell, the metrics enums, the channel converters, and the smaller items beside them.
