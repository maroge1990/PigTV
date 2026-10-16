# PigTV: blueprint

**State:** server builds **0208–0217** committed locally for Mark to push (0207 is the last deployed); Apple client build
**42** committed (40 is on devices). Waves 1–3 of the [16 Oct roadmap](docs/reviews/2026-10-16/ROADMAP.md) are done in code:
the [15 Oct review](docs/reviews/2026-10-15/REVIEW.md)'s findings, Mark's 16 Oct bug list (except cricket and the tuning
hang's server cause, which need his data) and Plan B1. Nothing is *Verified* until Mark's device and feed checks.

How to work in this repo (commands, shipping, rules) is in [`AGENTS.md`](AGENTS.md). This file holds **durable facts and the
roadmap** for the server, the web app and the joint plan; the Apple client's own architecture is in
`../PigTV-Swift/blueprint.md`, which points back here for the roadmap.

**One home per fact.** How to work → `AGENTS.md`. What the client may rely on → `docs/CLIENT-CONTRACT.md`. Environment
variables → `.env.example`. Running the container → `docs/OPERATIONS.md`. What shipped and why → the commit messages
(`git log --grep "^[0-9]\{4\}:"`). Everything older is frozen in `docs/archive/` (see its README): history, not instructions.

**Core requirements.** An IPTV server with a web app (this repo) and Swift clients (Apple TV first, then iPad and iPhone).
**Picture quality and stream stability come first**, then less overhead and complexity. **Stability and quality outrank
channel-change speed** (Mark, 20 Sept; reaffirmed 23 Sept: "quality of image should be the priority").

**Sections:** 1 Orientation · 2 How playback works · 3 Each area · 4 Roadmap · 5 Decisions · 6 Known limitations.

---

## 1. Orientation

| | |
|---|---|
| What exists | **Server** (Node 24, Express 5, SQLite via `better-sqlite3`, ffmpeg): M3U/Xtream + XMLTV sources, a primary provider and ordered backups with failover, the guide and library APIs, one playback path (resolve → HLS session), recordings (DVR with Comskip ad detection), channel numbers, channel health, EPG matching, sport events, a logo cache, device pairing. **Web app** (`public/`, no build step): Home, Live TV, Guide, Recordings, Status (admin) and Settings (Providers, Channels, Playback, Recording, Sports, System). **Apple client** (tvOS first, iPad, iPhone): `../PigTV-Swift`. |
| Repos | Server/web: `github.com/maroge1990/PigTV` → `/Users/markrogers/Documents/GitHub/PigTV`. Apple: `github.com/maroge1990/PigTV-Swift` → `/Users/markrogers/Documents/GitHub/PigTV-Swift`. Both public. |
| Deployment | Unraid box "PassyFlix", `http://192.168.1.235:3000`, container **`PigTV`**, reached over Tailscale only. Data folder on the host: `/mnt/user/appdata/nodecast_tv/data` (→ `/app/data`; back it up before a risky deploy). **Recordings:** host path `/mnt/remotes` → container `/app/recordings`, Access Mode **Read/Write - Slave** (an SMB share that mounts late or reconnects then appears inside the container); the recordings folder setting is `/app/recordings/SERVER01_Video/Recordings`. A plain bind of the share's subfolder went stale and showed Unraid's 1 MB tmpfs. Mark deploys (Unraid → Docker → PigTV → **Force Update**); env vars are set on the same Edit page. |
| Next build number | **0221** |
| Scale | About **1,000 channels** in the categories Mark selects in the web app (the Apple TV honours the selection); the provider's whole playlist is about 18,000 |

---

## 2. How playback works (one path)

**Every client, every live channel: `POST /api/playback/resolve` → an HLS session** (0102–0103). The server probes
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
  re-classified within 7 days or on its first failed start. ffmpeg's own probe is **not** reduced. Always on (the off switch went in 0204).
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

The tuner model (0126–0155: shared tuners, timeshift, HLS recordings) was removed in 0204; it is in git history.

---

## 3. What to know before touching each area

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
kind since 0151). **Built off the request path (0159), on a worker thread since 0195 (`sportsEventsWorker.js`, with an automatic inline fallback):** a request is always served the last built result; a stale cache key
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
(`.env.example`); the web Status page's "Sport fixtures" panel shows per-league last fetch, fixture count and last error.

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
The `channelNumbers` flag is always sent (its off switch went in 0204).

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

**Providers, backup links and failover** (0168–0181, 0198; `providerAccounts.js`, `channelLinks.js`, `providerRouting.js`,
`streamCoordinator.js`; the original design and its decisions D1–D9 are in `docs/archive/MULTI-PROVIDER-BRIEF-2026-09-30.md`)
- A provider is a source with `role` `primary` (exactly one with streams) or `backup` (ordered by `priority`), shown as
  cards in Settings → Providers. Account info (`player_api.php`: expiry, connection limit) is read at startup, every 6 h,
  after a sync and on "Check now"; **a failed read keeps the last good values** and never makes a provider look expired.
  Effective limit = the card's override, else the account's `max_connections`, else 1. Providers that are the same account
  (same origin + login, `accountKey.js`) share one pool at the lowest limit (0181).
- **Backups never write `playlist_items` or `categories`**, so the library, guide, numbers, sport and favourites can't see
  them. They sync into `backup_channels` (plus `provider_raw_channels`, 0178), and the linker maps each listed primary
  channel to up to 3 ranked backup streams in `channel_links`: raw-name/raw-epg, exact tvg-id, the Fox 50x number,
  same-region name, and the primary's own "(Backup)" **siblings**; quality pairs with quality and event/PPV slots are never
  linked. A relink keeps `approved`/`rejected`/`manual` rows. **Only `auto`, `approved` and `manual` links are used.** The
  linker reads `LISTED_SQL` (it must see linked siblings); the guide reads `VISIBLE_SQL`, which hides them (0204/0205).
- **Resolve** walks candidates: the primary (unless down, expired or this channel is quarantined there), its sibling, then
  each backup in order. Admission is per provider (free, idle reclaim, own replacement); with none admitted the 409 is the
  first candidate's. A start that fails for a provider reason goes to the next candidate; anything else is returned. The
  0143 refusal retries (1.5 s + 3 s) apply only to the last candidate, earlier ones get one after 1 s; the whole resolve
  stays under 30 s and no candidate starts with less than 8 s left. **Breaker:** provider-reason failures on ≥2 channels in
  5 min → down; half-open after 3 min (doubling to 15). **Quarantine:** 10 min per provider + channel, also set when a
  session ends unrequested, so a player's single re-resolve lands elsewhere. Connections are **leased before the probe**
  (0198), so two starts can't double-book one.
- **Recordings** take the first candidate with a free connection (else the prompt flow on the first), fail over at start,
  and continue as part N+1 on a mid-recording death or a 30 s stall (at most 3 parts).

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
- Known limits: the feeds aren't in step (a jump or repeat at a switch); a cold switch still waits for the 20 s stall
  watchdog; the provider in Stream info is the one the play started on. A switch applies to plays started after it changes.

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


---

## 4. Roadmap: close the gaps with Dispatcharr, natively (Plan B)

**15 Oct review:** B1–B5 implementation status is unchanged. The
[review action plan](docs/reviews/2026-10-15/REVIEW.md) recommends a bounded UI/freshness pass first and identifies
acceptance criteria for guide-following recording timers, pre-migration backups and shared ingest. R3 still requires
Mark's decision; review recommendations are not implementation approval.

**Decided 13 Oct 2026 (Mark):** PigTV stays standalone and does **not** run Dispatcharr. It adopts the core ideas it is
missing. The analysis, with file references into Dispatcharr's source, is [`docs/DISPATCHARR-REVIEW.md`](docs/DISPATCHARR-REVIEW.md):
§11 is this plan, §9 lists what PigTV already does better and must keep (K1–K15), and §5 has each recommendation (R1–R12) in
detail. Plan A (R1, the Dispatcharr spike) is not pursued.

Status words, used exactly: **Done**, **Shipped, awaiting a check** (needs Mark on a device or the real feed), **Verified**,
**Deferred** (with the reason).

| Step | What | Size | Status |
|---|---|---|---|
| **B1** quick wins (any order; none touches live playback) | **R12** nightly SQLite backup, plus one at startup when the build changes (0199 has the backup script) · **R4** a recording's end follows the guide · **R11** one webhook URL (provider down, recording failed, licence expiring) and live ffmpeg speed/fps on Status · check whether any provider sets `tv_archive` (keep the flag at sync) · check the reference samples for extra audio tracks (E3) | S each | **Done**, committed 16 Oct, not yet pushed: R12 (0213), R4 (0214), R11 webhook (0215), `tv_archive` kept and on Status (0216; the answer comes with the next sync). **Deferred:** live ffmpeg speed/fps (needs a `-progress` flag on the playback ffmpeg, so a capture first) and E3 (the samples are on the server; needs Mark) |
| **B2** recordings | **R3** segmented recordings: an HLS event playlist that appends across restarts and failover (replacing parts), remuxed at the end, MP4 preparation (K12) from the segments. **Approved by Mark on 16 Oct** (replaces the 4 Oct skip): with watch-while-recording on Apple TV, segments in appdata, a Settings switch off by default; see the roadmap's Wave 4. · **R5** follow-list and series recording rules, de-duplicated by episode/event · **R6** EPG artwork | M + M | Not started |
| **B3** shared ingest (behind a Settings switch, capture-first) | **R2** one reader per (provider, channel) into an in-memory ring buffer with subscribers, in its own process group. Consumers in order: recordings → the HLS session reads `pipe:0` (rerun `stream-doctor bench` on all five samples) → **R7** failover inside the ingest (speed-based stall detection, reconnect or switch by `providerRouting`'s order). The coordinator counts ingests: the same channel takes no new connection | L | Not started |
| **B4** retire (after B3 has run a week) | `streamRelay.js` leg-stitching and standby, the 0143 refusal retries, per-session warm leases (warming becomes "start an ingest early"): about 800–1,000 lines | M | Not started |
| **B5** provider and guide data (when convenient) | **R8** ingest filters · **R9** event-channel guide · **R10** EPG matching tune-ups · catch-up/start-over if B1 finds archives · E2 ffmpeg version parity | S–M each | R8 pilot **Done** (0217, committed): whole groups never imported, guarded and reversible; Mark's before/after sync time and DB size decide its future. The rest not started |

Rough total: 6–8 weeks of part-time sessions. B3 is the largest change to the playback path since 0102/0103: it needs the
full capture/bench pass (§3 "Diagnosing playback") before and after.

**Not planned:** AV1, more users, reviving VOD, access from outside the VPN, AirPlay/PiP, a session keep-alive. **Kept on
purpose:** the non-VAAPI encoders.

---

## 5. Decisions on record

- *20 Sept:* stability over channel-change speed.
- *23 Sept:* **one delivery path**: every play is resolve → HLS session; the web's recovery is a fresh session, not a remux.
  Development moved to the MacBook and **Claude pushes to `main`**; CI publishes the image only after the tests pass.
- *23 Sept (review):* the web app is admin plus light viewing; Xtream-emulation routes and fork code removed (0122); picture
  quality first (frame-rate matching in); one player on the TV.
- *24 Sept:* build everything, then test in one block; risky behaviour ships off by default behind a switch.
- *24–26 Sept (Mark's test rounds):* **channel numbers are labels only** (0139); **the UIKit guide is the only guide**;
  **HE-AAC passthrough is always on** for the Apple client; **sport is recognised per programme** with a follow list (C-I
  replaces C-H's row); replays in their own section; 72 h of sport; **Home is the tab the app opens on**; **Swift 6** language
  mode; the iOS player uses PigTV's own touch controls.
- *30 Sept:* multi-provider failover: one primary with backups, cold standby only by default (D1); links used only when
  auto, approved or manual.
- *3 Oct:* stream auth is always on (0196; was off while VPN-only).
- *4 Oct:* the tuner model (shared tuners, timeshift, HLS recordings) removed, never having run on a device (0204);
  segmented recordings (audit R13) skipped.
- *13 Oct:* Plan B (§4): no Dispatcharr; adopt its ideas natively.
- *16 Oct:* **R3 segmented recordings approved** (reverses 4 Oct's R13 skip): watch from the start while recording (sport
  that starts early), segments in appdata then the MP4 to the share, behind a switch off by default; provider use and a
  restart/takeover test day agreed. **tvOS icon option B** (kit 1.7.1).
- *16 Oct:* **Claude commits but never pushes**; Mark reviews and pushes (replaces 23 Sept's push-to-main). Work order:
  [`docs/reviews/2026-10-16/ROADMAP.md`](docs/reviews/2026-10-16/ROADMAP.md).

---

## 6. Known limitations

**Playback and the provider**
- **The provider cuts the connection about 38 s into a play on some channels and resends ~19 s of old content** (§2). ffmpeg
  rebases the timestamps, so the player neither freezes nor rewinds, but the viewer sees a short repeat and the stream sits
  ~19 s further behind live. When the rebase goes wrong instead (a timestamp loop, Fox Footy 3 Oct) the session is ended and
  restarted cleanly (0191). B3's ingest is the structural fix.
- A channel can still fail to start during a provider outage when no backup carries it; the viewer sees the C-B message and
  a Retry button.
- The 8 s read burst for finite sources (0144) is measured on ffmpeg 9.0 only; production runs Ubuntu's 6.x (6.1+ needed).
- In-stream recovery and the standby: the limits in §3.

**Still to watch in the logs** (no code yet): `Timestamps looping … after ffmpeg reconnected` and `Blank picture` lines (0191:
how often, which channels, any false positive; test-block M4–M6 were not run before it was archived) · 7 Flix Sydney's
`Stream ends prematurely … Will reconnect` loop (nothing produced; ffmpeg keeps running) · "Bug 2" (`[mpegts] Invalid
timestamps … dts=X+1800`: needs the channel that produces it) · `source timing` lines (the classifier has seen one uneven
feed in five) · the 20 s stall timeout (tighten only after real stall logs).

**Sport (C-I)**
- Recognition and live/replay are **heuristics** over guide titles, categories and flags (`sportsClassify.js`; rules in §3),
  checked against **ESPN fixtures first** (0161) where ESPN covers the league and time: NFL, AFL, NBA, F1, MLB, IPL/BBL and
  whatever international cricket ESPN's scorepanel lists that day. Elsewhere (AFLW always; other leagues; ESPN down or
  stale) the heuristics decide: an unflagged live game outside its league's hours reads as a replay, an unflagged replay
  inside them with no earlier airing in 36 h reads as live, travelling series without a fixture rely on flags and the
  first-airing rule, and the horizon ends where the provider's guide ends. Add a misfire to
  `test/fixtures/sports-export.json` with its expected kind before changing a rule.
- ESPN is unofficial and undocumented: a schema change degrades to "not matched" (heuristics), never a crash.

**Recordings**
- The recordings folder must be on a volume Docker sees live (§1 Deployment). The server checks it at startup and every
  15 min and warns on Status, but it can't fix a Docker mapping.
- A viewer who chose "Keep watching" blocks a due recording for the whole programme (an unanswered prompt hands over after
  3 min).

**Health and diagnostics**
- Stalls per hour depend on clients sending `play-end`; a play whose end is never reported adds nothing, so stalls are
  under-counted rather than over-counted.
- The Status page's last 50 plays and the terminal-status records are in memory: a restart empties them.

**Web**
- `routes/proxy.js` has not been split (one route, not needed so far).

**Apple client** (details in `../PigTV-Swift/blueprint.md`)
- Top Shelf card progress is only as fresh as the app's last refresh (the extension never uses the network).
- The screenshots in `../PigTV-Swift/docs/evidence` are taken on offline fixture data, not the real feed.
