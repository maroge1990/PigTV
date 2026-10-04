# Blueprint history, builds 0106-0203 (archived 4 Oct 2026)

This is the build-by-build record that was section 6 of `blueprint.md` until the simplification
build (0204). It is kept verbatim for reference; `blueprint.md` describes the current state, and
its section 8 keeps one line per build.

## Roadmap and status (from the 23 Sept independent review)

IDs: **S** server · **W** web · **A** Apple · **X** both. Every item on the 23 Sept roadmap is built. Status words, used
exactly:
- **Verified**: Mark checked it on the TV, iPad/iPhone or web and it passed (test numbers from `docs/TEST-BLOCK.md`).
- **Shipped, awaiting a check**: pushed (and, for the server, deployable), not yet checked by Mark.
- **Deferred**: shipped but its check is postponed, with the reason.
- **Done**: needs no device check of its own (a clean-up covered by tests, in daily use since it was deployed).

**How it was tested (24–26 Sept).** Mark waived the per-phase gates (24 Sept): everything was built, then tested in four
rounds (`docs/TEST-BLOCK.md`: round 1 = server 0138 + app 22; round 2 = 0146 + 28; round 3 = 0149 + 30; round 4 = 0151 + 31).
**Rounds 1–4 passed on the TV and the web**, apart from the deferred items listed in §10 and at the top of TEST-BLOCK.md.
Round 5 (0152–0154 + app 32): Mark tested everything except the tuner on 28 Sept and reported five bugs, which became the
fix run below; everything else in it passed. Round 6 (0166 + app 34) covered the fix run.

### Phase 0: clean-up and correctness

| ID | Item | Status |
|---|---|---|
| X0.1 | Push-to-main workflow; CI publishes only after the tests pass; Node 24 locally | **Done** (0e68c03) |
| S0.1 | `stableId` on `/library/guide` and `/library/favourites` rows | **Verified** (0106; favourites agree on TV and web, 1.5) |
| S0.2 | Remove the dead second `GET /api/proxy/epg/:sourceId` handler | **Done** (0107; the route family went in 0122) |
| S0.3 | Gzip JSON responses, never media, HLS or ranged responses | **Done** (0108) |
| S0.4 | Image on Node 24 LTS; Comskip pinned; `npm ci --omit=dev`; CI matrix Node 22/24 | **Done** (0109, ac3f69d) |
| A0.1 | Delete unused Swift views and model code; drop `remux` from the allow-list | **Done** (app 17) |
| A0.2 | SwiftUI "Environment accessed outside a View" runtime warning | Parked: not reproducible outside an accessibility-heavy UI test; reopen if the guide misbehaves |
| A0.3 | Swift CI (GitHub Actions macOS: iOS build, tvOS tests) | **Done** (`78c7376`, pushed; the old token-scope block is gone) |

### Phase 1: faster

**Baseline before 0113–0116** (Mark's log, 23 Sept, builds ≤0112): 16 plays; first picture median **8.1 s**, p90 8.7, max 10.1;
cold 8.2 s (n=14), warm 4.8 s (n=2). After round 2 the report's client wait was checked (R2.1, passed).

| ID | Item | Status |
|---|---|---|
| S1.1 | Channel profiles: a repeat play skips ffprobe (keyed like the probe cache, not `stable_id`; ffmpeg's own probe unchanged on purpose) | **Verified** (0114; 1.9) |
| S1.2 | Frame-rate-aware master playlist for every session (`FRAME-RATE`, `VIDEO-RANGE`, no `CODECS`) | **Verified** (0115; 50 Hz 1.12, HDR 1.13) |
| S1.5 | Fail fast, say why, retry a refused connection (two retries since 0143) | **Verified** (0113, 0143; 1.14, R2.3) |
| S1.6 | HE-AAC passthrough (capability `heaac`) | **Verified** (0116; 2.9, R2.9); the Apple client always sends it |
| S1.3 | Guide API for scale: cursor paging, 500 a page, `guide/version` (not HTTP ETag; one category per request) | **Verified** (0111, 0140; 1.6) |
| S1.4 | Logo cache `/api/logo/{key}`; transparency kept (0141); full-size and 640 px variants (0154) | **Verified** through 0141 (1.4, R2.2); **0154 shipped, awaiting a check** (via the Top Shelf cards) |
| A1.1 | Guide refreshes cheaply (cursor paging, version check) | **Verified** (app 18; 1.6) |
| A1.2 | Channel card while tuning; Last channel | **Verified** (app 18–19; 1.8, 1.10) |
| A1.3 | Show the server's C-B resolve-failure messages; send `heaac` | **Verified** (0118 + app 19; 1.14; `heaac` always on since app 27) |
| — | Finite sources paced with an 8 s read burst (`-readrate_initial_burst`) | **Deferred** (0144; R2.5/R3.11: the file-based channel could not be found again; ffmpeg 6.1 behaviour unmeasured in production) |

### Phase 2: one lineup, one contract, a steady guide

| ID | Item | Status |
|---|---|---|
| X2.1 | Channel numbers as **labels** (the provider's order kept), admin renumbering in the web, shown muted after the name on Apple | **Verified** (0117, 0123, 0139; 1.4, 1.20, R3.10) |
| A2.1 | tvOS guide on UIKit (`UICollectionView`), then delete the SwiftUI grid | **Verified** (app 20–22; 2.1–2.7). The only guide since app 27 (Mark), iPad too since app 29 |
| W2.1 | Web onto `/api/library`; catalogue for the Sources picker; remove Xtream emulation, whole-EPG proxy, `cache.js`, Movies, Series, Pluto, plugins | **Verified** (0120–0122; 1.18, 1.19, 1.21) |
| W2.2 | Web Status page | **Verified** (0124; 1.23) |
| S2.1 | Opaque playback handle instead of the credentialed `?url=` (C-D) | **Done** (0119; same path, no client change; direct plays are rare on this provider) |

### Phase 3: the tuner model (behind `PIGTV_TUNER=1`, off by default)

| ID | Item | Status |
|---|---|---|
| T1 | A tuner layer; viewers of one channel share it | **Deferred** (0126): TEST-BLOCK Part 3 not run. Mark wants to test it later |
| T2 | Recordings take their segments from a tuner (HLS VOD and a joined MP4) | **Deferred** (0127, 0130, 0131, 0155): Part 3. The HE-AAC caveat is resolved (0155, §3) |
| T3 | Timeshift (3 h per tuner; `PIGTV_TIMESHIFT_DIR` for a local disk, 0132); start over (client side) | **Deferred** (0128, 0132): Part 3 (pause/rewind, start over) |
| T4 | Watch a recording while it records | **Deferred** (0129): Part 3 (instant recordings) |

### Phase 4: capabilities and polish

| ID | Item | Status |
|---|---|---|
| A4.1 | Top Shelf: favourites on now with a deep link to play | **Verified** on the TV in round 4 (R4.4, app 31). App **32**'s rendered 16:9 cards from 0154's full-size logos: **Verified** (round 5, 28 Sept) |
| A4.2 | Stream info overlay (Labs) and the same numbers in `play-end` | **Verified** (app 22; 2.8) |
| A4.3 | One player on the TV: recordings in the custom player | **Verified** (app 21; 1.15, 1.17). Skip break / Auto-skip on a recording with breaks: **Deferred** (1.16, no suitable recording yet) |
| A4.4 | iPhone On now list; iPad/iPhone player and guide; custom touch controls instead of AVKit's (app 31) | Shipped (apps 22, 29, 31), **awaiting a check**: R4.7 (Mark: "testing tomorrow") |
| A4.5 | Siri / App Intents; Swift 6 language mode | Swift 6: **Verified** (app 28; R2.15, Mark's decision: on). Siri on iPad/iPhone: **awaiting a check** (R4.8, app 31). Siri on Apple TV: **Deferred/parked** (tvOS Siri may not offer third-party App Shortcuts) |
| S4.1 | Channel health: failed starts and stalls; `health` on rows; Status page list; Apple amber dot | **Verified** (0133, 0142; 1.7, R2.6) |
| S4.4 | Sport categories (C-H) | **Done** (0146) as a signal for sport recognition; its Home row was superseded by C-I (R2.12 dropped) |
| S4.2 | EPG matching tool (web) | **Verified** (0134; 1.22) |
| S4.3 | `db.json` into SQLite; Express 5; `jsonwebtoken` without passport; split `routes/proxy.js` | **Verified** (0135–0137; 1.1–1.3). Splitting `routes/proxy.js`: not done (238 lines, one route; not needed) |

### Sport events (contract C-I, added 25 Sept)

| ID | Item | Status |
|---|---|---|
| S5.1 | EPG programme categories stored; admin `GET /api/sports/categories`; Status page panel | **Verified** (0147; R3.1) |
| S5.2 | Sport recognised per programme, grouped into events, best channel first; follow list; `GET /api/sports/events` | **Verified** (0148; R3.2–R3.7) |
| S5.3 | Web Settings → Sports: follow list and preview | **Verified** (0149; R3.2) |
| S5.4 | Kinds (event / replay / show / placeholder), league aliases, merging by meaning | **Verified** (0150; R4.1, R4.2) |
| S5.5 | Web preview grouped by kind | **Verified** (0151; R4.1) |
| S5.6 | Live or replay from XMLTV flags, the first airing within 36 h and per-league live hours | **Verified** as the fallback (round 5); replays still leaked into On now, which S5.8 fixes |
| S5.7 | Sport horizon 72 h (`hours` up to 72) | **Verified** (0153 + app 32; round 5) |
| S5.8 | ESPN fixtures as a first rule ahead of the heuristics (NFL, AFL, NBA, F1, MLB, IPL/BBL, international cricket via the scorepanel); coverage-gated so stale/out-of-window data never decides (0162); Status page "Sport fixtures" panel; `PIGTV_SPORT_FIXTURES` | **Verified** (0161–0162; R6.7, R6.8; AFLW on the heuristics, R6.9) |
| A5.1 | Apple Sport tab, Home "Sport now & next", Replays section | **Verified** (app 30–31; R3.3–R3.7, R4.2, R4.3). Empty state (R3.8): **Deferred** (needs a quiet sport day) |
| A5.2 | Sport tab over 72 h: Tomorrow and weekday sections | **Verified** (app 32; round 5) |
| A5.3 | Apple tab switching: no reloads (app 31); no white flash between tabs (app 32) | Reloads: **Verified** (R4.6). Flash fix: **Verified** (round 5) |

### Fix run (28–29 Sept: Mark's round 5 bugs, then a review of both repos)

Planned as work packages W1–W11 (sized for Sonnet 5 / Haiku 4.5 agents; the lead reviewed every diff before pushing).

| ID | Item | Status |
|---|---|---|
| W1 | Sport: an upcoming event's channels offer Record on / Watch when it starts, not an immediate tune (app 33) | **Verified** (R6.10–R6.12) |
| W2 | Every schedule status change logged; missed/failed schedules kept 7 days (`?include=recent`, `scheduleHistory`); web Recent problems; Status list (0156) | **Verified** (R6.2). The overnight log check R6.4: **to run** |
| W2b | Recordings folder health check, no folder created on an unmounted share, Settings refuses an unusable path (0157, 0160, 0167) | **Verified** R6.1. R6.3 failed on 0166 (a relative path saved) → fixed in **0167**, re-check pending |
| W3 | Apple Recordings: Recent problems section (app 34) | **Verified** (R6.2) |
| W4 | An unanswered recording prompt hands the stream to the recording after `recordingPromptTimeoutMin` (default 3) (0158) | **Shipped, awaiting a check** (R6.5, R6.6) |
| W5 | Guide extends forward in merged 24 h slices; failed pages retry; far jumps never blank (app 33) | **Verified** (R6.13, R6.15) |
| W5b | Jump to… and Search are full-screen pages on tvOS (app 35; R6.14 failed on app 34) | **Shipped** (Mark, 29 Sept: "looking good") |
| W6 | Some pages need Back before anything can be selected (tvOS focus) | **Parked** until Mark names a screen (likely stacked full-screen covers; Apple blueprint §8) |
| W7 | ESPN fixtures for live/replay (0161–0162) | **Verified** (S5.8 above) |
| W8 | Sport events built in the background, not on a request (0159) | **Done** (the build itself still runs on the event loop, at most once per 5 min; §10) |
| W9 | Apple sport refresh: off-main decode, no republish when unchanged, cached sections (app 34) | **Done** |
| W10 | Dead code: `xml2js`, `nodecast.patch`, number-ordering branches, Movies/Series player/settings leftovers, dead CSS (0163–0166) | **Shipped, awaiting a check** (R6.16) |
| W11 | Branding "Spotlight": layered tvOS icon, iOS icons, Top Shelf, launch screen, animated splash; the pig logo unchanged, optically centred (app 35) | **Shipped** (Mark, 29 Sept: "looking good"). The wordmark uses the system rounded font (Fredoka was not downloaded) |

### Multi-provider failover (30 Sept–1 Oct; `docs/MULTI-PROVIDER-BRIEF.md`, contracts C-J/C-K)

Backups are **list only** (`backup_channels`, never the guide), linked to the primary's visible channels
(`channel_links`: exact id → auto; channel number / same-region name → pending review). Failover order: the primary, its own
"(Backup)" sibling (single-channel failures only), then backups in **Settings → Providers order** (Mark, 30 Sept). Per-provider
connection pools; a breaker (2 channels / 5 min → down, 3→15 min cooldown, half-open); 10-min channel quarantine after a
mid-play death. Tuner path unchanged (primary only).

| WP | Item | Status |
|---|---|---|
| P1 | Provider fields, `player_api` account info (expiry, connections), reminders C-K (0168, 0169 EPGenius `dns` key) | **Shipped** |
| P2 | Backup sync into `backup_channels`, EPGenius id overlay by stream id (0170) | **Shipped** |
| P3 | Linker + `/api/links` (0171) | **Shipped** |
| P4 | Web Settings → Providers, Backup links (0172) | **Shipped** |
| P5 | Per-provider connection pools (0173) | **Shipped** |
| P6 | Resolve failover, breaker, quarantine, C-J (0174) | **Shipped** |
| P8 | Status Providers panel, admin renewal banner (0175, lead fixes 0176) | **Shipped** |
| P7 | Recordings: free provider at start, start failover, parts on a mid-recording death (0177) | **Shipped** |
| P9 | Raw-list bridge: every provider's raw Xtream rows (`provider_raw_channels`); linker rules `raw-name`/`raw-epg` above the name rules, symmetric in either role (0178) | **Shipped** |
| A1 | Apple build 36: provider in stream info, reminder banner, renewed recovery after 2 min | **Shipped** |
| — | Swift CI: tests signed ad hoc so the App Group exists (red since build 31) | **Fixed** (green 30 Sept) |

Everything above is tested against fakes only: **round 7** is the live check.

### Settings consolidation (2 Oct; 0182, pushed; not yet deployed)

Settings went from 14 tabs to 6: **Providers** (admin), **Channels** (Manage content, Channel numbers, EPG matching on a
strip under the tab), **Playback** (Player + Transcoding, the VAAPI workarounds and User-Agent under "Advanced"),
**Recording**, **Sports**, **System** (theme, devices, users). Debug is gone: the Status page's Live sessions has a Stop
button per stream.

- **Providers is the one place for content input.** One card per provider, every card the same form (name, Xtream login
  or M3U address, guide (EPG) address, channel ID list). The card order is the roles: first = primary (its channels and
  guide are shown), the rest = backups in failover order. `PUT /api/sources/order { ids }` saves it in one go and syncs the
  providers whose role changed; moving a card to the top asks first. A provider added after the first is a backup at the
  end; deleting the primary promotes the first backup. Backup links opens from a backup's card ("Review links").
- **The guide belongs to the provider** (`epgUrl` on the source). Only the primary's is synced, stored under the
  provider's own id (`syncProviderGuide`; an Xtream login with no address uses its own XMLTV); a provider that becomes a
  backup has its guide rows dropped. The guide's sync state is the provider's `epg` row in `sync_status`.
- **Nothing is typed by hand that the account reports.** The manual connection limit and the purchase/term/end dates are
  removed: expiry and limit come from `player_api.php` alone (`providerAccounts`).
- **One-time move at startup** (`services/providerMigration.js`, meta `providers_consolidated`): strips the hand-typed
  fields, makes exactly one primary and numbers the backups, and turns the first enabled standalone EPG source into the
  primary's guide address (its programmes are moved, not re-downloaded). Other standalone EPG sources keep working and
  are listed under the cards until deleted.
- Removed settings: Stream Output Format (never read by the server) and the unused defaults `forceProxy`,
  `autoPlayNextEpisode`, `probeCacheTTL`, `seriesProbeCacheDays`. **Not done:** "Max concurrent recordings" is still a
  setting (deriving it from the provider pools needs a change in the recording engine); the Apple TV reminder text still
  says "update the dates in PigTV's web settings".

**0183 (2 Oct, pushed): an M3U backup covers the provider's whole list.** A backup added as an
EPGenius M3U used to offer only the channels EPGenius kept (Dream4K and Trex: no AU free-to-air), so those could never be
linked. `syncService.addUnlistedChannels` now reads the provider's own Xtream list with the login the playlist names and
appends the channels the playlist leaves out (raw name, category and guide id; address built from the login). The
playlist's rows are unchanged. No login, or the provider not answering: the playlist alone, as before.

**0184 (2 Oct, pushed): provider cards say more.** An M3U card shows whether a login was found in its playlist; a
backup card shows "Covers N of M primary channels" beside Review links; the overlay field is now "EPGenius playlist
(optional)" and only on Xtream cards (an M3U playlist is its own id list).

**0185 (2 Oct, pushed): more sport fixtures, "Premier League" is EPL, old grand prix no longer live.**
- ESPN fixtures (real kickoff times) now also for EPL, Championship, FA Cup, UEFA (Champions + Europa League, merged),
  La Liga, Bundesliga, Serie A, Ligue 1, MLS, A-League, NHL, WNBA, NBL, NRL and Super Rugby
  (`sportsFixtures.ESPN_LEAGUE_PATHS`; a league is fetched only when followed or named by a sport category).
  Not added: UFC, IndyCar, NASCAR, golf, tennis (ESPN lists them as events without two teams: needs its own matching);
  MotoGP, Supercars, netball (no ESPN feed).
- A title saying plain "Premier League" is EPL, unless it is another country's or another sport's (Indian, Scottish,
  Women's, darts...). One "EPL" keyword now covers both spellings.
- F1: an airing naming a grand prix ESPN has no session for, with no F1 session within 12 h either side, is a replay
  ("ESPN has no F1 session at this time"). Before, last weekend's race shown again midweek fell through to
  "first airing = live" (Mark: Azerbaijan GP in Live sport all week).
- Settings → Sports: leagues are picked from a list ("Add a league...", those with real fixture times first; `GET /api/sports/follow`
  now also returns `leagues`). The text box stays for other keywords.
- Teams can be followed: pick a league, then a team (`GET /api/sports/teams?league=`, ESPN's roster). Stored as the keyword
  `"NFL: Arizona Cardinals"`. It matches the full name anywhere, or the nickname/place ("Cardinals", "Arizona") only in a
  programme of that league; the team's league gets its fixtures fetched.

**0186 (2 Oct, pushed): only the English Premier League is EPL.** 0185 excluded a fixed list of other Premier Leagues,
so "Canadian Premier League Soccer" still came up as EPL. Now any word straight before "Premier League" that is not on a
short allow list (English, Live, Sky, Soccer...) makes it someone else's.

**0187 (2 Oct, pushed): the build badge is right again; the PigTV name shows on the light theme.** `server/version.js` was
not bumped in 0182–0186, so every one of them reported 0181 (test A1 failed on that). **Rule: every build bumps `BUILD` in
`server/version.js` in its own commit.** The navbar's "PigTV" text was hard-coded white.

**0188 (2 Oct, pushed): interruptions are counted.** `services/playbackInterruptions.js`: every stream lost mid-play
(ffmpeg exit or stall watchdog) is a row, closed by the same viewer's next successful resolve of that channel within 3 min
(time to recover, and on which provider). Status → **Interruptions** shows the last 7 days: count, per hour watched, typical
and worst recovery. This is the baseline for the in-stream recovery / standby work (`docs/STANDBY-BRIEF.md`).

**0189 (2 Oct, pushed; OFF by default): in-stream recovery and the hot standby** (`docs/STANDBY-BRIEF.md`,
`services/streamRelay.js`). `PIGTV_RELAY=1`: a relay keeps one HLS stream going across more than one ffmpeg ("legs"); when
the playing leg is lost the next provider is started and joined on after an `EXT-X-DISCONTINUITY`. `PIGTV_STANDBY=1` adds a
second copy of the channel on another provider's free connection, joined on after 10 s of silence. The coordinator treats a
standby as abandoned (a viewer or recording takes its connection unasked). With both unset nothing changes.
Checked with real ffmpeg on the MacBook (`node scripts/relay-rig.js [standby] [stall]`): cold switch ~10 s after the loss,
standby switch at once after the 10 s; an ffmpeg HLS reader and hls.js both read across the join without an error.
**Not checked: AVPlayer on the Apple TV / iPad, and real providers.** Found on the way: when a provider closes a stream
cleanly ffmpeg exits 0 and writes `#EXT-X-ENDLIST`, which without the relay tells the player the stream has ended.

**0190 (2 Oct, pushed): the Status page no longer keeps streams alive, and names them.** Status read each session with
`getSession()`, which counts as a client's access: with the page open (it refreshes every 5 s) no stream ever looked idle,
so an abandoned one was never reclaimed for another viewer or recording, nor swept. It now uses `peekSession()`. Live
sessions shows the channel name the resolve knew (a play on a backup read "unknown") and the provider beside it.

**0191 (3 Oct): reconnect timestamp loop, blank pictures, raw captures** (from Mark's channel diagnosis of Fox Footy 504
and 7 Mate Melbourne on Strong8K). Fox Footy: a raw capture (no ffmpeg) of 20 min had no timestamp jumps and a 2 ms A/V
start skew, and the server's arguments bench clean on it; but Strong8K drops connections at random **even with one idle
connection** (ETIMEDOUT 1045 s into a raw capture; PigTV plays lost it at ~2.5 and ~18 min). ffmpeg's in-place
`-reconnect` then got a response starting ~3.8 s back, and instead of rebasing once (the 7 channels' 38 s cut, §3) its
audio went into a loop: `timestamp discontinuity … -140478` on every packet, each moving the one per-input offset, 227 s
of drift in two minutes (the picture "moving back and forth in time"), then exit, cleanup and 404s.
`transcodeSession.noteStderrLine`: within 120 s of a `Will reconnect`, 25 timestamp warnings in 10 s end a live session
that has played as lost (`how: 'timestamps'`, a provider reason), like a stall: the relay restarts it behind a
discontinuity, otherwise the player re-resolves. A single rebase (checked with real ffmpeg: a cut plus a 3.8 s resend logs
2 lines) is left alone. 7mate: the provider sends black (`blackdetect` 0–120 s, 193 kbps at 1080p with audio; the probe
also sees a finite ~10 min file). `checkPicture`: once a live session has 20 s of segments, under 500 kbps (250 below 720p,
`PIGTV_BLANK_KBPS`) it is **blank**: logged, the channel quarantined on that provider without counting toward its breaker
(the next play tries another provider first), the play's health row failed with reason `blank`, Status → Least reliable
shows "Blank picture". The play goes on. `Stream ends prematurely` now counts as a provider reason for a lost session.
`stream-doctor capture` saves the provider's **raw bytes** (the ffmpeg capture smoothed the jumps away, which is why every
capture "classified EVEN") and says whether the connection held; `classify` adds per-stream jumps (a 33-bit wrap named as
normal), the A/V start skew and a blank-picture verdict.
**Recommended:** turn on `PIGTV_RELAY=1` (TEST-BLOCK L): with it a drop or a timestamp loop is a short freeze inside the
same stream instead of the player's error-and-restart. Not checked on the Apple TV yet.

**0192 (3 Oct): recording codec probe reads ffprobe JSON (audit R02).** `probeCodecs` asked for
`stream=codec_type,codec_name` as CSV and read each line as `[type, name]`, but ffprobe prints `codec_name,codec_type`, so
both codecs were always null: an HEVC recording's MP4 was never tagged `hvc1` (AVPlayer refuses it; the 0062 check passed on 2 Oct,
presumably on a recording that never went through this remux, e.g. a compressed one, which is tagged by the encoder) and MP2 audio was copied into the MP4 instead of
re-encoded. Now `-of json`, read by field name, with a 30 s deadline and a 1 MB output cap. `test/recording-codec-probe.test.js`
generates real H.264/AAC, HEVC and MP2 files and remuxes one; CI now installs ffmpeg so these run there too.

**0193 (3 Oct): recordings are prepared before the first Play, the MP4 replaces the .mkv, and compression can no
longer delete an original it could not verify (audit R06, R08).** Every finished recording is queued (`native_status`:
pending → preparing → ready | failed, with `native_error` and `native_attempts`, max 3) and remuxed for the Apple client
in the background, one at a time, newest first; while a recording is capturing only ones finished in the last day are
prepared. Play still prepares on demand and shares the same remux. Once the MP4 checks out against the original (length
within 5 %, a video track, audio if the original had it) it is renamed to `<name>.mp4`, the row moves to it, and the
`.mkv` is deleted. An original whose length cannot be read (an interrupted capture) is kept; the recording still plays.
At startup the library recorded before 0193 is queued the same way, interrupted jobs are requeued, and an interrupted
compression's output is removed. Capture is unchanged (MKV: it survives being cut off). Compression now encodes to
`.compressed.mp4.partial`, publishes only a verified result (both lengths must be known; an unreadable length used to
pass and, with "keep original" off, deleted the original), moves the row before deleting the original, and playback
only serves a compressed file once compression says `done`. ffmpeg remuxes and encodes are killed if their output stops
growing for 10 min. `PIGTV_NATIVE_PREPARE=0` turns the queue off; `PIGTV_KEEP_MKV=1` prepares but keeps originals.
**Disk:** each recording briefly needs room for a second copy while it is prepared; preparation waits when there isn't.
Tests `test/recording-prepare.test.js`.

**0194 (3 Oct): the recordings routes read files asynchronously (audit R09, part).** Recordings live on the SMB share,
and `routes/recordings.js` stat'ed, checked and read them synchronously inside requests, so a slow share stalled the
whole event loop, live segments for other viewers included. Now `fs.promises` throughout; files are piped with
`stream/promises` `pipeline`, so a read error reaches the route's error answer and the file is always closed. A player
abandoning a range request (every seek) is not logged. Tests `test/recordings-async-io.test.js`.

**0195 (3 Oct): sport events are built on a worker thread (audit R09).** `buildEvents()` (0.3–1.1 s on 1,000
channels) ran on `setImmediate` since 0159, which is still the event loop that serves live segments, so every 5-minute
rebuild, EPG sync and follow change stalled playback. It now runs on one long-lived `worker_threads` worker
(`services/sportsEventsWorker.js`) with its own **read-only** SQLite connection (WAL; `db/sqlite.js` opens read-only for
it, no schema or pragma writes); results come back in slices of 250 so no single receive is a large clone.
`decorateChannels` (it writes the logo cache) stays on the main thread, 100 channels per slice. Once anything is
cached a request never builds; only the very first awaits one. At most one build runs and one waits (latest key wins).
`PIGTV_SPORT_WORKER=0`, or a worker that will not start, builds inline as before, with a warning. Status reports
`sportEvents` (build ms, worst loop delay during the build, revision, stale age). Measured max loop delay during a
1,000-channel build: ~35 ms (was the whole build). **Not changed:** each `/events` request still filters and sorts
the cached events on the main thread (~100–200 ms measured under heavy load) — a candidate for next time.
Tests `test/sports-worker.test.js`.

**0196 (4 Oct): media and session control always need a signed-in user; the proxy takes handles only (audit R01).**
An audit fetched a recording and proxied the server's own loopback `/api/version` with no token: `requireStreamAuth`
was off by default, a settings read failure also meant "off", and `/api/proxy/stream?url=` (the 0119 rollback) fetched
anything. Mark (3 Oct): nothing but PigTV's own players uses these streams. Now: `streamAuth` is always enforced on
`/api/proxy`, `/api/transcode`, the recordings' media routes and `/api/playback` (resolve, release, and the recording
prompt's `/conflict` and `/conflict/decline`), and validates like the bearer path (`userFromToken`: JWT, user still
exists, role from the store, device not revoked); the setting is gone. `?url=` → 400 and `PIGTV_PLAYBACK_HANDLES` is
removed. `GET /api/transcode/sessions` and `DELETE /api/transcode/sessions/all` (it kills every stream and tuner) are
admin-only. Every response carries `Referrer-Policy: no-referrer`. Both clients already put `?token=` on every media
URL. **Rollout:** an old client build or a script without a token now gets 401; deleting a user cuts off their devices
at once. Tests `test/stream-auth-enforced.test.js`.

**0197 (4 Oct): in-stream recovery and the hot standby are Settings switches; Status shows what they do (audit R12).**
Settings → Transcoding → "Stream recovery (experimental)": **In-stream recovery** (`relayEnabled`) and **Hot standby**
(`standbyEnabled`, greyed out until recovery is on), both off by default; a change applies to plays started afterwards, a
running relay keeps its mode. `PIGTV_RELAY` / `PIGTV_STANDBY` are gone (Mark never set them); `PIGTV_RELAY_SWITCH_MS`
stays. Status → Live sessions has a relay table: per stream its state (`starting`, `playing`, `switching`,
`standby-starting`, `standby-ready`, `promoted`, `reclaimed`, `failed`), switches and last reason (`lost`, `stalled`,
`timestamps`, `blank`, `standby-incompatible`, `standby-reclaimed`, `no-candidate`, `incompatible`); reasons also go to
Recent plays and the Interruptions rows (`reason` column). `joinable()` now also requires the same video codec, frame
size, frame rate (1 %), audio codec and channel count (an unknown field counts as compatible, logged once).

**0198 (4 Oct): provider connections are leased before the probe; the likely next channel can be warmed (audit R11).**
Admission used to count only sessions that already existed, so two contenders deciding during each other's probe could
both be admitted (one connection too many; the standby's `hasFreeConnection()` + await had the same race). Now every
admission takes a **lease** synchronously with its decision (`streamCoordinator`: purpose viewer / recording / standby /
warm), counted in the pool until its session or recording exists (then that is counted instead), released on every
failure path, expiring after 60 s unbound with a warning. Recordings bind theirs to the recording and give it up when
ffmpeg exits; a viewer that forces past an unstarted recording takes its lease and that start waits for the next tick.
`tryReserveFree()` is how a standby or warm start takes a connection only when one is free. **Warming** (Settings →
Transcoding → **Warm the next channel**, `warmNextChannel`, off by default): `POST /api/playback/warm` (same body as
resolve; 200 `{ warm, ttlSec: 90, refreshed }` or 204 when off / nothing free / tuner) starts the channel on a spare
connection, never reclaiming or prompting; the same owner's resolve of that channel adopts it (`warm: true` in the
decision). A warm session is the first thing any viewer or recording reclaims, silently; 90 s TTL. `/api/info`
`features.warming` + `warmingEnabled`; Status `warming { enabled, active, hits, misses, expired, reclaimed }`.

**0199 (4 Oct): the image runs as PUID/PGID (99:100 by default), is built in stages, and reports its health (audit R17).**
`docker/entrypoint.sh` (as root only long enough to): own the container's own folders (`/app/data`, `/app/transcode-cache`,
`/app/config`) as PUID:PGID when they aren't already, add the user to the `/dev/dri` render/card groups so VAAPI keeps
working, check — never chown — that the recordings folder is writable (one clear WARNING naming the fix if not), then
`exec setpriv` to drop to that user, so SIGTERM still reaches node. `PUID=0` runs as root (escape hatch, logged).
Builder stage compiles better-sqlite3 and Comskip; the runtime stage has no compilers. `chmod 777` gone; `.dockerignore`
(no host `node_modules`, data, `.env`). `GET /api/health` (unauthenticated: `{ ok, db, recordingsFolder }` from the cached
folder state, never touching the share) + `HEALTHCHECK`. `engines` `>=22`. `scripts/backup-db.sh` (online SQLite backup,
newest 7 kept) and restore in **`docs/OPERATIONS.md`**, with the first-deploy checklist. CI: `docker-smoke.yml` builds
and starts the image on branches without publishing (checked: 99:100, own folders owned, recordings writable, ffmpeg,
Comskip's libraries, clean SIGTERM).

**0200 (4 Oct): the web nav is labelled for everyone; Status pauses when hidden and shows the background work (audit R16).**
Nav links have `aria-label`/`title`, `aria-current="page"` on the active one, a `:focus-visible` ring, and the mobile
menu toggle `aria-expanded`; icon-only buttons (search clear, modal close, sidebar, player controls) are named. Status
stops polling while the tab is hidden (refreshes on return), redraws only the sections whose data changed, and keeps an
open `<details>` and the scroll position. New: **Server load and background work** — event-loop delay (p50/p99/max, since
start and last minute, `services/loopDelay.js`), the recording preparation queue (0193: counts by `native_status`, the
one being prepared, last error) and the sport builds (0195); Providers gains **In use for** (viewer / recording /
standby / warm, with channel and age). `/api/status` adds `preparation`, `loopDelay`, `providers[].uses`.

**0201 (4 Oct): sport event requests are served from a per-minute cache.** After 0195 the build was off the loop, but each
`/api/sports/events` still filtered, ordered and serialised everything on it (~20 ms on 1,000 channels, more under
load). Now each event's JSON is written once per build (in slices that yield), a request joins the window's strings
(user favourites re-sort only the events that contain them), and the finished buffer is cached per (build revision,
hours, include, favourites, minute) with a weak ETag (304 on `If-None-Match`) and a ready gzip. Same bytes as before;
~0.05 ms for a repeat in the same minute, ~7 ms for the first. `now` in the answer is the start of the minute (the app
floors to the minute too). At most 12 entries / 48 MB. `.gitignore`: `node_modules` without the slash, so a symlink of
that name can't be committed.

**0202 (4 Oct): a hot standby may take a warm channel's connection.** With both switched on, warming (0198) and the
standby (0197) want the same spare backup connection; the standby only ever took a free one, so a warm guess at the next
channel could stop the playing channel from being protected. Continuity comes first: `reserveTakingWarm()` lets a
standby (only) take a connection a warm channel holds — lease taken in the same step, the warm stream released before
the standby's probe starts, so the provider never sees both. The relay tries a free connection anywhere first.

**0203 (4 Oct): recordings are captured as MPEG-TS, their audio is re-encoded when prepared, and a prepared file must
decode before its original is deleted.** Mark's recording #5 (Nick Toons, HE-AAC): after preparation the MP4 played to
~3:00 on the Apple TV with no sound (the web, more tolerant, had sound), Comskip failed at 41 %, and the .mkv had been
deleted — the 0193 check (length, tracks) never decoded anything. Cause, reproduced: the channel changes its audio
mid-programme (around an ad break); **Matroska keeps one audio config for the whole file**, from the first frame, so
everything after the change decodes wrongly (298 errors and silence in a 12 s reproduction), and the copied MP4 inherits
it. **MPEG-TS keeps each ADTS frame's own header**: captures are now `.ts` (`-f mpegts`; just as safe when cut off).
Preparation copies AC-3/E-AC-3 only and re-encodes every other audio (all AAC flavours, MP2) to AAC-LC 48 kHz, channels
kept up to 5.1, with `aresample=async=1`. Before an original is deleted the prepared file's audio is fully decoded and
must have no more than 5 errors beyond the original's (`native_version` 2; unknown → original kept). Preparations made
before 0203 whose `.mkv` still exists are made again at startup. Older `.mkv` captures keep working (their damage, if
any, is in the file). Tests: a real-ffmpeg reproduction (changing audio survives TS + preparation; the Matroska control
loses it). Also: turning In-stream recovery off now unticks and saves Hot standby off.

