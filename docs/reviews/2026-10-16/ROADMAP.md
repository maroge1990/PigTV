# PigTV development roadmap: review findings, reported bugs and Plan B

16 October 2026. Server/web `3449719` (0207), Swift `63f9a43`, Pig-Branding `b40c958`. Planning only: no code changed,
nothing committed, the deployed server was not contacted.

Inputs: the [15 Oct review](../2026-10-15/REVIEW.md) (F1–F8 and its Dispatcharr validation), Mark's eight bug reports of
16 Oct, and [`DISPATCHARR-REVIEW.md`](../../DISPATCHARR-REVIEW.md) with blueprint §4 (Plan B).

---

## 1. Assessment of the 15 Oct review

**It is accurate.** I re-checked it against the code instead of taking it on trust:

| Claim | Check | Result |
|---|---|---|
| F1 guide out-of-order, F2 Home stuck loading, F3 Back pushes history | `node docs/reviews/2026-10-15/web-reproductions.cjs` | All three reproduce |
| F5 Swift guide watches only `favourites.count` | `GuideView.swift:245` | Confirmed |
| F6 tvOS Recordings refreshes only on appearance | `RecordingsView.swift:103–110` | Confirmed |
| R4 needs the hard-stop timer moved, not just `program_end` | `recordingEngine.js:702–708` (one-shot `setTimeout` from the original end) | Confirmed |
| R12 should extend the existing backup | `scripts/backup-db.js` already uses SQLite online backup, keeps 7 | Confirmed |
| Test-port race | `test/helpers/server.js` opens and closes a socket, then starts the server on that port | Confirmed |

**What it got right:** the priorities (navigation and freshness before architecture), "one owner per request/timer/derived
list" as the simplification, and the six corrections to Plan B (§3 below adopts all of them).

**What it missed**, because it checked artwork *provenance* (hashes match the kit) rather than *appearance*:

- **Bug 3:** the tvOS icon matches the kit exactly, and the kit's own asset is too small (§2). Byte equality can't catch a
  bad master.
- **Bug 4:** "branding is consistent" applies to artwork and colours; the page *headers* are built five different ways.
- **Bug 2:** a second invalidation gap in the same file as F5 (`GuideView.swift`), and a worse one: the iPhone category
  filter never refreshes at all.

**Housekeeping:** `blueprint.md` has an uncommitted state-line edit pointing at the review, and `docs/reviews/` is
untracked. Commit them together as a docs-only commit (with this file) so the links work on GitHub.

---

## 2. The eight reported bugs

Confidence: **Found** = root cause seen in code · **Likely** = strong hypothesis, needs one confirmation · **Needs data** =
can't fix without a capture or sample from Mark.

| # | Bug | Platform | Root cause | Confidence | Fix | Size |
|---|---|---|---|---|---|---|
| 1 | Commercial break times shown on the recording page | all | Swift `RecordingDetails` has a "Commercial breaks" section listing every break's times (`RecordingsView.swift:595–608`, `BreakList`). The web shows status chips ("Breaks marked", "Finding breaks…") in the row (`RecordingsPage.js:157–159`) | Found | Remove the section and the list from the details page; keep "Find breaks", the player's Skip button, auto-skip and the scrub-bar markers. Web: keep only the failure chip. *Decision for Mark: keep the web scrub-bar markers (they're how you judge detection)?* | S |
| 2 | iPhone guide doesn't refresh on category change | iPhone | `.onChange(of: filter)` is attached to `gridView()` only (`GuideView.swift:351`). iPhone (compact width) shows `onNowList` instead, so the change is never observed; returning from Recordings runs `onAppear → refreshRows()`, which is why that "works" | Found | Move the `filter` observer to the shared body so both layouts use it. Fix F5 in the same change (observe the favourite identity set, not the count) | S |
| 3 | tvOS app icon logo and text very small | tvOS | The front layer (`App Icon.imagestack/Front`, 400×240 @1x) puts the pig + "PigTV" lockup in about 36 % of the width and 17 % of the height. It's the kit's asset (`Pig-Branding/tools/finish-platform-assets.py`), copied unchanged | Found | Fix in **Pig-Branding**: scale the lockup to roughly 75–80 % of the width within Apple's safe area (or mark only, larger); regenerate front layers for App Icon and App Store sizes; check parallax and the Top Shelf images; then copy into Swift. Bump kit version | S |
| 4 | Header logo differs between menus | iPhone, tvOS | Five header implementations: Home/Guide/Sport use pig 58×48 + `GuideTypography.title`; tvOS Settings uses pig + `.system(34, bold)`; Recordings and iOS Settings use a system `navigationTitle` with no pig; the iPhone guide has a 36×30 pig or none (slim bar); detail pages use `DetailType.pageTitle` | Found | One `PigPageHeader(title:, subtitle:, trailing:)` with a tvOS size and an iOS size, used by every tab and `DetailPage`. Add a contract test that no tab root uses `navigationTitle` alone | S–M |
| 5 | Cricket sometimes not linked (AUS v SA Test) | all | Two gaps in code, unproven for this match: (a) Sport groups airings by the **exact** normalised title (`sportsEvents.normaliseTitle`), so "Australia v South Africa – 1st Test Day 2" and "Live Test Cricket: Aus v SA" become separate events; (b) international series come only from ESPN's `scorepanel`, which lists *today's active* series, so a Test on a rest day or starting later in the 72 h window may get no fixture | Needs data | Mark: the guide titles and channels for that Test (Settings → Sports export, or the programme names). Add them to `test/fixtures/sports-export.json` with the expected grouping first (blueprint §6 rule), then fix grouping (team-pair + day aware) and/or series discovery | S–M |
| 6 | Un-closable "(i) cancelled" alert on every screen | tvOS | `AppModel.error` takes raw `error.localizedDescription` in several catches (`loadCategories`, `restore`, `logout`); a cancelled request's `URLError.cancelled` text is literally "cancelled". The root `.alert` sits on `ContentView` beneath the full-screen player/detail covers, so on tvOS focus can't reach its OK button | Likely | One `userMessage(for:)` that returns nil for `CancellationError` and `URLError.cancelled` (the guide and Sport already special-case `CancellationError`); use it in every catch. Present app-level errors as a dismissible banner, not an alert under a cover. Unit-test the filter | S |
| 7 | No Docker app icon | server | No icon anywhere: no Unraid template `<Icon>`, no `net.unraid.docker.icon` label in the `Dockerfile` | Found | **Now:** Unraid → Docker → PigTV → Edit → Icon URL: `https://raw.githubusercontent.com/maroge1990/PigTV/main/public/img/brand/web-dark-512.png` (checked: HTTP 200, 512×512 pig on the dark tile). **Next build:** `LABEL net.unraid.docker.icon=` and `net.unraid.docker.webui=http://[IP]:[PORT:3000]/` in the `Dockerfile` | XS |
| 8 | iPhone hangs on "Tuning" when a recording holds the provider | iPhone | The client handles a 409 `recording-in-progress` correctly on every platform (`APIClient.swift:175`, `PlayerScreen`). So the server most likely **admitted** the viewer: `recordingsInPool` counts a recording only when its provider's pool key matches (`streamCoordinator.js:497`). If the recording runs on a backup provider, after failover, or its provider is recorded differently, the check misses it, the provider refuses the second connection, and resolve waits for the probe timeout | Likely | **Capture first:** Mark reproduces (record on provider X, tune the same provider from the iPhone) and sends the server log lines `[Coordinator]`/`[Playback]` from that minute. Fix the pool attribution with a test that fails today. Safety net in Swift regardless: a tuning card that, after ~20 s, says why it's waiting and offers Back | S–M |

---

## 3. Dispatcharr scope (Plan B)

**The decision stands:** standalone, adopt the ideas natively (13 Oct). `DISPATCHARR-REVIEW.md` §1 still recommends the
Plan A spike; add a "Superseded by Plan B, 13 Oct" line at its top so it can't be followed by mistake.

**Scope assessment, per item:**

| Item | Value to Mark | Risk | Verdict |
|---|---|---|---|
| R12 backups | High (protects schedules, links, mappings) | Very low | **Do first.** Extend `backup-db.js`: nightly + before migrations when the build changes; keep 7 (or decide 14); atomic completion; restore test. Not a disk-loss backup: say so on Status |
| R4 end follows the guide | High for sport | Low–medium | **Do early**, with the review's correction: reschedule the hard-stop timer, cap the extension (+3 h), handle restart/manual stop/adjacent programmes, keep manual padding |
| R11 webhook + live ffmpeg stats | Medium | Low | Do in the same wave. Telemetry only; it must not drive recovery |
| `tv_archive` and audio-track checks | Unknown until checked | None | Use existing fixtures/samples first; new captures need Mark's approval |
| R8 ingest filters | Medium (1,000 of 18,000 channels) | Medium (identity, links) | Pilot whole-group "never import", reversible; measure sync time and DB size before and after |
| R5 recording rules | High ("record my teams") | Medium | After R4. Built on Sport's event identity, de-duplicated; one-offs unchanged; feature flag + contract |
| R6 artwork | Low–medium | Low | With R5 (same contract change) |
| R9 event-channel guide | Medium–high for Sport | Medium (time zones, DST) | After the cricket fix; fixtures for timezone/DST and real-EPG precedence |
| R10 EPG tune-ups | Low–medium | Low | Preview, review list and undo; never overwrite manual mappings |
| R3 segmented recordings | Medium | Medium–high | **Needs Mark's decision** (skipped as R13 on 4 Oct). Not scheduled until he says so |
| R2 shared ingest (B3) | Highest structural value: watch + record on one connection, fixes the root of bug 8 and the 38 s provider cut | High (largest playback change since 0102) | Last. Needs a written design (identity, byte-capped buffers, slow consumers, late joins, failover compatibility) and the full capture/bench pass on all five samples |
| R7 speed-based recovery | Medium | Medium | Inside B3 only, after reading real `speed=` values from logs |
| B4 retire old paths | Removes ~800–1,000 lines | High if premature | Gate each deletion on evidence (no slot leaks, arbitration, HDR/50 Hz/HE-AAC, rollback switch), not on "a week elapsed" |

**Overall:** B1 is safe and independent of everything in §2, B5's R8 can move earlier, B2 hinges on one decision, and
B3/B4 are a separate project that shouldn't start until the usability waves are verified on devices.

---

## 4. The roadmap

Each wave ends with the repo gates (`npm test`, `verify-build.sh`; Swift `Tools/test.sh` tiers) and Mark's device checks.
Nothing is *Verified* until he reports back. Build numbers continue from server **0208**.

### Wave 0 · today, no build

- Mark: set the Unraid icon URL (bug 7, link above).
- Mark: send the AUS v SA guide titles (bug 5) and, when it next happens, the server log for the iPhone tuning hang (bug 8).
- Docs commit: the 15 Oct review, this roadmap, the blueprint state line, and the "superseded" note in
  `DISPATCHARR-REVIEW.md` §1.
- Decisions for Mark: web break markers (bug 1); backup retention 7 vs 14. (R3: approved 16 Oct; tvOS icon: option B,
  done in kit 1.7.1 / Swift build 43.)

### Wave 1 · reported bugs and the test gate (about 1 week)

| Repo | Work | Bugs/findings |
|---|---|---|
| server | Test-harness port reliability first (flaky gates block every push) | review §"test harness" |
| server | Docker labels; recording-pool attribution fix once the log confirms it (+ test that fails today) | 7, 8 |
| server/web | F3 history modes (`push`/`replace`/`none`); F1 guide load coordinator; F2 Home render generation; web break chips | F1–F3, 1 |
| Swift | Guide: shared `filter` observer + favourite identity revision | 2, F5 |
| Swift | `PigPageHeader` everywhere; remove the recording-details break list; `userMessage(for:)` + banner for app errors; tuning-card "still waiting" state | 4, 1, 6, 8 |
| Swift | tvOS Recordings visible-only refresh (faster while a recording is pending/active) | F6 |
| Pig-Branding → Swift | Larger tvOS icon front layer, regenerated and copied; kit version bump | 3 |

Exit: each fix has a test that fails on the old code; Mark checks on iPhone (category switching, headers, tuning while
recording), tvOS (icon on the Home screen, headers, Recordings left open across a schedule change) and the web.

**Wave 1 progress (16 Oct, committed locally, not pushed):** server `3ed3254` test-port retry, **0208** Unraid icon/WebUI
labels, **0209** web F1–F3; Swift: iPhone category refresh + F5, one `PigPageHeader` on every tab (tvOS Home included,
hero 320 → 270 pt), break list removed from recording details, cancellations never shown as errors (and the app alert
waits while the player is up), a "taking longer than usual" line on the tuning card after 20 s, F6 visible-only Recordings
refresh. Icon: a size study in `Pig-Branding/tmp/tvos-icon-study/sheet.png` waits for Mark's pick. Still open: bug 8's
server fix (needs the log), bug 5 (needs the titles). Web break chips were left as they are: they show status, not times.

### Wave 2 · cricket, keyboard access, less idle work (about 1 week)

- Cricket grouping and series discovery from Mark's sample (bug 5), sample first in `sports-export.json`.
- F4 web keyboard semantics (native buttons, `aria-expanded`, focus kept through refresh).
- F7 one visibility-aware guide owner using the guide-version endpoint; drop the duplicate minute timer.
- F8 favourites colour (accent, not danger), Australian-English copy on the web, semantic kit-token test.
- Baseline measurements before any further optimisation (review's list: tvOS tab-switch p50/p95, first usable guide,
  web request counts, server event-loop delay during sync).

**Wave 2 progress (16 Oct, committed locally):** **0210** F4 keyboard access (focus restoration after a redraw still
open), **0211** F7 visible-only, version-checked guide refresh, **0212** F8 accent favourites and Australian-English copy
(kit-token equivalence test still open). Swift build **42** carries Wave 1.

Cricket (bug 5), probed with synthetic titles in `sportsEvents.eventsFromProgrammes` (not yet Mark's real ones):
grouping is **not** the problem: team-merge links "1st Test, Day 1", "Live Test Cricket: …" and "AUS v SA" across
channels. Three real gaps instead, any of which reads as "not linked":
1. **Day 2+ of a Test is classed a replay** of Day 1 when ESPN has no fixture for the series (the multi-day rule only
   applies with a fixture, and `scorepanel` lists only today's active series).
2. **An airing with no Cricket category on a non-sport channel is not recognised at all** (bare "1st Test" is
   deliberately not a keyword), so that channel is missing from the event.
3. **"Proteas" is not merged with "South Africa"** (no nickname alias).
Next step: Mark's real titles into `test/fixtures/sports-export.json` with the expected kinds, then fix whichever of the
three they show.

### Wave 3 · Plan B1 quick wins (about 1 week)

R12 backups → R4 guide-following end (with the timer fix) → R11 webhook and live stats → `tv_archive`/audio checks →
R8 group filters pilot (moved up from B5, measured).

**Wave 3 progress (16 Oct, committed locally):** **0213** R12 backups (pre-migration + nightly, verified copies, on
Status), **0214** R4 end follows the guide (with the hard-stop fix), **0215** R11 webhook (JSON or ntfy text), **0216**
`tv_archive` kept per provider and on Status, **0217** R8 pilot (groups never imported). Deferred: live ffmpeg stats (a
playback-path flag, capture first) and E3 audio tracks (samples on the server). Swift build 42 passed the regression UI
tier (14/14) and the iOS build.

### Wave 4 · segmented recordings first, then recording and guide features (about 3–4 weeks)

**R3 segmented recordings: approved by Mark, 16 Oct.** His answers:
1. Build it (the recommendation stands on the latest evidence; the 4 Oct skip is reversed).
2. **Watch while recording on Apple TV is wanted:** sport that starts early and is missed is played from the start
   while it is still recording.
3. Segments go to **appdata** (room confirmed), and only the finished MP4 goes to the SMB share
   (`/app/recordings`), which has a history of going stale.
4. Using the provider connection for test recordings of the reference channels (HDR, 50 Hz, HE-AAC) is approved.
5. Mark will give a test day: restart the container mid-recording, force a takeover from another device, watch on TV.
6. Behind a Settings switch, off by default; existing recordings keep the parts model; only new ones are segmented.

Shape (from DISPATCHARR-REVIEW §5 R3; native code, never copied: AGPL):
- Recording ffmpeg writes an HLS **event** playlist (`-f hls -hls_time 4 -hls_playlist_type event`,
  `append_list+omit_endlist+independent_segments`, `-avoid_negative_ts make_zero`) to
  `/app/data/recordings-work/<schedule id>/`. A restart or a provider failover starts a new ffmpeg that appends
  (`-start_number` after the highest segment) with a discontinuity, instead of a new part (today max 3).
- At the end: remux the playlist to the same MP4 the K12 preparation makes today, verify its duration, move it to the
  share's recordings folder atomically, then delete the work folder. A failed move keeps the work folder and says so on
  Status. Free-space checks cover appdata as well as the share.
- **Watch while recording:** a new authenticated route serves the in-progress event playlist and its segments (allow-listed
  names, token like live HLS, never a path). Contract: an additive flag in `/api/info` (e.g. `recordingLive`) and an
  additive field on an in-progress recording/schedule; CLIENT-CONTRACT and `APPLE_CLIENT_ROUTES` in the same commit.
  Apple: a "Watch from start" action on a recording in progress (Recordings, and Sport/Guide where the programme is being
  recorded) that plays the event playlist in the recording player, with seeking, and switches to the finished MP4 later.
- Live Comskip can then read segments (today it follows a growing file, 0207); keep the current path until proven.
- Tests first (they must fail on the old code): append across a forced ffmpeg exit, failover append, remux duration,
  atomic move and the failure path, the route's auth and allow-list, the switch off = today's behaviour byte for byte.
- Capture/bench before shipping (AGENTS.md rule): record the five reference samples through the new path and compare
  with today's output (A/V sync, HDR flags, 50 Hz, HE-AAC). Then Mark's test day.

Then: R5 follow/series rules and R6 artwork (one additive contract change, feature-flagged, web + Apple UX), R9
event-channel guide, R10 EPG review list.

**Wave 4 progress (16 Oct, committed locally, not pushed):**
- **0218 R3 segmented recordings** (Apple **44**: "Watch from start" on Recordings and the programme page). Off by default.
  Differences from the shape above: one folder per ffmpeg run, joined by the server, instead of `append_list` (each run
  starts clean; `-output_ts_offset` keeps one timeline); the Apple TV's fMP4 copy is made by a local follower ffmpeg only
  when someone presses Watch. Tests: real ffmpeg 9 (a capture killed mid-way, a second run, the watch copy, the MP4 with
  HDR10/50 fps/HE-AAC kept) and the engine with a fake ffmpeg (switch off = today's arguments; failover and restart
  resume; share down; delete; routes). **Not done:** the reference-feed capture (SSH to the server was refused for this
  session) and production's ffmpeg 6.x; Mark's test day.
- **0219 R5 rules**: "record every game of" (Sport follow keyword) and "record series" (title + channel); web (Recordings →
  Recording rules; the guide's Record series) and Apple **45** (Record every game on a Sport event, Record series on a
  programme, Recordings → Scheduled → Recording rules).
- **0220 R6 artwork**: the guide's programme image on recordings and schedules (`image`, via the logo cache); web
  thumbnails and Apple 45 tiles.
- **0221 R9**: Sport events from event-slot names (four provider forms, time zones and DST), only where the guide has
  nothing real.
- **0222 R10**: country-weighted EPG suggestions and an undoable "Auto-map" (≥ 90 %, clearly ahead, never over a hand
  mapping), web only.
Ingest changes (episode data, programme images) appear after the next EPG sync.

### Wave 4 device and feed checks for Mark

1. Push both repos; deploy; Settings → Sources → ⟳ Sync now (episode data and images come with the sync).
2. R3: Settings → Recording → turn on Segmented recordings. Record a programme on the HDR channel that is on now; after
   5 min, on the Apple TV: Recordings → it → **Watch from start**: plays from the beginning, HDR and 50 Hz.
3. R3: during a recording, Force Update the container; the log says "continues in the same recording"; at the end one MP4
   with a gap noted. Then take over the stream from another device mid-recording: it ends early with an MP4.
4. R3: watch from start past the programme's end: carries on into the finished MP4. Status → "Segmented recordings
   (appdata)" is empty afterwards; one `.mp4` per recording on the share.
5. R5: on a Sport event, **Record every game** → a team; Recordings → Scheduled shows its games "From a rule"; cancel one,
   sync again: it stays cancelled. On a programme, **Record series**; check episodes are not doubled.
6. R6: a recording made after the sync shows the programme's picture on its tile (web and Apple TV).
7. R9: Sport lists games from event slots whose guide is empty (e.g. Sportsnet+ / TSN+ / Apple TV F1 PPV) at the right
   local time.
8. R10: Settings → EPG matching → **Auto-map…**: check the preview, Map these, then Undo.

### Wave 5 · shared ingest (about 3 weeks, separate project)

Design note first (the review's corrections 3–5), capture/bench before and after, behind a Settings switch: recordings as
the first consumer, then HLS sessions, then R7 failover inside the ingest. B4 retirement only on the evidence list.

**Wave 5 progress (17 Oct, committed locally, not pushed):** the design note is
[`docs/SHARED-INGEST.md`](../../SHARED-INGEST.md). **0223** phase 5a: the ingest (plain HTTP reader, MPEG-TS only, byte-
and time-capped buffer, PAT join, eviction, reconnect then give up, linger) with recordings as its first consumer.
**0224** `stream-doctor bench --via-ingest` (it found two faults on its first run, fixed). **0225** phase 5b: live plays
and their probe read the ingest; the coordinator counts one connection per ingest, so watch + record and two devices on
one channel share a connection. All behind Settings → Playback "Shared provider connection", off. Not started: 5c (R7,
waits for real byte rates) and B4 (a week of evidence).
**18 Oct, step 1 done:** `bench --via-ingest` on the server (build 0225, production ffmpeg): SAME on all six samples there
(`pos_31` HDR 50 fps, `pos_1164`/`pos_1165` HE-AAC, `pos_1157`, `pos_29430`, `pos_31148`), both session shapes. Not
covered: an uneven-timestamp feed - none exists now: a fresh capture of Fox Sports 505 (moved to `pos_1182`) measured even,
and `pos_1187` is beIN Sports 3 now (even; benched SAME). The `igndts` path is covered by the unit tests only.
**18 Oct, device test (steps 2–5):** passed. Several devices on one Strong8K connection for the HDR channel; recording it
while watched joined the same ingest with no prompt; a different channel went to Dream 4K. No problem lines in an hour of
`[Ingest]` logs. Step 6 passed too: with everything stopped both ingests closed after their linger. **Bug 9 (display only; fixed in 0226, not deployed):** Status → Providers counts a viewer and a recording sharing one ingest as
2/1, and the recording banner still says live playback may fail; `routes/status.js` (`providersStatus`, `connectionUse`)
and `public/js/app.js` should count and label per ingest as the coordinator does.

### Wave 5 checks for Mark (after Wave 4's)

1. With nothing playing, on the server: `docker exec PigTV node scripts/stream-doctor.js bench --via-ingest
   /app/data/samples/<sample>.ts` for each of the five reference samples. Every one must end "the same output as reading
   the URL". If any says DIFFERENT, stop and send the output.
2. Settings → Playback → turn on **Shared provider connection**.
3. Play an HDR channel on the Apple TV: Stream info, HDR and 50 Hz as before; the log's `resolve timing` line shows one
   probe and the session on `pipe:0` (`[Ingest n] reading …`).
4. Play the same channel on the iPhone at the same time: it plays, no "another device" question. Status → Shared provider
   connections shows one ingest with two readers.
5. While it plays, record it (Guide → Record): no "give up the stream" prompt; still one ingest (three readers).
6. On the iPhone, try a different channel: the usual "another device is watching" question (one connection).
7. Stop everything: within ~10 s Status shows no ingest. Then turn the switch off again until the test day is reviewed.

**Rough total:** Waves 1–4 about 5 weeks of part-time sessions; Wave 5 about 3 more. The order puts everything Mark can
see and feel first, and the playback-path rewrite last, behind evidence.
