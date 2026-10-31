# Decisions

Numbered decisions: context, choice, consequence. **Added to, never rewritten.** A later decision that changes an earlier
one says so, and the earlier entry gets a one-line "Superseded by D-n" note. Decisions are Mark's unless marked
otherwise. Older detail: [`archive/blueprint-2026-10-30.md`](archive/blueprint-2026-10-30.md) §5 and the archived
reviews.

### D-1. Stability over channel-change speed (20 Sept 2026; reaffirmed 23 Sept)

- **Context:** an IPTV server with a web app and Swift clients (Apple TV first, then iPad and iPhone).
- **Choice:** picture quality and stream stability come first, then less overhead and complexity. Stability and quality
  outrank channel-change speed ("quality of image should be the priority", 23 Sept).
- **Consequence:** playback changes are judged on picture and stability before zap time; see D-27 for the 30 Oct
  zap-speed work that keeps this order.

### D-2. One delivery path (23 Sept 2026)

- **Choice:** every play is resolve → HLS session; the web's recovery is a fresh session, not a remux.
- **Consequence:** no remux, legacy pipe or browser-side strategy; `/api/remux` answers the JSON 404
  ([`architecture/playback.md`](architecture/playback.md)).

### D-3. Claude pushes to `main` (23 Sept 2026)

- **Choice:** development moved to the MacBook and Claude pushes to `main`; CI publishes the image only after the tests
  pass.
- Superseded by D-15 (16 Oct): Claude commits but never pushes.

### D-4. The web app is admin plus light viewing (23 Sept 2026, review)

- **Choice:** Xtream-emulation routes and fork code removed (0122); picture quality first (frame-rate matching in); one
  player on the TV.
- **Consequence:** Movies, Series and VOD are gone from the web (0122); the Apple TV has PigTV's own player only.

### D-5. Build, then test in one block; risky behaviour off by default (24 Sept 2026)

- **Choice:** build everything, then test in one block; risky behaviour ships off by default behind a switch.
- **Consequence:** the Settings switches for the relay, standby, segmented recordings, renewal and the dashboard.

### D-6. Mark's test rounds (24–26 Sept 2026)

- **Choice:** **channel numbers are labels only** (0139); **the UIKit guide is the only guide**; **HE-AAC passthrough is
  always on** for the Apple client; **sport is recognised per programme** with a follow list (C-I replaces C-H's row);
  replays in their own section; 72 h of sport; **Home is the tab the app opens on**; **Swift 6** language mode; the iOS
  player uses PigTV's own touch controls.
- **Consequence:** the guide keeps the provider's order; the 72-hour sport views are superseded by D-33's sport pages.

### D-7. Multi-provider failover (30 Sept 2026)

- **Choice:** one primary with backups, cold standby only by default (D1 of the brief); links used only when auto,
  approved or manual.
- **Consequence:** [`ARCHITECTURE.md`](ARCHITECTURE.md) › Providers, backups and failover; the brief is
  [`archive/MULTI-PROVIDER-BRIEF-2026-09-30.md`](archive/MULTI-PROVIDER-BRIEF-2026-09-30.md).

### D-8. No Siri or App Shortcuts (2 Oct 2026)

- **Context:** they failed on tvOS.
- **Choice:** removed in Apple build 37; not wanted.
- **Consequence:** `pigtv://play` and `pigtv://home` links (Top Shelf) remain.

### D-9. Stream auth always on (3 Oct 2026)

- **Choice:** media routes always need a token (0196); it was off while VPN-only.

### D-10. Tuner model removed (4 Oct 2026)

- **Choice:** the tuner model (shared tuners, timeshift, HLS recordings) removed, never having run on a device (0204);
  segmented recordings (audit R13) skipped.
- **Consequence:** the R13 skip is reversed by D-13; timeshift and Start over are gone from the Apple client (build 39).

### D-11. Plan B: no Dispatcharr; adopt its ideas natively (13 Oct 2026)

- **Context:** the Dispatcharr review ([`archive/DISPATCHARR-REVIEW.md`](archive/DISPATCHARR-REVIEW.md)) found that
  Dispatcharr and PigTV overlap in the provider layer but not the viewer layer, and that Dispatcharr opens each channel
  once and fans it out, where PigTV opened a connection per ffmpeg. Its Plan A (use Dispatcharr as PigTV's upstream, the
  R1 spike) was considered.
- **Choice:** PigTV stays standalone and does **not** run Dispatcharr. It adopts the ideas it was missing: the shared
  ingest (R2, R7), segmented recordings (R3), a recording end that follows the guide (R4), series rules (R5), artwork
  (R6), ingest filters (R8), the event-channel guide (R9), EPG matching tune-ups (R10), a webhook (R11), nightly backups
  (R12). Plan A is not pursued.
- **Consequence, what not to copy:** Dispatcharr's stack (Celery, Redis, Postgres: PigTV is one Node process with SQLite);
  VOD, catch-up, plugins, multi-user permissions, network ACLs, Schedules Direct; user-authored ffmpeg command profiles
  (PigTV keeps fixed, tested argument builders); its unfinished preemption. Dispatcharr is AGPL: read, never copied.
- **Guard-rails: what PigTV does better and must keep**

| # | Keep | Where | Why it matters |
|---|---|---|---|
| K1 | **Capability-driven, copy-first HLS** with Apple master playlists (`VIDEO-RANGE`, `FRAME-RATE`), HE-AAC passthrough, `hvc1` fMP4, the AVFoundation -11868 fallback | `playbackStrategy.js`, `transcodeSession.js`, `hlsPlaylist.js` | Picture quality, HDR and 50 Hz switching on the Apple TV. Dispatcharr can't feed AVPlayer at all |
| K2 | **Per-feed timestamp classification** (even/uneven → `igndts`), `-dts_delta_threshold`, read-rate burst for finite sources | `streamProbe.js`, `transcodeSession.js` | 0085 showed what a blanket flag does. Dispatcharr's blanket `+genpts` is exactly that pattern |
| K3 | **Channel profiles** (cached probe results, 7 days, deleted on a failed start) | `channelProfiles.js` | Repeat plays skip ffprobe |
| K4 | **`stream-doctor` and the capture-first rule**, with the sample corpus | `scripts/stream-doctor.js`, `/app/data/samples` | Dispatcharr has nothing comparable. It's what makes every playback change safe, *including* the Plan A hop |
| K5 | **Recording-versus-viewer policy**: idle reclaim, ask once, 3-minute hand-over, partial recordings with the missing span, takeover terminal status, superseded resolves (499) | `streamCoordinator.js`, `routes/playback.js` | Dispatcharr's preemption doesn't act. This is real household UX |
| K6 | **Admission leases** (no double-booking during a probe) | `streamCoordinator.js` | Same idea as Dispatcharr's INCR-first reservation. Keep it (scoped down in Plan A) |
| K7 | **Cross-provider matching**: region from `XX\|`/group/tvg-id suffix, quality pairing (UHD with UHD), event/PPV slots never linked, Fox 50x by number, D5 (own backup feed first; skipped when the whole provider is down) | `channelLinks.js`, `providerRouting.js` (D5 part) | Dispatcharr has none of it (§8) |
| K8 | **Sport**: per-programme kinds, league canonicalisation, team-merge, ESPN fixtures with graceful fallback, replays, 72 h, background rebuild | `sportsEvents.js`, `sportsClassify.js`, `sportsFixtures*.js` | Unique to PigTV |
| K9 | **Channel health and diagnostics**: per-start rows, stalls per hour, least reliable, interruptions, first-picture timing, Status page that never shows a URL | `channelHealth.js`, `playbackEvents.js`, `routes/status.js` | Better aimed at "why did this channel fail" than Dispatcharr's stats |
| K10 | **Security posture**: opaque playback handles, provider URLs never sent to clients, fixed error sentences (C-B), redaction | `playbackHandles.js`, `playbackErrors.js`, `redact.js` | Dispatcharr's Redirect mode hands out provider URLs by design |
| K11 | **The Apple contract** C-A…C-K, `/api/info` flags, `library_rev`, paged library, device pairing | `docs/CLIENT-CONTRACT.md`, `routes/library.js`, `deviceAuth.js` | The client depends on it. Plan A must not change a single field the client sees |
| K12 | **Recording playback on Apple**: MP4 preparation, resume positions, markers, live break detection, compression | `recordingMedia.js`, `recordingPost.js`, `adDetect.js` | Dispatcharr finalises to MKV, which AVPlayer can't play |
| K13 | **Provider order kept, channel numbers as labels**, placeholder grouping | `channelNumbers.js` | Mark's 24–26 Sept decision |
| K14 | **Predictive warming** (next/previous channel) | `channelWarming.js` | Dispatcharr only lingers, which is harmful with one connection (§8) |
| K15 | **One Node process + SQLite, 882 tests, `verify-build.sh`, CI gate before publish** | repo | Small, fast, understandable. Plan A must not move PigTV's logic into Dispatcharr's plugin system |

  Built as 0213–0226 and 0282–0292; what is still open is in the issues (#30, #95, #94, #96).

### D-12. Apple client deferrals (Apple blueprint §7, October 2026)

- **Choice:** no session keep-alive (recovery is needed regardless and idle reclamation protects recordings; revisit
  only if actual pause usage requires it; see D-26 for the 30 Oct live-pause policy); no AirPlay; no speculative VOD or
  series work (the server removed VOD in 0122); do not inherit the server build number as the Swift build number.
  Minimum OS versions, supported devices and distribution policy are decided before a release (today: iOS/tvOS 26.5,
  development signing only; D-30: later).
- **Correction (30 Oct):** iOS has had a bare `AVPlayerLayer` player with PigTV's own PiP and background audio since build
  41; the earlier "PiP and background playback outside scope" no longer describes the app.

### D-13. Segmented recordings approved; tvOS icon option B (16 Oct 2026)

- **Choice:** **R3 segmented recordings approved** (reverses 4 Oct's R13 skip): watch from the start while recording
  (sport that starts early), segments in appdata then the MP4 to the share, behind a switch off by default; provider use
  and a restart/takeover test day agreed. **tvOS icon option B** (kit 1.7.1).
- **Consequence:** [`architecture/recording.md`](architecture/recording.md) › Segmented recordings; the test day is #31.

### D-14. Wave 4 build choices (16 Oct 2026)

- **Choice:** R3 joins **one folder per ffmpeg run** instead of `append_list`, and makes the Apple TV's fMP4 copy with a
  local follower only on request (the archive stays MPEG-TS, 0203). R6 uses the guide's own image only (no TMDB-style
  lookups). R9 reads unnamed slot times as North American Eastern.

### D-15. Claude commits but never pushes (16 Oct 2026)

- **Choice:** Claude commits to `main` but never pushes; Mark reviews and pushes. Supersedes D-3.
- **Consequence:** [`../AGENTS.md`](../AGENTS.md) › How changes ship.

### D-16. The shared ingest reads with plain HTTP (17 Oct 2026, Wave 5)

- **Choice:** the ingest reads with **plain HTTP in Node, not ffmpeg** (subscribers must see the provider's own
  timestamps, 0191); phases ship off by default, each after the via-ingest bench; R7's thresholds wait for real rates.
- **Consequence:** [`architecture/ingest.md`](architecture/ingest.md).

### D-17. Adversarial review threshold (25 Oct 2026)

- **Choice:** a batch above a threshold (functional change to recording/DVR, rules, the playback path, provider routing
  or admission, caches or shared ownership/accounting, auth/redaction, anything in `CLIENT-CONTRACT.md`; any fix for a
  review finding; more than ~150 changed non-test lines) gets a Codex adversarial review before Mark is told it is ready.
- **Consequence:** [`../AGENTS.md`](../AGENTS.md) › Reviews; who launches it changed in D-32.

### D-18. F4 policy for cancelled rule schedules (25 Oct 2026)

- **Context:** the guide has no durable programme identity, so a cancelled schedule cannot always be paired with the
  airing it belonged to.
- **Choice:** accepted as proposed: a cancelled schedule holds only when its pairing is unambiguous, otherwise the
  candidates are recorded; keep the 72-hour horizon; series airings without episode data pair on their channel up to
  3 hours. A heuristic, not durable identity.
- **Consequence:** implemented in 0259 (refined 0260); C-M states the policy;
  [`architecture/recording.md`](architecture/recording.md) › Rules.

### D-19. At most two Codex rounds per batch (26 Oct 2026)

- **Context:** 12 rounds on 25–26 Oct each found a narrower edge; real-system evidence was worth more.
- **Choice:** at most two Codex rounds per batch: the first review, and one of the fixes it prompted. After that only
  **high** findings block the handoff; medium and low ones are recorded for Mark to prioritise. Nothing is dropped
  silently.
- **Consequence:** since 30 Oct they become issues labelled `finding` (D-22).

### D-20. Shared ingest default, adaptive limits, keep the standby (27 Oct 2026)

- **Choice:** feed-lag limits are **per channel, by exception, and self-correcting** (every channel starts at the default;
  one that goes past its limit moves up about 2 s and comes back down once the feed behaves); **live with** TNT Sports
  4's offset (FR-14); **keep the hot standby** (B4 no longer retires the relay's stitching or standby; the 0143 retries
  and warm leases stay for direct connections); **shared ingest on by default** for new installs; close R8's sync
  measurement and the E3 samples (no longer of value).
- **Consequence:** 0290–0292; [`architecture/ingest.md`](architecture/ingest.md).

### D-21. Renewal-budget exhaustion quarantines the channel only (29 Oct 2026)

- **Choice:** when a relay's renewal budget runs out, only the channel is quarantined; the provider-wide breaker is not
  tripped.
- **Consequence:** 0314; [`architecture/ingest.md`](architecture/ingest.md) › How the shared ingest works.

### D-22. Documentation and testing reset (30 Oct 2026)

- **Context:** the blueprint, four roadmaps, a findings register and dated status notes had overlapping, stale homes.
- **Choice:** the reset proposal, approved with eight amendments: one home per fact; docs describe the present; work lives
  in GitHub Issues in `maroge1990/PigTV` (labels `bug` · `feature` · `finding`, `P0`–`P3`, `server` · `apple` · `web`,
  `needs-device-test`); size budgets warn, never fail; handovers are not documents; an end-of-session docs check; the
  five test tiers T1–T5 with T3 live once the Unraid rig is; security matters go to private advisories, never public
  issues; `docs/FINDINGS.md` retired into issues.
- **Consequence:** [`../AGENTS.md`](../AGENTS.md), [`TESTING.md`](TESTING.md), [`../ROADMAP.md`](../ROADMAP.md); the
  proposal itself is in git history (`docs/RESET-PROPOSAL.md` before this migration).

### D-23. Exposure: Tailscale only (30 Oct 2026)

- **Choice:** PigTV is reachable only over Tailscale, not the public internet. The remaining security items are P2.

### D-24. The A/V offset stays P1 (30 Oct 2026)

- **Context:** sound behind the picture on iPhone/iPad (#3); the mitigations appear to work; seen once in real use since.
- **Choice:** P1, not P0.

### D-25. Relay timeline renewal off in production (30 Oct 2026)

- **Choice:** renewal stays off in production until reconnect handling is tested on the fake provider and in a planned
  device test (Mark unticks it in Settings → System; Claude confirms over SSH).
- **Intent recorded:** renewal makes a reconnect behave like a fresh start; it does not re-apply the 30 s live hold.
- **Consequence:** #4.

### D-26. Live pause policy (30 Oct 2026)

- **Choice:** a paused live play keeps its provider connection up to 30 minutes, with a warning 2 minutes before the end;
  a recording that needs the connection still takes it; another device can take over via "Stop the other stream and
  watch here"; if the stream ends, the player says why and Play returns straight to live.
- **Consequence:** #37.

### D-27. Channel switching without waiting for release (30 Oct 2026)

- **Choice:** the Apple client no longer waits for its own release before resolving the next channel (the server already
  ends a device's previous stream first). Prove it on the fake provider at a one-connection limit, then a device check.
- **Consequence:** part of the zap-speed work, #36; replaces the client rule "preserve release-before-switch".

### D-28. One connection, one stream (30 Oct 2026)

- **Choice:** one provider connection carries exactly one stream, for playback or recording. A recording's connection is
  not used for anything else, except watching the same thing being recorded. Recordings of the same channel at the same
  time share one connection. Clashes are shown when scheduling, never silent.
- **Consequence:** #12 (overlapping recordings).

### D-29. Per-channel airing times wait for the sport rebuild (30 Oct 2026)

- **Context:** Apple Codex round 2 on build 63 found a high finding: C-I event bounds cover merged broadcasts, not the
  selected channel.
- **Choice:** deferred to the sport rebuild as a P1 requirement (#20, part of #21); the Live now dashboard stays gated
  meanwhile.

### D-30. Migration defaults (30 Oct 2026)

- **Choice:** Mark accepted the migration's proposed defaults: known problems split between `PRODUCT.md` (what a user
  notices) and the architecture pages (technical); sport design notes in `DESIGN.md`; raw evidence (big screenshots, full
  logs, raw captures) kept off GitHub, referenced by path and SHA-256; the viewing-history file removed from the repo and
  kept locally; spoilers are **one global switch** replacing the per-account settings (#68); the old device-check backlog
  (22–26 Oct batches) closed as in daily use; the Live now device check folded into the sport rebuild (#21); the Apple
  release policy decided later.

### D-31. Roadmap order (30 Oct 2026)

- **Choice:** Now = #6 (Tuning and buffering), #5 (second stream loss), #7 (30 s hold at start), #12 (overlapping
  recordings), #8 (hung recordings share); then the sport rebuild #21, absorbing #22–#24 and #20.
- **Also:** "stuck on Tuning while recording" (iPhone) closed by Mark; the ESPN feed survey (rebuild step 1) and the Apple
  Codex rounds on builds 62–63 are done.

### D-32. Process (30 Oct 2026)

- **Choice:** Claude launches Codex adversarial reviews itself (the codex-companion script); agents close issues only
  after Mark confirms the fix was checked; every question to Mark is asked one at a time, with options and a marked
  recommendation.
- **Consequence:** [`../AGENTS.md`](../AGENTS.md).

### D-33. Sport product vision (30 Oct 2026)

- **Choice:** sport gets two levels: Live now (reassessed) and a page per sport built from shared templates; Apple TV
  first; following a team or driver replaces the team logic; one global spoiler switch; live scores essential but never a
  dependency of playback.
- **Consequence:** supersedes the per-sport "next 72 hours" views and the team-follow logic of the 29 Oct dashboard
  design; [`PRODUCT.md`](PRODUCT.md) › Sport; #21.

### D-34. Claude pushes reviewed batches (30 Oct 2026)

- **Choice:** Claude may push `main` itself (both repos) once a batch has passed its Codex review rounds (D-17, D-19:
  at most two, every finding filed and fixed or answered) and its tests; a docs- or test-only batch, which needs no
  review, once its tests pass. Deploy and rollback stay Mark's. Supersedes D-15.
- **Consequence:** [`../AGENTS.md`](../AGENTS.md) › How changes ship; Claude watches CI after each push and fixes or
  reverts a red run at once.

### D-35. Work in batches by area (30 Oct 2026)

- **Choice:** Mark's rule across his projects (PigMusic D-50, 30 Oct 2026). Open issues that touch the same code and the
  same risk (one subsystem, one platform) are fixed as one batch, which pays its fixed costs once: at most two Codex rounds
  (D-19), one push, one CI build; a release to production bundles a few batches. Inside a batch each fix is its own commit
  (`Refs #n`) with its own failing-before test; targeted tests run per fix, the full gates once before the first review
  round and again before the push. One platform per batch where possible; unrelated areas are never batched to save
  time, and a fix whose live effect must be proven alone ships where it can be told apart. The review focus names the
  batch, its issues and its first commit, against the commit before the batch. After round two only high findings
  block; mediums and lows stay open as issues (security ones private advisories). A batch with no high finding left
  after its rounds is pushed by Claude (D-34); each release to production still needs Mark's go-ahead.
- **Consequence:** [`../AGENTS.md`](../AGENTS.md) › How changes ship, Work in batches, Reviews.

### D-36. The live start builds its hold by playing slightly slower (30 Oct 2026)

- **Context:** #7: a new live play meets the provider's first delivery pause within ~5 s, and the fixed 30 s hold turns it
  into a ~26 s frozen picture. Measured four ways ([`evidence/2026-10-30-live-hold-variants/`](evidence/2026-10-30-live-hold-variants/README.md)).
- **Choice (Mark, 30 Oct):** RATE. The Apple player starts a live play without the fixed hold and plays at 0.97× (pitch
  kept) until it is 30 s behind the live edge, then at 1.0: the same 30 s buffer, built while the picture moves. If
  Mark finds 0.97× noticeable on his TV, the fallback is the hold that grows at each stall (GROW).
- **Consequence:** an Apple build of its own (released apart from other changes, D-35), then Mark's device check: 10 cold
  plays per test channel with a stopwatch.


### D-37. Working without Mark for batches 3b–7 (30 Oct 2026)

- **Context:** Mark will be unavailable, and no device testing (T5) is possible, while batches 3b–7 are built.
- **Choice (Mark, 30 Oct):** Claude builds, tests, reviews and pushes batches 3b–7 without asking. It deploys to
  production only when a deploy helps testing; otherwise it carries on without one. Batch 8 (#4, relay renewal: a real
  provider capture and a device test with renewal on) waits until Mark is back. A read-only copy of the production
  database sits on the Unraid test share (`/mnt/user/appdata/pigtv-test/prod-snapshot/`, owner-only, never in Git) for
  rehearsing migrations. Anything that needs Mark's approval is shown to him before he goes: the Cricket (Apple TV), F1
  iPhone and iPad, and web channel-change mock-ups were added to the "PigTV Sport mock-ups" canvas on 30 Oct.
- **Claude's defaults (Mark may change any):** new provider groups arrive hidden and are listed as "New on the provider"
  (#10); guide sync at a fixed 4:30 am, retrying after 15 min, 1 h and 3 h, with a warning under 36 h of guide (#11); a
  playlist more than 30% smaller, or a guide more than 50% shorter, is held until accepted (#42); spoiler-free and
  "Following" are server-wide, so every device agrees (#68, #67); the sport page's bells use the existing "watch when it
  starts" reminder (#69); channel up/down after a play from Home or the Top Shelf follows the guide order (#13); the web
  player's own preferences stay in the browser, and Show all / Hide all ask with counts and can be undone (#9, #16).
- **Consequence:** issues stay open until Mark's device checks after his return (AGENTS.md › Work tracking).

### D-38. Process reset: one review round, closing on evidence, cheaper gates (31 Oct 2026)

- **Context:** the week since 24 Oct: 36 server pushes at ~10 min of CI each (83 of 213 commits were docs- or test-only
  and each still built and published an image), 17 Apple pushes at ~23 min each plus `test.sh push` (25–40 min) before
  every commit, two Codex rounds per batch, and 183 open issues of which 104 had a fix on `main` waiting for Mark's
  check. Mark asked for less time in gates, fewer immaterial issues, and the sport front page first.
- **Choice (Mark, 31 Oct):**
  1. **One Codex round per batch**; a second only when round one leaves a high finding. A finding fixed inside the batch
     is listed in the batch's evidence README, not filed; a high, or anything left unfixed, becomes a `finding` issue.
     After round two only highs block the push (D-19's cap stays).
  2. **Apple gates:** `Tools/test.sh fast` before each commit; `push` once per batch before its review round and again
     before the push; CI on every push is the full gate.
  3. **Docs-only pushes skip CI** in both repos (`docs/**`, any `.md`, the issue templates). Docs-only commits have no
     build number.
  4. **Closing on evidence:** Claude closes an issue once its fix is pushed with T1–T3 evidence (the failing-before test;
     the rig for user-visible work), in a comment naming the build. An issue whose acceptance names T5, or labelled
     `needs-device-test`, waits for Mark's device report; those steps live on his Test Round checklist, not as issues. A
     closed issue is reopened if a device check contradicts it.
  5. **The issue list holds live work only:** fixed issues closed under 4; the sport family tracked under #21; device
     checks on the Test Round; P3 items parked under one label and one tracking issue.
- **Consequence:** `AGENTS.md` › How changes ship, Work tracking, Reviews (both repos); `docs/TESTING.md` › Tiers;
  D-19, D-34, D-35 and D-37 read with this where they say two rounds or that Mark closes.
