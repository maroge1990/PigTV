# Sports acceptance replay on production guide rows, 28 Oct 2026

**What this is:** the Sports build (`sportsEvents.buildEvents`) run offline, in throwaway copies of the server, on rows
exported read-only from production at 01:03 UTC on 28 Oct (`export.js`). The export covers 1,248 visible channels
(sibling backups excluded), 1 EPG mapping, 74,456 guide rows (26–30 Oct), the follow list, 128 stored ESPN fixtures and
10 stored rosters. No stream URL, credential or `provider_accounts` row was read or exported. No provider was contacted.
The export itself (1.1 MB) was kept out of the repo.

**How:** `git archive <ref> server package.json` into a scratch folder, then `node replay.js <copy> <from ISO>...`, run
in the copy's own `data/` (it fills a fresh SQLite there). The copies used were 0289 (`ed40bd1`), 0300 (`origin/main`,
deployed) and 0301 (local).

**What it shows and doesn't:** this is the server's output, before the Apple app or the web page draws it. Channel health,
logos and per-request time filtering are left out, and the ESPN fixtures are the ones stored at 00:44 UTC. This is not
device acceptance.

## MLB: World Series Game 4 (28 Oct 00:00 UTC). Passes offline on 0300 and 0301

One event, "Brewers de Milwaukee v Rays de Tampa Bay" ("event: a match-up, ESPN: the game started Tue 8:00 pm"),
45 channels:

| Channels | Notes |
|---|---|
| Every FOX affiliate | |
| FOX Deportes, AFN Sports, RDS 2 | |
| Sportsnet One, Event, East, Ontario and West | West's guide title is "MLB Postseason 2026" |
| TNT Sports 1, ESPN | "MLB World Series - Game 4" and the bare "MLB" |
| The Tampa Bay Rays and Milwaukee Brewers team channels | |

Kept out, as required:
- "World Series in 30" stays a show or placeholder.
- The "Dodgers Squeeze Play" and "Timeless Dodgers" games are replays.
- MLB Network Presents, the pre-game shows and the postgame shows are shows.

The event's title is RDS 2's French spelling (it starts at 23:30, earliest), which is cosmetic. The 05:00 FS1 airing and the
12:00 MLB Network airing are replays ("ESPN: the game started Tue 8:00 pm; this airing is 5 h / 12 h later").

## Fox Cricket 501: 3rd Test, South Africa v Australia. Fails offline on 0300 and 0301 (FR-19, FR-20)

| Airing (UTC) | Guide title, flag | 0300 / 0301 result | Correct? |
|---|---|---|---|
| 27 Oct 07:30– | Sky Sports Main Event and 8 others, "South Africa v Australia" | event, ESPN Test fixture (first ball 08:30) | yes |
| 27 Oct 17:00, 18:00 | Fox "ODI : South Africa v Australia G2/G3" | replay | yes |
| 27 Oct 21:00 etc. | Fox "Test Mini : RSA v AUS …" | replay ("mini") | yes |
| 27 Oct 22:00 | Fox "Test : South Africa v Australia" | replay | yes |
| **28 Oct 01:00, 04:00** | Fox "Test : South Africa v Australia", no flag (overnight) | **event**, matched to the Sheffield Shield game *South Australia v Western Australia* (first ball 28 Oct 00:00) | **no**: an overnight replay listed as live (FR-19) |
| **28 Oct 08:30, 11:10, 13:30** | Fox "Test : RSA v AUS 3rd Test D2 S1/S2/S3", **flag 8 (live)** | **replay**, "ESPN has no such game at this time" | **no**: Day 2 live play listed as a replay (FR-20) |
| 28 Oct 08:00, 10:40, 13:00 | Willow Cricket "South Africa v Australia" | event, but credited to the Shield game ("started Wed 12:00 am") | outcome right, wrong game |

## Roster-only league inference (0294/0295) across the whole guide

53 items in two builds (26 Oct 13:00 and 28 Oct 01:00) got their league only from a roster (`inferred.js`). Most are right:
- NBA team channels such as "Minnesota Timberwolves @ Cleveland Cavaliers": events;
- MLB, NBA and NFL "Classics" airings: replays;
- AFL Fox Footy replays such as "SYD v ESS": replays.

Wrong (FR-21):

| Guide title | Inferred as | Verdict | Actually |
|---|---|---|---|
| "Live EFL Cup: Man City v Brighton" (Sky Sports +, 28 Oct 19:00) | EPL | replay, "ESPN: the game started Sat 3:00 pm; this airing is 68 h earlier" | a live EFL Cup game |
| "TBA : Round 21 CAR v BRI" (Fox Footy 504) | FA Cup | replay, "no such game" | an AFL replay: Carlton v Brisbane |
| "Eredivisie Soccer - PSV vs. Feyenoord" | UEFA | replay | not a UEFA game |

`eflcup.js`: with "EFL Cup" and "Carabao Cup" followed, **0289** lists Man City v Brighton as a live EFL Cup event ("live" in
the title). **0300 and 0301** give an EPL replay, even with "EFL Cup" first in the follow list.

No NRL/NFL nickname collision (FR-18) appears in this window; the NRL is in its off-season.

## FR-17 (0301): the round-2 synthetic case is repaired

On 0301, a lone "NFL Football" (guide category) and "Live: Rugby League" (sport channel) are events again. With two
overlapping MLB games, "MLB" and "MLB Baseball" stay shows. The production rows contain no category-recognised generics
(source 8 has no categories and no category is marked as sport), so the 0300 and 0301 replays on them are identical.
