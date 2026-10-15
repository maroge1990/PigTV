# Dispatcharr review: what PigTV can learn, borrow or hand over

**12 October 2026 · PigTV server build 0207 · Dispatcharr v0.32.0 (`eab4b4f`, 9 Oct 2026)**

I read Dispatcharr's source; I did **not** run it. Its behaviour below comes from reading the code, with file
references. Anything marked *to verify* needs a spike before we rely on it.

---

## 1. Bottom line

> **Superseded on 13 Oct 2026:** Mark chose Plan B (§11, blueprint §4): PigTV stays standalone and the R1 spike below is
> not pursued. The recommendation is kept as the record of what was considered.

Dispatcharr and PigTV overlap heavily in the **provider layer**: ingesting M3U/Xtream, connection limits, multiple
providers, failover, EPG matching, and a DVR with Comskip. They don't overlap in the **viewer layer**: Apple-ready HLS,
the master playlist with HDR and frame rate, the Apple client contract, Sport, the guide UX, and the
recording-versus-viewer takeover policy. That layer is PigTV's own work, and Dispatcharr has nothing like it.

The biggest lesson is architectural. **Dispatcharr opens each channel from the provider once and fans it out to every
consumer.** Viewers, the DVR and transcode profiles all read one shared buffer. PigTV opens a new provider connection
for every ffmpeg. With providers that allow one stream each, that one difference produces most of PigTV's hardest
code: leases, the 409 takeover between our own devices, probe/ffmpeg collisions and their retries, relay legs, standby
and warming.

**Recommendation:**

1. **Run a time-boxed spike (about 3–5 days) with Dispatcharr as PigTV's upstream.** PigTV would add Dispatcharr as
   its one Xtream source and keep everything viewer-facing. If it holds up, about **1,700–2,200 lines** of PigTV's
   failover, relay and pool code can go. PigTV's cross-provider *matching* stays: Dispatcharr has no equivalent (§8).
   Both paths are planned in §10 and §11, and what must survive either way is in §9.
2. **Whatever the spike shows, adopt five patterns natively:** fan-out ingest (if we stay standalone), segmented
   recordings, a recording end that follows the guide, series rules, and speed-based stall detection.
3. **Don't copy their stack.** Django, Celery, Redis and Postgres solve multi-user, multi-worker problems PigTV doesn't
   have.

---

## 2. What Dispatcharr is

| | |
|---|---|
| Stack | Python/Django + DRF, Celery workers, Redis (stream buffers, locks, pub/sub), Postgres (SQLite also supported), gevent/uWSGI, nginx, React frontend. The AIO image runs all of it in one container (`docker/entrypoint.aio.sh`). |
| Size | ~1,000 Python/JS source files. Live proxy ~29k lines (`apps/proxy`), channels/EPG/M3U ~37k. **~2,560 test functions** in 180 files. |
| Pace | 61 tagged releases; recently about every 2–4 weeks (0.30.0 on 29 Aug → 0.32.0 on 7 Oct). Four named core maintainers plus contributors. |
| Licence | **AGPL-3.0** (PigTV is GPL-3.0). Re-implementing an idea is fine. Pasting code would put the combined work under AGPL terms. Running it as a separate container has no licence effect on PigTV. |
| Target clients | Plex/Emby/Jellyfin (HDHomeRun emulation), TiviMate-style Xtream clients, M3U players, its own web player. **Live output is progressive MPEG-TS or fMP4 over HTTP, not HLS.** AVPlayer can't play that directly. This decides how PigTV can use it (see §5). |

---

## 3. Feature overlap

| Area | PigTV today | Dispatcharr | Verdict |
|---|---|---|---|
| Sources | M3U + Xtream, sync, stable ids | M3U + Xtream, hash-based identity with configurable keys, **regex include/exclude filters at ingest**, stale-stream ageing, auto-create channels from a group into a number range | Close parity. Ingest filtering is worth borrowing (R8) |
| Provider limits | Per-provider pools, same-account detection (`accountKey.js`), leases (R11) | Per-profile `max_streams`, **credential pools** (same login across servers, `ServerGroup`), atomic INCR-first slot reservation (`apps/m3u/connection_pool.py`) | Parity in concept. Theirs counts **channels**, not consumers |
| Multiple providers / failover | Primary-only guide, backups linked by `channelLinks.js` (863 lines, region rules), cold failover, relay legs stitched in the playlist, optional hot standby | A Channel is an **ordered list of Streams from any provider**. Failover runs inside the ingest: retry the same stream if it was stable ≥30 s, else switch to the next. Rotation cooldown, retry windows, max 10 switches (`input/manager.py`, `config.py`) | Dispatcharr's model is simpler and much more exercised. **Biggest reason for the spike** |
| Sharing one stream | None. Each viewer, recording, probe, warm and standby is its own provider connection | **One upstream per channel, any number of consumers.** New clients join 5 s behind live from the buffer. Optional `channel_shutdown_delay` keeps a channel hot after the last client leaves | **Main architectural lesson** (R1/R2) |
| Stall detection | No new file for 20 s → kill (`stallWatchdog.js`) | Same "no data" monitor, **plus** ffmpeg `speed=` below 1.0× for 15 s counts as buffering and triggers a switch | Borrow the speed signal (R7) |
| Output to Apple | HLS sessions, copy-first, fMP4/TS, HE-AAC handling, master playlist with `VIDEO-RANGE`/`FRAME-RATE`, channel profiles | None. TS/fMP4 progressive plus "output profiles" (pipe-through ffmpeg, e.g. AAC or AC3 audio) | **PigTV's own value. Keep it** |
| EPG | XMLTV, categories, manual mapping with Dice + bigram suggestions | XMLTV + Schedules Direct, bulk auto-match (rapidfuzz, ±15 region bonus from the tvg-id suffix, optional MiniLM), **regex "dummy EPG"** that builds programmes from event-channel names | Small gains (R9, R10) |
| DVR | One-off recordings with padding, recording priority and takeover prompts, failover parts, MKV → MP4 prepare, Comskip, live break detection (0207) | Records **through its own proxy** (shares the channel). **HLS event segments**, watch while recording, restart recovery appends segments, remux to MKV at the end. **Series rules** with episode-identity dedupe, recurring time rules, **end time extended while recording**, artwork lookup | Several things to borrow (R3–R6) |
| Viewer vs recording policy | Full policy: idle reclaim, ask once, 3-minute auto hand-over, partial recordings | User-level preemption is scored, but **only logged, never acted on** (`apps/channels/models.py` `get_stream`: the `return` is commented out). Recordings are "protected" | **PigTV is ahead. Keep it** |
| Sport | Per-programme recognition, ESPN fixtures, follow list, replays | None | PigTV only |
| Monitoring | Status page, channel health, last 50 plays, least reliable channels | Live stats with per-channel ffmpeg speed/fps/bitrate/resolution, a system event log, **webhooks/scripts on events** (`apps/connect`) | Borrow webhooks and live ffmpeg stats (R11) |
| Operations | Manual backup "before a risky deploy" | **Scheduled DB backups with retention and restore** (`apps/backups`) | Borrow, it's cheap (R12) |
| Outputs to other apps | None | M3U, XMLTV, Xtream API, HDHomeRun emulation, per-profile | Free if the spike is adopted; otherwise not needed |
| Catch-up / VOD / plugins / multi-user | Removed or not planned | Present | Don't copy (§6) |

---

## 4. Why the fan-out ingest matters for PigTV

PigTV's providers allow **one connection each**. Today these all compete for that one connection:

- a second device on the **same** channel (409 takeover prompt);
- a recording of the channel you're **watching** (prompt, or a backup connection);
- the resolve **probe** and the ffmpeg it starts (hence "use the probe's own ffprobe call", and the two 4xx retries
  in ffmpeg's first 3 s, 0143);
- warming, the hot standby and relay legs (each one a lease).

In Dispatcharr's model, every item above that involves the same channel costs **zero extra connections**. That would
change things in PigTV:

| PigTV behaviour | With a shared ingest |
|---|---|
| Record the match and watch it live: prompt, or burn a backup | One connection |
| Two TVs on the same channel: 409 | One connection, no prompt |
| Probe, then ffmpeg, then 4xx because the provider hasn't released the probe | Both read the buffer. The retries can go |
| Cold start 7.1–10.1 s (probe + ffmpeg's own probe + first segment) | For a channel that's already running, probe bytes come from the buffer at once (*to verify*: the start-up gain on a cold channel is unproven) |
| Zap back to the last channel: full cold start | A short shutdown delay keeps it hot. That's most of what `channelWarming.js` is for |
| Failover: new relay leg, playlist stitching, discontinuity | The ingest switches source. The HLS ffmpeg keeps reading one pipe and sees one timestamp jump (*to verify* with `stream-doctor`, §7 rule) |

Different channels still need different connections. Fan-out doesn't create capacity, it just stops PigTV competing
with itself.

---

## 5. Recommendations, ranked

Sizes match the 3 October audit: **S** ≤2 days, **M** 3–5, **L** 6–10, **XL** >10.

### R1. Spike: Dispatcharr as PigTV's upstream (M, highest leverage)

**What:** run the Dispatcharr AIO container on PassyFlix next to PigTV. Put Strong8K, Trex and Dream4K in Dispatcharr
as M3U accounts and build channels there, each an ordered list of the three providers' streams. Point PigTV at
Dispatcharr's **Xtream output** (or its M3U + XMLTV) as PigTV's only source. PigTV keeps resolve, HLS sessions, the
guide, Sport, DVR scheduling, the Status page and the Apple contract.

**What could go if it works:** see §10 (Plan A). *Corrected after the second sweep (§8):* Dispatcharr does not link
a channel across providers on its own, so `channelLinks.js` stays as the source of the links and is pointed at
Dispatcharr's API. Realistically about **1,700–2,200 lines** go, not the 3,580 first estimated.

**Spike exit criteria (capture-first, per the AGENTS.md rules):**
1. `stream-doctor capture` through Dispatcharr on the reference samples (`pos_31` HDR, `pos_1187` uneven, `pos_463`,
   `pos_328`, `pos_468`). The even/uneven classification, HDR `colr` and HE-AAC must survive the extra hop. Its default
   "proxy" profile is a byte passthrough. Its ffmpeg profile adds `+genpts+discardcorrupt`, which may change our
   timestamp classification, so test both.
2. Kill a provider mid-play and check that the HLS session survives Dispatcharr's switch: no `Timestamps looping`, at
   most one visible glitch.
3. Watch + record the same channel and confirm one provider connection on Dispatcharr's stats page.
4. Map Dispatcharr's "all profiles at max connections" refusal onto PigTV's existing 409/prompt flow. **PigTV keeps
   the takeover policy**, because Dispatcharr's preemption doesn't act. PigTV can read capacity first from
   `/proxy/ts/status`.
5. Resolve timings for cold, warm (channel already running) and zap-back, against the 0109 baseline.
6. Idle footprint of the AIO container (Redis + Celery + Postgres) on PassyFlix.

**Risks:** one more service to deploy and upgrade, and its releases change behaviour every few weeks (pin a tag). An
extra network hop on the hot path. The provider's ~38 s cut and 19 s resend (§10) would now pass through Dispatcharr's
reconnect logic: better or worse is unknown until captured. PigTV's channel health would see Dispatcharr's channels
rather than per-provider feeds, so least-reliable reporting would move to Dispatcharr's stats.

**If the spike fails**, R2 delivers most of the same benefit natively.

### R2. Native fan-out ingest, only if R1 is rejected (L)

One upstream reader per (provider, channel): a single ffmpeg `-c copy -f mpegts pipe:1`, or a plain HTTP read, into
an in-memory ring buffer of about 30–60 s. Consumers subscribe: the HLS session's ffmpeg reads from stdin, recordings
read the same buffer, and the resolve probe reads the buffer's tail. The coordinator counts **ingests**, not sessions.
Failover swaps the ingest's source. A short linger (`channel_shutdown_delay`, 10–30 s) replaces most of the warming
logic.

It replaces the relay's leg-stitching and makes leases per channel. It's L because it touches the playback path
everywhere and needs the full capture/bench pass. Model it on `apps/proxy/live_proxy/input/manager.py` (ingest and
failover) and `output/ts/generator.py` (late-joiner positioning). Re-implement, don't paste (AGPL).

### R3. Segmented recordings: revisit R13 (M)

Dispatcharr records every programme as an HLS **event** playlist (`-f hls -hls_time 4 -hls_playlist_type event
-hls_flags append_list+omit_endlist+independent_segments`, `-avoid_negative_ts make_zero`) and remuxes to a single
file only at the end (`apps/channels/tasks.py` `_dvr_build_ffmpeg_cmd`, `_dvr_remux_hls_to_mkv`). That gives them:

- **watch while recording, and start-over**, with no preparation step;
- the **"fresh recording takes a minute to play"** problem from the 3 Oct audit gone: the HLS is playable immediately,
  and AVPlayer plays an event playlist natively;
- **restart and failover continuity**: a new ffmpeg appends to the same playlist (`-start_number` from the highest
  existing segment) instead of PigTV's "parts" (max 3);
- live Comskip on segments rather than a growing MKV.

Mark skipped R13 on 4 Oct. Dispatcharr is evidence that it's the mainstream design and has been hardened in
production. Worth reconsidering, and it pairs naturally with the HLS the Apple client already plays.

### R4. A recording end that follows the guide (S, high value for sport)

Dispatcharr's capture loop re-reads the recording's end time and **extends a recording in progress** when the schedule
moves. I found no equivalent in PigTV. A schedule's `program_end` is fixed when it's created. For sport overruns
(extra time, rain delays, F1 red flags), tie it to the EPG sync: after each sync, recompute end times for
`scheduled|recording` rows from the programme now in that slot (matched by title and overlap, never extended past
something like +3 h), and let the engine's tick honour a later end.

### R5. Series rules and recurring rules (M)

Dispatcharr's `evaluate_series_rules` schedules every future airing of a (tvg_id, title) for 7 days ahead. It
**deduplicates by episode identity** (season/episode, `onscreen_episode` or `sub_title`) plus a 15-minute start
window, because "XMLTV feeds nudge programme boundaries between refreshes" and exact-time keys schedule the same
airing twice. It also supports day-of-week/time rules. PigTV has one-off recordings only. The natural PigTV version is
**"record my followed teams/leagues"**: the Sport follow list already finds the events, and a rule turns each `event`
(not `replay`) into a schedule, deduplicated by the merged event identity.

### R6. Recording artwork (S, low priority)

Dispatcharr resolves a poster through a chain: EPG image → TMDB/OMDb → TVMaze/iTunes → channel logo, and skips the
lookup when the title is just the channel name (`_resolve_poster_for_program`). The Apple Recordings shelf would look
better with the EPG image at least. External lookups are optional.

### R7. Speed-based stall detection and reconnect-or-switch (S)

Dispatcharr parses ffmpeg's `speed=` line and treats below 1.0× for 15 s as buffering, an earlier and more honest
signal than "no file for 20 s". Its health monitor then **reconnects the same stream if it had been stable ≥30 s,
and switches stream if it hadn't** (`_monitor_health`), with a 60 s rotation cooldown after all streams are exhausted.
PigTV's watchdog and relay could use both rules. Per §7, ship behind the existing relay switch, and **after** reading
real `speed=` values from production logs. Copy sessions often run faster than 1.0× while catching up, so the
threshold needs data.

### R8. Ingest filters (S)

Mark's selection is about 1,000 channels out of about 18,000. Dispatcharr applies regex include/exclude filters
(group, name, url) **at sync time** (`_compile_m3u_stream_filters`), so unwanted rows never reach the database. PigTV
syncs everything and hides it. Filtering at ingest would shrink sync time, the DB and the linker's search space. Keep
hide/show for the UI; add "never import" for whole groups (adult, foreign-language, VOD-in-live).

### R9. Event-channel guide (M)

Dispatcharr's `dummy_epg.py` builds guide entries from **channel names** with user regexes. Example:
"NBA 06: Lakers @ Celtics 7:30 PM ET" becomes a programme with a title and a time. PigTV deliberately never links
event/PPV slots ("NBA 06 :", "ESPN+ 123"), and those slots carry exactly the games Sport wants. Parsing the event out
of the slot name would let Sport list them, since the guide has nothing for them today.

### R10. EPG matching: small tune-ups (S)

Two cheap ideas from `apps/channels/epg_matching.py`: a **±15 region bonus or penalty** from the tvg-id's `.au`/`.nz`/
`.uk` suffix (PigTV already learnt region matters for linking; it applies to EPG suggestions too), and a **bulk
"auto-map all unmatched" at a high threshold (≥90)** with a review list, instead of one at a time. Skip the ML model:
it needs PyTorch.

### R11. Webhooks and live ffmpeg stats (S)

`apps/connect` sends events (channel failover, buffering, recording start/end, M3U/EPG error, login failed) to
webhooks or scripts. For PigTV, one webhook URL setting for **provider down**, **recording failed** and **licence
expiring** would reach Mark's phone (ntfy/Home Assistant) without opening the Status page. Also show each live
session's ffmpeg speed/fps/bitrate on the Status page. We parse stderr already.

### R12. Scheduled database backups (S, do this regardless)

The deployment notes say "back it up before a risky deploy", which is manual. Dispatcharr runs scheduled backups with
retention and a restore endpoint (`apps/backups`). For PigTV: nightly `VACUUM INTO data/backups/pigtv-YYYYMMDD.db`,
keep 14, list them on the Status page, and take one automatically at startup when the build number changes. About
50 lines of code, protecting schedules, health, mappings and links.

---

## 6. What not to copy

- **The stack.** Celery, Redis and Postgres exist because Dispatcharr runs several uWSGI workers that must coordinate
  (`worker_id`, owner locks, Redis-held buffers). PigTV is one Node process. An in-memory ring buffer and SQLite are the
  right size.
- **VOD, catch-up, plugins, multi-user permissions, network ACLs, Schedules Direct.** All decided against or not needed
  (VPN-only, EPGenius guide).
- **User-authored ffmpeg command profiles.** Flexible for their audience, but PigTV's §7 rule ("no ffmpeg-flag patch
  ships on a hypothesis") argues for our fixed, tested argument builders.
- **Their preemption.** It isn't finished. PigTV's recording and takeover policy is more complete.

---

## 6a. The encoding components in detail

**How Dispatcharr is built.** It has two kinds of profile, at two separate stages:

| Stage | Dispatcharr | What it does | PigTV equivalent |
|---|---|---|---|
| Fetch | **Stream profile** (`core/models.py` `StreamProfile`) | How the stream is fetched from the provider: built-in byte "Proxy" (Python HTTP), "Redirect", ffmpeg `-c copy -f mpegts pipe:1` with `+genpts+discardcorrupt`, Streamlink or VLC. One per channel, writes into the shared buffer | The front half of each HLS session's ffmpeg |
| Convert | **Output profile** (`OutputProfile`, `output/profile/manager.py`) | Any command that reads TS on `pipe:0` and writes on `pipe:1`. Seeded with "Web Player (AAC Audio)" and "Media Server (AC3 Audio)", video copied in both. **One process per (channel, profile), shared by every client that asks for it.** Picked per user, per HDHR URL, per DVR setting, or by `?output_profile=` | The back half of each HLS session's ffmpeg (copy/encode decision, HLS muxing) |
| Remux | **fMP4 manager** (`output/fmp4/manager.py`) | One `-c copy` TS→fMP4 remux per channel. The init segment is cached so late joiners get it | Our fMP4 HLS segments |

**Dispatcharr's encoding is a generic pipe; PigTV's is the cleverer one.** Dispatcharr never runs ffprobe on a live
stream. It starts the stream and parses codec, resolution and fps out of ffmpeg/VLC/Streamlink stderr
(`services/log_parsers.py`) for display only. Nothing decides copy versus encode per client. It has no HDR or
frame-rate signalling, no HE-AAC handling, no timestamp classification, and no encoder logic at all (the user writes
the command). PigTV's resolve → capabilities → copy-first decision is ahead of it for Apple TV, which in practice
copies nearly everything. **The lesson is the shape, not the ffmpeg arguments.**

**E1. Split fetching from conversion (part of R1/R2).** PigTV's one ffmpeg does both, so anything that disturbs the
provider connection (the ~38 s cut, a refusal, failover) is a fault in the HLS session itself. That's why the relay
has to stitch legs and the timestamp-loop detection (0191) restarts the session. With the split, the converting
ffmpeg reads a local pipe that never drops. A provider reconnect or switch reaches it as one timestamp discontinuity
in a continuous input. Dispatcharr marks those discontinuities with `-mpegts_flags +initial_discontinuity+resend_headers
+pat_pmt_at_frames`, so a consumer joining or resuming always has the PAT/PMT tables it needs to decode. Its
`new_client_behind_seconds` start (5 s back in the buffer) also gives the converter, and our probe, a keyframe
immediately. *To verify*: the converter's behaviour across a source switch, using `stream-doctor bench` on a capture
that contains a switch.

**E2. One pinned ffmpeg, the same in development and production (S to try, gated).** Dispatcharr bases its image on
`lscr.io/linuxserver/ffmpeg:version-8.1.2-cli`: Ubuntu 24.04 with VAAPI, QSV and NVENC built in. It pins the tag after
`:latest` moved to FFmpeg 9 and broke older NVIDIA drivers (CHANGELOG 0.31.0). PigTV ships Ubuntu's apt 6.x but
measures on Homebrew 9.0 locally. That leaves known gaps: the 0144 read-rate burst is "unverified on production's
ffmpeg 6.x", and §3 reasons about 6.x "from reading its source, not run". This isn't the upgrade rejected earlier; the
point is that **what is measured is what runs**. Options: run 6.x locally, or take ffmpeg (and its iHD driver) from a
pinned linuxserver tag. Gate on `stream-doctor bench` of the five reference samples and a VAAPI encode on PassyFlix.

**E3. Keep every audio track (S, check first).** PigTV live maps `-map 0:v:0 -map 0:a:0?` (`transcodeSession.js:555`),
so only the first audio track survives. Dispatcharr maps everything (`-map 0`, and `0:v? 0:a?` for DVR). If any of
our feeds carry a second track (another language, commentary, AC-3 alongside stereo), AVPlayer would show a track
menu for free once they are copied. Check first with `ffprobe` on the reference samples and a few sport channels. If
no feed has a second track, drop this. If some do, the master playlist and the HE-AAC/encode branches need care for
the extra tracks.

**E4. Lessons from their changelog, cheap to apply where they touch us:**
- **Finalise segmented recordings by remuxing the playlist, not with the concat demuxer** (0.32.0: concat re-timed each
  segment and broke the file). Applies to R3.
- **Map subtitles and data explicitly.** DVB subtitles can't go into HLS, and without a subtitle codec ffmpeg's
  automatic encoder selection fails the open. PigTV already avoids both (`-sn -dn`, explicit maps), so this confirms
  the current choice.
- **Spawn multi-process pipelines in their own process group and kill the group** (0.32.0, orphaned children). This
  matters once PigTV pipes an ingest into a converter (R2) or runs Comskip alongside.
- **No filler packets toward the client while a channel starts** (null TS packets made Emby/Jellyfin deinterlace or
  fail). Relevant if PigTV ever outputs TS to other apps.

**What not to take:** user-editable ffmpeg commands (against §7's "no flag ships on a hypothesis"), Streamlink/VLC
inputs (our providers are plain Xtream TS), and per-(channel, profile) shared encodes. PigTV's clients rarely want the
same encode at the same time (Apple copies, the web re-encodes HE-AAC audio), so there's little to share.

---

## 7. Suggested order

*Superseded by §10–§12 (the two plans). Kept for the reasoning.*

1. **R12** backups (S): no-regret, before anything risky.
2. **R1** spike (M): decide "upstream or standalone" before spending on R2/R7.
3. **R4** recording end follows the guide (S): direct sport value, independent of R1.
4. **R3** segmented recordings (M) and **R5** follow-list recording rules (M).
5. Then, depending on R1: adopt Dispatcharr and delete the provider layer, **or** R2 + R7 natively.
6. Small ones when convenient: R8, R10, R11, R9, R6, and from §6a: **E3** (check for extra audio tracks) and **E2**
   (match the ffmpeg version between development and production).

---

## 8. Second sweep: what the first pass missed

A second pass over `apps/timeshift`, `apps/output`, `apps/accounts`, `apps/epg/tasks.py`, `apps/m3u/tasks.py`, the
frontend and the last two release notes. New findings, most important first:

| Finding | Detail | Matters for |
|---|---|---|
| **No automatic cross-provider linking** | `sync_auto_channels` creates **one channel per stream per provider group**. Joining Trex's and Dream4K's copies of a channel to Strong8K's is manual ("Add selected stream(s) to the target channel") or done through the REST API (`/api/channels/channels/`, `X-API-Key`). There's nothing like `channelLinks.js`: no region rules, quality pairing, event-slot exclusion or channel-number matching | **Plan A keeps PigTV's linker** and has it write Dispatcharr's stream order. This corrects §5 R1 |
| **Catch-up (provider archive)** | `apps/timeshift` proxies Xtream archives (`/timeshift/{user}/{pass}/{min}/{start}/{id}.ts` and `timeshift.php`). It pads 5 min because "archives commonly lag live by about 30 seconds to 2 minutes", fails over across providers, and handles seek/Range restarts. It advertises `tv_archive` in its own Xtream output | A potential **start-over and "watch the match from kick-off"** feature, *if* our providers have archives. PigTV discards `tv_archive` at sync (`syncService.js` keeps id/name/category/epg id only), so this is unknown. Check `get_live_streams` for `tv_archive: 1` first |
| **Event slots carry the game in the name** | Our own Trex fixture: `CA (TSN+ 001) \| ATP 500 Tennis: Tokyo _ Early Round Coverage Day #1 (2026-09-29 22:00:00)`. Dispatcharr's regex dummy EPG turns names like that into guide entries | Makes R9 (event-channel guide) more valuable than first rated |
| Stable ids in its Xtream output | `get_live_streams` returns `stream_id = channel.id` (Dispatcharr's own id, unaffected by provider reorders) and `epg_channel_id = channel number`. `tv_archive` is included | Plan A identity migration (§10 A3) |
| 503 when full | A tune with no free slot waits, then answers **503** `{"error": "...maximum connection limits..."}`. A provider failure answers 502 | Plan A coordinator mapping (A4) |
| A lingering channel holds its slot | `channel_shutdown_delay` keeps the upstream after the last client leaves, and preemption doesn't act. With **one** connection per provider, a lingering channel blocks a *different* channel on that provider | Plan A: keep the delay at **0**; don't use it as a warming substitute |
| Expiry tracking | `check_account_expirations` (daily, 7-day warning), from each profile's `exp_date` | Parity with D6/D7. Plan A reads it from Dispatcharr |
| EPG only parsed for mapped channels | `parse_programs_for_source` stages programmes only for EPG ids mapped to a channel, then swaps | Minor Plan B idea. PigTV's whole-feed swap already works |
| Integration events | `channel_failover`/`stream_switch` now carry `previous_stream_id` and a `reason` (0.32.0). `recording_end` fires after post-processing, with outcome | Plan A: PigTV's health/Status can subscribe to these instead of guessing |
| Operational extras | In-app log browser, system events page, OpenAPI schema, API keys, reverse-proxy auth, channel profiles (per-user subsets), radio, HDHomeRun for Plex/Jellyfin, plugin store | Mostly not needed. HDHomeRun comes free in Plan A |
| VOD and its proxy, Schedules Direct, multi-user levels, network ACLs | Large, mature | Out of scope (decided 23 Sept) |

Re-checked and still true: the live output is not HLS. Preemption only logs (`get_stream`, the `return` is commented
out). DVR records through its own proxy as HLS event segments. Its default ffmpeg ingest uses
`+genpts+discardcorrupt` and `-map 0`.

---

## 9. What PigTV does better: keep it in both plans

These are either absent from Dispatcharr or weaker there. Neither plan removes them. Each line names where it lives.

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

---

## 10. Plan A: use Dispatcharr as the provider layer

**Shape.** Dispatcharr owns *getting streams from providers*: accounts, connection slots, fetching each channel once
and sharing it, failover within a channel, account expiry. PigTV owns *everything a viewer touches* (K1–K15). PigTV
sees exactly one source: Dispatcharr's Xtream output. PigTV's linker decides the order of each channel's streams
inside Dispatcharr.

```
Strong8K ─┐                     ┌─ HLS session (K1–K3) ─ Apple TV / web
Trex ─────┼─ Dispatcharr ─ XC ──┼─ recording (K12)
Dream4K ──┘  (ingest, slots,    └─ probe
              failover)   ▲
                          └── PigTV linker (K7) writes each channel's stream order via the API
```

**A0. Gate: the spike (M).** As in §5 R1, with these added to the exit criteria:
- (a) the **D5 behaviour** with "whole provider down": Dispatcharr will try the dead provider's own backup feed
  before moving on. Measure the extra delay;
- (b) the **503 path** under three concurrent demands;
- (c) `channel_shutdown_delay = 0` confirmed to free the slot at once;
- (d) catch-up URLs work through Dispatcharr if providers have archives.

**Stop here if** any reference sample loses its classification, HDR or HE-AAC through the hop, or a provider switch
causes a timestamp loop in our HLS session.

**A1. Deploy (S).** AIO container on PassyFlix, **pinned tag** (never `:latest`), its own backups on, data volume
backed up. Add the three providers as accounts with `max_streams = 1` each. EPGenius as the EPG source. Auto channel
sync **for the primary's selected groups only** (D2), numbered from the provider's `num` (K13). Turn off what we don't
use: DVR, VOD, HDHomeRun, extra users.

**A2. Linker writes Dispatcharr (M).** Keep `channelLinks.js` matching unchanged (K7) and its tests. Replace its
output: instead of a `channel_links` table read by `providerRouting`, it calls Dispatcharr's API to set each channel's
ordered streams to [primary, primary's "(Backup)", Trex, Dream4K]. That ordering encodes D5's first half. Idempotent:
diff before writing, log changes. Run after each Dispatcharr M3U refresh. Its trigger is Dispatcharr's `m3u_refresh`
webhook (`apps/connect`) or PigTV polling.

**A3. PigTV source switch and identity migration (M, the riskiest step).** Add Dispatcharr as an Xtream source.
Favourites, schedules, channel numbers, EPG mappings, sport categories and health are keyed by (source, stable id).
Write a one-off, tested migration that maps each old primary stable id to the Dispatcharr channel holding that
provider stream (Dispatcharr keeps the provider's `stream_id` on its Stream). Run it in a transaction. Keep the old
sources disabled, not deleted, for one release as the rollback. The Apple contract (K11) is unchanged: same ids shape,
same fields.

**A4. Coordinator scoped down (M).** One pool, "Dispatcharr", with capacity read from `/proxy/ts/status` (sum of free
provider slots). **Same channel = no new connection**: a second viewer or a recording of the channel being watched is
admitted without a lease or prompt. Different channel with no capacity → Dispatcharr's 503 maps onto the existing 409
prompt flow. K5's policy and K6's leases are kept for that case only.

**A5. Retire (S–M, after A3 has run a week).**

| Goes | Lines | Replaced by |
|---|---|---|
| `streamRelay.js` (legs, standby, playlist stitching) | 674 | Dispatcharr failover inside the shared ingest |
| `providerRouting.js` (everything but the D5 ordering moved into A2) | ~350 of 415 | Stream order in Dispatcharr |
| `providerAccounts.js` + `accountKey.js` | 325 | Dispatcharr accounts and expiry; the PigTV reminder UI reads it through the API |
| Multi-pool parts of `streamCoordinator.js` | ~300–400 | One pool (A4) |
| 0143 refusal retries in `transcodeSession.js` | ~60 | The probe and ffmpeg share Dispatcharr's channel |
| `ProvidersSettings.js` / `BackupLinksSettings.js`, cut down to a status view and a "relink now" button | ~600 of 1,028 | Dispatcharr's UI for accounts |
| Related tests | ~6 of the 13 files | |

Total about **1,700–2,200 lines**. Kept: `channelLinks.js` (K7), `channelWarming.js` (K14, now able to warm through
Dispatcharr when a slot is free), all of K1–K15.

**A6. Then build, using Dispatcharr where it already does the work:**
- Catch-up/start-over through Dispatcharr's timeshift endpoint, if providers have archives (§8).
- Event-channel guide from Dispatcharr's dummy EPG regexes, which give Sport new events.
- Failure notifications from Dispatcharr's Connect webhooks plus PigTV's own (recording failed, licence).
- Natively in PigTV (Dispatcharr's DVR isn't used): **segmented recordings (R3)** recording from the Dispatcharr URL,
  **recording end follows the guide (R4)**, **follow-list recording rules (R5)**, **SQLite backups (R12)**.

**Plan A risks:** another service to run and upgrade, with frequent behaviour changes (mitigated by pinning and a
staged upgrade with the spike's checks as a script). An extra network hop on every play. The identity migration
(A3). Per-provider health is less visible: Dispatcharr's events would feed PigTV's health (K9). It depends on an
outside project's direction.

**Rough total:** M (A0) + S + M + M + M + S–M ≈ **4–6 weeks** of part-time sessions, before A6.

---

## 11. Plan B: stay standalone and adopt Dispatcharr's ideas natively

**Shape.** No new service. PigTV gains the shared ingest (R2) and keeps its own provider layer, simplified because
the ingest makes several pieces unnecessary.

**B1. Quick wins (S each, any order, all independent of the playback path):**
- R12 nightly SQLite backups + one at startup when the build changes.
- R4 recording end follows the guide.
- R11 one webhook URL (provider down, recording failed, licence expiring) + live ffmpeg speed/fps on the Status page.
- §8 check: does any provider set `tv_archive`? Keep the flag at sync (one column) so it's known.
- E3 check for extra audio tracks on the reference samples.

**B2. Recordings (M + M):**
- R3 segmented recordings: HLS event playlist, append on restart and failover (replacing parts), remux the playlist at
  the end, MP4 preparation (K12) from the segments.
- R5 follow-list recording rules, with episode/event-identity deduplication. R6 EPG artwork.

**B3. Shared ingest (L, behind a Settings switch, capture-first):**
1. `ingest.js`: one reader per (provider, channel) — `ffmpeg -c copy -f mpegts pipe:1` with
   `-mpegts_flags +resend_headers+pat_pmt_at_frames+initial_discontinuity` — into an in-memory ring buffer (30–60 s),
   with subscribers. Spawn in its own process group (E4).
2. First consumer: **recordings**. Lowest risk, and the main win (watch + record = one connection).
3. Second: **the HLS session reads `pipe:0`** from the ingest instead of the provider. K1–K3 are unchanged: the probe
   reads the buffer's tail, so the classification still runs on real packets. Rerun `stream-doctor bench` on all five
   samples through the pipe.
4. Third: **failover inside the ingest** (R7: speed below 1.0× or no data, then reconnect if it was stable ≥30 s,
   else switch provider by `providerRouting`'s existing order, K7). The HLS session sees one discontinuity.
5. Coordinator counts **ingests**: same channel = no new connection; leases (K6) and the policy (K5) are otherwise
   unchanged.

**B4. Retire after B3 has run a week:**
- `streamRelay.js` leg-stitching and standby (674; a standby, if still wanted, becomes a second ingest the first can
  switch to);
- the 0143 refusal retries;
- per-session warm leases (warming becomes "start an ingest early", K14).

That's about **800–1,000 lines** out. The provider layer (`providerRouting`, `providerAccounts`, `channelLinks`)
stays.

**B5. Provider and guide data (S–M each, when convenient):** R8 ingest filters, R9 event-channel guide (higher value
than first rated, §8), R10 EPG matching tune-ups, catch-up/start-over if B1 finds archives, E2 ffmpeg version parity.

**Plan B risks:** the shared ingest is the largest change to the playback path since 0102/0103. It needs the full
capture/bench pass, and it's built and maintained by us alone. Less code is deleted than in Plan A.

**Rough total:** B1 ~1 week, B2 ~2 weeks, B3 ~2–3 weeks, B4–B5 ~1–2 weeks: **6–8 weeks** of part-time sessions.

---

## 12. Common ground and how to choose

**Do first, whichever plan:** B1 (backups, end-follows-guide, webhooks, the `tv_archive` and audio-track checks) and
B2 (segmented recordings, follow rules). Both plans need them, nothing in them is thrown away later, and none of them
touches live playback.

**Then decide with the A0 spike.** Choose **A** if the spike passes and running a second service is acceptable: more
code goes, failover is someone else's to maintain, and catch-up, dummy EPG and webhooks come free. Choose **B** if
the spike shows any loss of picture or timestamp quality through the hop, or the identity migration looks too risky.
B3 then gives the same one-connection-per-channel benefit natively. In either case the items in §9 stay.
