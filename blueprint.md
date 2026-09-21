# PigTV server — handover (single source of truth)

**Last updated:** 20 September 2026 (build 0086)

Authoritative handover for PigTV **server / webapp** work. Keep it **short**: it is read at the start of every session.

| Document | Use it for |
|---|---|
| `blueprint.md` (this) | Current state, durable knowledge (§4b), roadmap, decisions, disciplines |
| `docs/SWIFT-CLIENT-HANDOFF.md` | What the Apple client must change, its test tips, and a log of server changes it should know about (§5 there) |
| `server-review.md` | Point-in-time code review (16 Sept 2026): the file:line *why* behind roadmap items named "P1-x / P2-x". Many items are since fixed — this file tracks status |
| `docs/blueprint-archive.md` | Frozen pre-condensing copy of this file with the full per-patch write-ups (0048–0086). **Historical; don't read routinely** |
| `../PigTV-Swift/blueprint.md` | The Apple client's current state, roadmap and verification; replaces its old handovers |

## Core Requirements and Guidelines
We are developing an IPTV server with a supporting webapp and Swift clients (iPad / Apple TV); the server and webapp are this repository.
Wherever possible ensure **stream stability and quality**, and **reduce overhead and complexity**.
As progress is made, keep this file current for handover — and keep it small (condense, don't append narrative).

---

## 1. Orientation

| | |
|---|---|
| Repo | `github.com/maroge1990/PigTV` |
| Deployment | Unraid box "PassyFlix", image `ghcr.io/maroge1990/pigtv`, `http://192.168.1.235:3000`, reached over an approved-device VPN (Tailscale) only |
| Local repo folder | `C:\Users\markr\OneDrive\Documents\GitHub\PigTV Server` (inside OneDrive — see §2 note) |
| Patch folder | `C:\Users\markr\GitHub\patches\PigTV` |
| Shipped through | **build 0090** once applied (0086 was the last confirmed running); confirm with `/api/version` |
| Next patch number | **0091** |
| Container name | Find with `docker ps` — the commands below use `<container>` |

Don't hard-code the `origin/main` SHA anywhere. The deployed build is whatever `/api/version` reports (§3).

---

## 2. How patches are delivered

Each change ships as a numbered `git format-patch` file continuing the running sequence: commit on a local
`patch-NNNN-*` branch **based on the previous patch's branch if that one isn't on `origin/main` yet** (never on `main`, never
pushed), run `git format-patch -1 --start-number N -o "C:\Users\markr\GitHub\patches\PigTV"`, give a size sanity-note and **both**
command blocks. Check the patches apply in order on a throwaway `git worktree` of `origin/main`. Mark pushes; Claude never pushes
(Claude may apply patches to the working folder's `main` if asked — Mark then only pushes).

**Apply + push (PowerShell):**
```powershell
cd "C:\Users\markr\OneDrive\Documents\GitHub\PigTV Server"
git fetch origin
git checkout -B main origin/main
git am "C:\Users\markr\GitHub\patches\PigTV\NNNN-<subject>.patch"   # one line per patch, in order
git push origin main
```
**If `git am` says `previous rebase directory .git/rebase-apply still exists`:** a stale state folder from an earlier interrupted
`am` (happened twice). Run `git am --quit` (keeps HEAD and files; **not** `--abort`, which can rewind commits), then repeat.
Suspected cause: the repo is inside OneDrive and GitHub Desktop is open on it — close GitHub Desktop while applying, or move the
repo out of OneDrive.

**Pull + recreate + verify (Unraid / Docker):**
```bash
docker pull ghcr.io/maroge1990/pigtv:latest
docker compose up -d --force-recreate pigtv     # recreate, not restart (or Force Update on the Unraid Docker tab)
curl -s http://192.168.1.235:3000/api/version      # confirm the build number
```
A redeploy restarts the container and ends every session — avoid it mid-trial unless fixing a fault the trial found.

---

## 3. Version & build identity (the testing instrument)

`server/version.js` is the single source of truth: product semver (`package.json`) + a **`build`** number equal to the last patch
applied, bumped by every functional patch *in its own diff*. `/api/version` and `/api/info` return it; the webapp's top-left
badge shows `display` (e.g. `v3.7.0 · build 0086`). Git SHA / build time can be stamped via Dockerfile `PIGTV_COMMIT` /
`PIGTV_BUILT_AT` (inert if unset). Docs-only commits don't bump it.

---

## 4. Shipped log

Full write-ups: `docs/blueprint-archive.md`. Facts worth keeping are in §4b.

**0033–0047 (prior agent):** `segmentedDelivery` HLS for the native client, stream-token propagation to segments, AAC-in-fMP4 fix,
native recording-playback contract (0045), HLS on-disk bounding (0046), EPG streaming-parser backpressure (0047).
⚠️ `-bsf:v dump_extra` was tried (0043) and **reverted (0044)** for corrupting live copy sessions — never add it on a copy path
(it is still on the *remux* path until §C Phase 4).

| Patch | What |
|---|---|
| 0048 | Build identity (§3) |
| 0049 | Live HLS `temp_file` + `hls_delete_threshold` (torn playlist / rolled-out segment stalls) |
| 0050 | Auth gate: `requireAuth` on `/api/channels`, `/api/probe`; token on subtitle, resolve, `DELETE /api/playback/:id`. `requireStreamAuth` default unchanged |
| 0051 | Dropped the dead `ffmpeg-static` require |
| 0052 | Provider-credential redaction in logs / `/sessions` / errors |
| 0053 | `db.json` in-memory write-through cache |
| 0054 | ffmpeg output-inactivity watchdog (remux and HLS) |
| 0055 | Viewer-vs-viewer arbitration + 5-minute live idle timeout |
| 0056 | Atomic EPG swap via generations (`epg_live`) |
| 0057 | HLS segment route allow-list (traversal fix) |
| 0058 | `?token=` carried through the HLS *proxy* rewriter |
| 0059 | Favourites: bare channel id canonical + startup migration |
| 0060 | Guide query bounds + item-id index |
| 0061 | Recording file names in local time (`TZ`); recordings honour the UA setting |
| 0062 | Recording native playback: `hvc1`, remux dedupe, atomic output, sidecar cleanup, MP2→AAC |
| 0063 | 2 MB body cap; login and pairing rate limits |
| 0064 | Remux: reliable codec identification (fixes "Malformed AAC bitstream") |
| 0065 | `POST /api/playback/client-event`; web player reports media errors |
| 0066 | Remux: AC-3 / E-AC-3 (`delay_moov`) |
| 0067 | EPG-icon `logo` fallback in `/api/library/*` |
| 0068 | Audio re-encode self-heal for the remux path (`audioEncode`) |
| 0069 | Fix: 0065 reported every channel change as an error |
| 0070 | Diagnostics for silent "nothing plays" + remux start-up measurements |
| 0071 | Quiet probe-phase decoder chatter; real line buffer for ffmpeg stderr |
| 0072 | Fix: Hide All / Show All left group checkboxes stale |
| 0073 | `-dts_delta_threshold 60` (A/V start-time skew flooded HLS sessions and dropped audio) |
| 0074 | Housekeeping: `access.test.js` runs on Windows (junction) |
| 0075 | §C Phase 1: "HLS Delivery (beta)" toggle + `play-start` / `play-end` measurement |
| 0076 | Dead code (a): `users.js`, `m3uXtreamAdapter.js`, `hello.js` |
| 0077 | Dead code (b): OIDC/SSO + express-session (two dependencies dropped) |
| 0078 | Dead code (c, part 1): JSON-file `hiddenItems` / `favorites` in `db.js` |
| 0079 | Unknown `/api/*` → JSON 404; Apple-client route guard test |
| 0080 | A failed `db.json` write is reported, not swallowed |
| 0081 | `scripts/playback-report.js` (turns saved logs into the HLS-vs-remux trial report) |
| 0082 | Recordings in `waiting` are listed, cancellable, not duplicated |
| 0083 | `?async=1` recording-playback polling + `/api/info` capability flags + the Swift hand-off doc |
| 0084 | Playback report keeps Apple-device plays apart from the web trial |
| 0085 | Copy-video HLS sessions ignore the source's DTS (`igndts`) |
| 0086 | Sources that end are read at real time (`-re`); `[HLS] 404` log line; `play-end` stops counting after a fatal error |
| 0087 | Fix: cancelling the webapp takeover prompt no longer falls through to the local path and takes the stream anyway |
| 0088 | `igndts` decided per feed from the probe (supersedes 0085, which applied it to every copy) |
| 0090 | `scripts/stream-doctor.js`: the timestamp diagnostics as a supported tool (0089 was docs) |

---

## 4b. What to know before touching each area

**Provider slot and viewers** (`streamCoordinator.js`)
- The provider allows **one stream** (`maxProviderStreams`, default 1; a recording holds a slot of its own). To admit a viewer the
  slot is freed in this order: streams idle ≥ `viewerIdleTimeoutSec` (60 s) silently → the caller's *own* earlier stream silently →
  another owner's live stream, which needs confirmation: **409** `{conflict:{type:"viewer-in-progress", streamId, lastActiveSec,
  message}}`, overridden by `force:true` (same shape as `recording-in-progress`). Owner keys: `device:<id>` (paired device) /
  `user:<id>` (web login). `admitViewer()` releases before the new stream starts. `/api/remux` and `POST /api/transcode/session`
  use **soft** mode (reclaim only, never 409 — their web callers can't answer a prompt).
- Live sessions are swept after **5 min** idle (`PIGTV_LIVE_IDLE_TIMEOUT_SEC`, checked every 60 s); seekable sessions 30 min. Not
  ~2 min on purpose: the 60 s rule already reclaims on demand, and a TV paused through a phone call shouldn't die (the 90-segment
  window has rolled past a ~6-minute pause anyway).
- **Stall watchdog** (`stallWatchdog.js`): kills an ffmpeg with no output for `PIGTV_STALL_TIMEOUT_MS` (20 s; 30 s grace before first
  output; HLS floor of 5 segments). *Output* = stdout bytes for a remux, any file written in the session dir for HLS — **not**
  stderr (it gets louder during reconnects). A remux paused because the *client* isn't reading isn't stalled. A remux's `idleMs` is
  time since media last flowed. Recordings (hard-stop timer) and the legacy piped `GET /api/transcode?url=` are not covered.
- Consequence: a paused web/remux viewer >60 s is "stale"; a due recording takes the slot silently instead of prompting.

**HLS sessions** (`transcodeSession.js`, `playbackStrategy.js`)
- Shape: 4 s segments, playlist of 90 + 12 spare (`hls_delete_threshold`) ≈ 102 kept; flags `independent_segments+delete_segments+temp_file`
  (atomic playlist swap; margin for a client re-requesting a just-rotated segment). No `append_list`. Directory on tmpfs (2 GB).
- fMP4 segments when copying video and (HEVC, or codecs fine): hls.js can't demux HEVC from MPEG-TS, and TS's strict ordering
  flooded "Invalid DTS" on feeds that were fine over remux. HEVC fMP4 needs `-tag:v hvc1`. AAC copied into fMP4 needs
  `-bsf:a aac_adtstoasc` (ADTS→ASC; it refuses non-AAC, so only for AAC).
- Input timestamp flags: **`-dts_delta_threshold 60`** (default 10 s let feeds whose audio and video clocks start >10 s apart
  "jump" on every packet: thousands of log lines and half the audio dropped; env `PIGTV_DTS_DELTA_THRESHOLD_SEC`). **`-fflags +igndts` only for a copy-video
  session whose feed the probe called uneven** (0088; `PIGTV_DTS_AUTO=0` restores 0085's unconditional version). Two populations
  of feed exist and one flag cannot serve both — see "Two kinds of feed" below. **`-re` only when the probe says the source ends.**
- **Two kinds of feed, and why one flag cannot serve both** (0088). Measured on four captured channels:
  a feed is **uneven** when a third of its video DTS steps are ~1 tick followed by a double — an upstream muxer bumped repeated
  DTS by +1 instead of fixing them (Fox Sports 505: with `igndts`, even frames and no warnings; without, ~1015 "Non-monotonic
  DTS" a minute). A feed is **even** when its DTS is simply correct (TSN, Sky Sports UHD, Sportsnet 4K) — and there `igndts`
  *causes* the fault: ffmpeg discards a good clock, re-derives it from the PTS reorder buffer, and emits zero-length frames
  followed by double-length ones. **0085 applied it to every copy session, so it fixed one population and broke the other** —
  the reason spot fixes kept trading one report for another. Reverting 0085 only swaps which channels break.
  `streamProbe.classifyTimestamps()` decides it: mean video frame period over the probe's packets, count steps below a quarter
  of it, >5% ⇒ uneven. Measured 33.8% vs 0.0%, so the threshold is nowhere near either. It does **not** count repeated or
  backward DTS — on a real feed those are already gone, and the near-zero step is what survives. `null` (no packets, <20, an
  older cache entry) ⇒ keep the source's DTS.
- **The classification rides on the resolve probe's own ffprobe call** (`-show_packets -read_intervals %+#300`). It must stay in
  that one call: the provider allows a single connection, so a second ffprobe collides with it. `-read_intervals` is what bounds
  it — without it `-show_packets` on a live feed never returns and the probe hits its 15 s timeout, i.e. nothing plays at all.
  Measured on the box (ffprobe 6.1.1, live HTTP): terminates at exactly 300 packets (~145 KB), ~157–179 of them video, and costs
  nothing (−360 ms and +165 ms on two channels — noise; the packets come from bytes `-probesize` already reads).
- **HLS sessions have no back-pressure** (a remux's pipe throttles ffmpeg to the client's read rate; a session writes to disk).
  A source that delivers faster than real time — a file served from the start (found on a provider URL), a catch-up channel, a
  start-up burst — runs ahead of the ~102-segment window and the player's next segment is gone: **404, which hls.js does not
  retry** (fatal at once, black frame under a `fragLoadError` banner). Fix = pace the input, gated by the probe: `format.size` or
  `duration` present ⇒ finite (a file with a `Content-Length` reports a size; an open-ended chunked live response reports
  neither). **Never blanket `-re`:** on a live-rate source it cost ~8 s at start-up. Remember this for Phase 3 and for VOD/series.
- **Software-decode retry hazard (open):** if ffmpeg exits non-zero within 10 s of start and `vaapiHwDecode !== false`, the session
  clears its whole segment folder and restarts — also for copy sessions, where nothing is decoded — which would 404 a client
  already fetching. Not seen in trial logs. Fix candidates: restrict to encode + VAAPI; fresh directory or `#EXT-X-DISCONTINUITY`.
- Start-up cost = the resolve-time probe + ffmpeg's own 5 MB / 5 s input probe + one 4 s segment. ffprobe result cached 5 min per
  URL. Trial logs: typically 7.5–9.6 s to first picture, 14 s occasionally (probe 3.6–6.6 s of it). Long keyframe spacing (≥10 s)
  can make a join fail ("Could not find codec parameters … unspecified size", exit -22); a smaller probe makes it worse — not shipped.
- The image's ffmpeg is Ubuntu 24.04's apt package (6.x). An upgrade was considered and rejected: the same warnings appear on 9.0,
  and it touches the hardware-driver stack under the Apple path.

**Remux route** (`routes/remux.js` — to be retired in §C Phase 4)
- Since 0088 it takes `needsIgnDts` from the same cached probe as the codecs (`findCachedCodecs` returns `dtsUneven` alongside
  them). It had applied `igndts` to every stream since long before 0085; that is where its `Packet duration … out of range`
  lines came from.
- Needs the codecs: reuses `/api/playback/resolve`'s cached probe (`findCachedCodecs`, no extra provider connection), else ffprobe
  with one retry after 1.5 s, else **503 + `Retry-After: 2`**. There is **no safe guess**: ADTS AAC into MP4 fails without
  `aac_adtstoasc`, and forcing the filter onto non-AAC fails at start-up. AC-3/E-AC-3 into empty-moov MP4 need `delay_moov` (added
  only for those; it delays start by up to a keyframe).
- `?audio=encode` / resolve `audioEncode:true` re-encodes only the audio (AAC-LC stereo 48 kHz, 160 kb/s, video still copied) and
  beats the "smart copy" shortcut. Reason: **Chrome aborts the whole `<video>` on one rejected audio frame**, and a copy hands the
  browser the provider's damaged frames. The web player retries once per selection on an audio `MEDIA_ERR_DECODE` and remembers
  the channel in `localStorage['pigtv_audio_encode']` (max 200; clear it to reset).
- ffmpeg stderr arrives in arbitrary pieces — always go through the line buffer (`makeLineBuffer`), never treat a read as a line.

**Reading ffmpeg's log** — harmless, recurring:
`[h264] non-existing PPS/SPS referenced`, `decode_slice_header error`, `no frame!`, `Increasing reorder buffer` (joining mid-GOP
during the probe; self-ending; remux counts them instead of logging); `Could not find codec parameters … eac3 … 0 channels`
(probe window ended early; if audio is ever silent from the start, suspect it — longer `-analyzeduration` for E-AC-3);
`[mp4] Packet duration: -N / dts: M is out of range` and `[hls] Non-monotonic DTS … changing to +1` — **not noise since 0088**:
a flood of these on a copy path means the feed was classified wrong. Check the channel's `[Playback] resolve timing` line, which
now ends `source timing even - DTS kept` / `uneven - DTS rebuilt` / `unknown - DTS kept`. A handful per hour is still normal. Real problems: `Could not write header`, `Codec probe failed`,
`FFmpeg exited with code`, `Releasing stalled session`, `[HLS] 404 for …`.

**`scripts/stream-doctor.js` — reach for this first on any playback fault** (0090). Five subcommands: `list <search>`,
`capture <pos_N> [sec]` (60 s of the real feed + a verdict), `classify <sample>`, `bench <sample>` (runs the server's *own*
argument builders once per candidate flag set and scores ffmpeg's warnings and frame-timing evenness), `probecost <pos_N>`.
Run it as `docker exec <container> node scripts/stream-doctor.js …`. `capture` and `probecost` open a provider connection, so
**nothing may be playing**; the rest only read files. It reuses `streamProbe.classifyTimestamps` and `redact` rather than
copying them, so its verdict is by construction the one the server will act on. **The lesson worth keeping: a 60-second
capture turns a playback bug into a local, repeatable experiment and removes the redeploy cycle entirely — and a redeploy ends
every session. It found the 0085 regression, and the two-populations result, in an afternoon after weeks of spot fixes.** Channel ids are `pos_N` (`item_id` in `playlist_items`); the provider's numeric stream id
appears only inside the URL, and the URL itself is in the row's `data` JSON blob, not `stream_url`. Known samples: `pos_1187`
Fox Sports 505 uneven; `pos_463` TSN, `pos_328` Sky Sports UHD (HEVC), `pos_468` Sportsnet 4K (a ~190 kbps slate) all even.

**Diagnostics and the trial** (`routes/playback.js`, `VideoPlayer.js`, `scripts/playback-report.js`)
- `POST /api/playback/client-event` (token required; whitelisted, bounded fields; **path only, never a query string**): events
  `media-error`, `start-timeout` (30/min limit) and `play-start`, `play-end` (120/min, separate budget). Log lines end
  `from=user:<id>` (web) or `from=device:<id>` (Apple). Grep: `docker logs <container> 2>&1 | grep -E "\[Player\]|\[Playback\]|\[HLS\]"`.
  `[Playback] resolve timing: <direct|remux|HLS session>, probe <X s|cached>[, first segment after Y s][, source ends (N min) - paced to real time]`.
- `scripts/playback-report.js`: `docker logs <container> --since 24h > x.log` then `node scripts/playback-report.js x.log`. It parses
  the exact log wording (pinned by `verify-build.sh`) and reports per path first-picture time (cold/warm), stalls/hour, failures,
  device plays separately, and the trial criteria (≥50 plays per path, ≥3 HLS sessions of ≥1 h, no HLS-only failures, stalls/hour no
  worse than remux — constants at the top of the script). The log never names a channel; stall rates need ≥10 min watched.
- Web player facts: `stop()` is defined **twice** in `VideoPlayer.js` (the later wins; cleanup candidate). Chrome keeps the *previous*
  URL in `currentSrc` while raising "Empty src attribute" on `video.src = ''` — detect a cleared source from the `src` attribute
  (`isSourceCleared`), and make `vm` test fixtures model real Chrome. A fatal hls.js error shows `Playback error (HLS <details>)` and
  reports `HLS_<type>`; **no recovery yet** (Phase 3).
- Toggle: Settings → Transcoding → Stream Processing → **HLS Delivery (beta)** — per browser (`localStorage['pigtv_hls_delivery']="1"`), off
  by default; it sets `capabilities.segmentedDelivery:true` in the web's resolve call, the request the Apple client already makes.

**Data, guide and library**
- Guide: query **`epg_live`** (each source's active generation), never `epg_programs`; a sync loads generation *active+1*, flips
  `active_gen` in one statement, deletes the old one in 20 000-row slices; a failed/empty feed leaves the live guide untouched; needs
  ~one extra guide of disk during a sync. Guide/now-next queries bound `start_time > from − 24 h` (`MAX_PROGRAMME_MS`) so the index
  range-scans — a programme that began >24 h before the window is not shown.
- `/api/library/*` fill a missing `logo` from the EPG channel with the same tvg-id, else the same name (case/spacing ignored); a
  playlist logo is never replaced; index cached 5 min; name matching can pair same-named channels.
- **Favourites: bare channel id is canonical** (`services/channelIds.js`); `initSchema` rewrote prefixed rows at startup (one-way,
  in `content.db`); `GET /api/favorites` re-presents the composite form the web matches on (`?format=bare` gives stored form).
  Open: derived `stable_id` (a provider reorder shifts `pos_N`).
- `db.json`: in-memory write-through cache; `saveDb` rejects on failure, rolls back the in-memory copy unless a newer save
  overtook it, keeps the write queue alive, and gives clients a plain sentence (path stays in `docker logs`). Legacy `hiddenItems` /
  `favorites` arrays are dropped on the next write.
- Auth is stateless bearer tokens (web login + paired devices); **no sessions or cookies** (express-session and OIDC removed in 0077 —
  if SSO is ever wanted it's in git history, but device pairing fits better). `requireStreamAuth` stays **off** (VPN-only).
- Limits: `express.json` 2 MB; failed logins 10 / 15 min per (socket address, username) → 429 + `Retry-After` (keyed on the socket,
  not `X-Forwarded-For`); pairing 60 start / 1 500 poll per 10 min; all in-memory. HLS segment names allow-listed
  (`seg\d{4,}.(ts|m4s)` and `init.mp4`); fMP4 segments are still served as `video/MP2T` on purpose (revisit with a device on hand).
  The HLS *proxy* rewriter carries `?token=`. Unknown `/api/*` → `404 {"error":"No such API endpoint"}`; **add any new Apple-client
  endpoint to `APPLE_CLIENT_ROUTES` in `test/api-404.test.js`.**
- `/api/proxy/stream` buffers a whole upstream body in memory (a progressive-MP4 VOD file would hit it). VOD/series are latent code
  (§8).

**Recordings** (`recordingEngine.js`, `routes/recordings.js`)
- Statuses `scheduled → waiting → recording → …`; `waiting` = due but held back by a viewer; it is included in the upcoming list,
  cancellable (cancelling also withdraws the viewer prompt) and in the duplicate check.
- File names use the server's **local** time: set `TZ` (compose passes `TZ=${TZ:-UTC}`; the Unraid template needs it too, e.g.
  `Australia/Sydney`). The recording ffmpeg uses `db.getUserAgent(settings)`.
- Native playback = a `.native.mp4` remux (`-tag:v hvc1` — ffmpeg's default `hev1` is refused by AVFoundation; MP2 audio →
  AAC), concurrent requests share one remux, written as `.partial` then renamed, existing files probed once per run, sidecars
  removed with the recording. Old HEVC sidecars are `hev1` and not regenerated: delete `*.native.mp4` for HEVC recordings once.
  **HEVC playback in AVPlayer has never been confirmed on a device.**
- `GET /api/recordings/:id/playback` blocks until ready (legacy). With **`?async=1`**: 200 as before when ready; **202
  `{status:"preparing",retryAfterSec:3}`** + `Retry-After: 3`; **500 `{status:"failed",reason:"remux-failed"|"file-missing",error}`**
  once, then a fresh attempt on the next ask. A fresh attempt gets a 1.5 s grace before answering 202.
- `/api/info` `features` flags: `recordingPlaybackPolling`, `scheduledWaiting`, `viewerConflict`, `epgLogoFallback`, `clientEvents`
  (plus the original `playbackResolve, library, guide, devicePairing, recordings, streamCoordination, streamTokenAuth`).
  `routes/info.js`'s handler is async with no `try/catch` (cosmetic today).

**Dev environment (Windows)**
- Tests: `node --test test/*.test.js` (245: 244 pass, 1 skipped — POSIX-only remux watchdog). `verify-build.sh` takes the repo path
  (`bash scripts/verify-build.sh .`) and needs a real `python3` on PATH (a one-line `exec python "$@"` shim) with `PYTHONUTF8=1`.
- Tests that copy `server/` into a temp sandbox link `node_modules` with a *junction* on Windows. Working tree is CRLF (autocrlf).
  Where `ffmpeg` is a launcher shim (chocolatey), killing the process orphans the real one — end test runs with `-t`, don't kill.
- Every functional patch adds a `verify-build.sh` check *and* a test that fails on the old code (reintroduce the bug to prove it).

---

## 5. Roadmap

**Guiding direction (committed): one server path, one contract** — HLS segments from `playbackStrategy.resolve()`, with a thin
native player per platform (hls.js / Safari on the web, AVPlayer on Apple). The two-path split (remux for web, HLS for native) was
the source of most recurring defects (favourites ids, logos, resolve shape, flags duplicated across files, `dump_extra`). Harden the
one path first (done: watchdog, arbitration, self-heal, diagnostics), then move the webapp onto it (§C).

### A. Server backlog (client-independent)
1. **After the HLS trial ends** (each touches the HLS/remux argument builders or a session — a redeploy restarts sessions):
   software-decode retry hazard (§4b); `/api/proxy/stream` streaming instead of buffering; ffmpeg `-protocol_whitelist` (`file:` /
   `concat:` accepted on URL routes; bounded by the VPN); exit code 255 leaves a dead HLS session marked `running`; dead code in
   `transcodeSession.js` (`persist`, `restore`, `recoverSessions`, `getOrCreateSession`).
2. **Dead code still held:** `cache.js` + the upstream Xtream/EPG proxy routes + non-streaming `epgParser`/`m3uParser` functions
   (pending Mark's decision on keeping the Xtream/VOD path), non-VAAPI encoders, unread settings, the legacy piped
   `GET /api/transcode?url=`. The plugin loader / `PLUGINS.md` is kept on purpose (empty extension point).
3. **P1-3 remainder:** derived `stable_id` so a provider reorder can't re-point favourites, history and scheduled recordings
   (re-keys three tables; its own patch). **P1-4:** `resolve` returns an opaque handle instead of a credentialed `?url=` (contract
   change for both clients).
4. **Tests for Apple-relevant paths (P2-8):** EPG parser under bursty input, `withStreamToken` on fMP4, recordings Range,
   viewer-already-holds-slot.
5. **Lower:** shared helpers (`channelUrl`, `ffmpegProcess`, `probe`, `ids`); paged-channel-ordering index and keyset paging;
   `USER node` (needs volume ownership sorted first); fMP4 segment MIME; the duplicate `stop()`; try/catch in `info.js`.
6. Client-side remux retry — on hold; skip if §C lands (the migration is the web's recovery).

### B. Apple client
See `docs/SWIFT-CLIENT-HANDOFF.md` (prioritised changes C1–C9, contract, test tips, and a change log). Nothing on the server blocks
it. Server ideas built only if asked: a **session keep-alive** riding the 5 s conflict poll (so a short pause can't lose the stream;
recommendation: skip — the client needs its recovery path either way, and the 60 s rule protects recordings), and **codec names on
`recordings/{id}/playback`** (only if an Apple TV fails an HEVC recording).

### C. Converge the webapp onto the one path (committed; the last step)
1. ✅ **Opt-in** (0075): the per-browser toggle above. Rollback = untick.
2. **Measure — in progress.** Mark uses the toggle for about a week, then saves logs and runs the report. The trial has already found
   and fixed two real faults (0085 uneven timestamps in copy sessions; 0086 finite sources outrunning the window). **Still to confirm
   after deploying them:** the channel that stopped and started (its `play-end` `stalls=`); the finite channel (provider stream id
   `1803789`) plays and its resolve line ends `source ends (N min) - paced to real time` — if not, check what ffprobe reports:
   `docker exec <container> ffprobe -v error -show_entries format=size,duration -of default=nw=1 "<channel URL>"`.
3. **Default on, with a safety net:** if an HLS session fails to start (15 s `waitForPlaylist`, fatal hls.js error — **including a
   segment 404, which hls.js won't retry**) fall back *once* to remux for that play.
4. **Retire remux** after a clean run of step 3: delete `routes/remux.js`, the coordinator's remux branches, the watchdog's remux
   wiring, `-bsf:v dump_extra`, the legacy `GET /api/transcode?url=` pipe, the web's direct `/api/remux` callers and their tests.

Risks: slower channel change (measured above; if it must be won back, shorten the first segment or skip the resolve probe for known
sources — measure first); a session holding the provider slot (60 s reclaim + 5 min sweep); browser variance (fMP4 is what the Apple
path uses); AC-3 (HLS copy/transcode, not remux); tmpfs 2 GB (~360 MB/session cap) — fine for one viewer; direct-play HLS
upstreams stay `direct`.

---

## 6. Frozen Apple-client contract (do not change without a client patch)

- **`/api/library/guide`** rows: `id`, `sourceId`, `name`, `logo`, `category`, `tvgId`, `programmes[]` with `startTime`/`endTime` in **ms**.
- **`/api/recordings/{id}/markers`**: camelCase `startMs`/`endMs`.
- **`/api/recordings/{id}/playback`**: bearer required; `{url:"/api/recordings/{id}/media.mp4", container:"mp4", durationSec}`;
  `media.mp4` takes `?token=`, supports byte ranges, `+faststart`. (`?async=1` is opt-in and additive.)
- **Favourites:** client writes `POST/DELETE /api/favorites` (bare id), lists via `/api/library/favourites`.
- **Playback:** `POST /api/playback/resolve` with `capabilities.segmentedDelivery:true`; `playbackURL` allow-list
  (`/api/proxy/stream`, `/api/remux`, `/api/transcode/…`, `/api/recordings/…`); token as `?token=`; bearer on `DELETE /api/playback/{id}`.
- **Additive, safe:** `/api/version` and `/api/info` fields (`build`, `commit`, `display`, `features`); `waiting` rows in
  `recordings/scheduled`; `finite` / `durationSec` in the resolve `info`.
- Client-coupled server changes are flagged in the handover and logged in `docs/SWIFT-CLIENT-HANDOFF.md` §5.

---

## 7. Standing disciplines

- Every functional patch pairs with a `verify-build.sh` check and a test that fails on the old code.
- Each functional patch bumps `version.js` `build` to its own number, in its own diff. Docs-only commits don't.
- Nothing in §6 changes without a coordinated client patch. **Every patch that changes what the Apple client sends or receives
  adds a row to `docs/SWIFT-CLIENT-HANDOFF.md` §5 in the same patch** (including changes to `transcodeSession.js` /
  `playbackStrategy.js`, which reach the Apple client even when no response shape changes).
- Deliver both command blocks together with a size note; patch files go to `C:\Users\markr\GitHub\patches\PigTV` (§2). Claude commits
  only on a local `patch-NNNN-*` branch and never pushes.
- Say plainly when tests / `verify-build.sh` could not be run, and give Mark live-test steps for anything that needs the real feed.
- Reference docs: `blueprint.md`, `server-review.md`, `docs/SWIFT-CLIENT-HANDOFF.md` (the archive is history, not reference).
- **Update this doc at the end of each session — and condense as you go:** replace narrative with the fact worth keeping (§4b),
  one line in §4, and move nothing back in from the archive.

---

## 8. Decisions, open questions and checks still owed

**Decided (Mark, 20 Sept 2026).**
- §C Phase 1 as a Settings toggle, off by default.
- **Stability and quality outrank channel-change speed** — a slower change is acceptable if that's the price; Phase 2 reports the cost.
- **VOD / series are kept** (a future provider may offer them) but are **unverified and unsupported** (no VOD source to test
  against): latent code, excluded from dead-code batches, don't refactor casually. If ever removed, tag the last commit that had them.
- **`requireStreamAuth` stays off** while access is VPN-only; revisit if the server is ever exposed.
- Dead-code batches go early, in reviewable patches, and don't touch the remux path (that waits for Phase 4).
- Mark applies and pushes patches.

**Open.**
- **Bug 2 is unexplained**: `[mpegts] Invalid timestamps … pts=X, dts=X+1800` (DTS *ahead* of PTS) on the mpegts segment path.
  None of the four captures reproduced it and playback was reported stable, so 0088 deliberately does not claim it. Needs the
  channel that produced it — the resolve-timing log line now names how each was classified, which should find it.
- **The classifier has seen one uneven feed out of four.** The margin is huge (33.8% vs 0.0%) but it should be checked across
  more channels; post-deploy the `source timing …` log line does this for free over an evening.
- Keep or drop the Xtream/upstream proxy path and `cache.js` (gates §A.2).
- GHCR build mechanism (GitHub Actions on push, or local `docker build`?) — decides whether `commit`/`builtAt` auto-inject.
- Stall timeout tuning: 20 s is a conservative guess for long-GOP sources; tighten only after watching real stall logs for false positives.
- Unraid template: confirm Extra Parameters give `/app/transcode-cache` a tmpfs (`--tmpfs /app/transcode-cache:size=2g`) and that `TZ` is set.
- Session keep-alive / codec names on recording playback (§5 B) — build only if asked.

**Live checks never recorded as done** (status unknown as of 20 Sept — tick off or drop when seen):
0054 cut the upstream mid-stream → `treating ffmpeg as stalled`, slot frees, a *paused* web player isn't killed ·
0055 two devices: the second gets "Another device is watching", a device changing channel never sees a prompt about itself ·
0056 during an EPG sync the guide stays populated; `Removed N superseded programmes` afterwards; `SELECT COUNT(*) FROM epg_live`
matches the XMLTV `<programme` count · 0059 a favourite made in the web shows in the Apple app and back · 0061 set `TZ`, schedule a
recording, the file name shows local time · 0062 an **HEVC** recording plays on the Apple client (delete old `*.native.mp4` first);
deleting a recording removes its sidecars · 0063 a large bulk hide/show still saves (a 413 means the 2 MB cap is too tight) ·
0073 `docker logs <container> | grep -c "timestamp discontinuity"` stays ~0 on the E-AC-3 channel · Apple-device checks B1/B3/B5/B7
from the original list need the Swift client.

**Already verified live (20 Sept):** web playback of several channels (A1 → 0071), bulk hide (A3 → 0072), 0071–0073 deployed and
working, 0085 running. The intermittent "nothing plays on some channels" stopped reproducing while others saw the same channel group
fail — put down to the provider; 0070's diagnostics will name it if it returns
(`docker logs <container> | grep -E "Could not write header|never produced a byte|media-error"`).
