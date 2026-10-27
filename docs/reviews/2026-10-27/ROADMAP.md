# Roadmap, 27 Oct 2026

Where things stand after the R7 week, what to do next in order, and what only Mark can answer. It replaces nothing:
`blueprint.md` §4 stays the record of each roadmap item's status, `docs/FINDINGS.md` the register of open findings.

## Where things stand

| | Server | Apple client |
|---|---|---|
| Live (deployed 27 Oct) | **0289** (`6c4cf96`): FR-11, `feed_lag`, the smaller Status page | **57** (on the Apple TV) |
| Next build number | **0290** | **58** |

- **R7 works on the device.** Since 0282–0284 (a feed judged by how far it is behind real time, by its own clock) and
  Apple 56–57 (live plays held 30 s back): NBC Sports Boston 35 min and Chicago Sports Network Plus 65 min, 0 stalls, no
  switches. Before: a stall every ~7 min and a provider switch every ~11 min, with the sound out of step afterwards.
- **Bug 5 has its root cause (27 Oct, late):** Fox Cricket 501's guide titles ("Test : South Africa v Australia") never
  say "cricket", so the channel is missing from the Test's event; the fix is P0 item 4. **MLB games** show on one
  channel when the others' titles don't say "MLB" (World Series Game 4, 27 Oct): P0 item 5.
- **Shared ingest is on** on Mark's server (off by default in code). **Segmented recordings is on** since 27 Oct.
- **Codex review of 0286–0289:** round 1 found one medium (feed names lost on profile plays), fixed in 0289; round 2
  approved. The batch has had its two rounds.
- **Tests:** server 1186/1186 and `verify-build.sh` passed at 0289. Apple CI green at 57.

## Prioritised work

Mark's answers to Q1-Q7 (below) settled the order. Statuses use blueprint §4's words.

### P0: the agreed next batch (Mark approved on 27 Oct)

Five server commits, in this order, each with a test that fails on the build before it. The batch changes when a live
feed is reconnected, so it gets a **Codex adversarial review** before Mark is told it is ready (two rounds at most).
Items 4 and 5 touch only the sport files and do not depend on 1-3.

**1. Shared ingest on by default (Q5).** `sharedIngestEnabled` defaults to `true` in `server/db.js`'s defaults. A stored
value wins, so an install where an admin turned it off stays off; Mark's server is already on. Check what else assumes
"off by default": Settings → Playback's hint text, `docs/SHARED-INGEST.md`, blueprint §3 and §6, `.env.example` if it is
mentioned, and tests that start a play without setting it (they now read through the ingest). Test: a fresh database's
settings have it on, and a stored `false` is kept.

**2. Remove code nothing uses (B4, re-scoped).** Confirmed on 27 Oct by searching every server, script and web file
(re-check before deleting):
- `public/js/auth.js` (144 lines) and `public/js/login.js` (13): loaded by no page; `login.html` has its own script.
- Server exports used nowhere, not even by tests: `requireRole` and `verifyToken` (`server/auth.js`),
  `getCurrentAndUpcoming` (`epgParser.js`), `liveViewers` and `staleStreams` (`streamCoordinator.js`), `closeForOwner`
  (`streamRelay.js`), `stopNightly` (`dbBackup.js`). Remove a function only if its body is not used internally.
- `releaseOwnerElsewhere` (`streamCoordinator.js`) is called only by tests: remove it with its tests, or keep it if the
  tests are the only proof of a rule still enforced elsewhere (`requestForViewer`'s `elsewhere`).

Not dead, so kept: the relay's stitching and hot standby (Q4), the 0143 refused-connection retries (recordings, catch-up
and any stream the ingest refuses still connect directly), and the warm-session leases. Add `verify-build.sh` checks
that the two web files and the removed names stay gone (prove each by putting one back). About 250 lines in all.

**3. An adaptive reconnect limit per channel (Q2, FR-12).** Mark's rule: every channel starts at the default; one that
goes past its limit moves up a step; it comes back down by itself once the feed behaves.
- **Default 24 s** (`PIGTV_INGEST_BEHIND_SEC`), **step 2 s**, **ceiling 28 s**. The ceiling is fixed by the Apple client's
  30 s hold (`PlayerSeekWindow.liveOffset`): above about 28 s its buffer would run dry before the server reconnects.
  Two steps (26, 28) is all the room there is; more needs a deeper hold (an Apple build, Mark's call).
- **Up:** a reconnect for lag (`lagReconnects`) on a channel and provider raises that pair's limit one step, at once,
  for the ingest that is open and for later ones.
- **Down:** after about **3 hours of reading** that channel and provider at a level with its worst lag at least **4 s
  under** the level, step down one. Any lag reconnect resets the count.
- **Stored per channel and provider** (a small table or rows next to `feed_lag`), so a redeploy keeps the level. Key it
  by the channel's identity (as `channel_health` does: source + stable_id, else item_id), not its display name; the
  routing plan already has it (`plan().primaryKey`, each candidate's `channelKey`), and `ingest.sourceFor` is where it
  would join the names 0287 added.
- **Shown** in Status → Show details → Feed lag: each channel's current limit next to its worst lag.
- **Capture first** (AGENTS.md): the batch changes the reconnect decision, not ffmpeg. Use the `feed_lag` rows
  collected since 0289's deploy plus the 27 Oct soaks (`docs/reviews/2026-10-27/`) as the evidence; no ffmpeg flag
  changes. Tests: with a fake feed that pauses past 24 s (as in `test/ingest-pace.test.js`), the first pass reconnects
  and raises the level; the next identical pause at 26 s does not reconnect; a clean run of the down-window lowers it;
  the level survives a reload of the module and never passes 28 s; a feed with no PCR is unaffected.
- **Docs in the same commit:** blueprint §3 "Stall watchdog", `docs/SHARED-INGEST.md` (Stall row), FINDINGS FR-12
  (fixed: delete the row), `docs/CLIENT-CONTRACT.md`'s note on the ingest limit (the hold stays 30 s).

**4. Fox Cricket's Test titles (bug 5's conclusion, Mark asked on 27 Oct).** Evidence: the real guide rows in
[`fox-cricket-501-titles.txt`](fox-cricket-501-titles.txt) (3rd Test, South Africa v Australia, 27 Oct). This is gap 2 of
the [16 Oct analysis](../2026-10-16/ROADMAP.md) ("an airing with no Cricket category on a non-sport channel is not
recognised"), now shown with real titles; it also explains the original report of the AUS v SA Test "not linked". Three
fixes in one commit, all in `server/services/sportsClassify.js` / `sportsEvents.js`:
- **Recognise:** a title that starts with a cricket format and a colon (`Test :`, `Test Mini :`, `Test Classic :`,
  `ODI :`, `T20 :`, `T20 Mini :`, `W T20 Mini :`, `T20I :`) and names a match-up is league `Cricket`; so is a match-up on a
  channel whose name contains "Cricket" (Fox Cricket, Willow Cricket). The bare word "test" stays not a keyword ("screen
  test"). Today the live Day 1 session was missed as well as the replay.
- **Parse:** strip a trailing Test-stage suffix ("3rd Test Day 1 Session 3", "Third Test Day 1", "G1"-"G5") before the
  match-up is read, so the teams are "South Africa" / "Australia" and "RSA" / "AUS" (today: no teams, or a team called
  "AUS Third Test Day 1"); the stage can stay in the cleaned title.
- **Live only during the day's play:** `fixtureLiveVerdict`'s multi-day rule calls any airing inside a Test's span live,
  so the 22:00 UTC replay (Day 1 ended 16:00, Day 2 starts ~08:00) would read as live. Make a later day live only when the
  airing starts near that day's start of play (the fixture's first-ball time of day, each day, with the usual grace) or
  carries the guide's live flag; otherwise replay. Keep the existing "day 3 of a still-running match is live" test.
- **Tests:** add the evidence rows to `test/fixtures/sports-export.json` with their expected kinds (blueprint §6 asks for
  this before a rule changes): the 13:30 session = event, live; the 22:00 and 01:00 "Test :" airings = replay; "Test
  Mini" = replay; "Test Classic" = replay or placeholder as today; the ODI G1-G3 blocks = replay. Plus "screen test v"
  style negatives, and a "Test : …" title on a non-cricket channel without a match-up = not sport. Use
  `test/sports-classify.test.js` and `test/sports-live.test.js` as patterns.
- **Docs in the same commit:** blueprint §3 "Sport events" (the recognition and multi-day rules), §6 Sport, the state
  line; remove bug 5 from FINDINGS' "Also open" line and from P1 below.

**5. MLB games whose title doesn't say "MLB" (Mark asked on 27 Oct).** Evidence:
[`world-series-titles.txt`](world-series-titles.txt): World Series Game 4, Brewers at Rays, 28 Oct 00:00 UTC, on ~40
visible channels, but Sports listed it on FOX Deportes only, the one guide whose title says "MLB" ("Serie Mundial MLB
2026 : …"). The FOX affiliates, Sportsnet and AFN say "2026 World Series - Milwaukee Brewers at Tampa Bay Rays", and the
team channels "Milwaukee Brewers @ Tampa Bay Rays": not sport, because the MLB follow matches only the word "MLB". The
same gap hits any league whose guides name the teams but not the league (NFL, NBA, AFL titles without the league word).
- **Recognise a match-up of a followed league's teams:** when both sides of a parsed match-up are teams of a followed
  league's stored ESPN roster (`sportsFixtures.teamsOf(league)`, the same aliases `fixtureVerdict` uses), the programme is
  that league (rule `keyword`, match the league). Both sides must match, so "Arsenal v Tampa" does not. With no roster
  stored the rule does nothing (no new false positives).
- **Join the broadcast titles:** "MLB World Series - Game 4" (TNT Sports 1), "MLB World Series 2026", "MLB Postseason
  2026" and a bare "MLB" (ESPN Australia) overlap the game: add their channels to the one overlapping event of the league
  (the existing plain-broadcast-title merge; check why "World Series - Game 4" is a show rather than a broadcast title).
- **Keep out:** "Climbing World Series Highlights", "Dodgermentary: 1988 World Series" and "World Series in 30 - Game 3:
  …" (a recap; must stay a show or a replay, not a second live event). Do not add "world series" as an MLB alias on its
  own (poker, climbing, Little League).
- **Optional, if small:** French "c." as a match-up separator ("Brewers de Milwaukee c. Rays de Tampa Bay", RDS 2).
- **Tests:** the evidence rows into `test/fixtures/sports-export.json` with expected kinds: one live event with every
  listed channel, the three "keep out" rows not in it. A roster-less build gives today's result.
- **Docs:** blueprint §3 "Sport events" (rule (b) gains the roster match), §6 Sport, the state line.

After the batch: Mark deploys, and the live checks are (1) Status → Show details → Feed lag shows a limit per channel,
(2) normal viewing; any channel that rises to 26 or 28 s is listed there, (3) after a quiet few hours it comes back, and
(4) during the next Test on Fox Cricket 501, Sports lists it live during play and as a replay overnight (Settings →
Sports' preview shows the rule for each airing), and (5) the next MLB game lists every channel carrying it.

### P1: correctness

4. **FR-9, HE-AAC copied on a fresh probe**: one failed start (~6 s) the first time an HE-AAC channel is played after
   its cache expires. Find why the fresh probe's capability check says "copy"; the cached path already re-encodes.
   Small, with a reproduction in FINDINGS.
5. **Reconnect or switch.** Once the adaptive limit has run a while: should repeated lag on one provider move the
   channel to the next? Avoid switching between Strong8K and Trex for the same pause: they share an upstream and paused
   together (FR-8).
6. **Channels with no usable standby** (TNT Sports 4: Dream 4K is HEVC/50 fps/5.1, Trex 720p; FR-14). Count them from
   the relay's "cannot join this stream" log lines before designing anything.
7. **FR-10, Apple player frozen after a long live play.** Not reproducible on demand. If it recurs: the time and channel,
   the server log around it, and whether the app answered at all. An Apple-side diagnostic only after a second case.
8. **Bug 8 (iPhone tuning)**: still without a root cause (blueprint). Bug 5 (AUS v SA cricket) found its cause on
   27 Oct and is P0 item 4.

### P2: housekeeping and design debts

9. **Settings → Recording has two Save buttons** (the section's and Notifications'). Left as is by Mark's choice; if
   touched, save each switch on change, as the hardware-decode switches do.
10. **FR-1** recording cleanup simplification (design), **FR-2** a Codex round on 0280 if wanted.
11. **Flaky tests** FR-3, FR-4, FR-13 (keep the log if they recur); Apple test-run hangs FR-5, the tab-switch gate FR-6.
12. **Deferred, unmeasured:** live ffmpeg speed on Status, E2 ffmpeg version parity, the efficiency register.

### Closed on 27 Oct

- **FR-14** (TNT Sports 4's sound offset is in Strong8K's feed): Mark lives with it; kept in FINDINGS as a known feed
  defect, no work planned.
- **B4's retirement of the relay stitching and standby**: not done (Q4); B4 is now the dead-code removal in P0.
- **R8's before/after sync measurement and the E3 audio-track samples**: closed, no longer of value (Q7).

## Questions for Mark (asked 27 Oct; answered below)

| # | Question | Why it matters | Suggested answer |
|---|---|---|---|
| Q1 | When can 0289 be deployed? | `feed_lag` only collects from the deploy on; the week of data for P1 starts then | As soon as convenient |
| Q2 | After a week of `feed_lag`: per-channel limits, or one higher limit for every channel (30 s, with the Apple hold at 36 s: 6 s further behind live)? | FR-12: a healthy Chicago pause reached 24.1 s; just above it means a needless reconnect | Per-channel, if a few channels stand out; one higher limit if most channels sit near 20 s |
| Q3 | TNT Sports 4: put Dream 4K first for it, add a per-channel audio delay, or live with it? | FR-14: the offset is in Strong8K's feed | Try Dream 4K on the Apple TV first (HEVC 50 fps 5.1); if it plays well, prefer it for that channel |
| Q4 | Keep the hot standby (re-scope B4) rather than retire it? | It is the only seamless failover; B4 assumed the ingest would replace it | Keep it; retire only the parts the ingest made redundant |
| Q5 | Make shared ingest the default in code? | It is on on your server and R7 depends on it; a fresh install gets the old path | Yes, once 0289 has run a week without trouble |
| Q6 | Is there a channel you watch that still stutters or loses sync after a stall? | The next capture (`scripts/stream-doctor.js`) should be on a real problem channel | Name it when you see it |
| Q7 | R8 sync measurement and the E3 samples' location (open since 16-18 Oct): still wanted? | They gate R8's future and the audio-track check | Close them if no longer of interest |

## Mark's answers (27 Oct, evening)

| # | Answer |
|---|---|
| Q1 | **0289 is deployed** (27 Oct). `feed_lag` collects from now on. |
| Q2 | **Per channel, by exception, and self-correcting.** Every channel starts at the default limit. A channel that goes past its limit moves up one step (about 2 s); it must come back down on its own once the feed behaves again, because a feed's trouble can be temporary. |
| Q3 | **Live with it** (TNT Sports 4's offset, FR-14). No change. |
| Q4 | **Keep the hot standby.** B4 no longer retires the relay's stitching or standby. |
| Q5 | **Shared ingest on by default** for new installs: it has run well for long enough. |
| Q6 | Mark will name a channel when he sees one. |
| Q7 | **Close** R8's sync measurement and the E3 samples if they are no longer of value (they are not: closed). |

## How to pick this up

The handover prompt for the next agent is [`HANDOVER.md`](HANDOVER.md).
