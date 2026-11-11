# T3 for batch #272 (sport reads): the rig's account, builds 0552, 0556 and 0558

All on the test rig's staging server with the fake score feed (`PIGTV_RIG_SCORES=fake`), deployed with `scripts/unraid-rig.sh up` from a clean detached clone;
no production container, no real provider, no repository file changed, nothing in this folder carries an address or credential. All times are UTC.
The scripted game is always Everton v Fulham (EPL, id `espn:soccer/eng.1:9917001`) on ITV1: a guide slot of 8 minutes from 47 s after kick-off, a final 20 minutes after kick-off.
Scripts used (kept beside this file, scratchpad only): `api.sh`, `snap.js`, `poll.js`/`poll0556b.js`/`run-0558/poll.js`, `render.js`, `loops.sh`.

| build | commit | what it was for | date | rig `check` |
|---|---|---|---|---|
| 0552 | 8e282bf | the batch's reads: agreement tables, rule and recording, idle loops, resume | 11 Nov | passed |
| 0556 | bb367ce | the database 0552 had altered opened and served; timings of front vs League page | 11 Nov | passed |
| 0558 | 00f1e50 | League pages and the NFL page read the score collector with the account's delay | 11 Nov | passed |

## 1. Build 0552: the three agreement tables (before, live, after)

Columns: the answer, the game's id, start, status, score, channel, notes. "events" = `GET /api/sports/events` (what the web Sport page and the guide's
live/replay marking use: `kind` event/replay, `live`). "front" = `/api/sports/front`, "EPL page" = `/api/sports/pages/league/EPL`.

#### 1. Before kick-off (07:26:20)
| answer | id | start | status | score | channel | notes |
|---|---|---|---|---|---|---|
| front | espn:soccer/eng.1:9917001 | 07:31:00 | scheduled | - | ITV1 HD | matched, broadcastStatus scheduled |
| EPL page | 9917001 | 07:31:00 | scheduled | - | ITV1 HD 07:31:47-07:39:47 | |
| events | 2822ab394feb782c | 07:31:47 | kind event, live=false | n/a | ITV1 HD 07:31:47-07:39:47 | |
| guide listing | - | 07:31:47 | isNow=false | n/a | ITV1 HD | |
| rule | rule #1 | - | enabled | - | - | upcoming=1 |
| scheduled list | rec #13 | 07:31:47 | scheduled | - | ITV1 HD | rule_id 1, endsWith event: exactly ONE, on a channel that shows it |

Agree. One transient disagreement at 07:24:57 (first snapshot, 27 s after the rule was made, about 3 min after boot): the front card showed
`finished 1-1`, freshness `fresh`, no channel (`unmatched`), from a row left by the previous rig run's game with the same id (observedAt a day old).
At 07:26:20 the collector's first pass had replaced it with `scheduled`. A stale final was shown as fresh for the first ~minutes after a restart.

#### 2. While live (07:34:23)
| answer | id | start | status | score | channel | notes |
|---|---|---|---|---|---|---|
| front | espn:soccer/eng.1:9917001 | 07:31:00 | live 1' | 0-0 | ITV1 HD | on-tv, canWatch=true, observedAt 07:32:21 (delay 90 s) |
| EPL page | 9917001 | 07:31:00 | **scheduled** | - | ITV1 HD | still the pre-kick-off answer |
| events | 2822ab394feb782c | 07:31:47 | kind event, live=true | n/a | ITV1 HD | |
| guide listing | - | 07:31:47 | isNow=true | n/a | ITV1 HD | marked live, not a replay |
| rule | rule #1 | - | enabled | - | - | upcoming=1 |
| scheduled list | rec #13 | 07:31:47 | recording | - | ITV1 HD | still ONE; later `overrun: true` (kept past the guide end to final + 5 min) |

Disagreement: the EPL page said `scheduled` with no score until 07:34:5x (about 3 min after kick-off, then `live 0-0`, matching the front). It is
fetched on demand from ESPN with its own cache (10 min on a game day, 2 min once a game is on), not read from the score collector, so it lags the
front card by up to its TTL. The events list said live=true at 07:32:08, 2 min before the front card said live (07:33:58): the front card is the
account's 90 s score delay plus the collector pass (a design, but it shows as a 2 min gap: events/guide live, front not yet). Scores then agreed
between front and EPL page at every poll (0-0, 1-0 at 4', 1-1) with the EPL page about 0-60 s behind. Poll log: `poll.log`.

#### 3. After final (07:57:49; the scripted final was 07:51:21)
| answer | id | start | status | score | channel | notes |
|---|---|---|---|---|---|---|
| front | espn:soccer/eng.1:9917001 | 07:31:00 | finished 90' | 1-1 | none | unavailable (game over) |
| EPL page | 9917001 | 07:31:00 | done FT | 1-1 | none | |
| events | - | - | not listed | - | - | the game ended; no entry |
| guide listing | - | - | not listed in the current window | - | - | |
| rule | rule #1 | - | enabled | - | - | upcoming=0 |
| scheduled list | (none) | - | - | - | - | rec #12 (made from #13) showed `recording` until ~08:00 then `completed` |

Agree. Front said `finished` at 07:53:53 (2 m 32 s after the final, 90 s delay + pass); the EPL page said `done` at 07:52:53. One recording
scheduled by the rule: yes (exactly one, #13, and it ran on ITV1 and completed).

Between 07:39:47 (guide end) and the final the game was missing from `/api/sports/events` while the front card (07:41 on) had `availability`
changing; the recording was kept alive by the overrun logic (the scheduled row showed `overrun: true`, `stopsAt` = final + post padding). Not a
disagreement about the recording; noted because the events list no longer names the game while it is still live on the front.


## 2. Timings, builds 0556 and 0558 side by side (relative to kick-off)

0556 kick-off 08:45:36; 0558 kick-off 09:57:42 (final at +20:00 on both). Polls every 10 s; "first" = the first poll that showed it.

| answer | event | 0556 | 0558 |
|---|---|---|---|
| events (`live=true`) | first live | +0:26 | +0:20 (09:58:02) |
| events | leaves the list | +8:28 (guide slot's end) | +8:21 (10:06:03; slot ended at +8:00) |
| front | first live | +2:07 | +0:40 (09:58:22) |
| Premier League page | first live | +2:57 | +0:40 (09:58:22, the same poll as the front) |
| front | 1-0 | seen by 7' | +3:40 (10:01:22) |
| Premier League page | 1-0 | seen by 7' | +3:40 (10:01:22, the same poll) |
| front | 1-1 | seen by 19' | +17:13 (10:14:55) |
| Premier League page | 1-1 | seen by 19' | +17:13 (10:14:55, the same poll) |
| front | first over (`finished`) | +22:11 (2:11 after the final) | +22:14 (10:19:56; 2:14 after the final) |
| Premier League page | first over (`done`) | +20:51 (0:51 after the final) | +22:14 (10:19:56, the same poll) |

Delay in force on 0558: 0 s from before kick-off until 10:06:03 (+8:21), then the account's own 90 s (put back by the poll script with one PUT) for the 1-1 and the final.
The account's delay as found: `scoreDelaySeconds` 90, `revision` 0, avoidSpoilers off. Kick-off and the 1-0 were therefore measured at delay 0, the 1-1 and the final at 90 s.
Result: the front and the Premier League page changed state within the same poll at kick-off, at 1-0, at 1-1 and at the final, on both delay settings (0556: 50 s apart at kick-off, 80 s apart at the final).
Screens (the web has no page for either answer, so the answers' entry for the game, rendered dark at 1440x900 with the rig clock): `evidence/0558-kickoff-front.jpg`,
`0558-kickoff-epl.jpg`, `0558-final-front.jpg`, `0558-final-epl.jpg`; no address in them.

## 3. The rule and the recording (0558; 0552 gave the same)

Rule `{"kind":"team","sport":"Football","match":"Everton"}` made at 09:50:27, answered `scheduled: 1`; the rule's `upcoming` stayed 1 until the game ended, and the scheduled list held exactly one
entry (#14, ITV1 HD, the guide slot 09:57:42-10:05:42 plus 1 min before) at every poll: `scheduled`, then `recording` from 09:56:52, then `overrun` past the guide's end to final + 5 min
(stopsAt 10:23:16, `endsWith: event`). Recording #13 ran 09:56:48-10:23:16 on ITV1 HD, `completed`, not partial, 1588 s, 94 MB. No second entry at any time: ONE recording by the rule, on a channel that shows the game
(0552: the same, one scheduled, one completed). The recording was not watched on the rig (no playback of the file was part of this check).

After the game: the game appeared once on the front (`finished 1-1`, unavailable), once on the Premier League page (`done FT 1-1`), no longer on the events list or the guide, and not at all on the web Sport page
(0 lines naming Everton or Fulham; its cards say "Scores hidden", guide-only view): no duplicate (#194).
`/api/status` `sportLoops` at the end of the run: fixtures `{running: true, why: "looking"}`, eventList `{running: true, why: "looking"}` (the poll had been reading until 10:22).

## 4. Idle and resume (commit 0545, observed on 0552), rule disabled and no browser open
`sportLoops` entries sampled every 30 s (`loops.log`, UTC). Rule disabled 07:58:35; last sport read ~07:58:15; browsers closed.
| time | event | sportLoops |
|---|---|---|
| 07:58:35 | rule disabled | fixtures running (why looking), eventList running (why looking) |
| 08:05:15 | eventList tick at 08:05:01 | eventList `{"running":false,"why":null,"idleSince":1794384301001}`, fixtures still running |
| 08:24:20 | fixtures tick at 08:23:51 | both idle: fixtures `{"running":false,"why":null,"idleSince":1794385431175}`, eventList idle |
| 08:24:36 | Sport page opened (then closed) | |
| 08:24:50 | | both `running:true, why:"looking"` (resumed within 11 s, the first sample after) |
| 08:30:01 | eventList idle again (rule still disabled) | |
| 08:30:30 | rule enabled | 08:30:31: eventList `{"running":true,"why":"a recording rule is on"}`, fixtures running |
| 08:35:22 | look window over, tick | eventList `why:"rule"`; it never went idle with the rule on |
So: idle with a reason (running false, idleSince set; the "why" is null when idle, the reason shown is that nothing is looking) after the look window
and a tick: the event list after about 7 min, fixtures after about 25 min (its tick is every 30 min, so idle can take up to 5 + 30 min). Resume on page
open and on rule enable: observed. Fixtures idle was not re-shown after the rule enable (it needed another 30 min); it resumed with "looking" at the page
open and stayed running afterwards. The score collector's own cadence read `{"everySec":300,"why":"nobody looking"}` in `/api/status` at the end.
Note: `GET /api/sports/events` and the score pages each count as a look, so the watcher calls only `/api/status` (which does not).

## 5. Database repair (0556)

The staging database that 0552 had opened and altered was left in place and 0556 was deployed over it: the server started and served the front, the Premier League page, `/api/status` (with `sportLoops`)
and the events list, all HTTP 200, the game present once in each, with no error. The rig script has no log command, so the repair message itself was not read; the proof is that the server
opened and served on the altered database. 0558 then opened it again the same way (staging reported "build 0558", `check` passed).

## 6. What could not be shown
- History row counts (commit 0549): `/api/status` and the admin endpoints expose timings only, and nothing was run inside the container.
- #281 (the AFL badge): the fake scores have no AFL teams.
- Scores on the rig's web Sport page (#261): the rig runs the guide-only "Ordinary sport" view (`sportsDashboard` off), so every card says "Scores hidden"; the score timings come from the front and League page answers.
  With the feature forced on by a route (the #276 shots) the 0556 wording check passed (button "Scores & delay", dialog "Hide scores and result details", the word "spoiler" nowhere).
- The 0558 NFL page change: the fake feed has no NFL game, so only the League page was timed; the NFL page shares the same code path but was not exercised.

## 7. Seen on the rig, not this batch's
1. A day-old final shown for about a minute after the rig restarts: the fake game reuses its id, so the previous run's row (`finished 1-1`, observedAt a day old, shown as `fresh`, no channel)
   is on the front until the collector's first pass replaces it with `scheduled` (0552: 07:24:57 until 07:26:20; 0556: 08:38 until 08:39:21). A real game has a fresh id each time, so this is an artefact of the fake feed, but a stale row marked `fresh` is worth a look.
2. The game leaves `/api/sports/events` when its guide slot ends (+8 min), 12 minutes before the final, while the front still says live. The recording is not affected (the overrun logic keeps it to final + 5 min); any
   consumer of the events list loses the game early.

## 8. Left as found
Rule #2 and recording #13 deleted through the API (`cancelled: 0`); the account's score delay is 90 s again (revision 2: it was 0 when this run began, set to 0 for the kick-off and put back at +8:21); the Football/EPL follow was
there before and is unchanged; tunnel closed; the rig's containers left running at 0558. Earlier-run rule/recording from 0552 were already removed.

## 9. Evidence files
`evidence/` holds 16 JPG: guide/recordings/sports/status at before, live and after (0552, desktop dark; the guide shot shows 11 rows, so the marked programme was checked in the API) and the four 0558 renders above.
`run-0558/poll.log` is the 10 s log of the 0558 run (front, League page, events, rule, scheduled list per poll).

