# PigTV: blueprint (single source of truth)

**Last updated:** 1 October 2026 · server build **0178** (built, not pushed) · Apple client build **36** (pushed) · **multi-provider failover built, awaiting round 7**
(`../PigTV-Swift/blueprint.md`)

Read this at the start of every session. It covers **the server, the web app and the joint roadmap**; the Apple client's own
architecture notes live in `../PigTV-Swift/blueprint.md`, which points back here for the roadmap. This file replaced the
earlier blueprint on 23 September 2026, after an independent review of both products. Everything older is frozen in
`docs/archive/` (see its README) and is history, not instructions.

Keep it **short**: current state, durable facts and the roadmap. When an item ships, mark it in §6, add one line to §8, and
put any long story in the commit message.

**Sections:** 1 Orientation · 2 How changes ship · 3 How playback works · 4 Each area · 5 Frozen Apple contract · 6 Roadmap
and status · 7 Rules and decisions · 8 Shipped log · 9 Configuration reference (every `PIGTV_*` variable) · 10 Known
limitations and open issues.

| Document | Use it for |
|---|---|
| `blueprint.md` (this) | How things work, the rules, the roadmap and its status |
| `README.md` | The short entry point: what PigTV is, how to run it |
| `docs/SWIFT-CLIENT-HANDOFF.md` | The Apple-client contract, the current `/api/info` flags, and the log of server changes the client must know about (its §5) |
| `docs/ROADMAP-CONTRACTS.md` | The server ↔ client contracts C-A…C-K (all implemented) |
| `docs/TEST-BLOCK.md` | Mark's device and live test rounds 1–7, with a status summary at the top |
| `docs/MULTI-PROVIDER-BRIEF.md` | Multi-provider failover (30 Sept): decisions, design, work packages P1–P8/A1 |
| `../PigTV-Swift/blueprint.md` | The Apple client: architecture, device-verification state, client rules |
| `docs/archive/` | Frozen: the old blueprint, per-build write-ups (0048–0104) and the 16 Sept code review (P1-x/P2-x reasoning) |

**Core requirements.** An IPTV server with a web app (this repo) and Swift clients (Apple TV first, then iPad and iPhone).
**Picture quality and stream stability come first**, then less overhead and complexity. **Stability and quality outrank
channel-change speed** (Mark, 20 Sept; reaffirmed 23 Sept: "quality of image should be the priority").

---

## 1. Orientation

| | |
|---|---|
| What exists | **Server** (Node 24, Express 5, SQLite via `better-sqlite3`, ffmpeg): M3U/Xtream + XMLTV sources, the guide and library APIs, one playback path (resolve → HLS session), recordings (DVR with Comskip ad detection), channel numbers, channel health, EPG matching, sport events, a logo cache, device pairing. **Web app** (`public/`, no build step): Home, Live TV, Guide, Recordings, Status (admin) and Settings (Sources, Player, Transcoding, Manage Content, Channel numbers, EPG matching, Sports, Recording, UI, Devices, Debug, Users). **Apple client** (tvOS first, iPad, iPhone): `../PigTV-Swift`. |
| Repos | Server/web: `github.com/maroge1990/PigTV` → `/Users/markrogers/Documents/GitHub/PigTV`. Apple: `github.com/maroge1990/PigTV-Swift` → `/Users/markrogers/Documents/GitHub/PigTV-Swift`. Development is on Mark's MacBook only (from 23 Sept). |
| CI | Both repos are **public** since 30 Sept (free Actions minutes; history checked for secrets). `gh` is signed in on the MacBook: `gh run view <id> --log-failed`. On a push to `main`, `docker-publish.yml` runs `test.yml` (Ubuntu, Node 22 and 24) and builds `ghcr.io/maroge1990/pigtv` **only if the tests pass** |
| Deployment | Unraid box "PassyFlix", `http://192.168.1.235:3000`, container **`PigTV`**, reached over Tailscale only. Data folder on the host: `/mnt/user/appdata/nodecast_tv/data` (→ `/app/data`; back it up before a risky deploy). **Recordings (fixed 28 Sept):** host path `/mnt/remotes` → container `/app/recordings`, Access Mode **Read/Write - Slave** (so an SMB share that mounts late or reconnects appears inside the container); the recordings folder setting is `/app/recordings/SERVER01_Video/Recordings`. A plain bind of the share's subfolder went stale and showed Unraid's 1 MB tmpfs (schedule #3 failed with "0.0 GB free"). Mark deploys (Unraid → Docker → PigTV → **Force Update**); env vars are set on the same Edit page (§9). |
| Shipped through | **0204** and app **39** (4 Oct; §6). Whether a build is *running* is whatever `/api/version` says. |
| Next build number | **0205** |
| Tests | `npm test`: **878 tests, all pass** (4 Oct, Node 24.21, Homebrew ffmpeg; tests that need ffmpeg skip without one; speed budgets run locally, and in CI's non-blocking `perf` job). `bash scripts/verify-build.sh .` passes. |
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
   Both must pass, and a push happens only after both have passed. If either can't be run, say so and don't push.
   `verify-build.sh` is for what a test cannot check (things that must not come back, placement, the image and CI,
   web markup, the build numbering); behaviour is proved by a test under `test/`.
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

**How work is organised.** The lead Claude session plans and either does the work itself or delegates parts to sub-agents
(as Mark asks per build; never Haiku), and **reviews every diff** against this file's rules before it's pushed. Any
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
  that sends capability **`heaac: true`** gets it copied into fMP4 instead (0116). **The Apple client always sends it** (app build 27,
  Mark's decision after test 2.9: passthrough is always on; its `'fmt?'` → `audioEncode` fallback is the safety net); the web never does. The
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
- **A failed start fails fast** (0113). `waitForPlaylist` returns as soon as ffmpeg has ended without a playlist (it used to poll out the
  15 s). `classifyInputFailure()` turns ffmpeg's `Server returned 4xx/404/5xx` / `Connection refused` into a fixed sentence for the
  resolve error (never the URL or ffmpeg's words). A **4xx other than 404, or a 5xx, within ffmpeg's first 3 s** (the provider allows
  one connection and may not have released the probe's yet; seen on 7 Flix Sydney in the 0109 log) gets a retry: folder cleared,
  a wait, same shape as the software-decode retry. Since 0143 **two**, after 1.5 s then 3 s (a re-resolve after a player failure
  was still refused after 1.5 s), and `waitForPlaylist`'s deadline moves by exactly what the retries cost (worst case +10.5 s
  on the resolve's 15 s; the Apple client's request timeout is 35 s).
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

The tuner model (0126–0155: shared tuners, timeshift, HLS recordings) was removed in 0204; see §6 and git history.

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
scrubbed. Look here before `docker logs`. Since 0133 it also lists the **least reliable channels** (7 days; since 0142 also
channels that only stall, ranked by failed starts + stalls per hour watched, hours floored at 30 min; stalls and minutes shown).

**Channel health** (0133, C-G, `channelHealth.js`, table `channel_health`): one row per start attempt per identity, kept 30 days
(pruned daily). A failed resolve is a failed start (a 409 is not an attempt); a client `media-error`/`start-timeout` before
that owner's `play-start` turns its last resolve into a failed start (`player`); `play-start` gives the first-picture time.
Client events carry no session id, so the mapping is owner → last resolve (as 0124). Since 0142 `play-end` stores
`watched_sec`/`stalls` on that attempt (once, within 24 h). `health` on guide/channels rows: flaky = ≥2 failed starts or >30% of
≥3 in 7 days, or ≥3 stalls per hour over ≥20 min watched. `library_rev` moves only when a channel's class changes.

**Sport categories** (0146, C-H, `sportCategories.js`, table `sport_categories`): Settings → **Manage Content** → the Sport
button at the end of a category's row (saved at once) = `PUT /api/library/categories/sport` (admin); `library/categories` and the Sources catalogue carry
`sport`. No sync writes the table; a change bumps `library_rev`. Since 0148 it is **one signal** of sport recognition (below),
not a row of its own (C-I replaces the C-H Home row).

**EPG categories** (0147): `epg_programs.categories` = the programme's XMLTV `<category>` values as a JSON array (trimmed,
de-duplicated, ≤12; NULL if none), filled by `syncEpgFromUrl` (EPG sources and Xtream `xmltv.php` alike). An older database
gains the column and its `epg_live` view is **dropped and recreated** (a view keeps its column list). Only data synced since
0147 has categories: **Sync now** after deploying. `GET /api/sports/categories` (admin, top 200, cached per EPG generation) =
the Status page's "EPG categories" panel (loaded once per visit, not on the 5 s refresh).

**Sport events** (0148, C-I, `sportsEvents.js`, `routes/sports.js`, table `sports_follow`): per programme, sport = (a) a category
in the vocabulary, (b) a followed keyword in the title/categories, or (c) a C-H sport category's channel + a live-looking title
("live", "vs", " v "). A keyword that names a league follows its canonical league in every spelling (`sportsClassify.LEAGUES`:
F1 = Formula 1 = Formula One = FIA F1; AFLW = "Women's AFL" = "AFL Women's", apart from AFL; NFL, NBA, NRL(W), …); other
keywords match as whole words. **Kinds (0150, `sportsClassify.js`, pure):** each programme is `placeholder` ("no event", "coming
up", a bare trailing ":", only league + channel words, a date more than a day from the airing, the same title in ≥3 back-to-back
identical blocks on its channel, "24/7", "channel guide", a replay word with no game named) > `show` for highlights ("Hls",
"Bitesize", "Plays of") > `replay` (a game or session + replay/re-air/classic/throwback/playback/mini/condensed, or a year before
the season: Jan–Mar count as last year's) > `show` (a word list: tonight, daily, report, gameday, pre/post show, …; "Live" with
no game) > `event` (a match-up "A v/vs/at/@/x B", or a session: practice 1–3, qualifying, sprint, race/GP, finals, PF1/QF2, …)
> EPG news/replay categories (`show`) > a keyword-only title (`show`); category/sport-channel titles stay events. **Merging:**
same kind + canonical league + overlapping times + the same game: teams in either order (one name's words within the other's,
single letters as initials, "FRE"/"BRL" by their letters in order), or the same session and a compatible grand prix location;
a teamless session ("AFL Grand Final 2026") joins the one overlapping match-up of its league; a plain broadcast title ("AFL
Premiership Football") adds its channel to the event it overlaps most (not its times), else is a show; anything else by the
normalised title (lower case; tags, the channel's own name, live/HD words and punctuation removed). The item's title is the
cleanest form ("Carlton Blues v Richmond Tigers", "Azerbaijan GP · Practice 3", "Sydney Swans v Fremantle · Preliminary Final
2"); `aliases` lists the raw titles. Visible channels only, once per identity; EPG mapping honoured. Built once per (guide
version, follow-list version, 5 minutes; a minute before 0153) for 72 h + 5 min ahead and 36 h back (0152), loop detection
and live/replay included (~0.3 s on 1,000 channels × 30 programmes; ~1.1 s on 1,000 channels × 108 hourly programmes, the
whole 36 h + 72 h, where every programme is a match-up); a request filters and orders (warm ~20 ms, ~50 ms returning 10,000
items). The sync logs `[Sync] EPG covers until …, N h ahead` and says when that is less than 72 h. `GET /api/sports/events?hours=[&include=all]` (any user,
default 6, 1–72 since 0153; Apple route; events + replays, all kinds with `include=all`), admin `GET/PUT /api/sports/follow` (≤100) and
`GET /api/sports/preview` (next 72 h since 0153, every kind, with the rule and `kindRule`); web Settings → **Sports** (0149; grouped by
kind since 0151). **Built off the request path (0159):** a request is always served the last built result; a stale cache key
triggers a background rebuild (`scheduleRebuild()`, `setImmediate`, never inline in a request) after an EPG sync, on a
follow-list change, and from a timer aligned to the 5-minute bucket (`startBackgroundRebuilds()`, started once at server
startup); a request that lands mid-rebuild gets the previous result rather than racing it. Only the very first request ever
(nothing cached at all) still builds synchronously. Output is unchanged either way. Direct DB
edits don't move the cache key: tests call `sportsEvents.reset()`. The fixture `test/fixtures/sports-export.json` is Mark's
25 Sept export (titles). **Live or replay (0152, `sportsClassify.resolveLive`):** an event naming a game is checked across
its airings (same league + teams, or league + session + GP), first answer wins: (a) XMLTV flags (`epg_programs.flags`, a bitmask
from `epgParser.PROGRAMME_FLAGS`: previously-shown 1 → replay; premiere 2, new 4, live 8 (also a "Live" category) → live);
(b) the first airing within 36 h is live, one > 30 min later a replay, unless ≥ 20 h later and inside league hours (a series'
next game); (c) "Live" in the title → live; (d) `LIVE_HOURS` (per league, home time zone, `Intl`): outside → replay. A build
reads epg_live from **now − 36 h** (the sync trims nothing by time; whatever past the provider's feed carries) and drops items
that ended before now. The 0148 route tests switch `LIVE_HOURS` off (they use the wall clock); `test/sports-live.test.js` has it.
**A 0-th rule ahead of (a)-(d) (0161, `sportsFixtures.js`, `sportsClassify.fixtureVerdict`):** when ESPN's free scoreboard
(`site.api.espn.com/apis/site/v2/sports/{path}/scoreboard`) covers the airing's league and time, its answer is checked first -
matched to a fixture (the existing fuzzy team matchers, extended with the fixture's own displayName/shortDisplayName/name/
location/abbreviation as aliases; F1 by session + Grand Prix location, reusing `parseTitle`'s own location parsing on the
event name): live when the airing starts at/near the fixture's real kickoff (≤ 30 min after, and still running), else replay,
worded with the real kickoff (`ESPN: the game started Sat 1:30 pm; this airing is 19 h later`); not matched, but both teams
are known to the league and no such fixture exists: replay (`ESPN has no such game at this time`); anything else (unknown
teams, league not covered, no fixture data, ESPN down) falls through to (a)-(d) unchanged. A multi-day cricket Test (league
`Cricket` only - IPL/BBL are always a single day) is live on any of its scheduled days, not just near its first ball.
**Coverage, not just presence (0162):** every league's snapshot carries the exact `[from, to]` window its *last successful*
fetch covered and when that was; an airing outside that window gets no ESPN verdict at all, matched or not - stale or
out-of-window data must never decide anything, let alone manufacture a replay for a real live game ESPN simply has not been
asked about recently. The matched-fixture branch may still use an older but in-window fetch (a real kickoff time rarely
moves); the "no such game" branch (an absence, not a presence) additionally needs the fetch to be recent (≤ 6 h,
`NO_GAME_MAX_AGE_MS`) and the window to reach a full 12 h either side of the airing (`NO_GAME_HALF_WINDOW_MS`) - a day of ESPN
being unreachable falls straight back to (a)-(d) instead of quietly turning an unlisted live game into a replay.
Fixtures are fetched only for the leagues that matter (the follow list, or a marked sport category's name), refreshed every
30 min and after an EPG sync, kept in SQLite (`sport_fixtures`, `sport_fixture_teams`, `sport_fixture_status`) so a restart or
an ESPN outage does not lose them, and never block a request - `sportsEvents.buildEvents()` reads the last stored snapshot.
A successful fetch fully replaces that league's stored fixtures (cricket included, since every refresh re-discovers and
re-fetches every active series from scratch), so a postponed or removed game never lingers.
International cricket (Tests/ODIs/T20Is) has no fixed ESPN league id, so its series are found each refresh from ESPN's
cricket "scorepanel" and merged under the canonical league `Cricket` (`sportsClassify.LEAGUES`: IPL and BBL stay their own
leagues). AFLW has no ESPN feed and stays on the heuristics above. `PIGTV_SPORT_FIXTURES=0` turns fixtures off completely
(§9); the web Status page's "Sport fixtures" panel shows per-league last fetch, fixture count and last error.

**Logo cache** (0112, fixed 0141): `/api/logo/<key>`, key = hash of the cache version + URL. Downscaled through `format=rgba`
to an RGBA PNG only when wider than 320 px (a palette PNG with transparency otherwise came out opaque: ABC, 7mate, 7two);
SVG, small and unconvertible logos are kept as fetched. Bumping `LOGO_CACHE_VERSION` (`logoCache.js`) changes every path and
drops the stored files once (`meta.logo_cache_version`) - needed because the Apple client caches artwork on disk by URL forever.
**Sizes (0154, Top Shelf):** the fetched original is kept beside the resized copy (`data/logos/<key>.orig`; `logo_cache.original_type`,
`original_bytes`); `?size=full` serves it, `?size=640` a ≤640 px copy made once from it (`<key>.640`, same rgba conversion), no size
the ≤320 px copy as before, any other size 400. Same allow-list, max-age and version drop; each size has its own ETag. A logo stored
before 0154 is fetched again on its first `size=full`/`640` request.

**EPG matching** (0134, `epgMapping.js`, table `epg_mappings`, Settings → EPG matching): an admin's tvg-id per identity,
applied **at query time** over `playlist_items.tvg_id` (guide programmes, now/next, logo fallback), because every sync
rewrites that column. `GET /api/epg/unmatched` = visible channels with no programmes in the next 24 h + 5 name-scored
candidates that do have programmes.

**Client diagnostics.** `POST /api/playback/client-event` (token; whitelisted, bounded fields; path only, never a query string):
`media-error`, `start-timeout`, `play-start`, `play-end`. Log lines end `from=user:<id>` / `from=device:<id>`.
`scripts/playback-report.js <saved log>` summarises first-picture time (cold/warm, median and p90), **client wait** (first
picture minus resolve, median/p90, 0145: the player's own share), stalls/hour and failures, per row: `HLS session`, `HLS session [Apple/device]`, `direct` (0113 relabelled it for the one-path world; a "probe profile" play is warm).
**Log vocabulary added in 0113–0115:** `resolve timing … probe profile (age Nd)`; `… first segment NOT produced - ffmpeg ended after Xs
(provider HTTP 4xx)`; `… , master playlist (SDR, 25.000 fps)`; `[TranscodeSession id] Provider refused the connection; retry N of 2
in 1.5s|3s` (0143; was "retrying once in 1.5s"); `… source ends (N min) - paced to real time after an initial 8s burst` (0144);
`[Logo] Cache version 1 -> 2: dropped N stored logos` (0141, once); `FFmpeg ended before producing a playlist`. **Captures** (0191): `capture` saves the
provider's raw bytes, so a backward step or a dropped connection shows as itself; before 0191 it copied through ffmpeg, which
rebased the step first (a reconnect showed up only as repeated content, and every capture "classified EVEN").

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
number 30 days. **Numbers are labels only (0139, Mark's test 1.4):** `/library/guide` and `/channels` keep the provider's
order, which groups channels under the provider's placeholder channels; dead code for number ordering was removed in 0164.
Admin: `GET /api/lineup`, `PUT /api/lineup/numbers` (a reserved number yields to the admin; a visible holder is a 400).
`PIGTV_CHANNEL_NUMBERS=0` removes the `channelNumbers` flag (the Apple client then shows no numbers; numbers are still kept).

**Guide and library.**
- Query **`epg_live`**, never `epg_programs`. A sync loads generation active+1, flips it in one statement, then deletes the old
  one in slices; a failed feed leaves the guide untouched.
- Queries bound `start_time > from − 24 h`.
- `/api/library/*` fill a missing logo from the EPG (by tvg-id, then by name).
- **Ingest-time changes only show after a sync:** a redeploy skips any source synced in the last 24 h (`syncIfStale`), so use
  Settings → Sources → the source's refresh button (⟳, "Refresh Data"), which these docs call **Sync now**.
- Favourites store the bare channel id (`channelIds.js`); `GET /api/favorites` re-presents the composite form (the web no
  longer reads it since 0121).
- Channel numbers are edited in Settings → Channel numbers (0123), which saves only changed rows and shows the server's error.

**Auth, limits, routes.**
- Stateless bearer tokens (web login + paired devices); no sessions or cookies. Media routes (`/api/proxy`, `/api/transcode`, recordings' media) always need a token (0196; `requireStreamAuth` is gone).
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
  `res.sendFile` needs `dotfiles: 'allow'` for anything under a dot-folder.

**Recordings** (`recordingEngine.js`: capture, scheduling, failover; `recordingMedia.js`: probes, MP4 remux, native playback,
preparation; `recordingPost.js`: compression, break detection; `recordingJobs.js`: which recording each job is on)
- `scheduled → waiting → recording → …`, where `waiting` = due but held back by a viewer (listed, cancellable, duplicate-checked).
- File names use the server's local time, so **`TZ` must be set** (verified).
- Native playback is a `.native.mp4` remux of the file: `hvc1`, MP2→AAC, shared across concurrent requests, written atomically,
  sidecars deleted with the recording. `?async=1` answers 202 while preparing. Old HEVC sidecars are `hev1`: delete
  `*.native.mp4` for those once. **HEVC recording playback on an Apple TV is still unconfirmed.**
- **Every status change is logged** (0156, `setScheduleStatus()` wraps `scheduledDb.setStatus`): one line per actual
  transition, including the `missed`/`failed` paths in `tick()` and `reconcileOnStartup()` that used to change the status
  with no log line at all. A missed/failed schedule also stays listed for 7 days via
  `GET /api/recordings/scheduled?include=recent` (flag `scheduleHistory`) - the plain route is unchanged - shown on the web
  Recordings page ("Recent problems") and the Status page.
- **The recordings folder is health-checked, not just space-checked** (0157, `services/recordingsFolder.js`,
  `checkRecordingsFolder()`): missing, not writable, a filesystem under 1 GB total (an unmounted network share or a stale
  Docker bind reads back this way, not as "missing" - what live testing actually hit), or free space below the configured
  minimum. Checked at startup and every 15 minutes (`recordingEngine.getFolderHealth()`, on `/api/status`, a warning banner
  on the web Status page); a warning is logged only on a state change. `getRecordingsRoot()` only creates the final folder
  when its parent already exists. Settings → Recording → Storage refuses an unusable `recordingsPath` with 400 instead of
  saving it silently (`services/recordingsFolder.js` `validateRecordingsPathSetting()`).
- **An unanswered "give up the stream" prompt no longer blocks a recording forever** (0158): if a due recording finds a
  live viewer on the provider's only stream, it still asks once (`streamCoordinator.js` `requestForRecording` /
  `pendingPrompt`), but takes the stream if nobody answers within `recordingPromptTimeoutMin`
  minutes (setting, default 3) of the recording actually becoming due - tracked as `dueSince` on the prompt entry,
  deliberately not from the earlier `announceUpcoming` lead-time notice. An explicit "Keep watching" (`declinePrompt`)
  still waits, however long. No new terminal-status value (a client sees an
  ordinary reclaim: a 404, its one-time re-resolve, then the existing `recording-in-progress` 409).

**Dev environment (macOS, from 23 Sept).**
- Node 24 from Homebrew (`/opt/homebrew/opt/node@24/bin`; see §2). `npm test`: 654 tests (29 Sept, after 0167), all pass locally with
  Homebrew ffmpeg 9.0 installed (tests that need ffmpeg skip without one).
- `bash scripts/verify-build.sh .` uses the system `python3`.
- The tree is LF. There is no local Docker; the image is only built by CI.
- **CI runs every test file at once on 2 vCPUs: keep timing margins ≥1 s, or poll** (0101).

---

## 5. Frozen Apple-client contract (change only together with a client change)

- `/api/library/guide` rows: `id`, `sourceId`, `name`, `logo`, `category`, `tvgId`, `programmes[]` (`startTime`/`endTime` in **ms**).
- `/api/recordings/{id}/markers`: `startMs`/`endMs`. `/api/recordings/{id}/playback` (bearer):
  `{url:"/api/recordings/{id}/media.mp4", container:"mp4", durationSec}`; `media.mp4` takes `?token=`, supports ranges and
  `+faststart`; `?async=1` is additive.
- Favourites: `POST/DELETE /api/favorites` (bare id), listed via `/api/library/favourites`.
- Playback: `POST /api/playback/resolve` → `strategy` `direct` | `transcode`, with `playbackURL` under `/api/proxy/stream`
  (`?h=<opaque handle>`, 0119: never a provider URL), `/api/transcode/…` (`master.m3u8` for every session with a usable frame
  rate and for an HDR copy, else `stream.m3u8`) or `/api/recordings/…`; token as `?token=`; bearer on
  `DELETE /api/playback/{id}`; `GET /api/playback/{id}/terminal-status`. The client's allow-list is exactly those three
  prefixes (`/api/remux` is gone since 0103).
- Resolve failure texts start with one of the three C-B prefixes (§3), which the client shows.
- Additive and safe: `/api/version` and `/api/info` fields (the current flags are tabled in the hand-off doc); `waiting` rows;
  `finite`/`durationSec`/`videoRange`/`fps` in resolve `info`; the optional `heaac` capability (0116; the Apple client always sends it).

---

## 6. Status (4 Oct 2026)

**Shipped through 0204 and app 39.** Every item of the 23 Sept review is built; the 3 Oct independent audit
(`audit/ROADMAP.md`) is done: Phase 1-2 in 0192-0196 + app 37, Phase 3 in 0197-0202 + app 38, recording audio in 0203,
and the simplification build in 0204 + app 39 (R13, segmented recordings, was skipped by Mark). The build-by-build
record 0106-0203 is in `docs/archive/blueprint-history-0106-0203.md`; §8 keeps one line per build.

Status words, used exactly: **Verified** (Mark checked it on a device; test ids from `docs/TEST-BLOCK.md`), **Shipped,
awaiting a check**, **Deferred** (with the reason), **Done** (needs no device check). What is still to check is at the top
of `docs/TEST-BLOCK.md`.

**0204, the simplification build (4 Oct).** No behaviour change except the guide (below). The tuner model
(`PIGTV_TUNER`: shared tuners, timeshift, HLS recordings) is removed: never run on a device, off by default; it is in git
history. Rollback flags retired: `PIGTV_NATIVE_PREPARE`, `PIGTV_KEEP_MKV` (an original is deleted only once its MP4
decodes cleanly), `PIGTV_SPORT_WORKER` (the automatic inline fallback stays), `PIGTV_PROBE_PROFILES`, `PIGTV_DTS_AUTO`,
`PIGTV_CHANNEL_NUMBERS`. `recordingEngine.js` is split: capture and scheduling stay; `recordingMedia.js` (ffmpeg/ffprobe
tooling, MP4 remux, native playback, preparation queue), `recordingPost.js` (compression, break detection),
`recordingJobs.js` (what each job is busy with; capture outranks them). `verify-build.sh` keeps only what tests cannot
check (297 checks, was 1,077). Tests: one way to start the real server (`test/helpers/server.js`); speed budgets are
skipped by CI's gate (`PIGTV_SKIP_PERF=1`) and run in a non-blocking `perf` job. **Guide:** a provider's own "(Backup)"
feed linked as a sibling of the channel it backs up is no longer listed anywhere (`channelNumbers.LINKED_SIBLING_SQL`
in `VISIBLE_SQL`), so warming warms the real next channel; an unlinked one stays.

### Next

**Done in app 37 (4 Oct):** Siri / App Shortcuts removed; the provider reminder reworded. **Phase 3 (4 Oct, server 0197–0202 · app 38):** the audit's R05, R11, R12, R14, R16, R17, the Guide's first-visit stall and the sport-request cost (0201) are done; R13 (segmented recordings) was skipped by Mark. Device checks: TEST-BLOCK **O** (and **L** with the new switches). Still open from the audit: an Instruments baseline on the Apple TV (app `TESTING.md`).

1. **Before anything else on the server:** Settings → Recording → set the recordings folder back to
   `/app/recordings/SERVER01_Video/Recordings` (R6.3 left `fake` saved; 0167 now refuses such a path but doesn't fix a saved one).
2. The rest of round 6: R6.4 (an overnight recording from the Apple TV), R6.5–R6.6 (the prompt timeout), R6.16 (the web
   pages after the cleanup).
3. **Mark's minor bugs from build 35 / 0167** (noted by him on 29 Sept for the next build; not yet reported in detail).
4. W6 (a screen that needs Back first) when Mark finds one.
6. The deferred checks: 1.16 (a recording with breaks), R3.8 (sport empty state), R2.5/R3.11 (a file-based channel).
7. Anything from §10 Mark wants fixed. **Kept on purpose:** the non-VAAPI encoders. **Not planned:** AV1, more users, reviving
   VOD, access from outside the VPN, AirPlay/PiP, a session keep-alive.

**Watch the logs, no code yet:** `Timestamps looping … after ffmpeg reconnected` and `Blank picture` lines (0191: how often, which channels, any false positive) · the provider's ~38 s cut and 19 s resend (§3, §10) · 7 Flix Sydney's second 0109 failure
(`Stream ends prematurely … Will reconnect` looping after ~14 MB, nothing produced: 0113 doesn't shorten that case, since ffmpeg
keeps running) · "Bug 2" (`[mpegts] Invalid timestamps … dts=X+1800`: needs the channel that produces it) · `source timing`
lines (the classifier has seen one uneven feed in five) · the 20 s stall timeout (tighten only after real stall logs).

**Older checks never done** (low priority, from before the review): 0054 cut the upstream mid-stream (the slot frees) ·
0062 an HEVC recording plays on the Apple TV · 0073 `timestamp discontinuity` stays about 0 on the E-AC-3 channel ·
`USER node` in the image (volume ownership first) · the fMP4 segment MIME (`video/MP2T`; devices play it, so low priority).

---

## 7. Rules

- **Capture before changing anything on the playback path** (`stream-doctor`). **No ffmpeg-flag or timestamp patch ships on a
  hypothesis**: 0085 did, and silently broke every even feed. If a fault can't be captured, say so and treat the fix as provisional.
- Every functional commit has a test that **fails on the old code** (prove it) and a `verify-build.sh` check, and bumps `build`.
- **Every change the Apple client can see**, including anything in `transcodeSession.js` / `playbackStrategy.js`, gets a row in
  `docs/SWIFT-CLIENT-HANDOFF.md` §5 in the same commit. Nothing in §5 changes without a matching client change.
- Say plainly what couldn't be run, and give Mark live-test steps for anything that needs the real feed or a device.
- At the end of a session, update this file: the status in §6, one line in §8, facts in §3/§4/§5 (and §9 for a new env var),
  and stories to the commit message or the archive.
- `scripts/verify-build.sh` asserts that features live where they should; add the check that would have caught each bug.

**Decisions on record.**
- *20 Sept:* stability over channel-change speed; VOD/series kept but unsupported (superseded 23 Sept: removed in 0122); `requireStreamAuth` off while VPN-only (superseded 3 Oct: always enforced, 0196); Mark
  applies and pushes.
- *21 Sept:* keep the Xtream/upstream proxy and `cache.js`; CI builds the images. (Superseded 23 Sept: removed in 0122.)
- *23 Sept:* **one delivery path now**: Phases 3 and 4 shipped together without the trial report, and the web's recovery is a fresh
  HLS session rather than a remux fallback.
- *23 Sept (later):* development moved to the MacBook. **Claude pushes to `main`** (supersedes "Mark applies and pushes"); the
  numbered patch files are retired; CI publishes the image only after the tests pass.
- *23 Sept (review):* new roadmap (§6) adopted. The web app becomes admin plus light viewing; the tuner model is approved after
  the quick wins; unused Xtream-emulation routes and fork code are to be removed; picture quality first (frame-rate matching
  in); a generous timeshift; one player on the TV. The old blueprint and hand-overs are archived.
- *24 Sept:* build everything that's left, then test it all in one block (the per-phase device gates are waived); risky
  behaviour ships off by default behind a switch.
- *24–26 Sept (Mark's test rounds):* **channel numbers are labels only** (the provider's order groups channels under its
  placeholder channels, 0139); **the UIKit guide is the only guide** (the SwiftUI grid deleted); **HE-AAC passthrough is always
  on** for the Apple client (the Labs switch removed); **the tuner stays, off by default**, to be tested later; **sport is
  recognised per programme** with a follow list (C-I replaces C-H's category row); replays are wanted, in their own section; a
  whole weekend (72 h) of sport; **the Home screen is the tab the app opens on**; **Swift 6** language mode is on; the iOS player
  uses PigTV's own touch controls, not AVKit's.

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
| 0139 | Channel numbers are labels only: the guide and channel lists keep the provider's order, which groups channels under their placeholder channels (Mark's test 1.4 rejected ordering by number) |
| 0140 | The guide version includes the server build, so every deploy makes the Apple TV reload its cached guide once |
| 0141 | Logos keep their transparency: the downscale goes through rgba (a palette PNG with tRNS came out opaque); ≤320 px, SVG and unconvertible logos kept as fetched; cache version 2 in the key, stored logos dropped once |
| 0142 | Channel health counts stalls: play-end stores watched time and stalls on the owner's last attempt; flaky also at ≥3 stalls/h over ≥20 min; Status list ranked by failed starts + stalls/h, with stalls and minutes watched |
| 0143 | A refused connection in ffmpeg's first 3 s is retried twice (1.5 s, then 3 s); the resolve's wait extends by exactly what the retries cost |
| 0144 | A finite source is paced with `-readrate 1 -readrate_initial_burst 8` instead of `-re` (first segment at once); `PIGTV_READRATE_BURST=0` rolls back |
| 0145 | `playback-report.js` shows the client wait (first picture minus resolve) per path, median and p90 |
| 0146 | Sport categories (C-H): flag `sportCategories`, `sport` on `library/categories`, admin `PUT /api/library/categories/sport`, Sport button on each category (Settings → Manage Content) |
| 0147 | EPG programme categories stored (`epg_programs.categories`, JSON; view rebuilt on upgrade); admin `GET /api/sports/categories`; Status page "EPG categories" |
| 0148 | Sport events (C-I): per-programme recognition, events across channels, best channel first; `GET /api/sports/events`, admin follow list and preview; flag `sportsEvents` |
| 0149 | Web Settings → Sports: follow-list chips, preview of recognised events; the Sport toggle's tooltip |
| 0150 | Sport kinds (C-I): event/replay/show/placeholder per programme (loop channels, stale dates, PPV slots), league aliases, merging by teams/session; `kind`, `aliases` on items; events + replays by default, `include=all`; preview with `kindRule` |
| 0151 | Web Settings → Sports: the preview grouped by kind (Events, Replays open; Shows, Placeholders collapsed), with why and the merged guide titles |
| 0152 | Sport live or replay (C-I): XMLTV `previously-shown`/`premiere`/`new`/`live` stored (`epg_programs.flags`); the first airing of a game within 36 h wins; per-league live hours in the home time zone; builds read the 36 h before now |
| 0153 | Sport horizon 72 h (C-I): `GET /api/sports/events?hours=` up to 72 (default 6), the preview 72 h, a build kept 5 min and covering 72 h + 5 min; the sync logs its guide's reach |
| 0154 | Logos at full resolution for the Top Shelf: `/api/logo/<key>?size=full` (the original as fetched, kept beside the resized copy) and `?size=640`; the default stays ≤320 px |
| 0155 | Tuner: compatible joining. A viewer joins a running tuner on the same stream whose output it can play (an exact key still first), so an Apple TV (`heaac: true`) shares a recording's tuner on an HE-AAC channel instead of a 409 |
| 0156 | Schedule observability: every status change of a scheduled recording writes one log line (centralised, including the `missed` paths that used to be silent); `GET /api/recordings/scheduled?include=recent` also lists missed/failed schedules from the last 7 days (flag `scheduleHistory`); shown on the web Recordings page ("Recent problems") and the Status page |
| 0157 | The recordings folder is checked for real: `checkRecordingsFolder()` catches missing, not writable, and a filesystem too small to be real (an unmounted network share or a stale Docker bind reads back this way, not as "missing") as well as low free space; checked at startup and every 15 minutes, shown on the Status page; `getRecordingsRoot()` no longer creates a folder tree inside an unmounted mount point; Settings → Recording → Storage refuses an unusable `recordingsPath` with a plain error instead of saving it silently |
| 0158 | A due recording that finds a live viewer on the provider's only stream still asks once, but now takes the stream if nobody answers within `recordingPromptTimeoutMin` minutes (new setting, default 3) of becoming due - not from the earlier lead-time notice. An explicit "Keep watching" still waits, however long. Same behaviour on the tuner path |
| 0159 | Sport events are built off the request path: a stale cache is now served the previous result while the rebuild runs on `setImmediate` (never inline in a request), triggered after an EPG sync, on a follow-list change, and by a timer aligned to the 5-minute bucket. The build itself is still synchronous (~0.3–1.1 s on the one event loop, now at most once per 5 min and never while a request waits); a worker thread is the follow-up if stalls are ever traced to it |
| 0160 | The recordings folder is never created inside a disconnected share's mount point (a parent on a filesystem under 1 GB, Unraid's 1 MB `/mnt/remotes` tmpfs), Settings refuses such a path, and the unmounted-share check runs even with a free-space minimum of 0 |
| 0161 | ESPN fixtures (C-I): a new first rule in `resolveLive` checks ESPN's free scoreboard (real kickoff/session times) before the guide-only heuristics - matched to a fixture by team/session, live near the real kickoff else replay with the real time, or "no such game" when both teams are known but nothing matches; `services/sportsFixtures.js` fetches only the leagues that matter (follow list, sport categories), every 30 min and after an EPG sync, into SQLite (never blocks a request); international cricket (Tests/ODIs/T20Is) is found each refresh from ESPN's cricket scorepanel and merged under a new canonical league `Cricket` (IPL, BBL stay their own); AFLW has no ESPN feed and stays on the heuristics; `PIGTV_SPORT_FIXTURES=0` turns it off; the web Status page gets a "Sport fixtures" panel |
| 0162 | Lead review of 0161: stale or out-of-window ESPN data could manufacture a replay for a real live game (a day of ESPN being unreachable, with yesterday's fixtures still cached, would tell a genuine unlisted game "no such game", and a fixture outside the fetched window could decide at all). Every league's snapshot now carries the exact window its *last successful* fetch covered and when that was (`sport_fixture_status.covered_from`/`covered_to`, `snapshot()`'s `coverage`); `fixtureVerdict` returns no verdict at all for an airing outside that window, and the "no such game" branch additionally requires the fetch to be recent (≤ 6 h) and the window to reach 12 h either side of the airing. A successful fetch fully replaces a league's stored fixtures (cricket now uses the same full-replace `saveFixtures` as every other league, dropping the `mergeFixtures` merge-by-append it had instead), so a postponed or removed game never lingers |
| 0163 | Dead-code cleanup W10 (part 1): removed unused `xml2js` dependency (never `require`d) and the 869-line `nodecast.patch` file (Feb 2026 leftover, unreferenced) |
| 0164 | Dead-code cleanup W10 (part 2): removed dead channel-number ordering branches (`GUIDE_NUMBERED_ORDER_BY`, `numbered` variable, number-keyed cursor handling); cursor rejecting legacy number-keyed cursors still returns 400; stale comment in `info.js` updated to note the behaviour is labels only (0139) |
| 0165 | Dead-code cleanup W10 (part 3): removed web player / settings leftovers from deleted Movies/Series pages (0122): `autoPlayNextEpisode`, `forceProxy` settings, legacy `loadSettings()` method, `movies` and `series` icons, `forceProxy` toggle from Settings tabs, HTML element for it |
| 0166 | Dead-code cleanup W10 (part 4): removed dead CSS selectors for the hidden-items list (`.hidden-list`, `.hidden-item`, `.hidden-item-info`, `.hidden-item-type`; 26 lines) that were never used after 0122; CSS file 4087 → 4061 lines |
| 0167 | Settings refuses a relative recordings path ("fake" passed: its parent is the server's working folder, which exists); R6.3 |

| 0168 | Multi-provider P1: source `role`/`priority`/`maxConnections`/`subscription`/`idOverlayUrl`; `provider_accounts` from `player_api.php` (6 h, after sync, Check now; a failed read keeps the last); `GET /api/providers/reminders` (C-K) |
| 0169 | EPGenius's `#EXT-X-CREDENTIALS` uses the key `dns` |
| 0170 | Backup sources sync their live list only into `backup_channels` (never the library); optional EPGenius id overlay by stream id |
| 0171 | Channel linker (`channelLinks.js`, `channel_links`, admin `/api/links`): exact id, Fox number, same-region name, siblings, quality pairing, event slots never |
| 0172 | Web Settings → Providers and Backup links; a settings-only source PUT no longer triggers a sync |
| 0173 | Per-provider connection pools (sessions and recordings carry `providerId`; single provider unchanged) |
| 0174 | Resolve failover across candidates, breaker, quarantine, retries/30 s deadline, `provider` on resolve (C-J), `channel_health.provider_id` |
| 0175 | Status Providers panel, provider names on sessions, admin renewal banner |
| 0176 | Lead fixes to 0175: duplicate reminders route removed, banner uses the local day, `accountOk` null until read, tests |
| 0177 | Recordings choose a free provider, fail over at start, continue as part N+1 on a mid-recording death or 30 s stall (max 3); `part`, `provider_id`, `provider_name` |
| 0178 | Raw-list bridge (P9): `provider_raw_channels` for every provider (fetched only when a backup exists); linker methods `raw-name` (auto) and `raw-epg` (auto, pending on the variant guard) rank above exact/number/name; Dream4K prefix styles understood |
| 0179 | A raw-epg link is automatic only when the loose raw names agree too (one id on two channels at Dream4K) |
| 0180 | A start stopped on request (the viewer's next play, a DELETE, a force) ends its resolve with 499 `{error, superseded}` - no failover, breaker, quarantine or failed-start row; an owner's newer resolve stops the older walk |
| 0181 | Providers that are the same account (same server origin + login, hashed in `accountKey.js`) share one connection pool (lowest limit); `GET /api/sources/providers` adds `sharesAccountWith` (ids), Settings -> Providers warns in red |
| 0182–0191 | Settings consolidation (provider cards), backups and links, sport teams, Status rework, in-stream recovery and hot standby (env-switched then), interruptions, reconnect timestamp loop and blank-picture detection (details: `docs/archive/blueprint-history-0106-0203.md`) |
| 0192 | Recording codec probe reads ffprobe JSON by field name (audit R02) |
| 0193 | Recordings prepared for the Apple client before the first Play; compression verifies before it deletes (R06, R08) |
| 0194 | Recordings routes read files asynchronously (R09) |
| 0195 | Sport events built on a worker thread (R09) |
| 0196 | Media and session control always need a signed-in user; the proxy takes handles only (R01) |
| 0197 | In-stream recovery and hot standby are Settings switches; Status shows relay state and reasons; stricter standby compatibility (R12) |
| 0198 | Provider connections leased before the probe; warming the likely next channel (Settings, off by default) (R11) |
| 0199 | Image runs as PUID/PGID 99:100, multi-stage, `/api/health` + HEALTHCHECK, database backup script (R17) |
| 0200 | Web nav accessibility; Status pauses when hidden and shows loop delay, preparation queue, sport builds, connection use (R16) |
| 0201 | Sport event requests served from a per-minute cache with ETag |
| 0202 | A hot standby may take a warm channel's connection |
| 0203 | Captures are MPEG-TS; preparation re-encodes audio to AAC-LC and decode-checks before deleting an original |
| 0204 | Simplification: tuner model and six rollback flags removed, recording engine split, verify-build slimmed, test helpers; linked "(Backup)" siblings not listed |

---

## 9. Configuration reference

Every `PIGTV_*` variable the server reads (`grep -rn "process.env.PIGTV_" server`, 26 Sept, build 0154). Set them on the
container (Unraid → Docker → PigTV → Edit, then Apply, which recreates it). Unset = the default. Most settings are **not**
env vars: they live in SQLite and are edited in the web app's Settings (sources, transcoding, recording, users).

| Variable | Default | Purpose |
|---|---|---|
| `PIGTV_RELAY_SWITCH_MS` | `10000` | With a standby ready: how long the playing stream may write nothing before the standby takes over (min 3000). |
| `PIGTV_LIVE_IDLE_TIMEOUT_SEC` | `300` | A live session nobody has fetched from for this long is removed by the idle sweep (seekable sessions: 30 min, fixed). |
| `PUID` / `PGID` | 99 / 100 | The user the container runs as (0199; Unraid's nobody:users). `PUID=0` runs as root. See `docs/OPERATIONS.md`. |
| `PIGTV_BLANK_KBPS` | 500 / 250 | A live play whose segments carry less than this (kbps, audio included; 500 from 720p up, 250 below) over its first 20 s is marked **blank** (0191): logged, quarantined on that provider for the next play, health reason `blank`. `0` switches it off. |
| `PIGTV_STALL_TIMEOUT_MS` | `20000` | The stall watchdog kills an ffmpeg that has written no file for this long (grace before the first output: the larger of this and 30 s). |
| `PIGTV_TERMINAL_STATUS_TTL_SEC` | `900` | How long a "taken over" record is kept for `GET /api/playback/:id/terminal-status`. |
| `PIGTV_PROFILE_MAX_AGE_DAYS` | `7` | A channel profile older than this is probed again. |
| `PIGTV_DTS_DELTA_THRESHOLD_SEC` | `60` | ffmpeg's `-dts_delta_threshold` for sessions. |
| `PIGTV_READRATE_BURST` | `8` | Seconds read at full speed before a finite source is paced to real time (0144; 0–60). `0` = plain `-re` (the rollback). |
| `PIGTV_SPORT_FIXTURES` | on | `0` turns off ESPN fixtures completely (0161, §4 "Sport events"): no fetch ever runs, and `resolveLive`'s ESPN rule never applies - every league is exactly on the guide-only heuristics, as before 0161. |
| `PIGTV_BUILD` | `server/version.js` | Overrides the build number reported by `/api/version` and `/api/info`. Not normally set. |
| `PIGTV_COMMIT` | `dev` | The commit shown in the version display; CI sets it as a Docker build arg. |
| `PIGTV_BUILT_AT` | none | The build time for `/api/version`; CI sets it. |

Other environment the server or image uses: `JWT_SECRET` (optional: at least 32 characters; unset, a random key is created
once and kept in `data/auth-secret`, so back that file up with the data folder); `PORT` (3000); `TZ` (**must** be set, e.g.
`Australia/Sydney`: recording file names use local time); `NODE_ENV=production`; `LIBVA_DRIVER_NAME=iHD` for Intel VAAPI.
The live-session tmpfs is `/app/transcode-cache` (2 GB in `docker-compose.yml`). Stream auth is always on since 0196 (there is no setting).

---

## 10. Known limitations and open issues (29 Sept)

**Playback and the provider**
- **The provider cuts the connection about 38 s into a play on some channels and resends ~19 s of old content** (§3). ffmpeg
  rebases the timestamps, so the player neither freezes nor rewinds, but the viewer sees a short repeat and the stream sits
  ~19 s further behind live. No code change made for the repeat itself; `stream-doctor capture` keeps the raw bytes since 0191,
  so it can now be measured. When the rebase goes wrong instead (a timestamp loop, Fox Footy 3 Oct) the session is ended and
  restarted cleanly (0191).
- **Provider refusals are retried** (two retries in ffmpeg's first 3 s, 0143) and the Apple client re-resolves once, but a
  channel can still fail to start during a provider outage; the viewer sees the C-B message and a Retry button.
- The 8 s read burst for finite sources (0144) is measured on ffmpeg 9.0 only; production runs Ubuntu's 6.x (6.1+ needed) and
  the file-based channel to check it on (R2.5/R3.11) has not been found again.
- HEVC recording playback: checked on 2 Oct (0062 passed); since 0192 a prepared HEVC MP4 is tagged `hvc1`.

**Sport (C-I)**
- Recognition and live/replay are **heuristics** over guide titles, categories and flags (`sportsClassify.js`; rules in §4 and
  C-I), now checked against **ESPN fixtures first** (0161) for the leagues ESPN covers and that Mark follows: NFL, AFL, NBA,
  F1, MLB, and cricket's IPL/BBL plus whatever international series ESPN's scorepanel currently lists. Where fixtures cover a
  league and an airing's time, the known misfires below do not apply - that is the point of 0161. Everywhere else (AFLW always;
  any league outside the seven above; a period ESPN has no data for; ESPN down) the heuristics below are exactly as they were:
  a live game that the guide doesn't flag and that starts outside its league's live hours reads as a
  replay; a replay aired inside league hours, not flagged `previously-shown` and not preceded by an earlier airing in the last
  36 h reads as live; travelling series (F1, without a fixture) have no live hours, so only flags, the first-airing rule and
  "Live" in the title decide; titles that name neither teams nor a session merge only by normalised title or become shows; the
  horizon ends where the provider's guide ends (the sync logs how far ahead it reaches). Mark's 25 Sept export is the fixture
  (`test/fixtures/sports-export.json`); add a misfire there with its expected kind before changing a rule.
- **ESPN fixture coverage is uneven.** IPL and BBL have fixed league ids and are always fetched when followed; other cricket
  (Tests, ODIs, T20Is) depends on ESPN's cricket "scorepanel" actually listing the series that day - a series it does not list
  is invisible to the fixture rule and falls back to the heuristics. ESPN's own `endDate` is trusted for a multi-day match only
  under the generic `Cricket` league (never IPL/BBL, whose nominal `endDate` is not a real multi-day span). ESPN is unofficial
  and undocumented: a schema change there degrades to "not matched" (heuristics), never a crash, but was not designed against.
  A league whose fetches have been failing (or have never run) falls back to the heuristics automatically once its last good
  data is either too old (over 6 h, for the "no such game" answer) or does not reach the moment in question (0162) - so an
  ESPN outage degrades gracefully rather than mislabelling a real live game as a replay.

**Recordings**
- The recordings folder must be on a volume Docker sees live: see §1 Deployment (the `/mnt/remotes` RW/Slave mapping). The
  server checks the folder at startup and every 15 min and warns on the Status page (0157), but it can't fix a Docker mapping.
- An unanswered "stop playback?" prompt hands the stream to the recording after 3 minutes (0158); a viewer who chose
  "Keep watching" still blocks the recording for the whole programme.

**Sport build**
- Since 0159 the sport event list is rebuilt in the background, but the build itself (~0.3–1.1 s on 1,000 channels) still runs
  on the server's one event loop, at most once per 5 minutes. If playback stutter is ever traced to it, move it to a worker
  thread.

**Web**
- `routes/proxy.js` has not been split (S4.3; one route, 238 lines, not needed so far).

**Health and diagnostics**
- Channel health's stalls per hour depend on clients sending `play-end` (with `watchedSec` and `stalls`) when a play stops
  (both clients do, for plays of 10 s or more). A play whose end is never reported (the app killed, a tab closed, a crash)
  adds no stalls and no watched time, so stalls are under-counted rather than over-counted.
- The Status page's last-50 plays and the terminal-status records are in memory: a restart empties them.

**Apple client** (details in `../PigTV-Swift/blueprint.md`)
- Top Shelf card progress is only as fresh as the app's last refresh (the extension never uses the network).
- Siri on Apple TV is parked (tvOS Siri may not offer third-party App Shortcuts); on iPad/iPhone awaiting R4.8.
- The iOS player overlay clashing with AVKit's controls is **resolved** (app 31: PigTV's own touch controls only).

**Docs**
- The screenshots in `../PigTV-Swift/docs/evidence` are taken on offline **fixture data** (made-up channels, programmes and
  logos), not the real feed.
