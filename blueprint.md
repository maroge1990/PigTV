# PigTV: blueprint (single source of truth)

**Last updated:** 24 September 2026 · server build **0138** (0113–0138 committed locally, not yet pushed) · Apple client build **16**

Read this at the start of every session. It covers **the server, the web app and the joint roadmap**; the Apple client's own
architecture notes live in `../PigTV-Swift/blueprint.md`, which points back here for the roadmap. This file replaced the
earlier blueprint on 23 September 2026, after an independent review of both products. Everything older is frozen in
`docs/archive/` (see its README) and is history, not instructions.

Keep it **short**: current state, durable facts and the roadmap. When an item ships, mark it in §6, add one line to §8, and
put any long story in the commit message.

| Document | Use it for |
|---|---|
| `blueprint.md` (this) | How things work, the rules, the roadmap and its status |
| `docs/SWIFT-CLIENT-HANDOFF.md` | The Apple-client contract, and the log of server changes the client must know about (its §5) |
| `../PigTV-Swift/blueprint.md` | The Apple client: architecture, device-verification state, client rules |
| `docs/archive/` | Frozen: the old blueprint, per-build write-ups (0048–0104) and the 16 Sept code review (P1-x/P2-x reasoning) |

**Core requirements.** An IPTV server with a web app (this repo) and Swift clients (Apple TV first, then iPad and iPhone).
**Picture quality and stream stability come first**, then less overhead and complexity. **Stability and quality outrank
channel-change speed** (Mark, 20 Sept; reaffirmed 23 Sept: "quality of image should be the priority").

---

## 1. Orientation

| | |
|---|---|
| Repos | Server/web: `github.com/maroge1990/PigTV` → `/Users/markrogers/Documents/GitHub/PigTV`. Apple: `github.com/maroge1990/PigTV-Swift` → `/Users/markrogers/Documents/GitHub/PigTV-Swift`. Development is on Mark's MacBook only (from 23 Sept). |
| CI | On a push to `main`, `docker-publish.yml` runs `test.yml` (Ubuntu, Node 22 and 24) and builds `ghcr.io/maroge1990/pigtv` **only if the tests pass** |
| Deployment | Unraid box "PassyFlix", `http://192.168.1.235:3000`, container **`PigTV`**, reached over Tailscale only. Mark deploys. |
| Shipped through | **0104**; whether it is *running* is whatever `/api/version` says |
| Next build number | **0139** |
| Scale | About **1,000 channels** in the categories Mark selects in the web app (the Apple TV honours the selection); the provider's whole playlist is about 18,000 |

---

## 2. How changes ship

**Claude commits and pushes straight to `origin/main`** (Mark, 23 Sept). No patch files and no feature branches. One logical
change per commit.

1. Start clean: `git status`, then `git pull --rebase origin main`.
2. Make the change with its test (§7 rules: capture before touching playback; a test that fails on the old code).
3. Run locally with **Node 24** (Homebrew `node@24`; the default `node` is 26, which `better-sqlite3` 12 can't build against):
   ```bash
   export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
   npm ci && npm test && bash scripts/verify-build.sh .
   ```
   Both must pass. If either can't be run, say so and don't push.
4. A functional commit bumps `build` in `server/version.js` in the same commit, and its subject starts with the number
   (`0106: Guide rows carry stableId`). Docs-only and test-only commits don't bump it and have no number.
5. `git push origin main`. Never force-push. If CI goes red, fix it or `git revert` it straight away.
6. Tell Mark what shipped, the build number, and **live test steps** for anything that needs the real feed or a device.

**Deploy (Mark):**
```bash
docker pull ghcr.io/maroge1990/pigtv:latest
docker compose up -d --force-recreate pigtv     # recreate, not restart (or Force Update on the Unraid Docker tab)
curl -s http://192.168.1.235:3000/api/version
```
A redeploy ends every session. **Rollback:** each push also publishes `ghcr.io/maroge1990/pigtv:sha-<short>`; point the
container at the last good tag, then `git revert` the bad commit.

**Build identity.** `server/version.js` `build` = the last functional commit's number (continuing the old patch sequence).
`/api/version` and `/api/info` return it with `commit`/`builtAt` (CI stamps them), and the web badge shows `display`.

**How work is organised (from 23 Sept).** The lead Claude session plans, delegates implementation to sub-agents (one per
repo at a time, so commits don't interleave), then **reviews every diff** against this file's rules before it's pushed. Any
item that needs real channels or a device ends with numbered test steps for Mark, and is only marked *Verified* after he
reports back.

---

## 3. How playback works now (one path)

**Every client, every live channel: `POST /api/playback/resolve` → an HLS session** (§C Phases 3–4, 0102–0103). The server probes
the channel once (ffprobe, cached 5 min in memory per URL + caps; since 0114 also kept in SQLite as a **channel profile** for 7 days, so a
repeat play skips ffprobe - see below), then returns either `direct` (a source that is already browser-ready,
through `/api/proxy/stream?h=<opaque handle>` since 0119, never the provider URL) or `transcode`: an HLS session that **copies** whatever the client can decode and re-encodes only what
it cannot. There is no remux, no legacy pipe and no browser-side strategy any more; `/api/remux` answers the JSON 404.

**Provider slot** (`streamCoordinator.js`)
- The provider allows **one stream** (`maxProviderStreams`, 1; a recording holds its own slot). To admit a viewer, streams are freed
  in this order: anything idle ≥60 s (`viewerIdleTimeoutSec`), silently → the caller's own earlier stream, silently → another
  owner's live stream, only after a **409** `{conflict:{type:"viewer-in-progress",…}}` that `force:true` overrides (same shape as
  `recording-in-progress`). Owners are `device:<id>` or `user:<id>`. (The `soft` mode for the movie/series page's
  `POST /api/transcode/session` went with that route in 0122.)
- Idle sweep: live sessions after **5 min** (`PIGTV_LIVE_IDLE_TIMEOUT_SEC`), seekable ones after 30 min. That's deliberately not
  ~2 min: the 60 s rule already reclaims on demand.
- **Takeover vs failure** (0094): a displaced client sees only a 404. `admitViewer` leaves an owner-only record (~15 min, in memory),
  read with `GET /api/playback/:id/terminal-status` → `taken-over` | `none`. **Only `admitViewer` writes one**; a DELETE, the idle
  sweep, the stall watchdog and a recording reclaiming a stale stream write nothing, so ordinary recovery keeps working.

**HLS sessions** (`transcodeSession.js`, `playbackStrategy.js`)
- 4 s segments; the playlist keeps 90 plus 12 spare (`hls_delete_threshold`), with
  `independent_segments+delete_segments+temp_file` and no `append_list`. The directory is on a **2 GB tmpfs** (verified).
- fMP4 when copying HEVC or when the codecs are fine (hls.js can't demux HEVC from TS). HEVC gets `-tag:v hvc1`; copied AAC gets
  `-bsf:a aac_adtstoasc`, and only AAC does.
- **HE-AAC** (the provider's 7 channels, among others) is re-encoded to AAC-LC (MPEG-TS out), because Chrome can't decode it. A client
  that sends capability **`heaac: true`** gets it copied into fMP4 instead (0116; the Apple client will, after a device check). The
  copied init segment signals **AAC-LC 24 kHz with implicit SBR** (ASC `13 10`: ADTS carries no more); ffmpeg decodes it as HE-AAC
  48 kHz, Chrome doesn't. Measured on `pos_1164`/`pos_1165` with ffmpeg 9.0: no warnings, A/V offset kept exactly (the re-encode shifts
  audio ~21 ms).
- **Channel profiles** (0114, `channelProfiles.js`, table `channel_profiles`, key = sha256 of the probe-cache key). Written only after a
  session produced its playlist from a fresh probe; a failed start from a profile deletes it (and its in-memory copy); re-probed after
  `PIGTV_PROFILE_MAX_AGE_DAYS` (7). **`dtsUneven` and `videoRange` ride in the profile**, so a feed whose timing or range changes is
  re-classified within 7 days or on its first failed start. ffmpeg's own probe is **not** reduced. `PIGTV_PROBE_PROFILES=0` = off.
- **Timestamps: two kinds of feed** (0088). *Uneven* feeds have about a third of their DTS steps as ~1-tick-then-double, left by
  an upstream muxer (Fox Sports 505), and need `-fflags +igndts`. *Even* feeds (TSN, Sky UHD, Sportsnet 4K) are **broken by**
  `igndts`. `streamProbe.classifyTimestamps()` decides per feed: steps below ¼ of the mean frame period >5% ⇒ uneven (measured
  33.8% vs 0.0%). It runs on the resolve probe's **own** ffprobe call (`-show_packets -read_intervals %+#300`), because a second
  ffprobe would collide on the one provider connection; without `-read_intervals` a live probe never returns. Also always
  `-dts_delta_threshold 60`. `PIGTV_DTS_AUTO=0` forces `igndts` everywhere (the 0085 behaviour — don't).
- **Pacing:** `-re` **only** when the probe says the source ends (`format.size` or `duration` present). A finite file read at full
  speed outruns the window, and hls.js never retries the resulting 404. Blanket `-re` cost ~8 s at start-up.
- **Master playlist** (0100 HDR, 0115 everything). tvOS only switches the panel to HDR on a **master playlist's `VIDEO-RANGE`**, and
  Match Frame Rate only goes to 50 Hz on its **`FRAME-RATE`**. The copied fMP4 already keeps `colr`/`nclx` (measured on `pos_31`, Sky
  Sports Main Event UHD, HDR10/PQ). `classifyVideoRange()` reads `color_transfer`: a copy+fMP4 PQ/HLG session gets `VIDEO-RANGE=PQ|HLG`;
  **every other session with a usable frame rate** (`avg_frame_rate`, else `r_frame_rate`; 0/0 and values outside 1–240 ignored) gets
  `VIDEO-RANGE=SDR` (an encode is SDR). An HDR feed copied into MPEG-TS, or one with no usable rate, still gets `stream.m3u8`. One
  variant: `BANDWIDTH`, `RESOLUTION` (copy only), `FRAME-RATE`, `VIDEO-RANGE`, **no `CODECS`** (a wrong one makes AVPlayer refuse).
  The custom Apple player must set `preferredDisplayCriteria` itself (hand-off 0100).
- **How a session ends** (0104). `stop()` marks it `stopped` before signalling ffmpeg, so any exit we didn't ask for is an `error`
  (`FFmpeg exited with code N` / `was killed (SIG)`). The software-decode retry (clear the folder, restart on the CPU) is only for an
  **encode** that really decoded on the GPU and died within 10 s **before any playlist**.
- **A failed start fails fast** (0113). `waitForPlaylist` returns as soon as ffmpeg has ended without a playlist (it used to poll out the
  15 s). `classifyInputFailure()` turns ffmpeg's `Server returned 4xx/404/5xx` / `Connection refused` into a fixed sentence for the
  resolve error (never the URL or ffmpeg's words). A **4xx other than 404, or a 5xx, within ffmpeg's first 3 s** (the provider allows
  one connection and may not have released the probe's yet; seen on 7 Flix Sydney in the 0109 log) gets **one** retry: folder cleared,
  1.5 s wait, same shape as the software-decode retry.
- **Stall watchdog** (`stallWatchdog.js`): ffmpeg is killed after 20 s without writing a file in the session directory
  (`PIGTV_STALL_TIMEOUT_MS`), with 30 s grace before the first output. Stderr doesn't count, because it gets louder during
  reconnects. Recordings aren't covered (they have a hard-stop timer).
- **Only network URLs are opened** (0104, `streamUrl.js`: http(s), rtmp(s), rtsp(s), udp, rtp, srt). Resolve, the session route,
  `/api/probe` and `/api/subtitle` answer 400, and the check is repeated at spawn. It isn't done with `-protocol_whitelist`
  because stream-doctor and the tests run the real arguments against local files.
- Start-up ≈ resolve probe + ffmpeg's own 5 MB/5 s probe + one segment: **7.1–10.1 s** cold, **4.4–5.2 s** with the probe cached
  (Mark's 0109 log: probe 3.3–4.7 s, first segment 3.6–5.0 s). A channel profile (0114) makes a repeat play the cached case.
- **The provider cuts the connection ~38 s into a play, and resends ~19 s of old content** (both 7 channels; 23 Sept). In
  `pos_1164`/`pos_1165` the video packet sizes from ~39.6 s repeat those from ~20.6 s exactly (a 19.0–19.2 s shift) - the capture's own
  `-c copy` had already rebased the step, which hides it in the file's timestamps. Through the server's copy arguments (fMP4 and
  MPEG-TS, `-dts_delta_threshold` 60 **or 10, identical**), ffmpeg flags one `timestamp discontinuity … new offset` and **rebases**: the
  output timeline is continuous (no backwards DTS, no gap, no `EXT-X-DISCONTINUITY`), so the player neither rewinds nor freezes; the
  viewer sees ~19 s of the programme again, ~0.16 s of broken picture to the next keyframe, a ~0.25–0.4 s audio gap, and the stream
  sits 19 s further behind live. The threshold only matters for *forward* jumps: fftools treats any backward step over 0.1 s on MPEG-TS
  input as a discontinuity (ffmpeg 9.0 measured; 6.x from reading its source, not run). No code change made.
  Long GOPs (≥10 s) can fail a join (`unspecified size`, exit −22), and a smaller probe makes that worse.
- ffmpeg is Ubuntu 24.04's apt 6.x. An upgrade was rejected: the same warnings appear on 9.0, and it touches the Apple path's
  driver stack. One `dump_extra` remains, on the TS copy branch for video that is neither H.264 nor HEVC: never seen, and
  **only change it against a sample** (0043/0044: `dump_extra` corrupts copy sessions).

**Web player** (`VideoPlayer.js`, 0102)
- `play()` always resolves with `segmentedDelivery:true` and plays what comes back. **Recovery = ask the server again, once per
  selection** (`recoverPlayback`): a failed resolve, or a fatal hls.js error including a segment 404, gets one fresh session. A
  fatal *media* error is first tried in place (`recoverMediaError`, once). A second failure is shown and never looped.
- **Chrome aborts the whole `<video>` on one rejected audio frame.** On an audio `MEDIA_ERR_DECODE`, the player replays once
  with `audioEncode:true` (the session re-encodes only the audio) and remembers the channel in
  `localStorage['pigtv_audio_encode']`.
- No `/api/subtitle` tracks on live: that route opens a second provider connection.
- Chrome keeps the old URL in `currentSrc` while raising "Empty src attribute", so detect a cleared source from the `src`
  attribute (`isSourceCleared`) and make `vm` test fixtures behave like real Chrome.
- **The web reads `/api/library`** (0121): the sidebar pages `/library/channels`, the guide pages `/library/guide` (500 a page,
  cursor, the 24 h on screen), favourites are `/library/favourites` + `POST/DELETE /api/favorites` with the bare id, and a play
  resolves by source + bare id (the web never holds a stream URL). Movies, Series and the VOD watch page were deleted in 0122.
- `/api/proxy/stream` **streams** binary content and drops the upstream when the client leaves (0104). Playlists are read whole
  (they're rewritten, and `?token=` is carried onto every URI). It takes `?h=` (a handle from `playbackHandles.js`: 32 hex,
  in memory, 12 h, LRU-bounded at 10,000; a restart forgets them, unknown → 404; a manifest fetched by handle hands out
  handles for its URIs) or `?url=`, which only the `PIGTV_PLAYBACK_HANDLES=0` rollback hands out. It is the only route left in
  `routes/proxy.js` (0122).
- **Resolve errors** (0118, contract C-B): every provider/channel failure starts "The provider refused this channel",
  "The provider did not respond" or "This channel is not available" (texts in `playbackErrors.js`); a failed ffprobe is
  classified like ffmpeg's stderr and never returned raw; the route strips any `scheme://` from whatever else it returns.

**Tuner model (`PIGTV_TUNER=1`, 0126–0131; contract C-E; off by default)**
- Off, every line above is exactly how it works (`test/tuner-off.test.js`). On, `services/tuner.js` puts a **tuner** under the
  sessions: one provider connection + one ffmpeg writing HLS into its own directory. A `TunerSession` *is* a `TranscodeSession`
  (same start, 0113 refused retry, software-decode retry, stall watchdog, stop). Its arguments are `buildSourceArgs()` (identical
  to a session's: `test/tuner-args.test.js` checks 133 option sets against the 0125 golden file) plus its own HLS muxer part:
  `-hls_list_size 30`, `independent_segments+temp_file`, **no `delete_segments`** (the server keeps the window).
- **Key** = sha256 of those exact arguments (its directory masked) + the master-playlist attributes. Same key → the viewer
  joins the running tuner (no slot, no probe: a missing analysis is re-read from the tuner's own with
  `streamProbe.reanalyzeForCaps`). Different arguments (e.g. web vs Apple TV on an HE-AAC channel) → another tuner, another slot.
- **Viewers** `{id, tunerId, owner, live, lastAccess}`: the `sessionId` resolve returns; DELETE, terminal-status and the idle
  rules (5 min live / 30 min) are per viewer; a tuner stops with its last viewer **and** recording hold (`rec:<scheduleId>`).
  The **coordinator counts tuners** (`requestForTuner`/`admitTuner`): dead → idle (all viewers ≥60 s) → only this owner's,
  silently; else the same 409 bodies (`streamId` = another viewer's id); `force` stops recordings (kept, partial) and viewers.
- **The playlist is the server's** (`hlsPlaylist.js`): ffmpeg's `ffmpeg.m3u8` is only parsed (every 1 s and per request).
  `#EXT-X-PROGRAM-DATE-TIME` on every segment = anchor (time first seen − listed durations) + accumulated EXTINF: monotonic,
  consistent with durations; drifts by the provider's ~19 s resend (mtimes were rejected: jitter, can step back). Token handling
  is `withStreamToken`; master playlists (0100/0115) unchanged on top.
- **Timeshift** (default on with the tuner; `PIGTV_TIMESHIFT_HOURS`, default 3, `0` = the 90-segment window on the tmpfs): tuner
  directories are `<recordings>/.timeshift/<id>`; trimmed by time and, every 15 s, below `PIGTV_TIMESHIFT_MIN_FREE_GB` (20) the
  oldest go at once (never below 90 segments); removed on stop and at startup. `CAN-SKIP-UNTIL` = 6 × target duration;
  `_HLS_skip=YES` → `EXT-X-SKIP` delta (version 9). Only these playlists (and recordings' `index.m3u8`) may be gzipped.
- **Recordings** hold the channel's tuner (any tuner on that URL; else one planned with the Apple TV's default capabilities,
  no `heaac`, 0130) and an `HlsRecorder` hard-links (same volume) or copies the segments overlapping [start − pre, end + post]
  into `<root>/<channel>/<title - date>/`: `index.m3u8` EVENT while recording, VOD + ENDLIST after, `EXT-X-START:TIME-OFFSET=0`
  (plays from its start, also while recording, 0129). Then joined (stream copy, the native-remux arguments) into
  `<title - date>.mp4`, which becomes `file_path` (comskip, compression, download, `media.mp4`). **Both are kept** (2× disk).
  Rows: `format='hls'`, `hls_dir` (columns only added once the tuner is used). A tuner that dies is released and re-tuned
  next tick (new `init-N.mp4` + discontinuity, 0131). Delete removes the folder (only a `<root>/<channel>/<rec>` one).

---

---

## 4. What to know before touching each area

**Diagnosing playback: `scripts/stream-doctor.js` — reach for this first on any playback fault.** Run it as `docker exec PigTV node scripts/stream-doctor.js …`:
- `list <search>` → `pos_N`
- `capture <pos_N> [sec]`: the real feed, plus a verdict
- `classify <sample>`
- `bench <sample>`: the server's **own** argument builders, scored per flag set
- `probecost <pos_N>`

`capture` and `probecost` take the provider connection, so **nothing may be playing**. Samples live in `/app/data/samples` (the bind
mount; they survive deploys) and are the regression corpus. A sample is evidence: it has to outlive the build it was taken on:
- `pos_31` Sky Sports Main Event UHD (HDR10, even)
- `pos_1187` Fox Sports 505 (**uneven**)
- `pos_463` TSN, `pos_328` Sky Sports UHD (HEVC), `pos_468` Sportsnet 4K: even

A 60 s capture turns a playback bug into a repeatable local experiment. It found the 0085 regression in an afternoon, after weeks
of spot fixes.

**When a channel misbehaves:**
1. Note the channel and roughly when (the log never names channels).
2. Run `docker logs PigTV --since 30m 2>&1 | grep -E "resolve timing|\[HLS\]|Non-monotonic|Packet duration"`. Each play's
   `resolve timing` line ends `source timing even/uneven/unknown`, and `, HDR PQ - master playlist` when it applies. A flood of
   timestamp warnings against a play classified the other way is a misclassification.
3. `list`, then with nothing playing, `capture` and `bench`.
4. Keep the sample.

**Reading ffmpeg's log.** Harmless: `non-existing PPS/SPS`, `decode_slice_header error`, `no frame!`, `Increasing reorder buffer`
(joining mid-GOP), and a handful per hour of `Non-monotonic DTS` / `Packet duration … out of range`. A *flood* of those two means
a wrong classification. `Could not find codec parameters … eac3 … 0 channels` means the probe ended early; suspect it if audio is
silent from the start. **Real problems:** `Could not write header`, `FFmpeg exited with code`, `was killed`,
`Releasing stalled session`, `[HLS] 404 for …`, `asking the server again` repeating on one channel.

**Status page** (0124): the admin page "Status" = `GET /api/status` (admin): live sessions with channel names, active
and next 5 recordings, the last 50 plays (first-picture time, cold/warm/profile, failure text; in memory, `playbackEvents.js`),
sync per source, free disk (transcode tmpfs, recordings), build. Never a URL: fields are whitelisted and the document is
scrubbed. Look here before `docker logs`. Since 0133 it also lists the **least reliable channels** (7 days).

**Channel health** (0133, C-G, `channelHealth.js`, table `channel_health`): one row per start attempt per identity, kept 30 days
(pruned daily). A failed resolve is a failed start (a 409 is not an attempt); a client `media-error`/`start-timeout` before
that owner's `play-start` turns its last resolve into a failed start (`player`); `play-start` gives the first-picture time.
Client events carry no session id, so the mapping is owner → last resolve (as 0124). `health` on guide/channels rows: flaky
= ≥2 failed starts or >30% of ≥3 in 7 days. `library_rev` moves only when a channel's class changes.

**EPG matching** (0134, `epgMapping.js`, table `epg_mappings`, Settings → EPG matching): an admin's tvg-id per identity,
applied **at query time** over `playlist_items.tvg_id` (guide programmes, now/next, logo fallback), because every sync
rewrites that column. `GET /api/epg/unmatched` = visible channels with no programmes in the next 24 h + 5 name-scored
candidates that do have programmes.

**Client diagnostics.** `POST /api/playback/client-event` (token; whitelisted, bounded fields; path only, never a query string):
`media-error`, `start-timeout`, `play-start`, `play-end`. Log lines end `from=user:<id>` / `from=device:<id>`.
`scripts/playback-report.js <saved log>` summarises first-picture time (cold/warm, median and p90), stalls/hour and failures, per
row: `HLS session`, `HLS session [Apple/device]`, `direct` (0113 relabelled it for the one-path world; a "probe profile" play is warm).
**Log vocabulary added in 0113–0115:** `resolve timing … probe profile (age Nd)`; `… first segment NOT produced - ffmpeg ended after Xs
(provider HTTP 4xx)`; `… , master playlist (SDR, 25.000 fps)`; `[TranscodeSession id] Provider refused the first connection; retrying
once in 1.5s`; `FFmpeg ended before producing a playlist`. **Capture caveat:** `capture` copies through ffmpeg, which rebases a backward
timestamp step, so a provider reconnect shows up as repeated content, not as a timestamp jump.

**Channel identity** (0096–0098). `item_id` is `pos_N`, the M3U line, and **the provider moves it**. `stable_id`
(`stableIds.js`) is the provider stream id from the URL (`s441360`), otherwise a hash of the credential-stripped URL. Favourites,
scheduled recordings and history key on it; 845 channels are listed twice, sharing one identity. **The trap:** a row that *has*
an identity must never fall back to its stored `pos_N`. Joins use
`(x.stable_id IS NOT NULL AND p.stable_id = x.stable_id) OR (x.stable_id IS NULL AND p.item_id = x.item_id)` plus a `GROUP BY` on
the identity. Only *pending* schedules were backfilled. The provider's stream id and URL live in the row's `data` JSON, not
`stream_url`.

**Channel numbers** (0117, `channelNumbers.js`, contract C-A). Table `channel_numbers`, keyed on the favourites' identity
(`source_id` + `COALESCE(stable_id, item_id)`), `number` unique server-wide. Assigned after a playlist sync, after every
hide/show, and lazily by the first `/api/library` request when the table is empty; a channel no longer visible keeps its
number 30 days. `/library/guide` and `/channels` order by number (nulls last), and the guide's cursor carries it (a cursor
from the other ordering is a 400). Admin: `GET /api/lineup`, `PUT /api/lineup/numbers` (a reserved number yields to the
admin; a visible holder is a 400). Rollback: `PIGTV_CHANNEL_NUMBERS=0` (old order, no flag; numbers still kept).

**Guide and library.**
- Query **`epg_live`**, never `epg_programs`. A sync loads generation active+1, flips it in one statement, then deletes the old
  one in slices; a failed feed leaves the guide untouched.
- Queries bound `start_time > from − 24 h`.
- `/api/library/*` fill a missing logo from the EPG (by tvg-id, then by name).
- **Ingest-time changes only show after a sync:** a redeploy skips any source synced in the last 24 h (`syncIfStale`), so use
  Settings → Sources → Sync now.
- Favourites store the bare channel id (`channelIds.js`); `GET /api/favorites` re-presents the composite form (the web no
  longer reads it since 0121).
- Channel numbers are edited in Settings → Channel numbers (0123), which saves only changed rows and shows the server's error.

**Auth, limits, routes.**
- Stateless bearer tokens (web login + paired devices); no sessions or cookies. `requireStreamAuth` stays **off** (VPN-only).
  Stream URLs carry `?token=`.
- Limits: JSON body 2 MB; failed logins 10 per 15 min per (socket, username); pairing 60 starts / 1 500 polls per 10 min.
- HLS file names are allow-listed (`seg\d{4,}.(ts|m4s)`, `init.mp4`). fMP4 segments are served as `video/MP2T` on purpose
  (revisit with a device).
- Unknown `/api/*` → `404 {"error":"No such API endpoint"}`. **A new Apple-client endpoint goes into `APPLE_CLIENT_ROUTES` in
  `test/api-404.test.js`.**
- Sources, settings and users live in SQLite since 0135 (`app_sources`, `app_users`, `app_settings`, `meta.next_id`; objects
  kept as JSON). The first start on 0135 migrates `data/db.json` once and renames it **`db.json.migrated`** (the backup; a
  `db.json` that reappears later is ignored and logged). **Rolling back past 0135:** rename `db.json.migrated` to `db.json`
  (anything changed since is not in it). `settings.get()` returns one deep-frozen object, rebuilt only after a write: copy
  it before adding to it. A failed write is one rolled-back transaction and a plain "could not save its data" error.
- Auth is `jsonwebtoken` + `bcryptjs` directly (0136; passport removed): `requireAuth` (bearer, 401 "Unauthorized"),
  `optionalAuth`, `streamAuth` (bearer or `?token=`), role always from the user store, revoked devices refused.
- Express 5 (0137): wildcards are `/{*splat}`; `req.body` is forced to `{}` when absent; query parser `extended`;
  `res.sendFile` needs `dotfiles: 'allow'` for anything under a dot-folder (the tuner's `.timeshift`).

**Tuner model (on with `PIGTV_TUNER=1`).** Log lines: `[Tuner <id>] Starting (key …)` / `Stopping (<why>)`; `resolve timing …,
tuner <id>` (new) or `…, shared tuner <id> (N viewers)` (joined, `first segment after 0.0s`); `Releasing stalled session (tuner)`;
`Only X GB free for timeshift … dropped the oldest N segments`; `[Recordings] #N shares|started tuner <id>`, `lost its tuner; taking
the channel up again`, `finished (…) N segments, Ns, … (N linked, N copied)`, `Joining #N`, `#N joined`. Rollback: unset the env var
(HLS recordings made meanwhile keep playing). Tests use a fake ffmpeg (`test/helpers/fakeHls.js`) and stub free space.

**Recordings** (`recordingEngine.js`)
- `scheduled → waiting → recording → …`, where `waiting` = due but held back by a viewer (listed, cancellable, duplicate-checked).
- File names use the server's local time, so **`TZ` must be set** (verified).
- Native playback is a `.native.mp4` remux of the file: `hvc1`, MP2→AAC, shared across concurrent requests, written atomically,
  sidecars deleted with the recording. `?async=1` answers 202 while preparing. Old HEVC sidecars are `hev1`: delete
  `*.native.mp4` for those once. **HEVC recording playback on an Apple TV is still unconfirmed.**

**Dev environment (macOS, from 23 Sept).**
- Node 24 from Homebrew (`/opt/homebrew/opt/node@24/bin`; see §2). `npm test`: 513 tests, all pass locally with
  Homebrew ffmpeg 9.0 installed (tests that need ffmpeg skip without one).
- `bash scripts/verify-build.sh .` uses the system `python3`.
- The tree is LF. There is no local Docker; the image is only built by CI.
- **CI runs every test file at once on 2 vCPUs: keep timing margins ≥1 s, or poll** (0101).

---

---

## 5. Frozen Apple-client contract (change only together with a client change)

- `/api/library/guide` rows: `id`, `sourceId`, `name`, `logo`, `category`, `tvgId`, `programmes[]` (`startTime`/`endTime` in **ms**).
- `/api/recordings/{id}/markers`: `startMs`/`endMs`. `/api/recordings/{id}/playback` (bearer):
  `{url:"/api/recordings/{id}/media.mp4", container:"mp4", durationSec}`; `media.mp4` takes `?token=`, supports ranges and
  `+faststart`; `?async=1` is additive.
- Favourites: `POST/DELETE /api/favorites` (bare id), listed via `/api/library/favourites`.
- Playback: `POST /api/playback/resolve` → `strategy` `direct` | `transcode`, with `playbackURL` under `/api/proxy/stream`,
  `/api/transcode/…` (`master.m3u8` when the session has a usable frame rate or is an HDR copy, else `stream.m3u8`) or `/api/recordings/…`; token as `?token=`; bearer on
  `DELETE /api/playback/{id}`; `GET /api/playback/{id}/terminal-status`.
- Additive and safe: `/api/version` and `/api/info` fields; `waiting` rows; `finite`/`durationSec`/`videoRange` in resolve `info`; the
  optional `heaac` capability (0116).

---

---

## 6. Roadmap (from the 23 Sept independent review)

IDs: **S** server · **W** web · **A** Apple · **X** both. Size: S ≈ hours, M ≈ days, L ≈ a week or more of agent time.
Status: **Planned → In progress → Shipped (build N) → Verified** (only after Mark's device or live check), or **Blocked** with
the reason. Each phase ends with Mark's gate; don't start the next phase's device-dependent work until it passes.

**24 Sept (Mark): build everything that's left, then test it all in one block.** The per-phase device gates are waived.
Risky behaviour ships off by default behind a switch (server env vars; Apple Settings → Labs). The interface between server
and client for Phases 2–4 is fixed in `docs/ROADMAP-CONTRACTS.md`; build to it exactly.

**All phases built by 24 Sept (server 0138, app 22).** Mark's combined device and live test list is `docs/TEST-BLOCK.md`; items move to *Verified* as he reports back.

### Phase 0: clean-up and correctness (gate: redeploy, CI green, guide unchanged)

| ID | Item | Status |
|---|---|---|
| X0.1 | Push-to-main workflow; CI publishes only after the tests pass; Node 24 locally | **Done** (0e68c03; Node 24 via Homebrew) |
| S0.1 | `stableId` on `/library/guide` and `/library/favourites` rows (only `/library/channels` had it, though the hand-off said all three did), with a test | Committed (0106), awaiting deploy |
| S0.2 | Remove the dead second `GET /api/proxy/epg/:sourceId` handler (`routes/proxy.js`, shadowed by the first) | Committed (0107), awaiting deploy |
| S0.3 | Gzip JSON responses (`compression`), never for media, HLS or range responses; log a guide page's size before and after | Committed (0108), awaiting deploy |
| S0.4 | Image on Node 24 LTS (Node 20 is end of life); pin the Comskip commit; `npm ci --omit=dev` | Shipped (0109), awaiting deploy; the CI matrix change (Node 22/24) is committed locally, **blocked** on the same token scope, and `verify-build.sh` fails its matrix check until it's pushed |
| A0.1 | Delete unused Swift views and model code; remove `remux` from the media allow-list and strategy lists | Shipped (app build 17, `6e81521`), awaiting Mark's TV check |
| A0.2 | Fix the SwiftUI "Environment accessed outside a View" runtime warning in the guide | Parked: not reproducible outside the accessibility-heavy guide UI test; three app-code hypotheses ruled out, no source location, likely from the system's accessibility bridge. Reopen if the guide misbehaves. |
| A0.3 | Swift CI (GitHub Actions macOS): build tvOS and iOS, run the tvOS tests on each push | Committed locally (`78c7376`); **blocked**: the Mac's GitHub token lacks the `workflow` scope |

### Phase 1: faster (measure first: `play-start … first-picture=` lines and `scripts/playback-report.js`)

**Baseline before 0113–0116** (Mark's log, 23 Sept, builds ≤0112): 16 plays; first picture median **8.1 s**, p90 8.7, max 10.1; cold 8.2 s (n=14), warm 4.8 s (n=2); 0 stalls in 18 min watched (longest 13 min); 2 failed starts (7 Flix Sydney, 441372). Compare with the same report after a week on 0116.

| ID | Item | Status |
|---|---|---|
| S1.1 | **Channel profiles**: persist each channel's probe result by `stable_id` (codecs, audio profile, fps, `dtsUneven`, `videoRange`); on a repeat play skip ffprobe and start ffmpeg with a smaller probe; probe again after a codec change, a failed start, or N days. Expect 2–4 s off repeat channel changes, and one fewer provider connection. | Committed (0114), awaiting deploy — keyed like the probe cache (URL + UA + caps, hashed), not `stable_id`; the "smaller ffmpeg probe" half deliberately not done (long GOPs) |
| S1.2 | **Frame-rate-aware master playlist for every copy session** (`FRAME-RATE`, `VIDEO-RANGE=SDR`, no `CODECS`) so Match Frame Rate can put 50 fps channels on 50 Hz. Quality first: the 1–2 s HDMI mode switch is accepted (Mark, 23 Sept). Device check. | Committed (0115), awaiting deploy and the device check (Match Frame Rate ON, a 25 fps channel → the TV reports 50 Hz); covers encodes too |
| S1.5 | Fail fast, say why, one retry when the provider refuses the connection right after the probe; `playback-report.js` relabelled (from Mark's 0109 log) | Committed (0113), awaiting deploy |
| S1.6 | HE-AAC passthrough for clients that decode it (capability `heaac`, off by default) | Committed (0116), awaiting deploy; the Apple client sends `heaac: true` only after a device check (441367/441372: sound with full treble, lip-sync) |
| S1.3 | Guide API for scale: `tvg_id` column; cursor paging; up to 500 per page; several categories per request; **ETag/304** from the EPG generation, playlist sync time and time window | Committed (0111), awaiting deploy — shipped as `guideCursor`/`guideVersion` (a revision counter plus EPG generations) rather than HTTP ETag/304; several-categories-per-request not done |
| A1.1 | Guide refreshes cheaply: a few large requests; ETag revalidation; no whole-guide rebuild per page; cache per window | Planned |
| A1.2 | Channel change feels quicker: the channel card (logo, now/next) shows instantly; one `AVPlayer` across changes; tuned forward buffer; **last channel** | Planned |
| S1.4 | Logo cache `/api/logo/{key}` (fetch once, resize to about 320 px, long cache headers); limit `/api/proxy/image` to known logo URLs | Committed (0112), awaiting deploy — the cache itself shipped; `/api/proxy/image` was deliberately left open (the web app also uses it for movie/series posters, not just logos) |
| A1.3 | Client follow-ups to 0113/0116: show the server's safe resolve-failure message (e.g. "The provider refused this channel…") instead of a generic HTTP 500, via an allow-list of known messages; send `heaac: true` **only after** Mark's device check of HE-AAC passthrough (7 Mate / 7 Flix: sound, treble, lip-sync) | Server side committed (0118: every failure uses the C-B prefixes, never a URL), awaiting deploy; client side per `../PigTV-Swift/blueprint.md` |

### Phase 2: one lineup, one contract, a steady guide

| ID | Item | Status |
|---|---|---|
| X2.1 | **"My TV" lineup** on the server: the selected categories in order, plus any extra channels, with **channel numbers** (was R11). Used by the guide, channel up/down, Top Shelf and the web. | Server committed (0117); web shows numbers (0121) and has the renumbering screen (0123), awaiting deploy; the Apple display is still to do |
| A2.1 | **tvOS guide grid on UIKit** (`UICollectionView` with a time-based layout, hosted in SwiftUI), behind a switch; compare on the TV; then delete the SwiftUI grid, edge targets and focus retries | Planned |
| W2.1 | Web onto `/api/library`; move the Sources category/channel picker off the Xtream-emulation routes; **then remove** the Xtream-emulation and whole-EPG proxy routes, `cache.js`, Movies, Series, Pluto and the plugin loader (Mark, 23 Sept: remove whatever nothing calls) | Committed (0120 catalogue, 0121 web on `/api/library`, 0122 removals), awaiting deploy and Mark's web check |
| W2.2 | Web status page: live sessions, recordings, recent channel starts with first-picture times, sync health | Committed (0124), awaiting deploy |
| S2.1 | **P1-4**: an opaque playback handle instead of the credentialed `?url=` (a coordinated client change) | Committed (0119: `direct` → `/api/proxy/stream?h=`, flag `playbackHandles`; proxy/probe logs and stored recording errors redacted), awaiting deploy; needs no client change (same path) |

### Phase 3: the tuner model (staged, behind a switch, with one env var to go back)

One provider connection → one ffmpeg (the same copy arguments as today) → fMP4 HLS on disk, feeding live viewers, recordings
and timeshift together. Run old and new side by side against the `stream-doctor` corpus.

| ID | Item | Status |
|---|---|---|
| T1 | A tuner layer under the sessions; viewers of the same channel share it; the coordinator arbitrates tuners | Committed (0126), behind `PIGTV_TUNER=1` (off); awaiting Mark's test block |
| T2 | Recordings take segments from a tuner (watching and recording one channel costs one connection); recordings stored as MP4 (joined without re-encoding) or as HLS VOD, with no preparation wait | Committed (0127, fixes 0130/0131): HLS VOD **and** the joined MP4 are both kept; behind the switch |
| T3 | Timeshift on the recordings disk: **3 hours per tuner by default, configurable** (about 1.2 TB free, Mark 23 Sept), trimmed if free space falls below a floor; **start over**; `EXT-X-PROGRAM-DATE-TIME` | Committed (0128): delta playlists + gzip; start over is client-side (C-E); behind the switch |
| T4 | Watch a recording while it's still recording | Committed (0129): `EXT-X-START`, first-segment wait; behind the switch |

### Phase 4: capabilities and polish

| ID | Item | Status |
|---|---|---|
| A4.1 | Top Shelf: the lineup's "on now" on the Apple TV home screen, with a deep link to play | Planned |
| A4.2 | Stream info overlay (codec, resolution, fps, bitrate, dropped frames, copy or encode, HDR); the same numbers in `play-end` | Planned |
| A4.3 | **One player on the TV**: recordings move into the custom player and the AVKit recording path is deleted (Mark, 23 Sept); best after T2 | Planned |
| A4.4 | iPhone/iPad touch guide and player controls; revisit PiP and AirPlay after the tuner work | Planned |
| A4.5 | Siri / App Intents ("Play … on PigTV"); Swift 6 language mode | Planned |
| S4.1 | Channel health: per-channel first-picture time, stalls per hour and failures from client events; flag unreliable channels | Committed (0133): `health` on guide/channels rows, flag `channelHealth`, Status page list; stalls per hour not kept (play-end's `stalls` is not tied to an attempt); Apple dot still to do |
| S4.2 | EPG matching tool (web): map channels with no programme information to EPG ids | Committed (0134) |
| S4.3 | `db.json` into SQLite (and stop copying settings on every segment request); split `routes/proxy.js`; Express 5; `jsonwebtoken` directly instead of passport | Committed: SQLite (0135), no passport (0136), Express 5 (0137). Splitting `routes/proxy.js` not done (238 lines since 0122; not needed) |

**Carried over from the old blueprint:** `USER node` (volume ownership first) · fMP4 segment MIME (revisit with a device).
(P2-8 tests, the `routes/info.js` try/catch and the stored-badge clean-up shipped in 0138.)
**Kept on purpose:** the non-VAAPI encoders. **Not planned:** AV1, adding more users, reviving VOD, access from outside the VPN.

**Watch the logs, no code yet:** the provider's ~38 s cut and 19 s resend (§3; decide whether anything should be done about the
repeated content, which needs a capture that keeps the raw bytes) · 7 Flix Sydney's second 0109 failure (`Stream ends prematurely …
Will reconnect` looping after ~14 MB, nothing produced: 0113 doesn't shorten that case, since ffmpeg keeps running) · "Bug 2" (`[mpegts] Invalid timestamps … dts=X+1800`: needs the channel that produces it);
`source timing` lines (the classifier has seen one uneven feed in five); the 20 s stall timeout (tighten only after real stall logs).

**Live checks still owed:** 0133–0138 (Status page "Least reliable channels"; Settings → EPG matching maps a channel and the guide fills; the first start on 0135 leaves `data/db.json.migrated` and sign-in, sources and settings work; login/logout and a paired device on 0136/0137) · 0121–0124 on the web (sidebar with numbers, stars incl. a cross-listed channel, guide Earlier/Later,
record from the guide, Manage Content save, Settings → Channel numbers, Status page while a channel plays) · 0102–0104 on the web (HLS badge, channel changes, recovery lines) · the HDR panel switch on the TV
(0100 plus Swift R13) · walk the favourites once since 0097 · 0054: cut the upstream mid-stream (stalled, slot frees) · 0059:
a favourite round-trips web ↔ Apple · 0062: an HEVC recording plays on the Apple TV · 0073: `timestamp discontinuity` stays
about 0 on the E-AC-3 channel.

---

## 7. Rules

- **Capture before changing anything on the playback path** (`stream-doctor`). **No ffmpeg-flag or timestamp patch ships on a
  hypothesis**: 0085 did, and silently broke every even feed. If a fault can't be captured, say so and treat the fix as provisional.
- Every functional commit has a test that **fails on the old code** (prove it) and a `verify-build.sh` check, and bumps `build`.
- **Every change the Apple client can see**, including anything in `transcodeSession.js` / `playbackStrategy.js`, gets a row in
  `docs/SWIFT-CLIENT-HANDOFF.md` §5 in the same commit. Nothing in §7 changes without a matching client change.
- Say plainly what couldn't be run, and give Mark live-test steps for anything that needs the real feed or a device.
- At the end of a session, update this file: one line in §4, facts in §3/§5, and stories to the archive.
- `scripts/verify-build.sh` asserts that features live where they should; add the check that would have caught each bug.

**Decisions on record.**
- *20 Sept:* stability over channel-change speed; VOD/series kept but unsupported; `requireStreamAuth` off while VPN-only; Mark
  applies and pushes.
- *21 Sept:* keep the Xtream/upstream proxy and `cache.js`; CI builds the images. (Superseded 23 Sept: removed in 0122.)
- *23 Sept:* **one delivery path now**: Phases 3 and 4 shipped together without the trial report, and the web's recovery is a fresh
  HLS session rather than a remux fallback.
- *23 Sept (later):* development moved to the MacBook. **Claude pushes to `main`** (supersedes "Mark applies and pushes"); the
  numbered patch files are retired; CI publishes the image only after the tests pass.
- *23 Sept (review):* new roadmap (§6) adopted. The web app becomes admin plus light viewing; the tuner model is approved after
  the quick wins; unused Xtream-emulation routes and fork code are to be removed; picture quality first (frame-rate matching
  in); a generous timeshift; one player on the TV. The old blueprint and hand-overs are archived.

---

## 8. Shipped log (one line each; 0033–0105 are in `docs/archive/blueprint-2026-09-23.md` §4)

| Build | What |
|---|---|
| — | 23 Sept: push-to-main workflow; CI gates the image on the tests; docs archived and this blueprint written (no build bump) |
| 0106 | `stableId` fixed on `/library/guide` and `/library/favourites` rows (0097 said it was already there; it wasn't) |
| 0107 | Removed the dead, unreachable second `GET /epg/:sourceId` and `DELETE /cache/:sourceId` handlers in `routes/proxy.js` |
| 0108 | JSON (and the server's own HTML/CSS/JS) responses are gzip-encoded; HLS, recording media and ranged requests never are |
| 0109 | Image moved to Node 24 (Node 20 is EOL); `npm ci --omit=dev`; Comskip pinned to a commit; CI matrix is Node 22/24 |
| 0110 | `GET /api/favorites` now follows a channel to its CURRENT position(s) after a provider reorder, instead of the stale stored `pos_N` (Mark's live test: Apple TV and web disagreed on the same favourite) |
| 0111 | Guide API for scale (S1.3): `tvg_id` column (filled at ingest, backfilled once); cursor paging and `limit` up to 500 on `/library/guide`; `GET /library/guide/version` for a cheap "did anything change?" check |
| 0112 | Logo cache (S1.4): `GET /api/logo/{key}` fetches a channel/EPG logo once, downscales it with ffmpeg when available, and serves it from disk with a week-long cache lifetime; `library/channels`, `/favourites`, `/guide` and `/recent` hand out that path instead of the provider URL |
| 0113 | A failed start fails fast (no 15 s wait once ffmpeg has exited) and says why in the resolve error (HTTP 4xx/404/5xx, connection refused); one retry after 1.5 s when the provider refuses ffmpeg in its first 3 s; `playback-report.js` relabelled for one path, with a cold/warm summary |
| 0114 | Channel profiles (S1.1): the probe's analysis kept in SQLite for 7 days, so a repeat play skips ffprobe; dropped on a failed start; `PIGTV_PROBE_PROFILES=0` turns it off |
| 0115 | Every session with a usable frame rate is handed out as `master.m3u8` with `FRAME-RATE` and `VIDEO-RANGE=SDR` (HDR copies unchanged), so Match Frame Rate can pick 50 Hz (S1.2) |
| 0116 | HE-AAC copied instead of re-encoded for a client that sends capability `heaac: true` (none does yet; the web never will) |
| 0117 | Channel numbers (C-A, X2.1): persisted per identity, assigned on sync/hide/show (lazily if empty), reserved 30 days; `number` on library rows; guide/channels in number order with an exact cursor; admin `GET /api/lineup`, `PUT /api/lineup/numbers`; flag `channelNumbers` |
| 0118 | Resolve failures all start with a C-B prefix and never carry a URL (404/5xx/refused/timeout reworded; a failed probe no longer returns ffprobe's stderr, which named the stream URL; "channel not found" → "This channel is not available") |
| 0119 | Opaque playback handles (C-D, S2.1): `direct` resolves answer `/api/proxy/stream?h=<32 hex>`; the proxy takes `h` (and still `url`); flag `playbackHandles`; proxy/probe log lines and a failed recording's stored error now redacted |
| 0120 | `GET /api/sources/:id/catalogue?type=live` (admin): a source's categories and channels, hidden included, from SQLite, for the Sources picker (W2.1); movie/series → 400 |
| 0121 | The web reads `/api/library` (W2.1): sidebar, guide (500/page, cursor), favourites and Home tiles; numbers shown; plays by source + bare id; the Sources picker reads the catalogue (movie/series tabs gone) |
| 0122 | Removed the fork leftovers: Movies/Series/Watch pages and CSS; `/api/proxy/xtream|epg|m3u|cache|image`, `cache.js`, the plugin loader, Pluto headers; `POST /api/transcode/session` + `soft`; `/api/probe`, `/api/subtitle`, `/api/history`, `/api/channels/recent` |
| 0123 | Settings → Channel numbers: search, inline renumbering, saves changed rows via `PUT /api/lineup/numbers`, shows the server's validation error |
| 0124 | Admin `GET /api/status` + web Status page (5 s refresh): sessions, recordings, last 50 plays, sync, disk, build; never a URL (W2.2) |
| 0125 | HTML is revalidated after a redeploy (`no-cache`) |
| 0126 | Tuner model T1 (`PIGTV_TUNER=1`, off by default): viewers with identical ffmpeg arguments share one tuner; coordinator counts tuners; server-rendered playlist with PROGRAM-DATE-TIME; `buildFFmpegArgs` split, proven identical |
| 0127 | T2: recordings hold the channel's tuner and keep its segments (EVENT → VOD), joined into an MP4; `/recordings/:id/index.m3u8`, playback `container:"hls"`; flag `recordingHls` |
| 0128 | T3: timeshift (3 h in `<recordings>/.timeshift`, free-space floor), delta playlists, gzip for tuner playlists; flag `timeshift` |
| 0129 | T4: recordings play from their start while recording (`EXT-X-START`); Play on a just-started recording waits for its first segment |
| 0130 | A recording's own tuner uses the Apple TV's default capabilities (no `heaac`), so a TV on an HE-AAC channel being recorded shares it |
| 0131 | A recording releases a tuner that died and re-tunes; a dead tuner never counts as a slot |
| 0132 | `PIGTV_TIMESHIFT_DIR` puts the tuners' timeshift on a local disk instead of the recordings share |
| 0133 | Channel health (C-G, S4.1): start attempts per channel (30 days), `health` on guide/channels rows, flag `channelHealth`, Status page "Least reliable channels" |
| 0134 | EPG matching (S4.2): `GET /api/epg/unmatched` with name-scored candidates, `PUT /api/epg/mapping` (query-time override that survives syncs), Settings → EPG matching |
| 0135 | Sources, settings and users moved from `db.json` into SQLite (one-time migration, `db.json.migrated` kept); settings served as one frozen object, no clone per request |
| 0136 | passport, passport-jwt and passport-local removed; bearer tokens and sign-in done with `jsonwebtoken`/`bcryptjs` directly, same semantics |
| 0137 | Express 5 (`/{*splat}` fallback, `req.body` default, `extended` query parser, `dotfiles: 'allow'` for `.timeshift`, listen errors exit) |
| 0138 | `/api/info` survives a failing feature check; stored badges stripped once and on the Xtream ingest path; P2-8 tests; recording Range accepts suffix and past-the-end ranges |
