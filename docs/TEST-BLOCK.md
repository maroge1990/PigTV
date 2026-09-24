# Test block: everything built on 23–24 September 2026

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

## Part 3: the tuner (server switch), about 30 minutes plus a recording

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
