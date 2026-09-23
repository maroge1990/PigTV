# PigTV server — handover (single source of truth)

**Last updated:** 23 September 2026 (build 0104; refreshed — history moved to the archive)

Read at the start of every session. Keep it **short**: current state and durable facts only. When something is finished,
leave one line in §4 and move the story to `docs/blueprint-archive.md`.

| Document | Use it for |
|---|---|
| `blueprint.md` (this) | How things work now, what to know before touching an area, what is left, the rules |
| `docs/SWIFT-CLIENT-HANDOFF.md` | The Apple-client contract, test tips, and the log of server changes the client should know about (its §5) |
| `server-review.md` | The 16 Sept code review: the file:line *why* behind items named P1-x / P2-x |
| `docs/blueprint-archive.md` | Frozen snapshots at build 0086 and 0104: how each fault was found and measured. **Not routine reading** |
| `../PigTV-Swift/blueprint.md` | The Apple client's own state and roadmap |

**Core requirements.** An IPTV server with a webapp (this repo) and Swift clients (iPad / Apple TV). Put **stream stability and
quality** first, then **less overhead and complexity**. **Stability and quality outrank channel-change speed** (Mark, 20 Sept).

---

## 1. Orientation

| | |
|---|---|
| Repo | `github.com/maroge1990/PigTV`; images built by GitHub Actions on push to `main` (`docker-publish.yml`), tests by `test.yml` (Ubuntu, Node 20 and 24) |
| Deployment | Unraid box "PassyFlix", image `ghcr.io/maroge1990/pigtv`, `http://192.168.1.235:3000`, container **`PigTV`**, reached over Tailscale only |
| Local repo | `C:\Users\markr\GitHub\PigTV` (moved out of OneDrive, 21 Sept) · patches go to `C:\Users\markr\GitHub\patches\PigTV` |
| Shipped through | **0104** on `origin/main` (23 Sept); whether it is *running* is whatever `/api/version` says |
| Next patch number | **0106** (0105 is this docs refresh) |

---

## 2. How patches are delivered

Each change is a numbered `git format-patch` file continuing the sequence. Commit on a local `patch-NNNN-*` branch, based on the
previous patch's branch if that one isn't on `origin/main` yet (never on `main`, never pushed). Then
`git format-patch -1 --start-number N -o "C:\Users\markr\GitHub\patches\PigTV"`, and check the chain applies in order on a throwaway
`git worktree` of `origin/main`, with the tests and `verify-build.sh` run there. Hand over a size note and **both** command blocks.
**Mark pushes; Claude never does** (Claude may apply patches to the working folder's `main` if asked).

```powershell
cd "C:\Users\markr\GitHub\PigTV"
git fetch origin
git checkout -B main origin/main
git am "C:\Users\markr\GitHub\patches\PigTV\NNNN-<subject>.patch"   # one line per patch, in order
git push origin main
```
```bash
docker pull ghcr.io/maroge1990/pigtv:latest
docker compose up -d --force-recreate pigtv     # recreate, not restart (or Force Update on the Unraid Docker tab)
curl -s http://192.168.1.235:3000/api/version
```
A redeploy ends every session. If `git am` complains that `.git/rebase-apply` still exists, run `git am --quit` (**not** `--abort`)
and repeat. The OneDrive cause is gone, so a recurrence is worth chasing.

**Build identity.** `server/version.js` holds `build` = the last functional patch, bumped in that patch's own diff (docs-only and
test-only patches don't bump it). `/api/version` and `/api/info` return it with `commit`/`builtAt`, which CI stamps, and the webapp
badge shows `display`.

---

## 3. How playback works now (one path)

**Every client, every live channel: `POST /api/playback/resolve` → an HLS session** (§C Phases 3–4, 0102–0103). The server probes
the channel once (ffprobe, cached 5 min per URL + caps), then returns either `direct` (a source that is already browser-ready,
through `/api/proxy/stream`) or `transcode`: an HLS session that **copies** whatever the client can decode and re-encodes only what
it cannot. There is no remux, no legacy pipe and no browser-side strategy any more; `/api/remux` answers the JSON 404.

**Provider slot** (`streamCoordinator.js`)
- The provider allows **one stream** (`maxProviderStreams`, 1; a recording holds its own slot). To admit a viewer, streams are freed
  in this order: anything idle ≥60 s (`viewerIdleTimeoutSec`), silently → the caller's own earlier stream, silently → another
  owner's live stream, only after a **409** `{conflict:{type:"viewer-in-progress",…}}` that `force:true` overrides (same shape as
  `recording-in-progress`). Owners are `device:<id>` or `user:<id>`. `POST /api/transcode/session` (the movie/series page) uses
  **soft** mode: it reclaims, but never answers 409.
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
- **Timestamps: two kinds of feed** (0088). *Uneven* feeds have about a third of their DTS steps as ~1-tick-then-double, left by
  an upstream muxer (Fox Sports 505), and need `-fflags +igndts`. *Even* feeds (TSN, Sky UHD, Sportsnet 4K) are **broken by**
  `igndts`. `streamProbe.classifyTimestamps()` decides per feed: steps below ¼ of the mean frame period >5% ⇒ uneven (measured
  33.8% vs 0.0%). It runs on the resolve probe's **own** ffprobe call (`-show_packets -read_intervals %+#300`), because a second
  ffprobe would collide on the one provider connection; without `-read_intervals` a live probe never returns. Also always
  `-dts_delta_threshold 60`. `PIGTV_DTS_AUTO=0` forces `igndts` everywhere (the 0085 behaviour — don't).
- **Pacing:** `-re` **only** when the probe says the source ends (`format.size` or `duration` present). A finite file read at full
  speed outruns the window, and hls.js never retries the resulting 404. Blanket `-re` cost ~8 s at start-up.
- **HDR** (0100): tvOS only switches the panel to HDR on a **master playlist's `VIDEO-RANGE`**. The copied fMP4 already keeps
  `colr`/`nclx` (measured on `pos_31`, Sky Sports Main Event UHD, HDR10/PQ). `classifyVideoRange()` reads `color_transfer`, and a
  copy+fMP4 session that is PQ/HLG is handed out as `/api/transcode/{id}/master.m3u8`: one variant, **no `CODECS`** (a wrong one
  makes AVPlayer refuse). SDR sessions and encodes are unchanged. The custom Apple player must also set
  `preferredDisplayCriteria` itself (hand-off 0100).
- **How a session ends** (0104). `stop()` marks it `stopped` before signalling ffmpeg, so any exit we didn't ask for is an `error`
  (`FFmpeg exited with code N` / `was killed (SIG)`). The software-decode retry (clear the folder, restart on the CPU) is only for an
  **encode** that really decoded on the GPU and died within 10 s **before any playlist**.
- **Stall watchdog** (`stallWatchdog.js`): ffmpeg is killed after 20 s without writing a file in the session directory
  (`PIGTV_STALL_TIMEOUT_MS`), with 30 s grace before the first output. Stderr doesn't count, because it gets louder during
  reconnects. Recordings aren't covered (they have a hard-stop timer).
- **Only network URLs are opened** (0104, `streamUrl.js`: http(s), rtmp(s), rtsp(s), udp, rtp, srt). Resolve, the session route,
  `/api/probe` and `/api/subtitle` answer 400, and the check is repeated at spawn. It isn't done with `-protocol_whitelist`
  because stream-doctor and the tests run the real arguments against local files.
- Start-up ≈ resolve probe + ffmpeg's own 5 MB/5 s probe + one segment: typically **7.5–9.6 s** to first picture (trial logs).
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
- **Movie/series page** (`WatchPage.js`, latent VOD): it probes, then sends anything not browser-ready through
  `POST /api/transcode/session`, the only path that can resume (`seekOffset`).
- `/api/proxy/stream` **streams** binary content and drops the upstream when the client leaves (0104). Playlists are read whole
  (they're rewritten, and `?token=` is carried onto every URI).

---

## 4. Shipped log (one line each; the stories are in the archive)

| Patches | What |
|---|---|
| 0033–0047 | Prior agent: `segmentedDelivery` HLS for Apple, token on segments, AAC-in-fMP4, recording-playback contract, HLS disk bounds, EPG parser back-pressure |
| 0048–0074 | Build identity · live HLS `temp_file` · auth gate, redaction, rate limits, 2 MB body cap · `db.json` cache · stall watchdog · viewer arbitration + 5-min idle · atomic EPG generations · segment allow-list · favourites bare-id · guide query bounds · recording fixes (local-time names, `hvc1`, atomic native remux) · client-event diagnostics · `-dts_delta_threshold 60` |
| 0075–0086 | HLS-delivery trial + measurement · dead code (users, OIDC/sessions, JSON favourites) · JSON 404 for unknown `/api/*` · playback report · recordings in `waiting` · `?async=1` recording playback · `-re` for finite sources |
| 0087–0095 | Cancelling the takeover prompt really cancels · **`igndts` per feed** (0088) · `stream-doctor.js` · samples kept on the data volume · terminal-status for displaced clients · CI stamps commit/build time |
| 0096–0098 | **Channel identity** (`stable_id`) for favourites, recordings, history |
| 0099 | Small-caps "ᴸɪᴠᴇ" badge stripped at ingest (shows after the next sync) |
| 0100 | **HDR**: master playlist with `VIDEO-RANGE` for HDR copy sessions |
| 0101 | Test-only: watchdog test margins for CI |
| 0102 | **Web on the one path**: always resolve + HLS; recovery is a fresh session; local strategy, beta toggle and force-* settings removed |
| 0103 | **Remux retired**: `/api/remux`, the legacy piped transcode, their branches, settings and tests |
| 0104 | Session hardening: honest exit status, narrower software-decode retry, network-only URLs, streaming proxy, dead session code |
| 0105 | Docs: this refresh (no build bump) |

---

## 5. What to know before touching each area

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

**Client diagnostics.** `POST /api/playback/client-event` (token; whitelisted, bounded fields; path only, never a query string):
`media-error`, `start-timeout`, `play-start`, `play-end`. Log lines end `from=user:<id>` / `from=device:<id>`.
`scripts/playback-report.js <saved log>` summarises first-picture time, stalls/hour and failures. It was built for the (now
closed) HLS-vs-remux trial and still reads the same lines.

**Channel identity** (0096–0098). `item_id` is `pos_N`, the M3U line, and **the provider moves it**. `stable_id`
(`stableIds.js`) is the provider stream id from the URL (`s441360`), otherwise a hash of the credential-stripped URL. Favourites,
scheduled recordings and history key on it; 845 channels are listed twice, sharing one identity. **The trap:** a row that *has*
an identity must never fall back to its stored `pos_N`. Joins use
`(x.stable_id IS NOT NULL AND p.stable_id = x.stable_id) OR (x.stable_id IS NULL AND p.item_id = x.item_id)` plus a `GROUP BY` on
the identity. Only *pending* schedules were backfilled. The provider's stream id and URL live in the row's `data` JSON, not
`stream_url`.

**Guide and library.**
- Query **`epg_live`**, never `epg_programs`. A sync loads generation active+1, flips it in one statement, then deletes the old
  one in slices; a failed feed leaves the guide untouched.
- Queries bound `start_time > from − 24 h`.
- `/api/library/*` fill a missing logo from the EPG (by tvg-id, then by name).
- **Ingest-time changes only show after a sync:** a redeploy skips any source synced in the last 24 h (`syncIfStale`), so use
  Settings → Sources → Sync now.
- Favourites store the bare channel id (`channelIds.js`); `GET /api/favorites` re-presents the composite form.

**Auth, limits, routes.**
- Stateless bearer tokens (web login + paired devices); no sessions or cookies. `requireStreamAuth` stays **off** (VPN-only).
  Stream URLs carry `?token=`.
- Limits: JSON body 2 MB; failed logins 10 per 15 min per (socket, username); pairing 60 starts / 1 500 polls per 10 min.
- HLS file names are allow-listed (`seg\d{4,}.(ts|m4s)`, `init.mp4`). fMP4 segments are served as `video/MP2T` on purpose
  (revisit with a device).
- Unknown `/api/*` → `404 {"error":"No such API endpoint"}`. **A new Apple-client endpoint goes into `APPLE_CLIENT_ROUTES` in
  `test/api-404.test.js`.**
- `db.json` is an in-memory write-through cache; a failed save is reported and rolled back.

**Recordings** (`recordingEngine.js`)
- `scheduled → waiting → recording → …`, where `waiting` = due but held back by a viewer (listed, cancellable, duplicate-checked).
- File names use the server's local time, so **`TZ` must be set** (verified).
- Native playback is a `.native.mp4` remux of the file: `hvc1`, MP2→AAC, shared across concurrent requests, written atomically,
  sidecars deleted with the recording. `?async=1` answers 202 while preparing. Old HEVC sidecars are `hev1`: delete
  `*.native.mp4` for those once. **HEVC recording playback on an Apple TV is still unconfirmed.**

**Dev environment (Windows).**
- `npm test` (~300 tests; 1 skipped on Windows, the POSIX signal test).
- `bash scripts/verify-build.sh .` needs a `python3` on PATH (a one-line `exec python "$@"` shim) and `PYTHONUTF8=1`.
- Sandboxed tests link `node_modules` with a junction. The tree is CRLF.
- **CI runs every test file at once on 2 vCPUs: keep timing margins ≥1 s, or poll** (0101).

---

## 6. What's left

**Server**
1. **P1-4 — resolve hands out an opaque handle instead of a credentialed `?url=`** (the provider login currently rides in
   `direct`/proxy URLs, logs and "Copy Stream URL"). It changes the contract, so it needs a coordinated Swift patch. This is the
   largest remaining item.
2. **P2-8 tests** for Apple-relevant paths: the EPG parser under bursty input, the token on fMP4 segments, recordings Range,
   viewer-already-holds-slot.
3. **Lower:**
   - shared helpers (`channelUrl`, `ffmpegProcess`, `probe`, `ids`)
   - a paged channel-ordering index / keyset paging
   - `USER node` (volume ownership first)
   - fMP4 segment MIME
   - try/catch in `routes/info.js`
   - optional badge clean-up of *stored* rows at startup, plus stripping on the Xtream ingest path
4. **Kept on purpose (not dead code):**
   - `cache.js` + the Xtream/EPG proxy routes (Mark, 21 Sept)
   - VOD/series: latent, unverified, don't refactor casually
   - the plugin loader
   - non-VAAPI encoders

**Watch the logs, no code yet**
- **"Bug 2"**: `[mpegts] Invalid timestamps … dts=X+1800` (DTS ahead of PTS). Needs the channel that produces it.
- The timestamp classifier has seen one uneven feed out of five; keep an eye on `source timing` lines.
- The 20 s stall timeout: tighten only after seeing real stall logs.
- Channel change is slower on the one path: if it has to be won back, shorten the first segment or skip the probe for known
  sources, and **measure first**.

**Live checks owed** (tick off or drop):
- 0102–0104 on the web: HLS badge, channel changes, recovery lines
- the HDR panel switch on the TV (0100 plus the Swift `preferredDisplayCriteria` change)
- walk the favourites once since 0097
- 0054: cut the upstream mid-stream → stalled, slot frees
- 0059: a favourite round-trips web ↔ Apple
- 0062: an **HEVC recording** plays on the Apple TV
- 0073: `timestamp discontinuity` stays ~0 on the E-AC-3 channel

**Verified live:**
- EPG generations keep the guide populated
- local-time recording names
- bulk hide/show
- the 2 GB tmpfs
- 0087/0088: zero `Non-monotonic DTS` across the first plays
- 0099: badge gone after a sync
- **0055: "another device is watching"** (23 Sept)

---

## 7. Frozen Apple-client contract (change only with a client patch)

- `/api/library/guide` rows: `id`, `sourceId`, `name`, `logo`, `category`, `tvgId`, `programmes[]` (`startTime`/`endTime` in **ms**).
- `/api/recordings/{id}/markers`: `startMs`/`endMs`. `/api/recordings/{id}/playback` (bearer):
  `{url:"/api/recordings/{id}/media.mp4", container:"mp4", durationSec}`; `media.mp4` takes `?token=`, supports ranges and
  `+faststart`; `?async=1` is additive.
- Favourites: `POST/DELETE /api/favorites` (bare id), listed via `/api/library/favourites`.
- Playback: `POST /api/playback/resolve` → `strategy` `direct` | `transcode`, with `playbackURL` under `/api/proxy/stream`,
  `/api/transcode/…` (`stream.m3u8`, or `master.m3u8` for HDR) or `/api/recordings/…`; token as `?token=`; bearer on
  `DELETE /api/playback/{id}`; `GET /api/playback/{id}/terminal-status`.
- Additive and safe: `/api/version` and `/api/info` fields; `waiting` rows; `finite`/`durationSec`/`videoRange` in resolve `info`.

---

## 8. Rules

- **Capture before changing anything on the playback path** (`stream-doctor`). **No ffmpeg-flag or timestamp patch ships on a
  hypothesis**: 0085 did, and silently broke every even feed. If a fault can't be captured, say so and treat the fix as provisional.
- Every functional patch has a test that **fails on the old code** (prove it) and a `verify-build.sh` check, and bumps `build`.
- **Every change the Apple client can see**, including anything in `transcodeSession.js` / `playbackStrategy.js`, gets a row in
  `docs/SWIFT-CLIENT-HANDOFF.md` §5 in the same patch. Nothing in §7 changes without a client patch.
- Say plainly what couldn't be run, and give Mark live-test steps for anything that needs the real feed or a device.
- At the end of a session, update this file: one line in §4, facts in §3/§5, and stories to the archive.

**Decisions on record.**
- *20 Sept:* stability over channel-change speed; VOD/series kept but unsupported; `requireStreamAuth` off while VPN-only; Mark
  applies and pushes.
- *21 Sept:* keep the Xtream/upstream proxy and `cache.js`; CI builds the images.
- *23 Sept:* **one delivery path now**: Phases 3 and 4 shipped together without the trial report, and the web's recovery is a fresh
  HLS session rather than a remux fallback.
