# PigTV server — handover (single source of truth)

**Last updated:** 23 September 2026 (build 0100)

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
| Local repo folder | `C:\Users\markr\GitHub\PigTV` (moved out of OneDrive, 21 Sept 2026) |
| Patch folder | `C:\Users\markr\GitHub\patches\PigTV` |
| Shipped through | **build 0104** once applied; 0100/0101 on `origin/main`. Confirm with `/api/version` |
| Next patch number | **0105** |
| Container name | **`PigTV`** on PassyFlix — every command in these docs names it literally, so it can be pasted as written. `docker ps` if it is ever renamed |

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
cd "C:\Users\markr\GitHub\PigTV"
git fetch origin
git checkout -B main origin/main
git am "C:\Users\markr\GitHub\patches\PigTV\NNNN-<subject>.patch"   # one line per patch, in order
git push origin main
```
**If `git am` says `previous rebase directory .git/rebase-apply still exists`:** a stale state folder from an earlier interrupted
`am` (happened twice, while the repo still lived in OneDrive). Run `git am --quit` (keeps HEAD and files; **not** `--abort`,
which can rewind commits), then repeat. The suspected cause — OneDrive syncing the repo with GitHub Desktop open on it — no
longer applies since the move, so a recurrence means something else and is worth chasing rather than shrugging off.

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
⚠️ `-bsf:v dump_extra` was tried (0043) and **reverted (0044)** for corrupting live copy sessions — never add it on a copy path.
It left with remux (0103) except in one place: `transcodeSession.js`'s MPEG-TS copy branch for a video codec that is neither
H.264 nor HEVC (e.g. MPEG-2). Not seen in any log; remove it only against a captured sample of such a feed (§7).

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
| 0093 | Captured samples go on the data volume, so a redeploy stops destroying the regression corpus |
| 0094 | `GET /api/playback/:id/terminal-status`: a displaced client can tell takeover from an ordinary failure |
| 0095 | CI stamps `PIGTV_COMMIT` / `PIGTV_BUILT_AT`, so `/api/version` proves what is running |
| 0096 | P1-3 part 1: `stable_id`, a channel identity a provider reorder cannot move (nothing keyed on it yet) |
| 0097 | P1-3 part 2a: favourites follow the channel, not the position |
| 0098 | P1-3 part 2b: scheduled recordings and watch history do too |
| 0099 | SR-2 (client R15): strip the decorative small-caps "ᴸɪᴠᴇ" badge from EPG titles/sub-titles/names and M3U channel names at ingest (shared `textCleanup.js`, ranges match the client) |
| 0100 | SR-1 (client R13): an HDR copy session is handed out via `master.m3u8` carrying `VIDEO-RANGE=PQ\|HLG` |
| 0101 | Test-only (no build bump): the watchdog's "keeps writing is left alone" test used 300 ms limits and failed CI's Node 20 job under load; now 1.5 s. **CI runs every test file at once on 2 vCPUs — keep timing margins ≥1 s** |
| 0102 | §C Phase 3: the web player is on the one path — always resolve + HLS, one re-resolve per selection as its recovery; local strategy, beta toggle, force-* settings gone; VOD page's remux → HLS copy sessions |
| 0103 | §C Phase 4: **remux retired** — `routes/remux.js`, the legacy piped `GET /api/transcode?url=`, their coordinator/resolve branches, `findCachedCodecs`, four unread settings and their tests deleted (589-line route, 454 lines of tests). HLS sessions are the only delivery path |
| 0104 | Session hardening: honest exit status (unrequested 255/signal = error), software-decode retry only for a GPU-decoding encode with no playlist yet, network-only URLs at every entry (`streamUrl.js`), `/api/proxy/stream` streams, dead `persist`/`restore`/`getOrCreateSession` gone |

---

## 4b. What to know before touching each area

**Provider slot and viewers** (`streamCoordinator.js`)
- The provider allows **one stream** (`maxProviderStreams`, default 1; a recording holds a slot of its own). To admit a viewer the
  slot is freed in this order: streams idle ≥ `viewerIdleTimeoutSec` (60 s) silently → the caller's *own* earlier stream silently →
  another owner's live stream, which needs confirmation: **409** `{conflict:{type:"viewer-in-progress", streamId, lastActiveSec,
  message}}`, overridden by `force:true` (same shape as `recording-in-progress`). Owner keys: `device:<id>` (paired device) /
  `user:<id>` (web login). `admitViewer()` releases before the new stream starts. `POST /api/transcode/session` (the movie/series
  page) uses **soft** mode (reclaim only, never 409 — its caller can't answer a prompt). HLS sessions are the only streams (0103).
- Live sessions are swept after **5 min** idle (`PIGTV_LIVE_IDLE_TIMEOUT_SEC`, checked every 60 s); seekable sessions 30 min. Not
  ~2 min on purpose: the 60 s rule already reclaims on demand, and a TV paused through a phone call shouldn't die (the 90-segment
  window has rolled past a ~6-minute pause anyway).
- **Stall watchdog** (`stallWatchdog.js`): kills an ffmpeg with no output for `PIGTV_STALL_TIMEOUT_MS` (20 s; 30 s grace before first
  output; HLS floor of 5 segments). *Output* = any file written in the session dir — **not** stderr (it gets louder during
  reconnects). Recordings (hard-stop timer) are not covered.
- Consequence: a viewer paused >60 s is "stale"; a due recording takes the slot silently instead of prompting.
- **Telling takeover from failure** (0094). A displaced client only sees a 404, the same as an expired session or a stalled feed;
  recovering from that takes the connection back off whoever just got it, and the two clients ping-pong. Owner equality cannot
  break the tie — two password logins are both `user:<id>`. So every release `admitViewer` performs leaves a short-lived record
  (`terminalRecords`, ~15 min, `PIGTV_TERMINAL_STATUS_TTL_SEC`, in memory) that only that session's owner can read, via
  **`GET /api/playback/:sessionId/terminal-status`** → `taken-over` | `none`. Non-consuming; anything else is `none`, so it cannot
  be used to discover that somebody is watching. **Only `admitViewer` writes records** — an explicit `DELETE`, the idle sweep, the
  stall watchdog and a recording reclaiming a stale stream all go elsewhere and leave nothing, which is what keeps ordinary
  recovery working. Releases now carry a `cause` (`idle` / `replacement` / `forced-takeover`) and the log line says which.

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
- **HDR needs a master playlist, not colour flags** (0100). Measured 23 Sept on `pos_31` Sky Sports Main Event UHD: source
  **HDR10 (PQ) + BT.2020, HEVC Main 10** (not HLG, as the client's SR-1 guessed), and the copied fMP4 `init.mp4` already keeps
  `colr`/`nclx` with the same values. Yet tvOS stayed SDR in both players: a media playlist has no `VIDEO-RANGE`, and Apple
  treats that as SDR. `streamProbe.classifyVideoRange()` reads `color_transfer` off the resolve probe (no extra connection);
  a **copy + fMP4** session with PQ/HLG gets `options.videoRange` and resolve returns `/api/transcode/{id}/master.m3u8`
  (built in memory; one variant → `stream.m3u8`). **No `CODECS`** on purpose — a wrong string makes AVPlayer refuse the variant.
  An encode is never called HDR (its output isn't). SDR is byte-for-byte unchanged. `mdcv`/`clli` boxes are absent (tvOS reads
  the SEI). Known sample: `pos_31` HDR10, timing even.
- **HLS sessions have no back-pressure** (a session writes to disk; nothing throttles ffmpeg to the player's read rate).
  A source that delivers faster than real time — a file served from the start (found on a provider URL), a catch-up channel, a
  start-up burst — runs ahead of the ~102-segment window and the player's next segment is gone: **404, which hls.js does not
  retry** (fatal at once, black frame under a `fragLoadError` banner). Fix = pace the input, gated by the probe: `format.size` or
  `duration` present ⇒ finite (a file with a `Content-Length` reports a size; an open-ended chunked live response reports
  neither). **Never blanket `-re`:** on a live-rate source it cost ~8 s at start-up. Remember this for Phase 3 and for VOD/series.
- **How a session ends** (0104). `stop()` marks it `stopped` *before* signalling ffmpeg, so the exit handler can tell "we ended it"
  (→ `stopped`, whatever code: 255 after SIGTERM, null after SIGKILL) from "it ended" (anything but 0 → `error`, logged
  `FFmpeg exited with code N` / `FFmpeg was killed (SIGNAL)`). An unrequested 255 used to leave the session `running` with no ffmpeg.
  The **software-decode retry** (clear the folder, restart with CPU decode) now happens only for an *encode* that really decoded on
  the GPU (`_usedVaapiDecode`) and died within 10 s **before any playlist** — it used to fire for copy sessions too (i.e. every live
  session), 404ing a client already fetching, for a restart that could not help.
- **Only network URLs are opened** (0104, `services/streamUrl.js`: http(s), rtmp(s), rtsp(s), udp, rtp, srt). Checked with a 400 at
  resolve, `POST /api/transcode/session`, `/api/probe`, `/api/subtitle` (whose `index` must be a number: it is a `-map` spec), and
  again where ffprobe/ffmpeg are spawned. Chosen over `-protocol_whitelist` because stream-doctor and the tests run the server's own
  ffmpeg arguments against local sample files.
- Start-up cost = the resolve-time probe + ffmpeg's own 5 MB / 5 s input probe + one 4 s segment. ffprobe result cached 5 min per
  URL. Trial logs: typically 7.5–9.6 s to first picture, 14 s occasionally (probe 3.6–6.6 s of it). Long keyframe spacing (≥10 s)
  can make a join fail ("Could not find codec parameters … unspecified size", exit -22); a smaller probe makes it worse — not shipped.
- The image's ffmpeg is Ubuntu 24.04's apt package (6.x). An upgrade was considered and rejected: the same warnings appear on 9.0,
  and it touches the hardware-driver stack under the Apple path.

**Audio that the browser rejects.** `audioEncode:true` on resolve makes the HLS session re-encode only the audio (AAC-LC,
video still copied) and beats the "smart copy" shortcut. Reason: **Chrome aborts the whole `<video>` on one rejected audio
frame**, and a copy hands it the provider's damaged frames. The web player replays once per selection on an audio
`MEDIA_ERR_DECODE` and remembers the channel in `localStorage['pigtv_audio_encode']` (max 200; clear it to reset). (Until 0103
this lived on the remux route, `?audio=encode`, with its own codec probe, `delay_moov` for AC-3 and line buffer — all in git.)

**Reading ffmpeg's log** — harmless, recurring:
`[h264] non-existing PPS/SPS referenced`, `decode_slice_header error`, `no frame!`, `Increasing reorder buffer` (joining mid-GOP
during the probe; self-ending); `Could not find codec parameters … eac3 … 0 channels`
(probe window ended early; if audio is ever silent from the start, suspect it — longer `-analyzeduration` for E-AC-3);
`[mp4] Packet duration: -N / dts: M is out of range` and `[hls] Non-monotonic DTS … changing to +1` — **not noise since 0088**:
a flood of these on a copy path means the feed was classified wrong. Check the channel's `[Playback] resolve timing` line, which
now ends `source timing even - DTS kept` / `uneven - DTS rebuilt` / `unknown - DTS kept`. A handful per hour is still normal. Real problems: `Could not write header`, `Codec probe failed`,
`FFmpeg exited with code`, `Releasing stalled session`, `[HLS] 404 for …`.

**`scripts/stream-doctor.js` — reach for this first on any playback fault** (0090). Five subcommands: `list <search>`,
`capture <pos_N> [sec]` (60 s of the real feed + a verdict), `classify <sample>`, `bench <sample>` (runs the server's *own*
argument builders once per candidate flag set and scores ffmpeg's warnings and frame-timing evenness), `probecost <pos_N>`.
Run it as `docker exec PigTV node scripts/stream-doctor.js …`. `capture` and `probecost` open a provider connection, so
**nothing may be playing**; the rest only read files. It reuses `streamProbe.classifyTimestamps` and `redact` rather than
copying them, so its verdict is by construction the one the server will act on. **The lesson worth keeping: a 60-second
capture turns a playback bug into a local, repeatable experiment and removes the redeploy cycle entirely — and a redeploy ends
every session. It found the 0085 regression, and the two-populations result, in an afternoon after weeks of spot fixes.** Channel ids are `pos_N` (`item_id` in `playlist_items`); the provider's numeric stream id
appears only inside the URL, and the URL itself is in the row's `data` JSON blob, not `stream_url`. Known samples: `pos_31` Sky Sports
Main Event UHD (HDR10, even); `pos_1187` Fox Sports 505 uneven; `pos_463` TSN, `pos_328` Sky Sports UHD (HEVC), `pos_468` Sportsnet 4K (a ~190 kbps slate) all even.

**Diagnostics and the trial** (`routes/playback.js`, `VideoPlayer.js`, `scripts/playback-report.js`)
- `POST /api/playback/client-event` (token required; whitelisted, bounded fields; **path only, never a query string**): events
  `media-error`, `start-timeout` (30/min limit) and `play-start`, `play-end` (120/min, separate budget). Log lines end
  `from=user:<id>` (web) or `from=device:<id>` (Apple). Grep: `docker logs PigTV 2>&1 | grep -E "\[Player\]|\[Playback\]|\[HLS\]"`.
  `[Playback] resolve timing: <direct|HLS session>, probe <X s|cached>[, first segment after Y s][, source ends (N min) - paced to real time]`.
- `scripts/playback-report.js`: `docker logs PigTV --since 24h > x.log` then `node scripts/playback-report.js x.log`. It parses
  the exact log wording (pinned by `verify-build.sh`) and reports per path first-picture time (cold/warm), stalls/hour, failures,
  device plays separately, and the trial criteria (≥50 plays per path, ≥3 HLS sessions of ≥1 h, no HLS-only failures, stalls/hour no
  worse than remux — constants at the top of the script). The log never names a channel; stall rates need ≥10 min watched.
- **Web player (0102): one path.** `play()` always calls resolve with `segmentedDelivery:true` (the Apple client's request) and plays
  what comes back; there is no browser-side strategy any more (no own probe, remux, legacy pipe or force-* settings; the beta toggle is
  gone). **Recovery = ask the server again, once per selection** (`recoverPlayback`): a resolve that fails, or a fatal hls.js error —
  including a segment 404, which hls.js never retries — gets one fresh session; a fatal *media* error is first tried in place
  (`hls.recoverMediaError()`, once). A second failure is shown, never looped. The audio re-encode self-heal now applies to HLS plays too.
  Subtitles: the live player adds no `/api/subtitle` tracks — that route opens a second provider connection (the removed local path
  was the only caller). Chrome keeps the *previous* URL in `currentSrc` while raising "Empty src attribute" on `video.src = ''` —
  detect a cleared source from the `src` attribute (`isSourceCleared`), and make `vm` test fixtures model real Chrome.
- **Movie/series page** (`WatchPage.js`, latent VOD): probes, then anything not browser-ready goes through `POST /api/transcode/session`
  (the only path that can resume, via `seekOffset`); what used to be remuxed is an HLS **copy** session in fMP4.

**Data, guide and library**
- Guide: query **`epg_live`** (each source's active generation), never `epg_programs`; a sync loads generation *active+1*, flips
  `active_gen` in one statement, deletes the old one in 20 000-row slices; a failed/empty feed leaves the live guide untouched; needs
  ~one extra guide of disk during a sync. Guide/now-next queries bound `start_time > from − 24 h` (`MAX_PROGRAMME_MS`) so the index
  range-scans — a programme that began >24 h before the window is not shown.
- `/api/library/*` fill a missing `logo` from the EPG channel with the same tvg-id, else the same name (case/spacing ignored); a
  playlist logo is never replaced; index cached 5 min; name matching can pair same-named channels.
- **Small-caps "ᴸɪᴠᴇ" badge stripped at ingest** (0099, SR-2): `services/textCleanup.js` `stripBadgeSuffix` is applied to EPG
  `title`/`sub-title`/`display-name` (both `epgParser` parse paths) and the M3U channel `name` (`m3uParser.parseExtinf`, so it also
  cleans derived `pos_N`-fallback tvg-ids). The code-point ranges match the client's `String.strippingBadgeSuffix()` exactly, so
  the client's interim stripper is now redundant. Only a *trailing* run of modifier/small-cap glyphs is removed — mid-title text is
  untouched. **It only cleans what is ingested after the deploy:** a redeploy skips any source synced <24 h ago (`syncIfStale`),
  so 0099 looked like it had failed until a manual Sync now (confirmed clean 23 Sept). Any ingest-time change needs a sync to show.
- **Channel identity vs playlist position** (0096–0098). `item_id` is `pos_N`, the M3U line number, and the provider moves it:
  on 21 Sept a reorder shifted Fox Sports 505 from `pos_1187` to `pos_1185` and a favourite was seen playing a different channel.
  `playlist_items.stable_id` (`services/stableIds.js`) is what a channel *is* — the provider's stream id out of the URL
  (`s441360`), a hash of the credential-stripped URL otherwise, NULL for a row with no URL. On the real playlist: 18 322 of
  18 323 from the stream id, 0 missing, **845 channels listed more than once**.
  Favourites (`favorites.stable_id`), scheduled recordings (`scheduled_recordings.channel_stable_id`) and `channel_history`
  all key on it, backfilled at startup, with `item_id` kept only as the fallback for rows that have **no** identity.
  **The trap, and it was caught by a test rather than by reading:** a row that HAS an identity still carries the position it was
  made at, and that position may now be a different channel — so matching must never fall back to it. Any new query joining these
  tables needs `(x.stable_id IS NOT NULL AND p.stable_id = x.stable_id) OR (x.stable_id IS NULL AND p.item_id = x.item_id)`,
  and a `GROUP BY` on the identity, or the 845 duplicates show up several times in a list.
  Only *pending* schedules are backfilled: rewriting a completed one would misstate what was recorded. Drift that already
  happened is not recoverable — the migration keeps whatever a row now points at.
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
- `/api/proxy/stream` **streams** binary content (0104; it used to buffer the whole body, so a progressive VOD file sat in memory and
  an endless source never reached the client) and aborts the upstream fetch when the client leaves. Playlists are still read whole —
  they have to be rewritten. VOD/series are latent code (§8).

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
- Tests: `node --test test/*.test.js` (~290, none skipped since 0103 removed the POSIX-only remux watchdog test). `verify-build.sh` takes the repo path
  (`bash scripts/verify-build.sh .`) and needs a real `python3` on PATH (a one-line `exec python "$@"` shim) with `PYTHONUTF8=1`.
- Tests that copy `server/` into a temp sandbox link `node_modules` with a *junction* on Windows. Working tree is CRLF (autocrlf).
  Where `ffmpeg` is a launcher shim (chocolatey), killing the process orphans the real one — end test runs with `-t`, don't kill.
- Every functional patch adds a `verify-build.sh` check *and* a test that fails on the old code (reintroduce the bug to prove it).

---

## 5. Roadmap

**Guiding direction (committed): one server path, one contract** — HLS segments from `playbackStrategy.resolve()`, with a thin
native player per platform (hls.js / Safari on the web, AVPlayer on Apple). The two-path split (remux for web, HLS for native) was
the source of most recurring defects (favourites ids, logos, resolve shape, flags duplicated across files, `dump_extra`).
**Done (0102–0103): one path.** The web plays through resolve + HLS and the remux route is gone.

### A. Server backlog (client-independent)
1. ✅ **Session hardening** (0104): exit status, software-decode retry, network-only URLs, streaming proxy, dead session code.
2. **Dead code still held:** `cache.js` + the upstream Xtream/EPG proxy routes + non-streaming `epgParser`/`m3uParser` functions
   (kept by Mark's 21 Sept decision), non-VAAPI encoders, any unread settings left (0103 dropped four). The plugin loader / `PLUGINS.md` is kept on purpose (empty extension point).
3. **P1-3 — part 1 shipped in 0096; part 2 is the remaining work.**
   **Part 1 (0096, done):** `playlist_items.stable_id` — what a channel *is*, from the provider's stream id inside its URL
   (`/live/<user>/<pass>/441360.ts` → `s441360`), falling back to a hash of the credential-stripped URL, and NULL for a
   placeholder row with no URL. Derived by `services/stableIds.js`, backfilled at startup, rewritten by every sync, and
   deliberately **not unique** — a channel cross-listed twice is two rows with one identity. Nothing is keyed on it yet, so
   0096 changes no behaviour; the sync logs `[Sync] Channel identity: …` so the derivation can be checked against the real
   18 000-channel playlist before anything depends on it.
   **Measured on the real playlist (21 Sept, 18 323 live rows):** 18 322 identities came from the provider's stream id, 1 from a
   URL hash, **0** with no URL; 17 127 distinct, **845 channels listed more than once**. The derivation is essentially total, and
   the duplicate count is what forced `library/favourites` to group by identity.
   **Part 2a (0097, done):** favourites. Keyed on the identity, migrated at startup, with the stored `item_id` used only for rows
   that have no identity — **a row that has one must ignore its stored position, or the stale id reintroduces the whole bug**
   (caught by a test, not by review). A channel listed twice is now one favourite.
   **Part 2b (0098, done):** scheduled recordings and `channel_history`. A schedule resolves its identity when it is *made* and
   prefers it at record time, so a reorder in between can no longer record the wrong programme. Only **pending** schedules are
   backfilled — rewriting a completed one would misstate what was actually recorded. History is joined the same way, grouped so a
   cross-listed channel appears once in "recently watched".
   **What none of it can do: favourites that had already drifted are already wrong**, and the migration preserves whatever they
   now point at. Mark should walk his favourites once after 0097 and fix any that look odd; after that they stay put.

   *Background — why the position was ever the id.* On 21 Sept the provider reordered its playlist mid-session:
   Fox Sports 505 moved from `pos_1187` to `pos_1185` within six hours (same channel, same URL, same provider stream id), and
   **a favourite was observed pointing at a different channel that evening**. `pos_N` comes from the channel's position in the
   M3U, so every id after an insertion shifts. Favourites, `channel_history` and scheduled recordings all key on it — a
   recording scheduled for one channel would record another. Needs a `stable_id` derived from something intrinsic; the provider's
   numeric stream id inside the URL survived both the reorder and is not the credentials (which rotate, and are why 0015 moved
   *off* a URL hash in the first place). Re-keys three tables; its own patch.
   Related, same day: the same channel is listed at **two** positions with an identical URL, so a favourite on one does not match
   the other and the recording duplicate-check may not see them as the same programme. `stable_id` gives both rows one identity,
   which is what part 2 needs to fix that too.

   **P1-4:** `resolve` returns an opaque handle instead of a credentialed `?url=` (contract change for both clients).
4. **Tests for Apple-relevant paths (P2-8):** EPG parser under bursty input, `withStreamToken` on fMP4, recordings Range,
   viewer-already-holds-slot.
5. **Lower:** shared helpers (`channelUrl`, `ffmpegProcess`, `probe`, `ids`); paged-channel-ordering index and keyset paging;
   `USER node` (needs volume ownership sorted first); fMP4 segment MIME; the duplicate `stop()`; try/catch in `info.js`.

### B. Apple client
See `docs/SWIFT-CLIENT-HANDOFF.md` (prioritised changes C1–C9, contract, test tips, and a change log). Nothing on the server blocks
it. Server ideas built only if asked: a **session keep-alive** riding the 5 s conflict poll (so a short pause can't lose the stream;
recommendation: skip — the client needs its recovery path either way, and the 60 s rule protects recordings), and **codec names on
`recordings/{id}/playback`** (only if an Apple TV fails an HEVC recording).

### C. Converge the webapp onto the one path (committed; the last step)
1. ✅ **Opt-in** (0075).
2. **Measure** — cut short by decision (Mark, 23 Sept: "move away from multiple approaches asap"); the report was not run. Mark uses the toggle for about a week, then saves logs and runs the report. The trial has already found
   and fixed two real faults (0085 uneven timestamps in copy sessions; 0086 finite sources outrunning the window). **Still to confirm
   after deploying them:** the channel that stopped and started (its `play-end` `stalls=`); the finite channel (provider stream id
   `1803789`) plays and its resolve line ends `source ends (N min) - paced to real time` — if not, check what ffprobe reports:
   `docker exec PigTV ffprobe -v error -show_entries format=size,duration -of default=nw=1 "<channel URL>"`.
3. ✅ **Default on** (0102). The safety net is a fresh HLS session rather than remux (which step 4 deletes): see "Web player" in §4b.
4. ✅ **Remux retired** (0103), straight after step 3 by the same decision: `routes/remux.js`, the coordinator's remux branches,
   the legacy `GET /api/transcode?url=` pipe and their tests are gone. `/api/remux` now answers the JSON 404.

Risks: slower channel change (measured above; if it must be won back, shorten the first segment or skip the resolve probe for known
sources — measure first); a session holding the provider slot (60 s reclaim + 5 min sweep); browser variance (fMP4 is what the Apple
path uses); AC-3 (HLS copy/transcode); tmpfs 2 GB (~360 MB/session cap) — fine for one viewer; direct-play HLS
upstreams stay `direct`.

---

## 6. Frozen Apple-client contract (do not change without a client patch)

- **`/api/library/guide`** rows: `id`, `sourceId`, `name`, `logo`, `category`, `tvgId`, `programmes[]` with `startTime`/`endTime` in **ms**.
- **`/api/recordings/{id}/markers`**: camelCase `startMs`/`endMs`.
- **`/api/recordings/{id}/playback`**: bearer required; `{url:"/api/recordings/{id}/media.mp4", container:"mp4", durationSec}`;
  `media.mp4` takes `?token=`, supports byte ranges, `+faststart`. (`?async=1` is opt-in and additive.)
- **Favourites:** client writes `POST/DELETE /api/favorites` (bare id), lists via `/api/library/favourites`.
- **Playback:** `POST /api/playback/resolve` with `capabilities.segmentedDelivery:true`; `playbackURL` allow-list
  (`/api/proxy/stream`, `/api/transcode/…`, `/api/recordings/…`; `/api/remux` is gone since 0103 and was never handed to it); token as `?token=`; bearer on `DELETE /api/playback/{id}`.
- **Additive, safe:** `/api/version` and `/api/info` fields (`build`, `commit`, `display`, `features`); `waiting` rows in
  `recordings/scheduled`; `finite` / `durationSec` in the resolve `info`.
- Client-coupled server changes are flagged in the handover and logged in `docs/SWIFT-CLIENT-HANDOFF.md` §5.

---

## 7. Standing disciplines

- **Diagnose a playback fault from a capture of the real channel before changing anything.** `scripts/stream-doctor.js`
  (§7a) turns it into a local, repeatable experiment; a redeploy costs a session and an evening. **No ffmpeg-flag or
  timestamp patch ships on a hypothesis** — 0085 did, and silently broke a whole class of channel that nobody had a sample
  of. If a fault cannot be captured, say so and treat any fix as provisional.
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

## 7a. When a channel misbehaves

The loop that works, in order. Mark can do steps 1–4 alone; steps 2 and 4 are the ones worth pasting into a session.

1. **Note the channel name and roughly when.** The log never names a channel, so this is the only link back to it.
2. **Ask what the server decided**, before touching anything:
   `docker logs PigTV --since 30m 2>&1 | grep -E "resolve timing|\[HLS\]|Non-monotonic|Packet duration"`.
   Each play's `resolve timing` line ends `source timing even - DTS kept` / `uneven - DTS rebuilt` / `unknown - DTS kept`
   (0088). A flood of timestamp warnings against a play classified the other way is a misclassification — that is the
   whole diagnosis, and the sample below proves it.
3. **Find its id:** `docker exec PigTV node scripts/stream-doctor.js list "<name>"` → `pos_N`.
4. **Capture and bench it, with nothing playing** (both take the provider's only connection):
   `… stream-doctor.js capture pos_N` then `… stream-doctor.js bench /app/data/samples/pos_N.ts`.
   `capture` prints the verdict; `bench` shows what the shipping arguments produce against the forced alternatives.
5. **Keep the sample.** They are the regression corpus: any future flag change gets tried against every one of them
   before it ships, which is exactly what 0085 had no way to do. Known so far (21 Sept): `pos_1187` Fox Sports 505
   **uneven**; `pos_463` TSN, `pos_328` Sky Sports UHD (HEVC), `pos_468` Sportsnet 4K (a ~190 kbps slate) all **even**.
   They live in **`/app/data/samples`**, which is the bind mount (`./data:/app/data`) and so survives a deploy. 0090 wrote
   them to `/app/samples` — the writable layer — and `docker compose up --force-recreate` destroyed the first corpus before
   anything had been retested against it (fixed in 0093). **A sample is evidence: it has to outlive the build it was taken on.**

Channel ids are `pos_N` (`item_id` in `playlist_items`); the provider's numeric stream id appears only inside the URL,
and the URL itself is in the row's `data` blob, not `stream_url`.

---


## 8. Decisions, open questions and checks still owed

**Decided (Mark, 20 Sept 2026).**
- §C Phase 1 as a Settings toggle, off by default.
- **Stability and quality outrank channel-change speed** — a slower change is acceptable if that's the price; Phase 2 reports the cost.
- **VOD / series are kept** (a future provider may offer them) but are **unverified and unsupported** (no VOD source to test
  against): latent code, excluded from dead-code batches, don't refactor casually. If ever removed, tag the last commit that had them.
- **`requireStreamAuth` stays off** while access is VPN-only; revisit if the server is ever exposed.
- Dead-code batches go early, in reviewable patches.
- Mark applies and pushes patches.

**Decided (Mark, 23 Sept 2026).**
- **One delivery path now** — §C Phases 3 and 4 shipped together (0102–0103) without waiting for the trial report: "move away from
  multiple approaches asap". The web's recovery is a fresh HLS session, not a remux fallback.

**Decided (Mark, 21 Sept 2026).**
- **Keep the Xtream/upstream proxy path and `cache.js`.** Likely wanted in the near future, so they stay out of the dead-code
  batches (§A.2 is now only the other items listed there).
- **Images are built by GitHub Actions on push to `main`** (`.github/workflows/docker-publish.yml`) — that was never in doubt,
  only undocumented. 0095 passes the commit and build time through, so `/api/version` carries them instead of `dev`.

**Open.**
- **Bug 2 is unexplained**: `[mpegts] Invalid timestamps … pts=X, dts=X+1800` (DTS *ahead* of PTS) on the mpegts segment path.
  None of the four captures reproduced it and playback was reported stable, so 0088 deliberately does not claim it. Needs the
  channel that produced it — the resolve-timing log line now names how each was classified, which should find it.
- **The classifier has seen one uneven feed out of four.** The margin is huge (33.8% vs 0.0%) but it should be checked across
  more channels; post-deploy the `source timing …` log line does this for free over an evening.
- Stall timeout tuning: 20 s is a conservative guess for long-GOP sources; tighten only after watching real stall logs for false positives.
- Session keep-alive / codec names on recording playback (§5 B) — build only if asked.

**Live checks never recorded as done** (status unknown as of 20 Sept — tick off or drop when seen):
0054 cut the upstream mid-stream → `treating ffmpeg as stalled`, slot frees, a *paused* web player isn't killed ·
0055 two devices: the second gets "Another device is watching", a device changing channel never sees a prompt about itself ·
0059 a favourite made in the web shows in the Apple app and back · 0062 an **HEVC** recording plays on the Apple client
(delete old `*.native.mp4` first); deleting a recording removes its sidecars ·
0073 `docker logs PigTV | grep -c "timestamp discontinuity"` stays ~0 on the E-AC-3 channel · Apple-device checks B1/B3/B5/B7
from the original list need the Swift client.

**Verified live (21 Sept):** 0056 EPG sync keeps the guide populated · 0061 recording file names in local time (`TZ` is set) ·
0063 a large bulk hide/show saves · `/app/transcode-cache` really is a 2 GB tmpfs (`docker exec PigTV df -h /app/transcode-cache`
→ `tmpfs 2.0G`), so segment churn never touches the array · 0087/0088 deployed, and across the first 12 plays every feed
classified `even - DTS kept` with **zero** `Non-monotonic DTS` (against ~33 000 timestamp warnings in the 24 h before).

**Already verified live (20 Sept):** web playback of several channels (A1 → 0071), bulk hide (A3 → 0072), 0071–0073 deployed and
working, 0085 running. The intermittent "nothing plays on some channels" stopped reproducing while others saw the same channel group
fail — put down to the provider; 0070's diagnostics will name it if it returns
(`docker logs PigTV | grep -E "Could not write header|never produced a byte|media-error"`).
