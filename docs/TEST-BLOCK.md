# Test block: everything built on 23 September – 2 October 2026

## Outstanding as of 4 October 2026 (server 0204 · app 39)

Mark's results of 2 Oct are ticked. Still open: A1 (re-check on 0187), D5–D10, G2–G4, G6, G7, H (the tuner), K (captures), **L (in-stream recovery and the standby, 0189)**, **M (0191)**. Round 7 below was written for 0179 and the old
Sources/Providers tabs; **R7.1–R7.5 and R7.14 are replaced by the steps here** (0182 moved providers onto cards and removed
the hand-typed dates). R7.6–R7.13 and R7.15 are unchanged and repeated here in short.

**A. Deploy and the 0182 upgrade step**
- [x] A1 **FAILED 2 Oct (badge said 0181: version.js was not bumped in 0182–0186; fixed in 0187, re-check)** Back up the data folder, Force Update, `/api/version` says **0186**.
- [x] A2 Log has one line `[Providers] One card per provider: …`; the guide is not empty afterwards.
- [x] A3 Favourites, channel numbers and scheduled recordings are unchanged.

**B. Settings → Providers (0182, 0184)**
- [x] B1 One card per provider, the primary first; each shows Account, Expires, Connections, Channels, Guide.
- [x] B2 Edit opens the same form on every card; Save with no change closes it; a changed guide address starts a sync.
- [x] B3 Add a provider from the blank card (it becomes the last backup); Delete removes it.
- [x] B4 Move a backup up/down: saved at once, no sync. (Optional, disruptive: move a backup to the top, confirm, then back.)
- [x] B5 Check account on each: Strong8K **14 Jan 2027**, Dream4K **29 Mar 2027**, Trex **30 Mar 2027**.
- [x] B6 M3U cards show "Login: Found in the playlist"; backup cards show "Covers N of M primary channels".
- [x] B7 "Sync channels and guide every" keeps its value after a reload.

**C. Backups and links (0183; replaces R7.2–R7.5)**
- [x] C1 Sync now on Dream4K and Trex: Backup channels rises to each provider's full list (tens of thousands).
- [x] C2 Review links: Australian channels now have candidates. Nothing wrong-country among the Auto links (no US ABC, no French beIN).
- [x] C3 Approve the AU sport and free-to-air you care about; "Covers" on the card goes up.
- [x] C4 A sync of a backup while something is playing causes no stutter (note it if it does).

**D. Failover (R7.6–R7.13, R7.15)**
- [x] D1 (R7.6) A linked channel plays on Strong8K.
- [x] D2 (R7.7) Second device plays a different linked channel on a backup with no "another device" prompt.
- [x] D3 (R7.8) Primary down (break Strong8K's playlist address on its card): a linked channel plays on a backup within ~20 s; after two failures Status shows Strong8K down; restored after the cooldown.
- [x] D4 (R7.9) Mid-play break: rebuffers ~5–20 s, carries on on the backup.
- [ ] D5 (R7.10) An unlinked channel fails with "The provider refused this channel".
- [ ] D6 (R7.11, Mark testing 2 Oct) A due recording starts on a backup without a prompt while the TV watches.
- [ ] D7 (R7.12) Everything busy: the recording prompts as before.
- [ ] D8 (R7.13, optional) Break the primary during a recording: a "(part 2)" appears on a backup.
- [ ] D9 (R7.15) Both backups disabled: everything behaves as before.
- [ ] D10 (replaces R7.14) The expiry banner appears for a provider within 7 days of its account's end (web and Apple TV), and can be dismissed for the day. Nothing to type: it can only be checked when one is actually close.

**E. Settings layout and Status (0182)**
- [x] E1 Six tabs; Channels has Manage content / Channel numbers / EPG matching; each opens and saves.
- [x] E2 Playback: Player and Transcoding settings save; "Advanced" opens.
- [x] E3 System: theme, devices and users work.
- [x] E4 Status → Live sessions: Stop ends that stream; Stop all appears with two or more.

**F. Sport (0185, 0186)**
- [x] F1 Settings → Sports: "Add a league…" lists leagues; picking EPL adds a chip; Save.
- [x] F2 "Add a team from…" → NFL → a team: chip "NFL: <team>"; after Save its games show "Matched by: keyword".
- [x] F3 Status → Sport fixtures lists each followed league (EPL shows 0 until a matchday is within 72 h).
- [x] F4 No other country's Premier League is labelled EPL (0186).
- [x] F5 Midweek re-airings of last weekend's grand prix show as replays, not in Live sport.

**L. In-stream recovery and the hot standby (0189; experimental, `docs/STANDBY-BRIEF.md`)**
Turn on: Settings → Transcoding → Stream recovery → **In-stream recovery** (and for L4–L7 also **Hot standby**). A switch applies to channels played after it is changed; start the channel again after turning it on.
Log filter: `docker logs PigTV --since 30m 2>&1 | grep -E "\[Relay|failover|Coordinator"`
- [x] L0 Before turning anything on, note Status → Interruptions after a few normal days: the baseline.
- [x] L1 Turn on **In-stream recovery** in Settings → Transcoding, then normal viewing for an evening on the Apple TV and the web: nothing is different. Status → Live sessions says "In-stream recovery is on" and lists each followed stream (state `playing`).
- [x] L2 **Cold switch**: play a linked channel, then break Strong8K's playlist address on its card (as D3/D4). The picture freezes ~20–30 s and carries on **without** the player restarting or an error; log: `[Relay …] Strong8K … switching` then `now on <backup> after N s`. Interruptions shows the row with "Back in N s (on <backup>)".
- [x] L3 The same on the **iPad** and the **web**. If any player shows an error or restarts instead, note which.
- [x] L4 **Standby**: turn on **Hot standby** in Settings → Transcoding (it is greyed out until In-stream recovery is on), then play a linked channel for a minute. Status: the stream's state is `standby-ready` and Standby shows <backup> (ready), and Providers shows that backup's connection in use.
- [x] L5 Break Strong8K again: the picture carries on after ~10 s, with a jump or a few seconds repeated. Log: `wrote nothing for 10 s; switching`, `now on <backup> after 0.0 s`.
- [x] L6 **Giving way**: with a standby running, play another channel on a second device, or let a recording start: it gets the backup's connection with **no prompt**; log `standby on … gone: its connection was needed`. The first device keeps playing.
- [x] L7 Change channel a few times quickly with the standby on: each old relay ends (`[Relay …] ended`), no stray streams left on Status after a minute.
- [x] L8 Roll back: turn **Hot standby** and **In-stream recovery** off in Settings → Transcoding. New plays are as before; a stream already playing finishes as it was.

**M. Reconnect loop and blank pictures (0191)**
Log filter: `docker logs PigTV --since 30m 2>&1 | grep -E "Timestamps looping|Blank picture|blank picture|Relay|lost .* mid-play"`
- [x] M1 Deploy, `/api/version` says **0191**.
- [x] M2 Play 7mate Melbourne for 30 s: log `Blank picture: … kbps … at 1080p`, then `Strong8K is sending a blank picture for "7 Mate Melbourne"`. Status → Least reliable shows it with **Blank picture**. Playback itself carries on.
- [x] M3 Play a few normal channels (a sport channel, a 7 channel, an SD one) for a minute each: **no** `Blank picture` line for any of them. If one appears for a real picture, note the channel and the kbps.
- [ ] M4 Fox Footy for an hour or so (relay on, see L): when Strong8K drops it, either nothing happens beyond a short freeze or the log shows `Timestamps looping … ending the session so it restarts cleanly` followed by the relay's `now on Strong8K after N s`. The picture must **not** wander back and forth for minutes any more. Status → Interruptions shows "Timestamps broke after a reconnect" for such a row.
- [ ] M5 The 7 channels' ~38 s cut still plays through as before (a short repeat, no restart, no `Timestamps looping`).
- [ ] M6 `docker exec PigTV node scripts/stream-doctor.js capture pos_1178 300` (nothing playing): says `the connection held` or when the provider closed it, and lists `jumps` per stream plus `PICTURE : has picture data`. On `pos_1157` (7mate) it says `PICTURE : BLANK`.

**N. The audit build (server 0192–0196 · app 37, 4 Oct). Deploy server and app together: 0196 refuses media requests without a token, so an app older than these builds may fail to play.**
- [x] N1 `/api/version` says **0196**; Settings → About on the Apple TV says build **37**.
- [x] N2 Live TV, the Guide, Sport and a recording all play on the Apple TV (0196: every stream URL needs the token the app sends). Seek within a recording.
- [x] N3 Status page loads (admin), Live sessions listed; nothing in the log about 401s from your own devices.
- [x] N4 Sport tab: switch Home → Guide → Sport and back a few times; Sport is selectable at once (was 1–3 s). Scroll Replays to the end and back; open and close Event details: focus returns to the same card.
- [x] N5 Log after the deploy: `earlier recording(s) queued to be prepared for the Apple client`, then one `#N is now <name>.mp4; the .mkv it was made from is deleted` per recording, one at a time. Recordings show "Preparing for playback…" until theirs is done. Free space drops briefly while each is prepared, then rises (the .mkv is gone).
- [ ] N6 Record something short (10 min). When it finishes, wait for its `is now … .mp4` line, then press Play: it starts within a couple of seconds (was about a minute for a fresh recording).
- [ ] N7 A recording with ad breaks: playback starts without waiting; the skip prompt still appears at a break.
- [x] N8 An HEVC channel recorded and played (0192: the prepared MP4 is tagged `hvc1`).
- [ ] N9 Optional: Instruments baseline on the Apple TV (app `TESTING.md` → "Measuring on the Apple TV").

**O. Phase 3 (server 0197–0202 · app 38, 4 Oct). Before deploying: back up the data folder (`docs/OPERATIONS.md`). The image now runs as PUID/PGID 99:100.**
Log filter: `docker logs PigTV --since 30m 2>&1 | grep -E "entrypoint|Relay|Coordinator|warm|Recordings"`
- [x] O1 Deploy (Force Update). The first lines are `[entrypoint] …`: ownership fixed for `/app/data` (first start only), `recordings folder … is writable by 99:100`, `starting as 99:100`. If it says the recordings folder is **not** writable: see `docs/OPERATIONS.md` (or set `PUID`=`0` on the template to run as root as before). `/api/version` says **0202**; the Docker tab shows the container **healthy** after a minute.
- [x] O2 VAAPI still works: play a channel that is transcoded (or check Settings → Transcoding hardware status / the log for `vaapi`). If it fell back to CPU, note it.
- [x] O3 A recording still records and plays (any short one), and compression (if you use it) still runs.
- [x] O4 Settings → Transcoding → **Stream recovery (experimental)**: three switches, all **off**. Hot standby is greyed out until In-stream recovery is on. (Then run section **L** with these switches.)
- [x] O5 Status page: **Server load and background work** shows loop delay, the preparation queue and sport builds; Providers shows **In use for** (viewer / recording / standby). Leave the Status tab in the background a minute: it doesn't keep polling (no flicker on return).
- [x] O6 Two devices start the same single-connection provider at the same moment: one plays, the other gets the usual "another device is watching" question — never both briefly playing and then one failing.
- [x] O7 **Warm the next channel** on. On the Apple TV: watch a channel for 10 s, then channel-up: it should start noticeably faster than with warming off. Focus a live Sport card for 2 s, then select it: fast start. Status → Providers shows a `warm` connection while one is warm; it disappears within ~90 s of moving on. A recording due, or another device, takes the warm connection with **no prompt**.
- [x] O8 With In-stream recovery + Hot standby + warming all on and only one spare connection: the standby wins (log `Releasing … (warm) for a standby`).
- [x] O9 App 38: TV Guide opens without the first-visit pause (the grid fills in over a few frames); Home/Guide/Sport/Recordings switch quickly; signing out and in again shows your own guide straight away (no stale one).
- [x] O10 Roll back if needed: Unraid → PigTV → Edit → Repository tag of the previous image, or `PUID`=`0` for the permissions part only.

**P. Recording audio (0203, 4 Oct).** (`PIGTV_KEEP_MKV` is ignored from 0204: an original is deleted only once its MP4 decodes cleanly. Remove the variable from the template.)
- [x] P1 `/api/version` says **0203**. Record ~15 min of Nick Toons (or any channel with ad breaks). The new file in the share ends in **`.ts`**, not `.mkv`.
- [ ] P2 When it finishes, the log shows `#N ready for native playback` then `#N is now … .mp4` (with the variable set, the `.ts` is kept beside it). Play it on the Apple TV **past the first ad break**: picture and sound all the way to the end.
- [ ] P3 Break detection finishes for it (`#N: K break(s) marked`, not `Break detection failed`).
- [ ] P4 Run the audio check from 4 Oct on the new `.mp4`: `0 errors` (or only a handful).
- [ ] P5 Settings → Transcoding: tick In-stream recovery and Hot standby, then untick In-stream recovery: Hot standby unticks too and stays unticked after a page reload.

**Q. The simplification build (server 0204–0205 · app 39, 4 Oct). Behaviour should be unchanged apart from Q2.**
- [ ] Q1 `/api/version` says **0204**; Settings → About on the Apple TV says build **39**. Remove `PIGTV_KEEP_MKV` from the Unraid template (it is ignored now).
- [ ] Q2 TV Guide: ESPN, NFL RedZone and Sky Sports Main Event each appear **once** (no "(Backup)" copy beside them). Play one, then (if you can) break Strong8K's address as in D3: it still fails over to its backup feed.
- [ ] Q3 With Warm the next channel on: watching ESPN, channel up warms the real next channel (Status → Providers shows `warm` on that channel, not on "ESPN (Backup)").
- [ ] Q4 Everyday checks still pass: a live channel, the Guide, Sport, a recording (record, play, delete), Settings switches, Status page.
- [ ] Q5 The app: Home, Guide, Sport, Recordings and Settings behave as in app 38 (this build only reorganised code and tests).
- [ ] Q6 (0205) Settings → Transcoding: In-stream recovery and Hot standby on. Play ESPN for a minute: Status shows the stream `standby-ready` with a backup named, as in L4. Then rerun L2/L3 (provider lost mid-play: the picture carries on). Settings → **Backup links** still lists the "(Backup)" siblings after a sync.

**G. Still open from earlier rounds**
- [x] G1 R6.3 again: recordings folder set back to `/app/recordings/SERVER01_Video/Recordings`; a bad path is refused.
- [x] G2 R6.4 An overnight recording scheduled from the Apple TV is there next morning.
- [ ] G3 R6.5 Prompt ignored: the recording takes the stream ~3 minutes after it is due.
- [ ] G4 R6.6 "Keep watching": playback continues, the recording waits.
- [x] G5 R6.16 Web: Live TV, Guide, Recordings play; every Settings tab opens and saves (now the six tabs, see E).
- [ ] G6 1.16 Skip break / Auto-skip on a recording with detected breaks.
- [x] G7 R3.8 Sport tab empty state (a moment with no followed sport).
- [x] G8 R2.5 / R3.11 A file-based channel starts quickly (needs that channel found again).
- [x] G9 Mark's minor bugs from app 35 / 0167 (29 Sept): not yet reported in detail.

**H. The tuner: removed in 0204** (never run; Mark, 4 Oct). Part 3 below is kept only as history.

**I. Closed (2 Oct)** - 4.2 Siri on Apple TV: failed, and Mark does not want the feature; it is removed in the next Swift build (blueprint §6 Next). W6 dropped with it.

**J. Older checks: passed (Mark, 2 Oct)** - 0054 cutting the upstream mid-stream frees the slot · 0062 an HEVC recording plays on the Apple TV · 0073 `timestamp discontinuity` stays near 0 on the E-AC-3 channel.

**K. Captures wanted while the fault is happening** - Fox Footy 504 audio timestamp flood · the ~38 s cut with ~19 s resent (7 channels) · 7 Flix Sydney "Stream ends prematurely" loop.

## Status summary (29 September 2026)

Mark ran six rounds: **1** (server 0138 · app 22), **2** (0146 · 28), **3** (0149 · 30), **4** (0151 · 31), **5** (0154 · 32,
28 Sept) and **6** (0166 · 34, 29 Sept). The checkboxes below are the original lists and were not ticked one by one; this
summary is the record.

**Passed:** everything in rounds 1–4 on the **Apple TV and the web**, except the items below (including 1.13, the HDR panel
switch, and R4.4, the Top Shelf). **Round 5:** Mark tested everything except the tuner; it passed apart from five bugs, which
started the 28–29 Sept fix run (`blueprint.md` §6 "Fix run"): a future sport event's secondary channel tuned instead of
offering to record; replays in the Sport tab's On now; an overnight recording that silently failed (a stale Docker mount of
the recordings share, fixed on the Unraid side plus 0156–0160); pages that need Back before anything is selectable (W6,
parked); the guide stopping about a day ahead. **Round 6:** passed except R6.3 (a relative recordings path saved; fixed in
**0167**) and R6.14 (Jump to… cut off on tvOS; fixed in **app 35**). R6.7's "F1: 0 fixtures" was correct at the time (the next
session was just past the 72 h window). Mark's verdict on app 35 and its branding (29 Sept): "looking good", with a few minor
bugs saved for the next build.

**Still to run:**

| Item | Why / when |
|---|---|
| R6.3 again | Re-check on 0167 after setting the recordings folder back to `/app/recordings/SERVER01_Video/Recordings` |
| R6.4–R6.6 | An overnight recording from the Apple TV; the 3-minute prompt timeout and "Keep watching" (Mark: a later date) |
| R6.16 | The web pages after the dead-code cleanup (0163–0166) |
| 1.16 Skip break / Auto-skip on a recording with breaks | No recording with detected breaks to test on yet |
| R3.8 Sport tab empty state | Needs a moment with no followed sport in the next hours |
| R2.5 / R3.11 File-based channel starts quickly (0144) | The channel could not be identified again |
| **Part 3** The tuner | Removed in 0204 (never tested) |
| 4.2 Siri on Apple TV | Parked: tvOS Siri may not support third-party App Shortcuts |
| W6 | Parked until Mark names a screen that needs Back before anything can be selected |

**Decisions from the rounds:** the UIKit guide is the only guide (2.7); HE-AAC passthrough is always on (2.10); channel
numbers are labels only, the provider's order kept (1.4); the tuner stays, off by default; sport is recognised per programme
with a follow list, checked against ESPN fixtures where ESPN covers the league (AFLW stays on the guide rules); an
unanswered recording prompt hands over after 3 minutes; the app opens on Home; Swift 6 stays on (R2.15); branding
direction A "Spotlight", the pig logo itself never changed.

## Round 7: multi-provider failover (server 0179 · app 36)

**Deploy first:** Unraid → Docker → PigTV → **Force Update**; `/api/version` should say **0179**. Install **app build 36**.
Anything that fails: send the step number, what you saw and roughly when. Useful log filter:
`docker logs PigTV --since 30m 2>&1 | grep -E "failover|\[Providers\]|resolve timing|Recordings"`

**Set-up (web, admin)**
- [ ] R7.1 Settings → Sources → edit **Strong8K**: paste the **new** playlist link (server moved to `vip.wd.omguhd.top`) →
      Save → **Sync now**. Favourites, channel numbers and scheduled recordings are unchanged afterwards.
- [ ] R7.2 Settings → Sources → add **Trex** as **Xtream**, role **Backup** (server `http://line.trx-pro-iptvstore.cc`, its
      username and password). Then Settings → **Providers** → Trex → paste its EPGenius M3U link as the id overlay → Save →
      Sync now. The card shows about 55,000 backup channels.
- [ ] R7.3 Add **Dream4K** the same way: **Xtream** (not its EPGenius M3U: the raw list has the Australian free-to-air
      channels EPGenius dropped), server `http://line.d4k-pro-iptvstore.cc`, role Backup, its EPGenius link as the overlay.
- [ ] R7.4 Providers: order the backups with the arrows (plan: **Dream4K first** - a different upstream from Strong8K;
      Trex, which shares Strong8K's upstream, second). **Check now** on each: Strong8K expires
      **14 Jan 2027**, Dream4K **29 Mar 2027**, Trex **30 Mar 2027**, each "1 connection". (Strong8K's account page returned
      502 all of 30 Sept; if it still does, the card shows the error and the provider still works.)
- [ ] R7.5 Settings → **Backup links**: Trex shows mostly *auto* (raw-name / raw-epg) including most Australian channels
      (0178); Dream4K shows *auto* for UK TNT, NZ, AU Fox/beIN, and *pending* for its Australian free-to-air (messy names). Approve the AU sport and free-to-air you care about ("Approve all pending in <category>" is fine
      after a quick look). Link **ESPN (AU)** to Trex "AU| ESPN 1 HD" by hand with **Pick…**. Nothing looks wrong-country
      (no US ABC for ABC, no French beIN).

**Failover (Apple TV)**
- [ ] R7.6 Play a linked channel normally: it plays on Strong8K. Stream info (Labs) shows no provider line, or "Strong8K".
- [ ] R7.7 **Second device**: while the TV plays, play a different linked channel on the iPad or web. It plays (on a backup)
      with **no** "another device is watching" prompt. Status → Providers shows 1/1 on two providers.
- [ ] R7.8 **Primary down** (simulate): Settings → Sources → edit Strong8K and temporarily break its password (or wait for a
      real outage). Play a linked channel: it plays within ~20 s; stream info says "Provider: Trex (backup) · switched from
      primary". Play a second channel: after 2 channel failures Status shows Strong8K **down until hh:mm**, and later plays go
      straight to the backup. Put the password back; after the cooldown the next play is on Strong8K again.
- [ ] R7.9 **Mid-play**: with a channel playing on Strong8K, break Strong8K the same way (or restart the Strong8K line from
      its provider's panel if that exists). The TV rebuffers ~5–20 s and carries on on the backup.
- [ ] R7.10 An **unlinked** channel with Strong8K broken fails with the usual "The provider refused this channel" message.

**Recordings**
- [ ] R7.11 While the TV watches a channel on Strong8K, a recording due on another linked channel starts **without a prompt**
      (on a backup). Recordings shows it; Status shows it under the backup.
- [ ] R7.12 Everything busy (TV on Strong8K, iPad on Trex, Dream4K in use or disabled): a due recording prompts as before.
- [ ] R7.13 (Optional) Break Strong8K during a short recording that started on it: a "(part 2)" recording appears on a
      backup; part 1 is kept.

**Reminders**
- [ ] R7.14 Settings → Providers → Trex → set an **end date** 3 days from today. Reload the web app: an admin banner says
      "Trex expires … (in 3 days)". Close it; reload: gone until tomorrow. The Apple TV shows a short banner on launch (once
      today), not during playback. Clear the end date afterwards.

**With no backups (regression)** - [ ] R7.15 Disable both backups: everything plays, records and prompts exactly as before 0168.

## Round 6: the 28–29 Sept fix run (server 0166 · app 34; R6.3 fixed in 0167, R6.14 in app 35)

**Deploy first:** Unraid → Docker → PigTV → **Force Update**; `/api/version` should say **0166**. Then Settings → Sources →
**Sync now** on the EPG source (the sport fixtures refresh after a sync). Install **app build 34** on the Apple TV. The
recordings folder must be `/app/recordings/SERVER01_Video/Recordings` (the Docker mapping fixed on 28 Sept).
Anything that fails: send the step number, what you saw and roughly when.

**Recordings (0156–0160)**
- [ ] R6.1 Web **Status**: no recordings-folder warning; Disk → Recordings shows about 1.8 TB free of 11 TB.
- [ ] R6.2 Web **Recordings**: a **Recent problems** section lists the 28 Sept 06:00 NFL (Cardinals at 49ers) failure with
      its reason. The Apple TV's Recordings tab shows the same section (app 34).
- [ ] R6.3 Settings → Recording → type a made-up recordings folder and save: a red error, and the setting is not changed.
- [ ] R6.4 Schedule a short recording from the **Apple TV** for later tonight. Next morning it is in Recordings, and
      `docker logs PigTV --since 12h | grep "Schedule #"` shows one line per status change (scheduled → recording → completed).
- [ ] R6.5 **Prompt timeout:** watch channel A; schedule a recording on channel B starting in ~5 minutes; ignore the prompt.
      About 3 minutes after it is due, playback stops and the recording starts (log: `No answer from the viewer in 3 min`).
- [ ] R6.6 Repeat R6.5 but choose **Keep watching**: playback continues and the recording waits, as before.

**Sport (0159, 0161–0162, app 33)**
- [ ] R6.7 Web Status → **Sport fixtures**: NFL, AFL, NBA, F1, MLB (and Cricket when a series is on) each show a recent
      last fetch and a fixture count.
- [ ] R6.8 Web Settings → Sports preview: games now carry reasons starting **"ESPN:"** (live at the real start time, replay
      with "this airing is N h later"). **On now** on the Apple TV no longer lists replays of games already played.
- [ ] R6.9 AFLW still appears, judged by the old guide rules (known to be rougher; lowest priority).
- [ ] R6.10 Apple TV: an **upcoming** event with 2+ channels → select a non-recommended channel → **Record on …** /
      **Watch … when it starts** (no immediate tuning). Record it: the row then shows **Recording scheduled**.
- [ ] R6.11 The same through long-press → **Choose a channel** on the event card.
- [ ] R6.12 A **live** event still tunes any channel immediately.

**Guide (app 33)**
- [ ] R6.13 TV Guide → hold Right (or press Later repeatedly) into tomorrow and the day after: no wall, no blank grid, focus
      stays put.
- [ ] R6.14 **Jump to** a day several days ahead: the grid stays visible while it loads.
- [ ] R6.15 Everyday guide use unchanged: Now, Earlier/Later, categories, search, Favourites.

**Web cleanup (0163–0166)**
- [ ] R6.16 Web: Live TV plays, the Guide pages, Recordings plays a finished recording, every Settings tab opens and saves,
      Status loads. (Removed: the unused "Force Backend Proxy" toggle.)

**Still open from earlier rounds:** R4.7/R4.8
(iPad/iPhone), 1.16, R3.8, R2.5/R3.11. **Parked:** W6, the screens that need Back before anything can be selected (send the
screen when you find it).

**Branding (W11):** choose a direction on the concepts page (A Spotlight, B On Air, C Sunburst; mixing is fine). It is built
after your choice.

## Round 5 (server 0154 · app 32): passed on 28 Sept apart from the five bugs in the summary

Deploy the server (`/api/version` should say **0154**), then Settings → Sources → refresh the EPG source (**Sync now**, needed
for 0152's guide flags), and install **app build 32**.
- [ ] R5.1 **Sport live or replay:** On now shows games being played now; re-aired games (e.g. an MLB game shown at 7 am New York
      time, or a later airing of a game already shown) sit under **Replays**. Web → Settings → Sports shows the reason (`kindRule`).
- [ ] R5.2 **72 hours:** the Sport tab has **Tomorrow** and weekday sections (e.g. "Sunday"); later cards read "Sat 1:30 pm".
      Home's "Sport now & next" is unchanged.
- [ ] R5.3 **Top Shelf cards:** focus PigTV on the home screen. Favourites appear as sharp 16:9 cards (logo at its own size,
      programme title, LIVE and times, a thin pink progress bar), not stretched logos. Settings → Diagnostics shows the cards
      rendered.
- [ ] R5.4 **Tab switching:** switch quickly between the five tabs in Light, Dark and System appearance: no white or grey
      flash.
- [ ] R5.5 Still open: R4.7, R4.8 (iPad/iPhone), then the deferred items above when possible.

---

# Round 1 (server 0138 · app 22, 24 Sept)

**Server build 0138 · Apple app build 22.** Work through the parts in order. Part 1 has everything off, so it shows
whether the everyday app still works. Parts 2 and 3 turn the new things on. For anything that fails, send Claude the
step number, what you saw, and roughly when; step 0.7 has a log command.

---

## 0. Preparation (about 15 minutes)

1. Both repos' **Actions** tabs are green:
   - https://github.com/maroge1990/PigTV/actions (test → build-and-push)
   - https://github.com/maroge1990/PigTV-Swift/actions (CI)
2. **Back up the server's data folder first.** This update moves settings, sources and users from `db.json` into the
   database. Copy `/mnt/user/appdata/nodecast_tv/data` somewhere safe.
3. Deploy: Unraid → Docker → PigTV → **Force Update**. Then open `http://192.168.1.235:3000/api/version`. It should show
   **build 0138**.
4. Check the data folder now has `db.json.migrated` and no `db.json`. That shows the move happened.
5. Xcode: open `PigTV.xcodeproj`, then **Signing & Capabilities**. For **both** the `PigTV` and `PigTVTopShelf` targets,
   make sure **App Groups** includes `group.au.markrogers.PigTV`. Xcode may register it the first time.
6. Install on the Apple TV. Settings → Version should show `App: 1.0 (22)` and `build 0138`.
7. Useful at any time:
   `docker logs PigTV --since 30m 2>&1 | grep -E "resolve timing|\[Tuner|\[Recordings\]|Coordinator|Resolve failed|refused"`

---

## Part 1: the everyday app, with nothing switched on (about 30 minutes)

### Sign-in and data (the settings move)
- [ ] 1.1 The Apple TV is still signed in without pairing again. Web sign-in works with your usual password.
- [ ] 1.2 Web → Settings: your sources, settings and users are all still there.
- [ ] 1.3 Web → Settings → Devices lists the paired Apple TV.

### Apple TV: guide and channels
- [ ] 1.4 The guide loads. Channel **numbers** show on the tiles. **Logos** all appear; the first load may take a
      moment while the server caches them.
- [ ] 1.5 **Favourites** show the same channels on the TV and the web (Fox Footy 504 in both).
- [ ] 1.6 Leave the app and come back later: the guide appears straight away with no long reload.
- [ ] 1.7 An **amber dot** appears on any channel that has failed to start repeatedly. It may not appear until the server
      has seen some failures.

### Apple TV: playback
- [ ] 1.8 Choose a channel. While it starts you should see the **tuning card** (logo, now/next, progress), not a spinner.
- [ ] 1.9 Channels you've watched this week start noticeably faster, in about 4–5 s. See step 1.24 for the numbers.
- [ ] 1.10 Watch A, switch to B, press Select, then **Last channel** in the overlay. It should go back to A.
- [ ] 1.11 Up/Down side channel list, Left/Right ±15 s with the scrub bar, and Play/Pause all work as before.
- [ ] 1.12 **50 Hz**: on the Apple TV, Settings → Video and Audio → Match Content → **Match Frame Rate** on. Play a normal
      Australian channel. The TV should blank briefly and switch to 50 Hz. Does sport look smoother?
- [ ] 1.13 **HDR**: play Sky Sports Main Event UHD (950402) on the HDR TV. The TV should switch to HDR.
- [ ] 1.14 If a channel won't start, a **clear message** ("The provider refused this channel…") should appear within about
      2 s rather than 15.

### Apple TV: recordings (the new player)
- [ ] 1.15 Play a recording. The **PigTV-style player** should open, no longer Apple's. Check the scrub bar, ±15 s,
      Play/Pause, and that Back hides the controls and then closes.
- [ ] 1.16 On a recording with detected breaks: **Skip break** appears in a break, and the **Auto-skip breaks** toggle
      works.
- [ ] 1.17 Close and reopen the recording: it should resume where you left off. An HDR recording still switches the TV to
      HDR.

### Web app
- [ ] 1.18 The live sidebar and the guide load, with numbers and logos. Playing a channel works. A hard reload is no longer
      needed after a deploy.
- [ ] 1.19 **Movies and Series are gone** from the navigation. Nothing else looks broken.
- [ ] 1.20 Settings → **Channel numbers**: change one channel's number and save. The TV guide should show it after the
      guide next refreshes. Try a duplicate number; it should be refused with a message.
- [ ] 1.21 Settings → Sources → the category/channel picker lists everything, and hiding and showing still works.
- [ ] 1.22 Settings → **EPG matching**: pick a channel that shows "No programme information", then choose a candidate or
      search for one. Its programmes should appear in the guide on the TV and the web.
- [ ] 1.23 The **Status** page shows the current session while something plays, recent channel starts with timings, sync
      health, disk space and "Least reliable channels".

### Speed report (after a few days of normal use)
- [ ] 1.24 Run:
      `docker logs PigTV > /mnt/user/appdata/pigtv-after.log 2>&1 && docker exec -i PigTV node scripts/playback-report.js < /mnt/user/appdata/pigtv-after.log`
      and send it to Claude. The baseline was a median of 8.1 s, with 14 of 16 starts cold.

---

## Part 2: Labs on the Apple TV (Settings → Labs), about 20 minutes

### New guide
- [ ] 2.1 Turn on **New guide**. Swipe and click Right through several hours. Cells should slide in, never pop in, and
      the grid should move by whole half-hour columns.
- [ ] 2.2 Hold or repeat Left from hours ahead. It should come back to the live programme and then the channel tile.
- [ ] 2.3 Go Up/Down from a programme far to the right. It should keep the same time column and never shift sideways,
      including when scrolling past the bottom of the screen.
- [ ] 2.4 Up from the top row should land on **Now**. **Later** pressed several times should keep focus on Later. **Now**
      should jump back and put focus in the grid.
- [ ] 2.5 Select a live programme (it plays) and a future one (details open). Close each: focus should come back to where
      you were.
- [ ] 2.6 Long-press a programme to get the menu. Switch categories quickly, and check smoothness on the full guide in
      light and dark appearance.
- [ ] 2.7 Verdict: keep the new guide as the default? If yes, Claude removes the old one.

### Stream info
- [ ] 2.8 Turn on **Stream info overlay**. In the player's info overlay, the stats line should be correct against a known
      HEVC/HDR channel and a normal HD channel.

### HE-AAC passthrough
- [ ] 2.9 Turn on **HE-AAC passthrough**. Play **7 Mate Melbourne** and **7 Flix Sydney** for a few minutes each. Is the
      sound clear, with full treble and correct lip-sync? The server log line should now say "Audio: Copy".
- [ ] 2.10 Verdict: keep it on? If yes, Claude makes it the default for Apple devices.

---

## Part 3: the tuner (removed in 0204; history only)

**Turn it on:** Unraid → Docker → PigTV → Edit → add the variables below → Apply, which recreates the container.
- `PIGTV_TUNER` = `1`
- `PIGTV_TIMESHIFT_DIR` = `/app/data/timeshift`, which keeps the 3-hour pause window on local appdata instead of the
  network share for recordings.
- (Optional) `PIGTV_TIMESHIFT_HOURS` = `3`

- [ ] 3.1 `http://192.168.1.235:3000/api/info` shows `"timeshift":true` and `"recordingHls":true`.
- [ ] 3.2 **Two devices, one channel:** play the same channel on the Apple TV and the web. There should be no "another
      device is watching" prompt. Stopping one leaves the other playing. The log shows `shared tuner … (2 viewers)`.
- [ ] 3.3 **Pause and rewind:** after watching a channel for 30+ minutes, rewind well past 6 minutes. The readout should
      show "… behind live", and Go to live should return.
- [ ] 3.4 **Start over:** on a programme that began after you tuned in, open the info overlay and choose Start over. It
      should jump to the programme's beginning.
- [ ] 3.5 **Record the channel you're watching:** schedule a short programme on it. There should be no prompt, and
      watching should continue uninterrupted.
- [ ] 3.6 **Watch while it records:** Recordings → the in-progress recording → "Watch from start (still recording)". It
      should start at the beginning, show LIVE near its newest part, and the scrub bar should grow.
- [ ] 3.7 When it finishes it plays normally, with no "Preparing…" wait, and the web recordings page can download it.
- [ ] 3.8 The Status page's disk section shows timeshift use under `/app/data/timeshift`, and it shrinks back after
      playback stops.
- [ ] 3.9 Leave it on for a normal evening. Any stalls, freezes or odd prompts? The log trouble words are:
      `lost its tuner`, `Releasing stalled session`, `dropped the oldest`, `Join of #N failed`.
- **Turn it off (rollback):** remove `PIGTV_TUNER` and Apply. Recordings made with it on still play.

---

## Part 4: the rest of the Apple features (about 15 minutes)

- [ ] 4.1 **Top Shelf:** open the app once so favourites load. Then focus the PigTV icon on the home screen: favourites
      with numbers and what's on should show. Press Play on one; it should play, including after force-quitting the app.
- [ ] 4.2 **Siri (Apple TV and iPhone):** "Play Fox Footy on PigTV", and a number, for example "Play 503 on PigTV".
- [ ] 4.3 **iPhone:** the guide is an **On now** list. Tapping plays; ⓘ opens the schedule. In the player: **Last
      channel**, **Go to number** and **Channels**.
- [ ] 4.4 **iPad:** the grid guide and player work as before, plus Go to number.

---

## If something is badly wrong

- **Server:** point the container at the previous image tag (`ghcr.io/maroge1990/pigtv:sha-<short>` from the Actions
  run). **Past build 0135 you also need** to rename `data/db.json.migrated` back to `db.json`, or restore the backup from
  step 0.2. Changes made after the migration won't be in the old file.
- **Tuner:** remove `PIGTV_TUNER` (Part 3).
- **Apple TV:** turn the Labs switches back off; everything in Labs is off by default.

---

# Round 2: fixes and new features (server 0146 · app 28, 25 Sept)

Deploy the server (Force Update; `/api/version` should say **0146**), then install **app build 28** from Xcode.

### Fixes from round 1
- [ ] R2.1 **Channel start speed:** start 8–10 channels, then run the speed report (step 1.24). The new "client wait" column
      should be about 0.1–0.5 s, not about 3 s. 50 Hz switching still happens.
- [ ] R2.2 **Logos** on ABC (546), 7 Mate Melbourne (550) and 7two Sydney (551): no semi-transparent background, and
      transparency is kept. The first load re-fetches every logo once.
- [ ] R2.3 **NBC Sunday Night Football:** plays, perhaps after one brief automatic retry. The next time it starts straight away.
- [ ] R2.4 **Sky Sports Main Event on the non-HDR TV:** plays after one brief retry instead of showing error -11868.
- [ ] R2.5 **A file-based channel** (the 22 s one, "source ends (10 min)" in the log): the first picture is much faster.
- [ ] R2.6 **Status → Least reliable channels** now includes channels that stalled, with stalls and minutes watched.
- [ ] R2.7 **Tab bar**, light and dark: with focus on the bar, a solid pink pill with white text. With focus in the page, pink
      text on a faint pink pill. Readable everywhere.
- [ ] R2.8 **Top Shelf:** PigTV in the top row, open the app once, then go Home. If there's still only the pig, open Console on
      the Mac, select the Apple TV, filter `subsystem:au.markrogers.PigTV.TopShelf` and send Claude what it says.
- [ ] R2.9 **HE-AAC** is always on now (the Labs switch is gone). 7 Mate and 7 Flix still sound right.
- [ ] R2.10 **The old guide is gone** (Labs no longer has New guide). The guide behaves as it did in 2.1–2.6.

### New
- [ ] R2.11 **Home screen:** the app opens on Home.
      - "Continue watching" shows your last channel, with a colour wash from its logo, what's on and a progress bar.
        Down lands on **Watch**, which plays straight away. After watching something else and relaunching, it shows that
        channel.
      - The shelves are Recently watched, Favourites on now, Starting soon ("in 12 min", which opens the programme page),
        and Recordings (in progress first).
      - Tell Claude what you'd change: this is the first cut.
- [ ] R2.12 **Sport on now:** in the web app, **Settings → Manage Content**, pick the live source, then press the **Sport** button at the end of each sport category's row (it turns into "Sport ✓" and saves at once). The
      Home screen then shows a Sport on now row (live first).
- [ ] R2.13 **Programme page** (Details on a programme): the new hero layout.
      - **Record** → choose Start early / Finish late → **Schedule**. A "Recording scheduled" badge appears, and the guide
        cell shows it.
      - **Channel schedule** and **Favourite** work.
- [ ] R2.14 **The less-used screens:** Channel schedule, Channel details, Recording details (Play/Resume, Find breaks,
      Delete), Search, Jump to… (day and hour chips), Settings, and the Can't reach PigTV screen. They should match the
      main app in light and dark, with no grey backgrounds.
- [ ] R2.15 **Swift 6** is back on: nothing should crash. Live channels, switching, Last channel, a recording, Start over
      (if the tuner is on).

### Still to test later
1.13 (HDR on the HDR TV), 1.16 (a recording with breaks), Part 3 (tuner), 4.3/4.4 (iPhone/iPad), and Siri on iPad.

---

# Round 3: Sport, Top Shelf and iPad (server 0149 · app 30, 25 Sept)

Deploy the server (`/api/version` should say **0149**). Install **app build 30**; if Xcode shows odd errors, quit it and
reopen the project first.

### Sport setup (web)
- [ ] R3.1 Web → Settings → Sources → **Sync now** on the EPG source. Then **Status → EPG categories**: which categories does
      your guide use (e.g. "Sport", "American Football")? Send Claude a rough list; it decides how much the follow list
      needs to do.
- [ ] R3.2 Web → Settings → **Sports**: add the keywords you follow (NFL, AFL, F1, NRL, team names…) and save. The preview
      should list today's matching events, with the rule that matched and how many channels carry each one. Check that the
      same game on several channels shows once, and that nothing obviously wrong appears.

### Sport (Apple TV)
- [ ] R3.3 The tab bar is **Home · TV Guide · Sport · Recordings · Settings**. The Sport tab shows **On now**, **Starting
      soon** and **Later today**, with league chips that filter.
- [ ] R3.4 **Select** a live event: it plays the best channel (UHD/HD first). Channel up/down stays within that event's
      channels.
- [ ] R3.5 **Long-press** an event, then "Choose a channel": pick another channel, and it plays.
- [ ] R3.6 An upcoming event: **Record** creates the right recording in Recordings. **Watch when it starts** plays at
      kick-off, but only if the app stays open; its Cancel works.
- [ ] R3.7 Home shows **Sport now & next** (live, then within the hour), with a **See all** card at the end that opens the
      Sport tab.
- [ ] R3.8 With no keywords followed and no sport in the next 12 hours, the Sport tab shows a helpful empty state.

### Fixes
- [ ] R3.9 **Top Shelf:** PigTV in the top row, open the app once, then go Home. Your favourites should show with logos.
      Console (subsystem `au.markrogers.PigTV.TopShelf`) should show no "write: failed".
- [ ] R3.10 **Channel numbers:** none on any logo. Where a number still appears, it's small muted text after the name.
- [ ] R3.11 **R2.5 file-based channel:** find its name with
      `docker logs PigTV 2>&1 | grep -B8 "source ends" | grep "Starting session" | tail -3`, then
      `docker exec PigTV node scripts/stream-doctor.js list <id>`. It should now start quickly.

### iPad / iPhone (build 30)
- [ ] R3.12 Changing channel shows the **Tuning…** card.
- [ ] R3.13 The **Channels** button opens the new side panel (iPad) or bottom sheet (iPhone). Tapping a row switches
      channel.
- [ ] R3.14 Tapping the picture shows the **info overlay** (programme, progress, next; Favourite / Record / Last channel)
      together with Apple's controls. Check it doesn't overlap Apple's bar, in portrait and landscape.
- [ ] R3.15 iPad guide: it **follows your finger** when you swipe sideways and settles on a half hour. Tap a live programme
      (it plays), tap a future one (details open), and touch-and-hold for the menu.
- [ ] R3.16 iPad/iPhone Sport tab and Home row as on the TV. Siri on iPad: "Play Fox Footy on PigTV".

---

# Round 4: sport rework, Top Shelf, iPad player, speed (server 0151 · app 31, 25 Sept)

Deploy the server (`/api/version` should say **0151**) **and** install **app build 31** together; the sport replays need both.

### Sport
- [ ] R4.1 Web → Settings → **Sports** preview: **Events** and **Replays** open, **Shows** and **Placeholders** collapsed. The NBA
      PASS "NO EVENT" slots and "NFL Replay N" channels are under Placeholders. The same game under different titles is one
      row, listing the titles merged into it. F1 and Formula 1 appear as one league, "F1"; AFL and AFLW stay separate. You
      can remove the "F1" keyword.
- [ ] R4.2 Apple TV → **Sport**: On now / Starting soon / Later today hold only real games and sessions. A new **Replays**
      section (grey REPLAY badge) holds replays of identifiable games. League chips count and filter both.
- [ ] R4.3 Home's **Sport now & next** shows no replays.

### Apple TV
- [ ] R4.4 **Top Shelf:** open PigTV once, then go Home and focus PigTV in the top row. Your favourites should appear. Then
      Settings → **Diagnostics** should show "Top Shelf: Written …, N items · App Group OK" and "Top Shelf extension: Last
      asked …: returned N items". Note whether the logos load.
- [ ] R4.5 **Home:** "Continue watching" takes about a third of the screen, and two shelves fit below it, in dark and light.
- [ ] R4.6 **Tab switching** (Home ↔ Guide ↔ Sport ↔ Recordings ↔ Settings) no longer sticks on the tab you left.

### iPad / iPhone
- [ ] R4.7 The player shows **only PigTV's controls** (no Apple controls on top). Tap to show or hide; they hide after 4 s
      unless paused.
      - Top bar: **Channels** and **TV Guide** (TV Guide closes the player and opens the Guide).
      - Centre: −15 / play-pause / +15.
      - Bottom panel: programme info, a **draggable scrub bar**, Go to live, and Favourite / Record / Last channel / channel
        up-down / Go to number.
      - Controls are big enough and readable over bright and dark video.
- [ ] R4.8 **Siri** (iPad): open the **Shortcuts** app and search "PigTV"; you should see "Play channel" and "Open PigTV".
      Then "Hey Siri, open PigTV", then "Hey Siri, play Fox Footy on PigTV" (a favourite works best).

### Still open from earlier
R3.8 (sport empty state), R3.11 (file-based channel), 1.16 (recording with breaks), Part 3 (tuner).
