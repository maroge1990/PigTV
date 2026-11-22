# Playback

Every client, every live channel, takes one path: resolve → HLS session ([`../ARCHITECTURE.md`](../ARCHITECTURE.md) ›
The playback path; admission and the provider slot are in the same file). This page holds the detail and the lessons:
read **Diagnosing playback** before changing anything here, and capture before changing (AGENTS.md rule). The shared
ingest that sessions read through is [`ingest.md`](ingest.md); the Apple player's side is the client's
`docs/ARCHITECTURE.md` › Player (live plays are held 30 s behind the edge).

## HLS sessions

**HLS sessions** (`transcodeSession.js`, `playbackStrategy.js`)
- 4 s segments; the playlist keeps 90 plus 12 spare (`hls_delete_threshold`), with
  `independent_segments+delete_segments+temp_file` and no `append_list`. The directory is on a **2 GB tmpfs** (verified).
- fMP4 when copying HEVC or when the codecs are fine (hls.js can't demux HEVC from TS). HEVC gets `-tag:v hvc1`; copied AAC gets
  `-bsf:a aac_adtstoasc`, and only AAC does.
- **HE-AAC** (the provider's 7 channels, among others) is re-encoded to AAC-LC (MPEG-TS out), because Chrome can't decode it. A client
  that sends capability **`heaac: true`** gets it copied into fMP4 instead (0116). **The Apple client always sends it** (app build 27,
  Mark's decision after test 2.9: passthrough is always on; its `'fmt?'` → `audioEncode` fallback is the safety net); the web never does. The
  copied init segment signals **AAC-LC 24 kHz with implicit SBR** (ASC `13 10`: ADTS carries no more); ffmpeg decodes it as HE-AAC
  48 kHz, Chrome doesn't. Measured on `pos_1164`/`pos_1165` with ffmpeg 9.0: no warnings, A/V offset kept exactly (the re-encode shifts
  audio ~21 ms).
- **Channel profiles** (0114, `channelProfiles.js`, table `channel_profiles`, key = sha256 of the probe-cache key). Written only after a
  session produced its playlist from a fresh probe; a failed start from a profile deletes it (and its in-memory copy); re-probed after
  `PIGTV_PROFILE_MAX_AGE_DAYS` (7). **`dtsUneven` and `videoRange` ride in the profile**, so a feed whose timing or range changes is
  re-classified within 7 days or on its first failed start. Always on (the off switch went in 0204).
  #240: a start from a profile also shortens ffmpeg's own analysis to 5 MB / **2 s** (`analysisWindow: 'short'`, log
  `, analysis window short`); 1 s and 0.5 s lost the picture or the timing on a join far from a key frame
  ([bench](../evidence/2026-11-17-start-speed/README.md), `stream-doctor bench --window`). A short-window start that ends
  before its first segment for a reason not the provider's runs once more with the full window in the same session; if
  that plays, the profile keeps `fullWindow` (beside the analysis, never sent to the client) and the channel starts with the
  full window until the profile is re-probed.
  #332: a probe of the provider's placeholder is never kept, as a profile or in the 5-minute memory: not when the probe's
  shared feed ended as the placeholder or had a short low-rate connection, nor when the session's feed did, nor while the
  feed is held back for it; a profile saved from a fresh probe is dropped when the feed later ends as the placeholder.
  A failed start on the placeholder keeps the channel's existing profile.
- **Timestamps: two kinds of feed** (0088). *Uneven* feeds have about a third of their DTS steps as ~1-tick-then-double, left by
  an upstream muxer (Fox Sports 505), and need `-fflags +igndts`. *Even* feeds (TSN, Sky UHD, Sportsnet 4K) are **broken by**
  `igndts`. `streamProbe.classifyTimestamps()` decides per feed: steps below ¼ of the mean frame period >5% ⇒ uneven (measured
  33.8% vs 0.0%). It runs on the resolve probe's **own** ffprobe call (`-show_packets -read_intervals %+#300`), because a second
  ffprobe would collide on the one provider connection; without `-read_intervals` a live probe never returns. Also always
  `-dts_delta_threshold 60`. Never apply `igndts` everywhere: that was the 0085 regression (the switch for it went in 0204).
- **Pacing:** only when the probe says the source ends (`format.size` or `duration` present). A finite file read at full
  speed outruns the window, and hls.js never retries the resulting 404. Blanket `-re` cost ~8 s at start-up. Since 0144 it is
  `-readrate 1 -readrate_initial_burst 8` (ffmpeg 6.1+): 8 s at full speed so the first segment is written at once, then real
  time. Measured on ffmpeg 9.0 only (first segment 3.6 s → 0.1 s, then exactly 8 s ahead); **unverified on production's ffmpeg
  6.x** (the check, R2.5/R3.11, is deferred: the file-based channel wasn't found again). `PIGTV_READRATE_BURST=0` = the old `-re`.
- **Master playlist** (0100 HDR, 0115 everything). tvOS only switches the panel to HDR on a **master playlist's `VIDEO-RANGE`**, and
  Match Frame Rate only goes to 50 Hz on its **`FRAME-RATE`**. The copied fMP4 already keeps `colr`/`nclx` (measured on `pos_31`, Sky
  Sports Main Event UHD, HDR10/PQ). `classifyVideoRange()` reads `color_transfer`: a copy+fMP4 PQ/HLG session gets `VIDEO-RANGE=PQ|HLG`;
  **every other session with a usable frame rate** (`avg_frame_rate`, else `r_frame_rate`; 0/0 and values outside 1–240 ignored) gets
  `VIDEO-RANGE=SDR` (an encode is SDR). An HDR feed copied into MPEG-TS, or one with no usable rate, still gets `stream.m3u8`. One
  variant: `BANDWIDTH`, `RESOLUTION` (copy only), `FRAME-RATE`, `VIDEO-RANGE`, **no `CODECS`** (a wrong one makes AVPlayer refuse).
  The custom Apple player sets `preferredDisplayCriteria` itself, built from the resolve `info` (`fps`, `videoRange`) since app
  build 27 so nothing waits on the asset; on a non-HDR TV it falls back to the same session's `stream.m3u8` on AVFoundation
  error -11868. Verified by Mark: 50 Hz (1.12) and the HDR panel switch on the HDR TV (1.13).
- **How a session ends** (0104). `stop()` marks it `stopped` before signalling ffmpeg, so any exit we didn't ask for is an `error`
  (`FFmpeg exited with code N` / `was killed (SIG)`). The software-decode retry (clear the folder, restart on the CPU) is only for an
  **encode** that really decoded on the GPU and died within 10 s **before any playlist**.
- **A start stopped on request is not a failure** (0180). `stop()` sets `stopRequested`; `playbackStrategy.resolve` then throws `superseded` (route: HTTP 499, `{error: "Playback was replaced by a newer request", superseded: true}`) instead of failing over. Nothing is noted: no breaker, quarantine, channel-health row or failure event. The route also keeps a per-owner generation and starts no further candidate once the owner's newer resolve exists.
- **One walk through the providers** (D-7): starting a viewer on the first candidate that can be admitted without disturbing
  anybody (admit, start on the lease, give back a lease the start did not bind) is `playbackStart.js`, used by the route's first
  pass and the relay's cold switch. Its header names the starts that are deliberately not this walk (forced pass, warm adopt,
  standby, warming, recording).
- **A failed start fails fast** (0113). `waitForPlaylist` returns as soon as ffmpeg has ended without a playlist (it used to poll out the
  15 s). `classifyInputFailure()` turns ffmpeg's `Server returned 4xx/404/5xx` / `Connection refused` into a fixed sentence for the
  resolve error (never the URL or ffmpeg's words). A **4xx other than 404, or a 5xx, within ffmpeg's first 3 s** (the provider allows
  one connection and may not have released the probe's yet; seen on 7 Flix Sydney in the 0109 log) gets a retry: folder cleared,
  a wait, same shape as the software-decode retry. Since 0143 **two**, after 1.5 s then 3 s (a re-resolve after a player failure
  was still refused after 1.5 s), and `waitForPlaylist`'s deadline moves by exactly what the retries cost (worst case +10.5 s
  on the resolve's 15 s; the Apple client's request timeout is 35 s).
- **Stall watchdog** (`stallWatchdog.js`): ffmpeg is killed after 20 s without writing a file in the session directory
  (`PIGTV_STALL_TIMEOUT_MS`), with 30 s grace before the first output. Stderr doesn't count, because it gets louder during
  reconnects. Recordings aren't covered (they have a hard-stop timer). On the shared ingest (R7, 0282) a pause in the feed is
  excused: the ingest calls a feed lost by its PCR at a per-channel/provider limit (0292: default 24 s, up 2 s on a lag reconnect, ceiling 28 s; `PIGTV_INGEST_BEHIND_SEC` sets the default), and the watchdog and
  the relay excuse ffmpeg only while it has been handed less than their limit's worth of media since its last output (0283), then the limit again in time, once (0284); no PCR, no excuse. Bursty providers pause 3-16 s while healthy (FINDINGS FR-8). Each ingest that read a minute or more
  leaves a `feed_lag` row on close (0287, `feedLag.js`, 30 days): channel and provider by name, worst lag over every connection,
  reconnects and how many were for lag; Status shows it per channel and provider. The current limit is shown beside the worst lag. Limits use the provider source + stable channel key (item id only when no stable id), persist across restarts, and fall 2 s after 3 measured reading hours whose worst lag stays ≥4 s below the level. Lag or marginal headroom resets that clean window; no-PCR feeds keep the default silence rule. Since 0298,
  different URLs of one provider/channel share one retained learning state; overlapping reading intervals count once.
  The last ingest releases the state, and Status reads do not retain it.
- **Only network URLs are opened** (0104, `streamUrl.js`: http(s), rtmp(s), rtsp(s), udp, rtp, srt). Resolve, the session route,
  `/api/probe` and `/api/subtitle` answer 400, and the check is repeated at spawn. It isn't done with `-protocol_whitelist`
  because stream-doctor and the tests run the real arguments against local files.
- Start-up ≈ resolve probe + ffmpeg's own 5 MB/5 s probe (2 s from a profile, #240) + one segment: **7.1–10.1 s** cold, **4.4–5.2 s** with the probe cached
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

## Media toolchain

- **0307** prepares FFmpeg/ffprobe **9.0.2** from verified source, selected first on PATH in the Ubuntu 24.04 image;
  Linux CI uses the same release/build recipe and tests the final candidate before publishing it. The deployed build was
  confirmed as 0305 with tools 6.1.1 during this review; Linux image and hardware/device validation of 0307 are pending.
  This upgrades the tools for parity, not to remove the existing FOX warnings. The recipe uses oneVPL, Ubuntu runtime
  libraries, and NVENC headers pinned to a compatible older API, not moving master. Optional-library differences are
  tracked in FR-25. Details: [`docs/architecture/playback.md`](#media-toolchain).
  One `dump_extra` remains, on the TS copy branch for video that is neither H.264 nor HEVC: never seen, and
  **only change it against a sample** (0043/0044: `dump_extra` corrupts copy sessions).

- `docker/media-toolchain.conf` pins the release archive hashes for [FFmpeg 9.0.2](https://ffmpeg.org/download.html)
  and [nv-codec-headers 11.1.5.3](https://github.com/FFmpeg/nv-codec-headers/tree/n11.1.5.3).
- `docker/build-media-tools.sh` checks both downloads, including cached files, before building. The FFmpeg checksum was
  computed from the official archive and independently matched the installed Homebrew formula. The downloaded PGP
  signature was not verified (no GPG installed); no signature-verification claim is made.
- Docker's `media-build` and `.github/actions/setup-media-tools` use that same recipe on **Ubuntu 24.04 amd64**.
  It explicitly enables software H.264/HEVC, AAC, MP3, VAAPI, NVENC/NVDEC, CUDA scaling, QSV through **oneVPL**,
  dav1d, XML2, iconv, HTTPS and SRT. FFmpeg's own
  libraries are static in the tools; external codec/driver libraries come from Ubuntu 24.04. Those system packages and
  Node are still allowed security updates; this is release/feature parity, not bit-for-bit reproducibility.
- The image puts `/opt/pigtv-ffmpeg/bin` first on PATH and does not install the distro ffmpeg executable. Comskip still
  links Ubuntu's separate libav* libraries; the new static FFmpeg libraries do not replace that ABI. Existing Intel/Mesa
  driver packages and the entrypoint/device-group behaviour remain unchanged.
- NVIDIA headers use the oldest API FFmpeg 9's configure explicitly accepts, with a documented minimum Linux driver of
  470.57.02. This avoids selecting current moving headers that require much newer drivers. Actual GPU execution still
  requires acceptance on the host. The Linux profile does not enable AMF encoders; those remain available only where a
  separately built toolchain includes them. FFmpeg links the oneVPL dispatcher (`libvpl`). Since 0312 the runtime recipe explicitly retains both
  legacy Media SDK (`libmfx1`, for older Intel graphics) and modern VPL GPU (`libmfx-gen1.2`) implementations.
  [Intel documents](https://github.com/intel/libvpl) this dispatcher/runtime distinction. Actual Intel hardware
  encode/decode is not established by compile-time capability checks.
- `scripts/check-media-tools.js --hardware` rejects a wrong release of **either** tool, missing software/hardware
  encoders or filters (including `scale_cuda`), and missing HTTPS/SRT support. It checks compiled support without opening
  a GPU or provider, and checks required decoders and demuxers. `scripts/check-encoder-options.js` queries the actual
  session builders' private options against each encoder's own help output (0312 rejects malformed/valueless
  builder flags rather than shifting flag/value pairs) and runs real software lavfi encodes at all
  three quality levels. Hardware execution still requires host acceptance. Build failure or a missing required
  capability stops the image; there is no fallback to a stripped build. Optional external libraries not named by the
  explicit profile are not asserted to match the deployed 6.1.1 build; see FR-25 in `docs/archive/FINDINGS-2026-10-30.md`.

No production session, recording or probe command-line flags change. Apple capabilities, endpoint shapes and the 30 s
hold remain unchanged. This is not a fix for FR-22's startup stall or unmeasured iPhone sound timing.

How the candidate image is validated before publication is in [`../TESTING.md`](../TESTING.md) › CI and the media
toolchain; rollback is in [`../OPERATIONS.md`](../OPERATIONS.md).

## Web player

**Web player** (`VideoPlayer.js`, 0102)
- `play()` always resolves with `segmentedDelivery:true` and plays what comes back. **Recovery = ask the server again**
  (`recoverPlayback`): a failed resolve, or a fatal hls.js error including a segment 404, gets a fresh session (never the
  dead one, which is given back first). Before the first picture, once per selection. **After it (#321, the Apple model):**
  up to 3 reconnects in any 10 min, after 0, 3 and 10 s, with "Reconnecting…" on screen; each first asks
  `terminal-status` and stops with "Playback moved to another device." on `taken-over`. A **stall** is the picture not
  moving for 35 s while not paused, not seeking and the tab showing; it, and `ended` on a live stream, count as failures.
  Out of attempts: the session is released and the error has **Try again**. A newer play, Stop, pagehide or sign-out
  cancels a pending reconnect (the play generation). A fatal *media* error is first tried in place (`recoverMediaError`, once).
- **Chrome aborts the whole `<video>` on one rejected audio frame.** On an audio `MEDIA_ERR_DECODE`, the player replays once
  with `audioEncode:true` (the session re-encodes only the audio) and remembers the channel in
  `localStorage['pigtv_audio_encode']`.
- No `/api/subtitle` tracks on live: that route opens a second provider connection.
- Chrome keeps the old URL in `currentSrc` while raising "Empty src attribute", so detect a cleared source from the `src`
  attribute (`isSourceCleared`) and make `vm` test fixtures behave like real Chrome.
- **The web reads `/api/library`** (0121): the sidebar pages `/library/channels`, the guide pages `/library/guide` (500 a page,
  cursor, the 24 h on screen), favourites are `/library/favourites` + `POST/DELETE /api/favorites` with the bare id, and a play
  resolves by source + bare id (the web never holds a stream URL). Movies, Series and the VOD watch page were deleted in 0122.
- **Sport events feed playback only through the ordinary resolve** (C-I, 0148): an event's `channels[0]` is the best channel
  (quality from the name, then health ok, then favourite, then guide order) and is played by source + id like any other; nothing in
  this section changes for it. Since 0150 a replay item (`kind: "replay"`) plays the same way.
- `/api/proxy/stream` **streams** binary content and drops the upstream when the client leaves (0104). Playlists are read whole
  (they're rewritten, and `?token=` is carried onto every URI). It takes `?h=` (a handle from `playbackHandles.js`: 32 hex,
  in memory, 12 h, LRU-bounded at 10,000; a restart forgets them, unknown → 404; a manifest fetched by handle hands out
  handles for its URIs); since 0196 a `?url=` is refused (400) and there is no rollback. It is the only route left in
  `routes/proxy.js` (0122).
- **Resolve errors** (0118, contract C-B): every provider/channel failure starts "The provider refused this channel",
  "The provider did not respond" or "This channel is not available" (texts in `playbackErrors.js`); a failed ffprobe is
  classified like ffmpeg's stderr and never returned raw; the route strips any `scheme://` from whatever else it returns.

- `routes/proxy.js` has not been split (one route, not needed so far).

## Diagnosing playback

**Diagnosing playback: `scripts/stream-doctor.js` — reach for this first on any playback fault.** Run it as `docker exec PigTV node scripts/stream-doctor.js …`:
- `list <search>` → `pos_N`
- `capture <pos_N> [sec]`: the real feed, plus a verdict
- `classify <sample>`
- `bench <sample>`: the server's **own** argument builders, scored per flag set; `bench --window <samples…>`: ffmpeg's analysis window, full vs shorter, per join point (#240)
- `probecost <pos_N>`

`capture` and `probecost` take the provider connection, so **nothing may be playing**. Samples live in `/app/data/samples` (the bind
mount; they survive deploys) and are the regression corpus. A sample is evidence: it has to outlive the build it was taken on:
- `pos_31` Sky Sports Main Event UHD (HDR10, even)
- `pos_1187` Fox Sports 505 (**uneven**) as captured in September; `pos_463` TSN, `pos_328` Sky Sports UHD (HEVC),
  `pos_468` Sportsnet 4K: even

**`pos_N` is a playlist position, not an identity: the provider reorders.** By 18 Oct `pos_1187` was beIN Sports 3 and Fox
Sports 505 was `pos_1182`, and **Fox Sports 505 measured even** (0 % near-zero steps, from 33.8 %): no current sample
exercises the uneven (`igndts`) path, which is covered by the unit tests only. Find a channel with `list <name>` before a
capture, and name the channel next to the file. The samples folder on 18 Oct: `pos_31.ts` (Sky Sports UHD, HDR10 50 fps),
`pos_1164.ts`/`pos_1165.ts` (7 channels, HE-AAC), `pos_1157.ts` (30 fps), `pos_29430.ts`, `pos_31148.ts` (50 fps),
`pos_1187.ts` (beIN Sports 3, 1080p, even), `pos_1182.ts` (Fox Sports 505, 720p, even), and three ~700 MB `pos_1178`
captures.

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
(joining mid-GOP; a reader joining a running shared feed starts on a key frame since #3, [`ingest.md`](ingest.md) › Subscribers), and a handful per hour of `Non-monotonic DTS` / `Packet duration … out of range`. A *flood* of those two means
a wrong classification. `Could not find codec parameters … eac3 … 0 channels` means the probe ended early; suspect it if audio is
silent from the start. **Real problems:** `Could not write header`, `FFmpeg exited with code`, `was killed`,
`Releasing stalled session`, `[HLS] 404 for …`, `asking the server again` repeating on one channel.

**Client diagnostics.** `POST /api/playback/client-event` (token; whitelisted, bounded fields; path only, never a query string):
`media-error`, `start-timeout`, `play-start`, `play-end`, `av-desync`. Log lines end `from=user:<id>` / `from=device:<id>`.
`av-desync` (#268) is the player's "Sound out of step" mark: one line, `[Player] av-desync t=<s>s buffered=<s>s behind=<s>s rate=<r>
catching-up=<bool> stalls=<n> watched=<s>s from=device:<id>` then the owner's open relay in brief (`streamRelay.forOwner`,
`Relay.brief()`): `relay=<id> leg=<n> provider=<name> switches=<n> since-last-switch=<s>s|none standby=off|none|starting|ready`,
or `relay=none`. A number out of range or not a number reads `?`; the provider is a name (spaces as `_`), URLs stripped.
It uses the fault reports' limiter, never counts against the channel's health, and is a "Sound out of step" row in Status ›
Recent plays. `scripts/playback-report.js <saved log>` summarises first-picture time (cold/warm, median and p90), **client wait** (first
picture minus resolve, median/p90, 0145: the player's own share), stalls/hour, `av-desync` marks (counted on the sender's
next `play-end`, with the plays they fell in) and failures, per row: `HLS session`, `HLS session [Apple/device]`, `direct` (0113 relabelled it for the one-path world; a "probe profile" play is warm).
**Log vocabulary added in 0113–0115:** `resolve timing … probe profile (age Nd)`; `… first segment NOT produced - ffmpeg ended after Xs
(provider HTTP 4xx)`; `… , master playlist (SDR, 25.000 fps)`; `[TranscodeSession id] Provider refused the connection; retry N of 2
in 1.5s|3s` (0143; was "retrying once in 1.5s"); `… source ends (N min) - paced to real time after an initial 8s burst` (0144);
`[Logo] Cache version 1 -> 2: dropped N stored logos` (0141, once); `FFmpeg ended before producing a playlist`. **Captures** (0191): `capture` saves the
provider's raw bytes, so a backward step or a dropped connection shows as itself; before 0191 it copied through ffmpeg, which
rebased the step first (a reconnect showed up only as repeated content, and every capture "classified EVEN").

## In-stream recovery (relay) and hot standby

**In-stream recovery and the hot standby** (0189, switches since 0197: Settings → Playback, both off by default;
`streamRelay.js`; the brief is `docs/archive/STANDBY-BRIEF-2026-10-02.md`)
- A **relay** follows a channel play's HLS session. Its id is the first session's, so the client's URL never changes. Each
  **leg** is an ordinary session (own ffmpeg, folder and connection, counted by the pools). Until the first switch the
  playlist is ffmpeg's own file; from then the relay renders it (`hlsPlaylist.renderMediaPlaylist`), later legs' segments
  named `L<n>-seg…`, with an `EXT-X-DISCONTINUITY` at each join.
- A leg joins only if segment type, video range, codec, frame size, frame rate (±1%) and audio match; the master playlist the
  player holds cannot change.
- **Cold switch** (recovery only): the lost leg is quarantined, candidates are planned again, and the first that starts
  becomes the next leg; if none does, the relay ends (404, the client re-resolves: the old behaviour).
- **Standby**: 20 s into a play, a second copy on the first other provider with a *free* connection, owned by
  `standby:<relay id>`; a viewer or recording that needs that connection takes it without a prompt, and a standby may take a warmed channel's connection (0202).
  When the playing leg writes nothing for `PIGTV_RELAY_SWITCH_MS` (10 s) the standby is spliced in.
- A feed the shared ingest finds **repeating the same clip** (#324, [`ingest.md`](ingest.md) › Looping feed) ends as lost:
  the relay switches with reason `repeating` (`<provider> kept repeating the same N s clip`), to the standby when one is ready.
  Only when another provider can take over; with none it plays on. Feeds without sound are not checked (the sound must
  confirm a loop). Only feeds read through the shared ingest are checked:
  a play or recording that opens the provider URL itself (shared connection off, or refused) is not.
- A feed the shared ingest finds sending the **provider's placeholder** (#332, [`ingest.md`](ingest.md) › Placeholder feed)
  ends as lost with reason `placeholder`, whether or not another feed can take over. A later leg's loss switches as any
  other; leg 0's ends the relay (failed) instead, since the stream the player holds (its master playlist, the relay's
  fingerprint) was described from the slate: the player asks again and its resolve probes afresh. While the channel's feed
  is held back for it (3 min) and nothing else can play it, the resolve answers C-B's "This channel is not available right
  now: nothing is on this stream at the moment." without opening the provider.
- **The placeholder file** (#348): a live channel's candidate that answers with a file (the probe says its media ends;
  the ingest's Content-Length alone never counts, an HLS manifest has one) of the placeholder's shape (1920x1080 at 30 fps) or at most 15 min long is the provider's placeholder: no
  session starts, its probe, profile and measurement are dropped, it is held back 3 min, and the walk tries the next
  candidate (`playbackStrategy.isPlaceholderFile`). A long real-rate file plays as before.
- **Mid-play, without a shared feed** (#348): the 20 s blank verdict on a play that reads the provider itself (a file, or
  the shared connection off) is the placeholder when the source has its shape or a length; the play ends as lost with
  reason `placeholder` (held back 3 min) and the player's re-resolve moves on. A dark channel of another shape is noted only.
- **The game's next channel** (#348, C-J): when every candidate of a channel failed as (or was skipped as) the placeholder,
  the resolve finds the one live C-I game (kind `event`) listing the channel now (`sportsEvents.liveEventFor`, from the last
  built list, never a build; by source + stable id, else id; or the client's `eventId`) and walks its other channels in
  C-I order, each through its own routing plan and the same admission walk (never disturbing anybody), skipping the same
  stream and any held back as the placeholder, within the resolve's 30 s. The answer gains `fallback`.
- Known limits: the feeds aren't in step (a jump or repeat at a switch); a cold switch still waits for the 20 s stall
  watchdog; the provider in Stream info is the one the play started on. A switch applies to plays started after it changes.

### The relay's transition table (#41)

`Relay.state` is what Status shows: `starting` (leg 0, nothing joined), `playing`, `standby-starting`, `standby-ready`,
`switching` (inside `switchOver`, transient), `promoted` / `reclaimed` (shown for 60 s), `failed`; a closed relay is gone
(404). Connections: the **playing leg** holds one (its session on a shared ingest, owner the viewer); the **standby**
one in another pool (owner `standby:<relay id>`, taken by anybody unasked); during a **planned renewal** the stopped
old leg stays registered and a `renewal-pin` reader keeps its ingest, which the new leg joins (no new connection).
The table is not a data structure in the code (that would mean reshaping `tick`/`switchOver`); its rows are asserted
for every step by the model test `test/stream-relay-model.test.js` (random event sequences against the real relay,
coordinator and start walk: one connection per pool, no pin or reader left after the end, a monotonic playlist with a
discontinuity exactly at each leg change, every leg stopped, no timer left).

| Event (where it is seen) | Action |
|---|---|
| The playing leg writes (`tick` → `ingest`) | Its segments join the list; `starting` → `playing`. Nothing else |
| Leg lost: stall, exit, broken timestamps, repeating clip, placeholder (`tick`, `leg.lost`) | `switchOver`: a ready standby is promoted (`promoted`); else the old leg is retired first, the providers are planned again and the first that starts is the next leg (cold). Nothing starts: `failed` (`no-candidate`). Leg 0 as the placeholder: `failed` at once |
| The playing leg writes nothing for 10 s with a standby ready (`tick`) | The standby is promoted (`stalled`); never without a ready one |
| Standby due (20 s in, then every 60 s while there is none) | `startStandby`: a lease on a free connection in another pool (or one a warm channel holds), then a standby leg; nothing free, nothing started |
| Standby lost, or its connection taken (`tendStandby`) | Dropped (`failed` / `reclaimed` shown), retried in 60 s; the play goes on |
| The shared ingest reconnects on a leg with renewal on (`timeline-restart`) | The session stops itself; within the budget (3 a minute) a **planned renewal**: same feed, same candidate, never the standby, never a re-plan, no interruption counted; a new leg joins the same ingest behind a discontinuity. Over the budget: ordinary failover (`renewal-budget`, the channel quarantined), then the primary once more without renewal. **A renewal that cannot land** (#4, 0904: its new leg has no playlist, or the ingest does not settle within 20 s): `renewal-failed` is noted and counted as an interruption, the channel is quarantined on that provider (the renewal's own start never counts toward the provider-wide breaker, 0905), renewal is off for the rest of the play, and the play recovers as from a stall of the leg: a ready standby, else the provider walk (without the failed feed), else that feed once more without renewal. Only that ordinary path finding nothing ends the play (`no-candidate`) |
| The ingest ends under the leg (upstream lost) | As a lost leg |
| The leg is stopped on request (DELETE, takeover, idle sweep), the viewer plays something else, a cold start finds the viewer's newer stream | The relay ends (not failed); nothing is started for it |

**Renewal (#4, 0904).** A planned renewal is opportunistic: it may never make a healthy play worse. The old leg's ffmpeg
stops at the reconnect (it cannot take the new connection's timestamps), so a renewal that cannot land falls back to the
ordinary recovery above instead of ending the play (0903 ended it: the 29 Oct FOX Kansas City stop, where the client
then spent its one recovery and the next stall was fatal). The relay rig shows it: `node scripts/relay-rig.js standby
reconnect renew-stall sync long` (A's reconnected feed sends a burst, then nothing) ends the play on 0903's relay
(`failed`, `no-candidate`) and is promoted to the standby on 0904's (A/V 0 ms across the join); without `standby`, the
provider walk takes B. The wait for the renewal's deadline is still part of the gap (22–31 s on the rig): the player's
30 s hold covers most of it. Renewal stays off by default (D-25).
**Known limitation (renewal on only):** the fallback has no supersession check of its own beyond the cold start's, which
treats any other session or pending viewer lease of the same owner key as a newer play; for a plain login that key is
shared by every tab, so a wider use (tried in 0905–0906) ended plays wrongly and was taken out in 0907. A newer play of the
same device that arrives while a failed renewal's fallback promotes the standby or starts a leg can therefore leave two
plays running until the idle sweep. With renewal off (the default) the relay is as at 0903: the model test's sequences
give byte-identical traces on 0903's relay and 0907's.

The relay's reconnect renewal and its budget, and the standby reading through the shared ingest, are in
[`ingest.md`](ingest.md) › How the shared ingest works. Decision D-25 in [`../DECISIONS.md`](../DECISIONS.md) keeps
renewal off in production until reconnect handling is tested.
