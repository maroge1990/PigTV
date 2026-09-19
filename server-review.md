# PigTV server review — 16 September 2026
 
Reviewed: github.com/maroge1990/PigTV at commit e73ee1f ("Add the native recording-playback contract for the Apple client"), the whole `server/` tree plus scripts, Docker files and tests, read with the Apple client's contracts in mind. Findings were spot-checked in source before publishing; file:line references are to that commit.
 
## Executive summary
 
The server is in reasonable shape for a single-user LAN deployment and the newest work (device pairing, auth secret handling, recording free-space policy, session cleanup idempotency) is solid. Three problems deserve fixing before anything else, because each can take down more than the feature it belongs to:
 
1. **Live HLS sessions never delete segments** (`transcodeSession.js:392-412`: `-hls_list_size 0`, no `delete_segments`). Every viewing session writes the entire stream into `/app/transcode-cache`, which is inside the container's writable layer, i.e. Unraid's `docker.img`. A full `docker.img` stops every container on PassyFlix. Fix: `delete_segments`, a bounded list size (30–90 segments), a startup sweep, and mount the cache on tmpfs or appdata.
2. **The streaming EPG parser can silently drop programme batches** (`epgParser.js:268-437`): a single-slot "mailbox" with no backpressure lets a completed batch overwrite an unconsumed one under bursty gzip input, and a second `'error'` handler turns recoverable warnings into a failed sync. Symptom: channels with "no EPG today" at random, and full re-downloads after restart.
3. **State-changing routes are reachable without a token** (`index.js:189-194`): `/api/channels/*` (hide every channel), `POST /api/transcode/session` and `DELETE /sessions/all` (start ffmpeg against any URL / kill your stream), `GET /api/transcode/sessions` (lists upstream URLs **with the provider password**), `/api/probe`, `/api/subtitle`, and `POST /api/playback/resolve`. On the LAN this is tolerable; over Tailscale it is not. The Apple client already sends a bearer header on JSON calls and `?token=` on media, so gating these costs nothing on the client side.
Second tier (P1): viewer-vs-viewer arbitration for the single provider slot; recording native playback fixes (`-tag:v hvc1` for HEVC, dedupe concurrent remuxes, don't accept partial `.native.mp4`, delete sidecars, don't run the remux inside the HTTP request); favourites written by the web app (`m3u_<src>_pos_N`) are invisible to `/api/library/favourites` (bare `pos_N`) and vice versa; provider credentials in resolve responses, session listings, logs and ffprobe errors; the EPG sync empties the guide for minutes (delete-then-insert, no atomic swap); a load-time `require('ffmpeg-static')` that isn't used but will crash startup if the optional dependency fails; `db.json` re-read from disk on every HLS segment request.
 
Roughly a third of the server is unreachable in this deployment (multi-user admin, OIDC, VOD/series sync, JSON-file favourites/hidden items, non-VAAPI encoders, session persist/restore, non-streaming parsers). Deleting it is the single biggest streamlining win and would have prevented two earlier incidents caused by editing dead paths.
 
## What the Apple client relies on (verified)
 
- `/api/library/guide` rows carry `id`, `sourceId`, `name`, `logo` (playlist `stream_icon` only), `category`, `tvgId`, `programmes[]` with `startTime/endTime` in ms. The client matches EPG icons itself via `/api/proxy/epg/{id}`; a server-side fallback (`logo = stream_icon ?? epg_channels.icon` by `tvgId`, then by name) would let the client drop that download.
- `/api/recordings/{id}/markers` returns camelCase `startMs/endMs` — matches the client model.
- `/api/recordings/{id}/playback` requires a bearer header and returns `{url:"/api/recordings/{id}/media.mp4", container:"mp4", durationSec}`; `media.mp4` accepts `?token=`, supports byte ranges and has `+faststart`, so seeking works. The client appends the token and allows `/api/recordings/` media paths. Gaps: HEVC recordings need `hvc1` tagging; `durationSec` is wall-clock, not media duration (the client only uses it to bound resume); the remux runs inside the request and can exceed the client's 60 s timeout on large files — return `202 {status:"preparing"}` or remux in the background.
- Favourites: the client uses `/api/favorites` POST/DELETE with the bare item id and `/api/library/favourites` to list — consistent with the server, but not with the web app until P1-3 lands.
The detailed review follows.
 
---
 
# PigTV server review (raw)
 
Scope: everything under `server/**`, `scripts/**`, `docker/**`, `Dockerfile`, `docker-compose.yml`, `package.json`, `test/**`, plus the parts of `public/js` needed to confirm API contracts. Version reviewed: `package.json` 3.7.0. No files were modified. Line numbers refer to the checkout at `/home/claude/pigtv/server`.
 
Where I say "verified" I ran or traced the code; where I say "likely" or "unverified" I did not.
 
---
 
## 1. Architecture map
 
### 1.1 Process layout
 
`server/index.js` is the only entry point. It:
 
- creates an Express app with `express.json({limit:'50mb'})`, `express-session` (MemoryStore, `saveUninitialized:true`) and Passport (`index.js:18-28`);
- serves `public/` statically (`index.js:30`) and falls back to `index.html` for every non-matching path including unknown `/api/*` paths (`index.js:210-212`);
- locates `ffmpeg`/`ffprobe` (system first, then npm packages) and stores them in `app.locals` (`index.js:36-89`);
- loads every file in `server/services/` into a frozen `services` object and every file in `server/plugins/` as a plugin (`index.js:91-153`) — the only plugin is `hello.js`, which registers an unauthenticated `GET /api/hello`;
- mounts routers (`index.js:182-201`);
- on listen: loads plugins, then after 2 s runs hardware detection and starts the DVR engine, then after 5 s runs `syncIfStale()` and starts the periodic sync timer (`index.js:220-256`).
### 1.2 Modules and responsibilities
 
| Module | Responsibility | Notes |
|---|---|---|
| `server/auth.js` | bcrypt, JWT sign/verify, Passport local/JWT/OIDC strategies, `requireAuth`, `streamAuth` (query-token auth), `requireAdmin` | JWT expiry 24 h for users; device tokens 365 d (`services/deviceAuth.js:21`) |
| `server/authSecret.js` | one persisted signing key in `data/auth-secret` or `JWT_SECRET` env | good: refuses the old public default and short keys |
| `server/db.js` | JSON-file "DB" (`data/db.json`) for sources, users, settings, plus legacy `hiddenItems`/`favorites` collections | re-reads and re-parses the file on every call |
| `server/db/sqlite.js` | better-sqlite3 connection to `data/content.db`; schema for categories, playlist_items, epg_programs, sync_status, devices, pairing_codes, channel_history, favorites, watch_history | WAL + synchronous=NORMAL; no other pragmas |
| `server/db/recordingsDb.js` | `scheduled_recordings`, `recordings`, `recording_markers` on the same connection | |
| `services/syncService.js` | pulls M3U / Xtream / XMLTV into SQLite on a timer | sequential per source; batches of 100/1000 with `setImmediate` yields |
| `services/m3uParser.js`, `services/epgParser.js` | streaming parsers (readline / sax) | |
| `services/xtreamApi.js` | Xtream Codes client; builds credentialed stream URLs | |
| `services/streamProbe.js` | `ffprobe` + capability-aware compatibility analysis | in-memory `probeCache`, 5 min TTL, never evicted |
| `services/playbackStrategy.js` | direct / remux / transcode decision → playable URL | the server-side brain for both clients |
| `services/transcodeSession.js` | per-viewer ffmpeg → HLS-on-disk session (`transcode-cache/<id>/`) | 30 min idle timeout, 5 min sweep |
| `routes/remux.js` | piped ffmpeg fMP4 remux, in-memory registry of live pipes | |
| `services/streamCoordinator.js` | arbitrates the single provider connection between viewers and recordings | in-memory prompt map |
| `services/recordingEngine.js` | DVR scheduler (15 s tick), ffmpeg stream-copy to `.mkv`, post-record compression, comskip queue, native-playback remux | |
| `services/adDetect.js` | wraps `comskip`, parses EDL | |
| `services/hwDetect.js` | detects NVENC/VAAPI/QSV/AMF via shell commands | |
| `services/cache.js` | JSON-file cache in `data/cache/` | only used by the legacy Xtream/EPG proxy routes |
| `services/deviceAuth.js` | pairing codes, device rows, revocation | |
| `services/m3uXtreamAdapter.js` | Xtream-shaped reads of M3U data | **not required anywhere** (dead) |
| `routes/library.js` | native-client read API: categories, channels, favourites, guide, recent | |
| `routes/playback.js` | `resolve`, `conflict`, `conflict/decline`, `DELETE /:sessionId` | |
| `routes/recordings.js` | DVR REST + media serving | |
| `routes/proxy.js` | Xtream emulation for the web app, DB-backed EPG dump, HLS/segment proxy, image proxy | 869 lines, several duplicate routes |
| `routes/transcode.js` | legacy `GET /api/transcode?url` piped audio transcode, HLS session playlist/segments, sessions list/kill-all | |
| `routes/channels.js` | hide/show items & categories | **no auth at all** |
| `routes/favorites.js`, `routes/history.js`, `routes/devices.js`, `routes/settings.js`, `routes/sources.js`, `routes/info.js`, `routes/probe.js`, `routes/subtitle.js`, `routes/auth.js` | as named | |
| `routes/users.js` | user CRUD against `db.json` | **not mounted** (dead; `routes/auth.js` has the live copy) |
 
### 1.3 Live playback, end to end (native client)
 
1. Client `POST /api/playback/resolve {sourceId, channelId, capabilities:{..., segmentedDelivery:true}}` (`routes/playback.js:80`). `optionalAuth` attaches `req.user` if a Bearer token is present but never rejects (`playback.js:27-32`).
2. `streamUrlForChannel()` resolves the upstream URL: Xtream → `api.buildStreamUrl(id,'live','ts')` (credentials embedded); M3U → SQLite lookup accepting bare `item_id`, composite `m3u_<src>_<item>`, or the PK, then `stream_url` column or `data.url` from the JSON blob (`playback.js:40-69`). Note `stream_url` is always NULL for M3U rows (see §2.9), so it is always the JSON path.
3. Coordinator check: `recordingEngine.listActive()` + `coordinator.requestForViewer()` (`playback.js:98-115`). If a recording holds the single connection and `force` is not set → `409 {conflict}`; with `force` the recording is finalised via `stopForViewer()` and marked partial (`playback.js:117-127`).
4. `playbackStrategy.resolve()` (`services/playbackStrategy.js:63`): ffprobe (cached by `url|ua|caps`), then:
   - `direct` if container is hls/mp4/mov and both codecs decodable → URL `/api/proxy/stream?url=<upstream>`;
   - `remux` if codecs fine but container not, and client did **not** set `segmentedDelivery` → `/api/remux?url=<upstream>` (piped fMP4);
   - otherwise `transcode`: `transcodeSession.createSession()` → `session.start()` spawns ffmpeg writing `stream.m3u8` + `seg%04d.(ts|m4s)` into `transcode-cache/<id>/` (`transcodeSession.js:99-203`, args at `208-417`); `waitForPlaylist(15000)` polls the playlist until it contains a media segment; on timeout the session is removed and the error carries `info`. Response: `{strategy:'transcode', url:'/api/transcode/<id>/stream.m3u8', sessionId, container:'hls', videoMode, segmentType, info, reason}`.
   For the Apple client (`segmentedDelivery:true`) every non-direct stream goes through the HLS session path, with `videoMode:'copy'` and `audioMode:'copy'` when codecs are fine (`playbackStrategy.js:137-161`).
5. Channel history is upserted best-effort when the caller is known (`playback.js:140-159`).
6. Client fetches `/api/transcode/<id>/stream.m3u8?token=...` (`routes/transcode.js:132-148`). `withStreamToken()` rewrites every segment URI and the `#EXT-X-MAP` init URI to carry the token (`transcode.js:47-63`). Segment requests hit `transcode.js:154-176`; every fetch `touch()`es the session.
7. Teardown: `DELETE /api/playback/:sessionId` (`playback.js:212-225`) or `DELETE /api/transcode/:sessionId`; both route `remux_*` ids to `killRemux()` and everything else to `transcodeSession.removeSession()` → `cleanup()` → `stop()` (SIGTERM, SIGKILL after 2 s, resolves once `exit` fires or after 5 s) → `fs.rm(dir)`. Without an explicit delete, the 5-minute sweep removes sessions idle for 30 minutes (`transcodeSession.js:29-31, 965-973`).
### 1.4 Recording, the scheduler and the single-stream limit
 
- `recordingEngine.init()` (`recordingEngine.js:970-984`) creates the schema, reconciles orphans (`reconcileOnStartup`), and starts a 15 s `tick()`.
- `tick()` (`recordingEngine.js:892-968`): for each schedule due (`status IN ('scheduled','waiting')` and `program_start - pre_buffer <= now`, `recordingsDb.js:133-140`): skip if window passed or already active; enforce `maxConcurrentRecordings`; ask `coordinator.requestForRecording(schedule, settings)`.
- `requestForRecording` (`streamCoordinator.js:98-137`): counts `activeStreams()` = transcode sessions + remux pipes. If below `maxProviderStreams` → allowed. Else: streams idle ≥ `viewerIdleTimeoutSec` (60 s) are killed and the recording proceeds; if someone is live, a prompt is registered once (`prompts` map) and the recording is put in `waiting`, re-tried every tick.
- `pendingPrompt()` is what `GET /api/playback/conflict` returns; `declinePrompt()` marks it declined so it is never shown again; `announceUpcoming()` pre-registers a prompt `recordingPromptLeadMin` ahead (`tick()` at `recordingEngine.js:928-938`).
- `startRecording()` (`recordingEngine.js:637-750`): resolves URL, free-space pre-flight, creates the `recordings` row, marks partial if it starts >30 s late, spawns `ffmpeg -c copy -f matroska <root>/<channel>/<title - yyyy-mm-dd hh-mm>.mkv`, sets a hard-stop timer at `program_end + post_buffer`. Recording ffmpeg does **not** register in any viewer registry, so `requestForViewer()` adds `activeRecordings.length` to the count explicitly (`streamCoordinator.js:205`).
- `finalizeRecording()` (`752-792`) runs on process close, sets `completed` if the file has >1 KiB, queues ad detection (`pending`). Compression is manual only.
- `stopRecording()` (`794-832`) writes `q` to stdin, SIGKILL after 8 s, gives up waiting after 9 s.
- Viewer-vs-recording: `requestForViewer()` (`streamCoordinator.js:197-224`) only considers conflicts when a recording is active; it never arbitrates viewer-vs-viewer (see §2.3).
### 1.5 EPG data flow into `/api/library/guide`
 
1. `syncService.syncEpgFromUrl()` (`syncService.js:456-558`): `DELETE FROM epg_programs WHERE source_id=?` **first**, then streams the XMLTV via `epgParser.fetchAndParseStreaming()` (sax, batches of 1000), inserting each batch in a transaction with `start_time`/`end_time` as epoch ms (`p.start.getTime()`), `title`, `description`, and the whole programme object as JSON in `data`. Channels from `<channel>` elements are stored as `playlist_items` rows of `type='epg_channel'`.
2. `parseXmltvDate()` (`epgParser.js:15-37`) handles `YYYYMMDDHHmmss ±ZZZZ`; a missing offset is treated as UTC; anything else falls back to `new Date(str)`.
3. M3U channels carry `tvg-id` in `playlist_items.data.tvgId` (`syncService.js:596`); Xtream channels carry `epg_channel_id`.
4. `GET /api/library/guide` (`routes/library.js:204-279`): pages visible live channels by provider order (`LIMIT/OFFSET`), extracts `tvgId` from each row's JSON, then runs **one** query `SELECT ... FROM epg_programs WHERE channel_id IN (...) AND end_time > ? AND start_time < ? ORDER BY start_time` and buckets rows per channel. Window default 3 h, capped at 24 h. `epg_programs.source_id` is not filtered, so any EPG source that carries a matching `channel_id` contributes (this is what makes the "separate EPG source" arrangement work; test at `test/access.test.js:175-205`).
---
 
## 2. Correctness bugs and risks
 
Ordered roughly by impact.
 
### 2.1 HLS sessions keep every segment forever (disk exhaustion on the Docker image) — `services/transcodeSession.js:392-412`
 
`-hls_list_size 0` with `-hls_flags independent_segments+append_list` and no `delete_segments`: a live session never deletes a segment. `CACHE_DIR = path.join(process.cwd(), 'transcode-cache')` = `/app/transcode-cache`, which is **not** a volume in `docker-compose.yml:8-11`, so it lives in the container's writable layer (on Unraid, inside `docker.img`). A 3-hour evening of viewing an 8 Mbps HEVC channel in copy mode is ~10 GB written into the image, only reclaimed when the session is deleted or the 30-minute idle sweep fires. The playlist also grows without bound and is read, string-split and rewritten by `withStreamToken()` on every 4 s poll (`routes/transcode.js:140-147`). Verified from the args; not measured.
 
### 2.2 EPG streaming parser silently drops batches — `services/epgParser.js:332-403, 416-432`
 
`parseStreaming` hands batches to the consumer through a single-slot mailbox: when a batch completes and no consumer is waiting, it does `pendingBatch = batch` (`epgParser.js:354, 401`), **overwriting** whatever was already there. Nothing applies backpressure: `input.pipe(saxStream)` writes into a sax stream whose `write()` always returns true, so a gunzip transform (`fetchAndParseStreaming`, `252-256`) can push many 16 KiB chunks synchronously in one burst, and the consumer (`syncService.js:495-517`) is meanwhile inside a synchronous `insertProgrammes()` or an `await setImmediate`. Any time two 1000-programme batches complete before the consumer wakes, the first is lost without any log line. The second `'error'` handler (`405-410`) also stores a recoverable parser warning and rethrows it at the end (`434-436`) even though the first handler already resumed the parser — so a single bad entity anywhere in the feed marks the whole sync `error` in `sync_status` after it has already deleted and partially re-inserted the programmes. Likely (mechanism verified by reading the stream semantics; not reproduced against the real feed). Cheap check on the live box: compare `SELECT COUNT(*) FROM epg_programs` with `zcat feed.xml.gz | grep -c '<programme'`.
 
### 2.3 Single-stream policy is only enforced viewer-vs-recording — `services/streamCoordinator.js:197-207`
 
`requestForViewer()` returns `{allowed:true}` immediately when `activeRecordings.length === 0`, regardless of how many viewer sessions already exist. With `maxProviderStreams = 1`, a second device starting playback (or the same device re-resolving after a crash, or a channel change where the client did not `DELETE` the old session) opens a second upstream connection; the provider refuses one of them and the failure surfaces as an ffmpeg timeout with no explanation. Related: `SESSION_TIMEOUT_MS` is 30 minutes (`transcodeSession.js:29`), while the coordinator's idle definition is 60 s (`streamCoordinator.js:30`) — the 60 s rule is only applied when a *recording* asks. A tvOS app that is killed leaves ffmpeg pulling the provider stream for up to 30 minutes.
 
### 2.4 `/api/proxy/stream` buffers the whole upstream body in memory — `routes/proxy.js:789-806`
 
The non-HLS branch collects every chunk into `chunks` before sending. For HLS segments this is a few MB; for the `direct` strategy on an MP4/MOV upstream (VOD, or an M3U entry pointing at a progressive file) it buffers the entire file, including for `Range` requests that AVPlayer/Chrome make with open-ended ranges (`bytes=0-`). Live raw-TS never reaches `direct` (`streamProbe.js:132,154`), so today this mostly affects the web app's movie/series pages, but it is a latent OOM. Also: a failure after `res.status()`/`res.set()` inside the retry loop (`650-817`) retries and calls `res.set` on a response whose headers may already be sent; the outer `if (!res.headersSent)` guard only protects the final error.
 
### 2.5 `require('ffmpeg-static')` at module load in `routes/proxy.js:13`
 
`ffmpeg-static` is an `optionalDependency` (`package.json:27-29`) and the value is never used (`proxy.js` has no other reference; `http`, `https`, `fs`, `path`, `spawn` on lines 8-12 are unused too). If the optional download fails during `npm ci` (it fetches a binary from GitHub at install time in the Docker build, `Dockerfile:82`), `require('./routes/proxy')` throws at `index.js:188` and the server never starts. Verified by reading; the failure mode depends on the build network.
 
### 2.6 Native recording remux drops the `hvc1` tag — `services/recordingEngine.js:535-543`
 
`ensureNativePlayback()` builds `-c copy -movflags +faststart` without `-tag:v hvc1`. Both live paths add it for HEVC (`routes/remux.js:203-205`, `transcodeSession.js:274-277`) because AVFoundation refuses `hev1`-tagged HEVC in MP4. Any HEVC recording therefore produces a `.native.mp4` that AVPlayer will not play, while H.264 recordings work. Also no handling of MP2 audio (common in DVB-sourced TS), which MP4 cannot carry for AVPlayer; the probe result is only used for the AAC bitstream filter. Verified by reading the args; not tested on a device.
 
### 2.7 Recording remux races and truncation — `services/recordingEngine.js:522-571`, `routes/recordings.js:75-89, 194-215`
 
- No in-flight guard: `GET /:id/playback` and `GET /:id/media.mp4` (or two clients) arriving together both spawn `ffmpeg -y` on the same output path. Both write the same file; one truncates the other's work; the first to finish returns a path the other is still overwriting.
- `if (fs.existsSync(output)) return output;` (`532`) accepts a partial file left by a killed or crashed remux (container restart mid-remux, SMB hiccup) forever — it is never re-validated.
- The remux is awaited inside the HTTP handler. For a 4 GB file on an SMB mount this can be tens of seconds to minutes; URLSession's default request timeout is 60 s, so the Apple client can time out while the server keeps working, then retry and hit the race above.
- `deleteRecording()` (`617-635`) only unlinks `rec.file_path`; the `.native.mp4` sidecar and the `.compressed.mp4` kept alongside when `postRecordKeepOriginal` is on are orphaned on disk.
### 2.8 Guide is empty for the duration of every EPG sync — `services/syncService.js:472-473`
 
Programmes are deleted before the new feed is streamed in (batches interleaved with `setImmediate`). With ~500 k programmes this window is minutes, during which `/api/library/guide`, `/channels` now/next and the recording scheduler's EPG-derived UI show nothing. There is no transactional swap (e.g. insert into a staging table, then rename/replace).
 
### 2.9 M3U `stream_url` is always NULL — `services/syncService.js:390`
 
`saveStreams()` binds `null` for `stream_url` for every type, and the upsert never updates it (`340-346`). M3U URLs survive only inside the `data` JSON, so every resolve (`playback.js:52-66`, `recordingEngine.js:114-129`) does a JSON parse per lookup, and `m3uXtreamAdapter.buildStreamUrl()` would always return null. Functionally works today; fragile and confusing.
 
### 2.10 Position-based channel identity breaks every stored reference on provider reorder — `services/syncService.js:591`
 
`stream_id = 'pos_' + position`. The handover explains why (tvg-id and URL both collide), but the consequence is that inserting or removing one channel near the top of an 18 000-line playlist silently re-points every favourite (`favorites.item_id`), every `channel_history` row, every future `scheduled_recordings.channel_item_id` (a scheduled recording would record the wrong channel), and every id the Apple client has cached. There is no detection or migration.
 
### 2.11 Favourites contract split between clients — `routes/library.js:157-160, 175-190`, `public/js/components/ChannelList.js:856, 953-955`
 
The web app favourites a channel using its composite id `m3u_<src>_<pos_N>` (`ChannelList.js:856` defines `id`, `953/955` pass `channelId`). `/api/favorites` stores that string verbatim (`routes/favorites.js:28`). `/api/library/channels` marks `favourite` by matching `f.item_id` against the bare `p.item_id` (`library.js:157-160`) and `/api/library/favourites` joins on `p.item_id = f.item_id` (`library.js:180-182`), so web-created favourites never appear in the native client, and native-created favourites (bare ids from `/api/library/channels`) do not appear in the web app. Playback and recordings tolerate both forms (`playback.js:50`, `recordingEngine.js:141`); favourites do not. Appears real from reading both sides; not executed.
 
### 2.12 Path traversal through an encoded slash in the segment route — `routes/transcode.js:154-176`
 
Express matches routes against the raw path and URL-decodes params afterwards, so `GET /api/transcode/<validSessionId>/..%2F..%2F..%2Frecordings%2FX.mp4` yields `req.params.segment === '../../../recordings/X.mp4'`; `session.getSegment()` does `path.join(this.dir, segmentName)` (`transcodeSession.js:838`) with no containment check and `res.sendFile()` serves it. I verified the decoding behaviour with Express 4 in a scratch script (`{"seg":"../../x.mp4"}`). The extension filter (`.ts|.m4s|.mp4`) limits what can be read, and a valid session id is needed — but `GET /api/transcode/sessions` hands those out unauthenticated (§3). Low-to-medium severity on a LAN; worth a one-line fix.
 
### 2.13 Express-session MemoryStore with `saveUninitialized:true` — `index.js:21-28`
 
Every request without a session cookie (every AVPlayer segment fetch if it does not persist cookies, every `curl`, every health check) creates a new in-memory session that is never evicted. The session is only needed for the OIDC flow, which is not configured (`auth.js:147-150` warns and returns). Memory growth is slow but unbounded, and express-session logs the MemoryStore production warning.
 
### 2.14 Smaller correctness items
 
- `transcodeSession.js:155-185`: exit code 255 is treated as "not an error" (`code !== 255`), but the session status stays `running` in that branch; `getAllSessions()` then reports a dead process as live, and the coordinator counts it as a viewer stream until it idles out.
- `transcodeSession.js:170-181`: the software-decode retry calls `this.start()` from inside the exit handler while `this.status='pending'`; if `cleanup()` runs concurrently, `stop()` sees `this.process === null` and resolves immediately, then `fs.rm` deletes the directory the retried ffmpeg is writing into. Narrow window.
- `transcodeSession.js:867-884` `restore()` / `recoverSessions()` are never called; after a crash, `transcode-cache/*` directories from the previous process are never swept (compounds §2.1).
- `routes/remux.js:158-159`: `-user_agent` passed twice (harmless).
- `routes/remux.js:20, 24-31`: `idleMs` for a remux is `now - startedAt`, so a remux that has been playing for 2 minutes is "idle" for 2 minutes by that field, yet the coordinator overrides it to 0 (`streamCoordinator.js:55`). Two definitions of the same field.
- `recordingEngine.js:908`: fallback `settings.maxConcurrentRecordings || 2` disagrees with the default of 1 (`db.js:99`); harmless because settings are merged with defaults.
- `recordingEngine.js:410-429`: `POST /:id/detect-ads` sets *that* recording to `pending` but `processAdDetectionQueue({manual:true})` runs `pending[0]` ordered by `ended_at`, which may be a different recording, and `manual` bypasses `adDetectionEnabled` for it.
- `recordingEngine.js:617-627`: `stopRecording(scheduledId, 'deleted')` — `'deleted'` is not a handled reason, so the schedule keeps whatever `finalizeRecording()` set while its `recording_id` now dangles.
- `recordingEngine.js:800-821`: `stopRecording` resolves after at most 9 s even if ffmpeg is still alive (SIGKILL sent at 8 s); `stopAllActive()` races that against 6 s on SIGTERM (`index.js:156-179`) — fine, but the `.mkv` may lack a trailer, and `finalizeRecording` will still mark it completed.
- `recordingEngine.js:668-671`: file names use the container's local time; the Dockerfile sets no `TZ`, and `docker-compose.yml` sets none either, so on a default image the "local" time is UTC. (The Unraid template may set it; unverified.)
- `epgParser.js:485-486`: an unparsable date yields `Invalid Date` → `getTime()` is `NaN`; whether better-sqlite3 binds NaN as NULL (violating `NOT NULL`, aborting the batch transaction) or throws, either way that batch of 1000 programmes is lost. Unverified which.
- `syncService.js:143`: `source.syncInterval` is never set by any route, so the per-source staleness check always uses 24 h, independent of the `epgRefreshInterval` setting that drives the periodic timer.
- `syncService.js:56-62`: `setInterval` with an `async` callback and no overlap guard; `syncSource()` has its own `activeSyncs` guard, so overlapping timers are only wasteful, not harmful.
- `db.js:139-157`: `saveDb()` swallows write errors (`.catch` logs, returns resolved promise), so a failed `db.json` write (disk full, read-only mount) is reported to the client as success.
- `routes/proxy.js:332` and `:551` both define `GET /epg/:sourceId`; `:427` and `:594` both define `DELETE /cache/:sourceId`; `:245` and `:525` overlap on `/xtream/:sourceId/stream/:streamId/:type`. Express uses the first, so the second `GET /epg/:sourceId` (which would parse the entire XMLTV in memory) is dead — but `POST /epg/:sourceId/channels` (`614-639`) is live and does exactly that in-memory parse of the whole feed per call.
- `routes/recordings.js:27-35`: suffix ranges (`bytes=-500`) and multi-range requests are answered 416; AVPlayer does not use them for MP4, so cosmetic.
- `routes/transcode.js:173`: every segment, including `.m4s` and `init.mp4`, is served as `video/MP2T`.
- `index.js:210`: unknown `/api/...` paths return `index.html` with 200 instead of 404 JSON; a client typo is hard to diagnose.
- `hwDetect.js:136`: QSV detection relies on `lspci`, which the image does not install (`pciutils` absent), so `recommended` can never be `qsv` today; if it were, the Ubuntu ffmpeg build has no working QSV and `hwEncoder:'auto'` would pick a broken encoder ahead of VAAPI (`hwDetect.js:231-241`).
---
 
## 3. Security
 
Context: LAN-only today, Tailscale planned. Everything below matters more the moment the port is reachable from outside the LAN.
 
### 3.1 Auth coverage by route (from `index.js:182-201` and each router)
 
| Mount | Auth | Notes |
|---|---|---|
| `GET /api/info`, `GET /api/version` | none | intended |
| `POST /api/auth/setup`, `/setup-required`, `/login`, `/logout`, `/oidc/*` | none | `setup` guarded by user count |
| `GET /api/auth/me`, `/users*` | JWT (+admin for users) | |
| `POST /api/devices/pair/start`, `GET /pair/poll` | none | intended; codes are 29^6, 10 min TTL, one-shot token hand-off |
| `/api/devices` rest | JWT | |
| `/api/library/*`, `/api/favorites/*`, `/api/history/*`, `/api/settings/*`, `/api/sources/*` | JWT (admin for writes on settings/sources) | good; tests cover sources/settings |
| **`/api/channels/*`** (hide/show/bulk/all, `/recent`) | **none** (`routes/channels.js` has no middleware) | anyone on the LAN can hide every channel/category |
| **`/api/probe?url=`** | none | spawns `ffprobe` on any URL |
| **`/api/subtitle?url=&index=`** | none | spawns `ffmpeg` on any URL |
| **`POST /api/playback/resolve`**, `GET /conflict`, `POST /conflict/decline`, **`DELETE /api/playback/:id`** | optional | anyone can start a transcode (GPU + provider slot) or kill anyone's session; `resolve` also accepts a raw `url` |
| `/api/proxy/*` | `streamAuth` (off by default) | includes `xtream/:id/auth` (returns upstream `user_info` with the provider password in it), `xtream/:id/stream/...` (returns credentialed URL as JSON), `xtream/:id/:action` (proxies arbitrary Xtream actions upstream), `stream?url=`, `image?url=`, `DELETE cache/:id` |
| `/api/transcode/*` | `streamAuth` | includes **`GET /sessions`** (lists every active upstream URL with credentials), **`DELETE /sessions/all`**, `POST /session {url}`, legacy `GET /?url=` |
| `/api/remux?url=` | `streamAuth` | |
| `/api/recordings/:id/stream`, `/media.mp4`, `/download` | `streamAuth` | rest requires JWT |
| `GET /api/hello` (plugin) | none | lists loaded service names |
 
The `streamAuth` middleware itself is sound (`auth.js:257-285`): it verifies the JWT and checks device revocation. But with `requireStreamAuth` defaulting to `false` (`db.js:88`) the practical position is that all media, all Xtream emulation, session listing/killing, hide/show, probing and arbitrary-URL ffmpeg spawning are anonymous.
 
### 3.2 Token-in-query handling
 
- Works as designed on `/api/proxy`, `/api/transcode`, `/api/remux`, `/api/recordings` (`index.js:188-201`). The playlist rewriter (`transcode.js:47-63`) correctly propagates `?token=` to segments and `#EXT-X-MAP`. The HLS proxy rewriter in `proxy.js:756-784` does **not** propagate the token onto rewritten segment URLs, so with enforcement on, `direct`-strategy HLS playback loads the manifest and then 401s on every segment. (Verified by reading; the rewriter builds `${req.protocol}://${host}/api/proxy/stream?url=...` with no token.)
- Tokens in query strings end up in access logs, `Referer` headers and the ffmpeg command lines that are logged with `console.log` (`transcodeSession.js:119`, `remux.js:207`, `transcode.js:322`). Device tokens are valid for 365 days, so a leaked one is long-lived; revocation exists, which mitigates.
- `routes/auth.js:45`: the OIDC callback redirects to `/?token=<jwt>` — token in a URL, browser history and referrers. Unused today.
### 3.3 Path traversal / file serving
 
- Transcode segments: encoded-slash traversal, §2.12.
- Recordings: paths come from the DB, not the request; safe. `res.download()` sanitises the filename.
- `transcode-cache` lives under `process.cwd()`; if the server were started from another directory it would write there.
### 3.4 Upstream credential leakage
 
- The Xtream password is part of every stream URL (`xtreamApi.js:128-143`). That URL is: returned to clients in `resolve` responses (`playbackStrategy.js:91, 115` embed it in `/api/proxy/stream?url=` and `/api/remux?url=`), returned by `GET /api/transcode/sessions` (`transcode.js:207-219`, unauthenticated), returned by `/api/proxy/xtream/:id/stream/...` (`proxy.js:274, 537`), logged in full on every session start (`transcodeSession.js:105, 119`; `remux.js:150, 207`; `transcode.js:273, 322`), and included in error messages returned to clients: `probeStream` rejects with `ffprobe exited with code N: <stderr>` (`streamProbe.js:69`), which `resolve` returns verbatim as `{error: err.message}` (`playback.js:165`); ffprobe stderr normally echoes the input URL.
- M3U playlist URLs with embedded tokens (`https://provider/list?token=...`) are protected on `/api/sources` (allow-listed, tested), but `syncService.js:457` logs the first 60 characters, which for a short host may include the token.
- `routes/proxy.js:98-115` (`/xtream/:sourceId`) returns the upstream `authenticate()` payload, whose `user_info` object contains `username` and `password` in clear — to anyone (streamAuth off).
### 3.5 SSRF / arbitrary URL execution
 
`/api/proxy/stream`, `/api/proxy/image`, `/api/remux`, `/api/transcode` (GET and POST), `/api/probe`, `/api/subtitle` and `POST /api/playback/resolve {url}` all take a caller-supplied URL and either `fetch()` it from the server's network position or hand it to ffmpeg/ffprobe. ffmpeg accepts `file:`, `concat:`, `subfile:` and playlist-driven local reads, so on a reachable server this is arbitrary local file read (e.g. `data/db.json`, `data/auth-secret`) and internal-network probing. On a private LAN this is theoretical; behind Tailscale it is still bounded to tailnet members; on the public internet it is critical. No allow-list of upstream hosts exists anywhere.
 
### 3.6 CORS
 
No global CORS middleware. `Access-Control-Allow-Origin: *` is set ad hoc on media responses (`remux.js:219`, `transcode.js:337`, `proxy.js:696, 850`, `subtitle.js:37`). Fine for a same-origin SPA and native clients. `trust proxy: true` (`index.js:15`) trusts any `X-Forwarded-*` from anyone; only matters if something starts using `req.ip`.
 
### 3.7 Rate limiting / brute force
 
None anywhere. `POST /api/auth/login` uses bcrypt cost 10 (`auth.js:21`), which self-limits to a few tries per second per core but does not stop a slow online guess. `GET /api/devices/pair/poll` is unauthenticated and unthrottled; the code space (29^6 ≈ 5.9×10^8, 10-minute TTL) makes guessing impractical, but each guess is a SQLite query. `POST /api/auth/setup` is safely guarded by `userCount > 0`.
 
### 3.8 Miscellaneous
 
- `express.json({limit:'50mb'})` on every route (`index.js:18`); the largest legitimate body is a bulk hide list. 1 MB would do.
- `Dockerfile:88` `chmod 777` on `/app/transcode-cache` and `/app/recordings`; the process runs as root anyway (no `USER`).
- `hwDetect.js:90, 136` shell out with `shell:true`; inputs are constant, so no injection.
- `adDetect.js:76-78` passes a settings-controlled `comskipIniPath` to `--ini=`; admin-only, fine.
---
 
## 4. Performance
 
### 4.1 `/api/library/guide` — `routes/library.js:204-279`
 
Cost for a page of 50 channels × 24 h:
 
1. `SELECT COUNT(*)` over `playlist_items` with a correlated `NOT EXISTS` on `categories` (`225`): full scan of ~18 k live rows, ~1-3 ms.
2. Page query with `ORDER BY CASE ... sort_order, name LIMIT ? OFFSET ?` (`226-232`): no index on `sort_order`, so SQLite sorts all matching rows (up to 18 k) per request; still low single-digit ms, but it is O(N log N) per page and offset-based, so page 300 costs the same as page 1.
3. 50 `JSON.parse` of the `data` blobs (`236`) to get `tvgId` — the whole M3U line's attributes per channel, trivial.
4. One EPG query with `channel_id IN (50 ids) AND end_time > start AND start_time < end` (`252-257`). `idx_epg_channel_time(channel_id, start_time, end_time)` (`sqlite.js:106`) is used as: for each `channel_id`, range-scan `start_time < end`, filter `end_time > start`. Because the lower bound is on `end_time`, not `start_time`, the scan covers **every programme for that channel from the beginning of the feed up to `end`**, i.e. all past days too. With a 7-day feed and ~150 programmes/channel/day that is ~1 000 index rows per channel × 50 ≈ 50 k rows touched to return ~1 500. Measured elsewhere as a few ms; fine at this scale, but the guide is per channel-page, so a client scrolling 18 000 channels runs it 360 times. Adding `AND start_time > ? - <max programme length, e.g. 12 h>` would make the range tight.
5. No caching; every scroll page and every pull-to-refresh hits SQLite. Given a single user this is acceptable; the numbers above say the endpoint is cheap, so the risk is elsewhere (§2.8 empty guide during sync).
`nowNextFor()` used by `/channels` and `/favourites` (`31-63`) has the same shape with a 6 h window — good.
 
`/api/proxy/epg/:sourceId` (web app guide, `proxy.js:332-424`) is the expensive one: ±24 h across **all visible channels**, materialised as JSON with ISO strings; with 18 k channels that is easily 50-100 MB of JSON per guide load, and the `json_extract` over `playlist_items.data` (`350-356`) is a full-table JSON parse on every call. Only the web app uses it.
 
### 4.2 EPG parse memory and storage
 
- Parser memory is bounded by batch size (1000 programmes) **plus** whatever the unthrottled pipe buffers (§2.2); the sax stream itself does not buffer, so heap stays modest — the `logMemory()` calls (`syncService.js:460-465`) exist because this was a problem before.
- Storage: `epg_programs.data` stores `JSON.stringify(p)` for every programme (`syncService.js:489`), duplicating `title`/`description`/`category[]`/`icon`/`episodeNum` already or never used (the guide reads only `title`, `description`, times). For 500 k programmes that is likely 200-400 MB of `content.db` rewritten every sync, plus WAL churn. `AUTOINCREMENT` on `id` (`sqlite.js:97`) adds `sqlite_sequence` bookkeeping for no benefit.
- `DELETE ... WHERE source_id=?` then bulk insert (`472-473`) without `VACUUM` means the file never shrinks and each sync rewrites hundreds of MB.
### 4.3 SQLite pragmas and indexes — `db/sqlite.js`
 
- `journal_mode=WAL`, `synchronous=NORMAL` (`20-21`). Missing: `busy_timeout` is left at better-sqlite3's 5 s default (fine); `cache_size`, `temp_store=MEMORY`, `mmap_size` could help the sync; `foreign_keys` is irrelevant (none declared).
- `playlist_items`: indexes on `(source_id,type)` and `(source_id,category_id)`. Missing `(source_id,item_id)` — lookups by `item_id` (`playback.js:52-57`, `recordingEngine.js:114-119`, favourites join `library.js:180-182`, `library.js:294-295`) scan the source's rows. Missing an index containing `sort_order` for the paged ordering.
- `epg_programs`: no index on `source_id`, so `/api/proxy/epg/:id` and the sync's `DELETE WHERE source_id=?` scan the table (the delete of 500 k rows without an index is a full scan; acceptable once per day).
- `favorites.user_id` is `INTEGER` but `library.js` queries it with `String(req.user.id)` while `favorites.js` inserts a number; SQLite's affinity makes it work, but it is inconsistent with `channel_history.user_id TEXT`.
### 4.4 `db.json`
 
`loadDb()` reads and parses the file on every getter (`db.js:14-54`). `streamAuthFromSettings` calls `db.settings.get()` on **every media request** (`auth.js:291-300`, mounted on `/api/proxy`, `/api/transcode`, `/api/remux`, `/api/recordings`) — one file read + JSON parse per HLS segment. Small file, but it is on the hot path and the recordings tick also reads it several times per tick (`recordingEngine.js:907, 930`).
 
### 4.5 Sync service behaviour
 
- Sequential per source, batched with `setImmediate` yields (`syncService.js:305-311, 401-407`): the event loop stays responsive but a 500 k-programme EPG takes minutes.
- `syncIfStale()` at startup is correct in intent; the staleness source is `sync_status.status='success'`, so any sync that ends in `error` (including the spurious error from §2.2) forces a full re-sync on the next start.
- `purgeStaleItems()` uses a TEMP table of ids (`424-449`): fine. `_visible_epg_ids` TEMP table in `proxy.js:363-367` is created/cleared per request on the shared connection — not concurrency-safe in principle (single connection, synchronous, so no actual race).
- The periodic timer re-syncs **all** sources every `epgRefreshInterval` hours, including the 18 k-line M3U; the M3U rarely changes, and re-upserting 18 k rows with full JSON blobs is the cost.
### 4.6 Other hot spots
 
- Every transcode playlist poll (every ~4 s) reads the ever-growing `.m3u8`, splits and joins it (§2.1).
- `probeCache` and `codecCache` (`streamProbe.js:13`, `remux.js:43`) are unbounded Maps keyed by URL; entries expire logically but are never deleted. With 18 k channels this is bounded by usage, not a leak in practice.
- `requestForRecording` → `activeStreams()` calls `require('../routes/remux')` inside the function on every tick (`streamCoordinator.js:49`); `require` is cached, so it is just untidy.
---
 
## 5. Recording playback contract
 
### 5.1 `GET /api/recordings/{id}/playback` — `routes/recordings.js:194-215`
 
- Auth: **requires a Bearer JWT** (it is below `router.use(requireAuth)` at `:106`); `?token=` is *not* honoured here (`streamAuth` only populates `req.user`; `requireAuth` is passport-jwt with the header extractor).
- Preconditions: recording exists (404) and `status === 'completed'` (409 otherwise).
- Side effect: awaits `recordingEngine.ensureNativePlayback(rec)` — may spawn an ffmpeg remux and block the request until it finishes (§2.7).
- Response: `{ url: "/api/recordings/<id>/media.mp4", container: "mp4", durationSec: <recordings.duration_sec or null> }`. `url` is **relative** and carries no token; the client must prepend the base and append `?token=`. `durationSec` is the wall-clock recording length (`finalizeRecording`, `recordingEngine.js:765`), not the media duration; after a partial/late recording they differ, and for a compressed recording it is the original's number.
- Errors: 500 with `{error: <ffmpeg stderr tail>}`.
### 5.2 `GET /api/recordings/{id}/media.mp4` — `routes/recordings.js:75-89`
 
- Auth: `streamAuth` only (mounted in `index.js:201`); with `requireStreamAuth=false` anyone can fetch; with it on, `?token=` or a Bearer header works (`auth.js:259-261`).
- Same preconditions; calls `ensureNativePlayback()` again (lazy, so a client that skipped `/playback` still works).
- What is served, by case (`recordingEngine.js:508-571`):
  1. `rec.file_path` already ends in `.mp4` (compression done with keep-original off): that file. Codec: whatever `buildCompressArgs` produced — H.264 or HEVC (per `postRecordCodec`), AAC-LC stereo, `+faststart`. HEVC here is `hevc_vaapi`/`libx265` into MP4 with **no `hvc1` tag** either (`recordingEngine.js:229-253`), so a HEVC-compressed recording is likely unplayable on AVPlayer as well.
  2. `<base>.compressed.mp4` exists (keep-original on): that file, same caveats.
  3. Otherwise `<base>.native.mp4`, created once by `ffmpeg -i x.mkv -map 0:v:0? -map 0:a:0? -c copy [-bsf:a aac_adtstoasc] -movflags +faststart`. Container: MP4 with moov at the front. Codecs: the source's — H.264 (fine), HEVC (missing `hvc1`, §2.6), audio AAC (fixed up), AC-3/E-AC-3 (fine in MP4 for Apple), MP2/MP3 (MP2 will fail; MP3-in-MP4 is tolerated but non-standard).
- Seekable: yes. `serveWithRangeSupport()` (`22-53`) honours single byte ranges with 206/`Content-Range`/`Accept-Ranges: bytes`, 416 on out-of-range, and `+faststart` puts the index first so AVPlayer can seek without reading the tail. `Content-Type: video/mp4`.
- `?token=` on this route: works (see auth above).
### 5.3 Bugs and gaps in the contract
 
1. HEVC recordings lack `-tag:v hvc1` (§2.6) — P1 for a HEVC-heavy provider.
2. Concurrent/duplicate remux with `-y` on the same output; partial output accepted forever; remux runs inside the request (§2.7).
3. Sidecar `.native.mp4` is not deleted with the recording, not counted in `file_size_bytes`, and not shown anywhere.
4. `durationSec` semantics (wall clock) — clients should prefer the asset's own duration.
5. The response says `container: 'mp4'` but nothing tells the client the codecs; the Apple client cannot tell an H.264 file from a HEVC one it may not be able to decode (older Apple TV HD cannot decode HEVC).
6. `GET /:id/playback` requires a header token while the media URL it returns needs a query token — the client has to know both mechanisms. Consistent with live playback (`/api/playback/resolve` vs stream URLs), but undocumented in `/api/info`.
7. No `HEAD` support and no `ETag`/`Last-Modified` on `media.mp4`; AVPlayer occasionally issues `HEAD`. Express answers `HEAD` for `GET` routes by running the handler, so it works but streams the body to nowhere (`fs.createReadStream(...).pipe(res)` on a HEAD — Node discards it, cost is a full file read). Minor.
8. Markers: `GET /:id/markers` returns `start_ms`/`end_ms` relative to the recording file, which is the same timeline as `.native.mp4` (stream copy) — OK — but if `avoid_negative_ts make_zero` shifted the MKV's timestamps relative to comskip's frame timing there may be a small offset; unverified.
---
 
## 6. Streamlining opportunities
 
### 6.1 Dead code (safe to delete)
 
- `server/routes/users.js` (186 lines): never mounted; `routes/auth.js:174-292` is the live implementation. Its delete handler even checks `req.session.userId`, which nothing sets.
- `server/services/m3uXtreamAdapter.js` (134 lines): no importer. The handover already records that changes here "had no effect".
- `server/db.js` `hiddenItems` (`226-310`) and JSON `favorites` (`313-360`): no route uses them; hidden state lives in SQLite (`routes/channels.js`), favourites in SQLite (`db/sqlite.js:223-281`). `sources.delete()` still filters them (`db.js:207-209`).
- `services/transcodeSession.js`: `getOrCreateSession()`, `persist()`/`restore()`/`recoverSessions()` (`850-884, 939-949, 978-999`) — nothing calls them; `session.json` is written per session for nothing.
- `services/epgParser.js`: `parse()`/`fetchAndParse()`/`getProgrammesForChannel()`/`getCurrentAndUpcoming()` (`44-180, 185-225`) are only reachable from the dead second `GET /epg/:sourceId` and from `POST /epg/:sourceId/channels` (`proxy.js:614-639`), which the web client does not call (grep of `public/js` finds only `api.js:181` defining it).
- `services/m3uParser.js`: `parse()`/`fetchAndParse()`/`generateStableId()` (`15-25, 86-176`) — only the streaming variants are used; `generateStableId` output is discarded by `syncService`.
- `services/cache.js` and everything in `routes/proxy.js` that uses it (`98-115, 200-241, 439-519, 544-608`): the Xtream upstream-proxy paths exist to emulate an Xtream server for the web app; with an M3U-only, native-first setup they are unused. The DB-backed `live_categories`/`live_streams`/`m3u` routes are still used by the web app's `ChannelList`.
- `routes/proxy.js:13` `ffmpeg-static` require and unused imports (`8-14`).
- `services/hwDetect.js`: NVENC/AMF/QSV detection (`31-77, 121-211`) and the matching encoder branches in `transcodeSession.js:422-482, 591-623, 675-687` are unreachable on this box; `hwEncoder:'auto'` could resolve to VAAPI-or-software with 20 lines.
- OIDC: `auth.js:146-237`, `routes/auth.js:21-47`, `configureSessionSerialization`, `express-session`, `passport-openidconnect` — unconfigured and, for a single user behind pairing, unlikely to be wanted. Removing it removes the MemoryStore leak (§2.13) and two dependencies.
- Multi-user: roles and `/api/auth/users*` are harmless but add branches everywhere (`requireAdmin`, `created_by`, `user_id` on every table). Keep the *shape* (one admin user is the auth principal) but stop pretending to be multi-tenant in the data model only if you are willing to migrate tables; otherwise leave it.
- VOD/series: `syncXtream` steps 3-6 (`syncService.js:248-266`), `routes/channels.js:320-354`, `routes/history.js` (watch positions for movies/episodes), `watch_history` table, `showMovies/showSeries/autoPlayNextEpisode/seriesProbeCacheDays` settings, `MoviesPage/SeriesPage/WatchPage` in the web app. All unused with an M3U-only source and the Apple client. Candidates for deletion or a feature flag.
- Settings that nothing on the server reads: `arrowKeysChangeChannel`, `overlayDuration`, `defaultVolume`, `rememberVolume`, `lastVolume`, `autoPlayNextEpisode`, `forceProxy`, `forceTranscode`, `forceVideoTranscode`, `forceRemux`, `autoTranscode`, `streamFormat`, `probeCacheTTL`, `seriesProbeCacheDays` (`db.js:59-82`; grep of `server/` finds no reader outside `db.js`). Some are read by the web client via `/api/settings`; they belong in browser storage like `lastVolume` already does.
- `plugins/hello.js` and the plugin loader (`index.js:112-153`): a demo route on a production server.
### 6.2 Duplicated logic
 
- Channel → upstream URL resolution exists twice, character for character: `routes/playback.js:40-69` and `services/recordingEngine.js:94-132`. Extract to one `channelUrl.js`.
- Composite-id stripping regex `/^(?:m3u|xtream)_\d+_/` appears in `playback.js:50, 142`, `recordingEngine.js:112, 141`; not in favourites (§2.11).
- Three ffmpeg "tail the last N stderr lines" implementations: `transcodeSession.js:137-152`, `remux.js:227-239`, `recordingEngine.js:301-306, 553-558, 726-732`, `adDetect.js:88-93`.
- Four "spawn ffprobe and parse" helpers: `streamProbe.probeStream`, `remux.detectCodecs`, `recordingEngine.probeDuration`, `recordingEngine.probeCodecs`.
- Two piped-fMP4 ffmpeg pipelines with different flag sets: `routes/remux.js:155-197` and `routes/transcode.js:280-320`. With `segmentedDelivery` the native client uses neither; the web app uses remux. The legacy `GET /api/transcode?url=` is superseded by sessions.
- Row → channel decoration exists in `library.js:65-90` and again inline in `library.js:234-246`.
- Range serving is shared (`recordings.js:22-53`) — good — but `/:id/stream` (MKV) is only useful to the web app.
- `settings.get()` is called two to four times per recording tick and once per media request.
- `Cache-Control: no-store` middleware copied in `settings.js:8` and `sources.js:11`.
- User-agent string literal duplicated in `db.js:121`, `proxy.js:663, 839`, `streamProbe.js:45`, `recordingEngine.js:701`, `subtitle.js:24`, `m3uParser.js:286` — and the recording engine ignores the configured `userAgentPreset` entirely.
### 6.3 Oversized modules
 
- `routes/proxy.js` (869 lines): three unrelated concerns — Xtream emulation over SQLite (web app), upstream Xtream/EPG proxying with file cache (unused), HLS/segment/image proxying (live). Split into `proxy/xtreamEmulation.js`, `proxy/hls.js`, `proxy/image.js`; delete the upstream-proxy third.
- `services/recordingEngine.js` (1023 lines): scheduler/tick, ffmpeg capture, compression, ad-detect queue, native remux, free-space policy. `compression.js`, `nativePlayback.js` and `scheduler.js` would each be ~150-250 lines.
- `services/transcodeSession.js` (1038 lines): most of it is encoder-specific arg building for hardware you do not have. A VAAPI+software-only version is roughly half the size.
### 6.4 Config sprawl
 
- Defaults live in `db.js:57-117` (50 keys), some duplicated as fallbacks at every read site (`playbackStrategy.js:143-152`, `transcode.js:87-96`, `recordingEngine.js:653, 874, 908`), plus constants that are effectively settings (`SESSION_TIMEOUT_MS`, `SEGMENT_DURATION`, `TICK_INTERVAL_MS`, `DEFAULT_IDLE_TIMEOUT_SEC`, `CODE_TTL_MS`, `DEVICE_TOKEN_EXPIRY`). A single typed settings module with one merge and one place for each fallback would remove the drift (e.g. `maxConcurrentRecordings` 1 vs 2).
- `recordingsPath` is a setting and `/app/recordings` is also a Dockerfile/compose path; `comskipIniPath` setting vs `DEFAULT_INI` constant vs Dockerfile `COPY`.
- Two refresh notions: `settings.epgRefreshInterval` (global timer) and `source.syncInterval` (never set) (§2.14).
### 6.5 Where the web-app and native contracts diverge
 
| Concern | Web app | Native (`/api/library`, `/api/playback`, `/api/recordings`) |
|---|---|---|
| Channel id | composite `m3u_<src>_<pos_N>` (`ChannelList.js:856`) | bare `pos_N` (`library.js:73`) |
| Favourites | `POST /api/favorites` with composite id | `/api/library/favourites` joins on bare id (`library.js:180-182`); `favourite` flag likewise | 
| Spelling | `/api/favorites` | `/api/library/favourites` (read) + `/api/favorites` (write) — the native client has to use both spellings |
| Logo | `stream_icon`/`tvgLogo` (proxy shapes) | `logo` (`library.js:76, 241`) — and it is the raw upstream URL; the web app routes logos through `/api/proxy/image?url=`, the native client fetches upstream directly (mixed-content/ATS and referer differences) |
| EPG key | `epg_channel_id` / `tvgId` in the item JSON | `tvgId` on channel and guide rows (`library.js:78, 243`) — present, but never null for M3U because the parser fabricates one from the name (`m3uParser.js:74-76`), so `tvgId` cannot be used to mean "has EPG" |
| Guide | `/api/proxy/epg/:id` ±24 h dump, ISO strings | `/api/library/guide` epoch ms, paginated, `isNow` |
| Playback | `/api/playback/resolve` then hls.js or `<video>`; falls back to local strategy; stops via `DELETE /api/transcode/:id` | same resolve with `segmentedDelivery`; stops via `DELETE /api/playback/:id` |
| Recording playback | `/:id/stream` (MKV) | `/:id/playback` → `/:id/media.mp4` |
| Conflict | `confirm()` dialog | 409 body / conflict poll — same server shape |
| Settings | reads the whole settings object | not used |
| Auth | Bearer from localStorage, `?token=` helper | Bearer + `?token=` |
 
The server has been careful to make the *new* surfaces consistent; the leftovers are ids and favourites.
 
---
 
## 7. Prioritised recommendations
 
### P0
 
**P0-1. Bound HLS session disk usage** — `services/transcodeSession.js:392-412`.
Add `delete_segments` to `-hls_flags`, set `-hls_list_size` to a live-appropriate window (e.g. 30 segments = 2 minutes; 90 if you want a short rewind), and drop `append_list` (it only matters for the software-decode retry, which can instead restart into a fresh playlist). Also add a startup sweep that removes every directory in `transcode-cache/` (`recoverSessions` restores nothing useful today) and mount `transcode-cache` on tmpfs or an appdata path in compose. Rationale: every viewing session currently writes the whole stream to the Docker writable layer and only reclaims it on an explicit delete or a 30-minute idle sweep; on Unraid that fills `docker.img`, and a full `docker.img` takes every container on the host down, not just PigTV. It is the single failure mode most likely to produce an outage that looks unrelated to PigTV.
 
**P0-2. Fix the EPG batch mailbox** — `services/epgParser.js:268-437`, `services/syncService.js:495-517`.
Replace the single `pendingBatch` slot with a queue, and pause the source (`input.pause()` / resume around yields, or write the sax consumer as a proper `Writable` with backpressure) so batches cannot outrun the consumer. Remove the second `'error'` handler or make it distinguish fatal from recoverable errors. Verify on the real feed by comparing `COUNT(*)` with the programme count in the XML. Rationale: the guide, now/next and every scheduled recording are keyed off this table; silent loss of arbitrary 1000-programme runs means channels that "have no EPG today" for no visible reason, and a sync that reports `error` forces a full re-download on every restart.
 
**P0-3. Put an auth gate on the routes that can change state or spend resources without a token** — `index.js:189-194`, `routes/channels.js`, `routes/playback.js:80, 212`, `routes/transcode.js:70, 207, 225`, `routes/probe.js`, `routes/subtitle.js`.
At minimum: `requireAuth` on `/api/channels` and on `POST /api/transcode/session`, `GET /api/transcode/sessions`, `DELETE /api/transcode/sessions/all`, `/api/probe`, `/api/subtitle`; require *some* token (header or query) on `POST /api/playback/resolve` and `DELETE /api/playback/:id` (`optionalAuth` → a `streamAuth({enforce:true})`-style check that accepts either). Then flip `requireStreamAuth` to `true` before Tailscale. Rationale: today any device on the LAN can hide every channel, list live upstream URLs with the provider password, kill the user's stream, or make the server run ffmpeg against any URL it likes. Every one of these is one line to fix, and the Apple client already sends a Bearer token on JSON calls and `?token=` on media.
 
### P1
 
**P1-1. Arbitrate viewer-vs-viewer and shorten the live idle timeout** — `services/streamCoordinator.js:197-224`, `services/transcodeSession.js:29`.
In `resolve`, before starting a new session, release any existing viewer stream that has been idle for longer than `viewerIdleTimeoutSec` (the coordinator already has `staleStreams()` + `releaseStream()`), and if a *live* viewer still holds the only slot return a 409 with a `viewer-in-progress` conflict the client can force through, exactly like the recording case. Lower `SESSION_TIMEOUT_MS` for live sessions to a couple of minutes (VOD seeking is the only reason it was 30). Rationale: with one provider slot, the most common real-world failure is "changed channel on the TV, the phone was still playing / the app crashed 5 minutes ago", and the current code produces an unexplained ffmpeg timeout for that case.
 
**P1-2. Fix recording native playback: `hvc1`, in-flight dedupe, partial-file detection, sidecar cleanup** — `services/recordingEngine.js:522-571, 617-635`, `routes/recordings.js:194-215`.
Add `-tag:v hvc1` when `probeCodecs().video` is HEVC (and in `buildCompressArgs` for `hevc`). Keep a `Map<recordingId, Promise>` so concurrent calls await the same remux; write to `<out>.tmp` and rename on success so an existing `.native.mp4` is always complete. Make `/:id/playback` return `202 {status:'preparing'}` when the remux is running (or run it in the background and let `/media.mp4` block) so the Apple client does not hit URLSession's 60 s timeout on a 4 GB file over SMB. Delete `.native.mp4` and `.compressed.mp4` in `deleteRecording()`. Rationale: the native recording contract is the newest and least tested path, and three of its defects produce "plays on the web, not on the TV" reports that are hard to diagnose remotely.
 
**P1-3. Normalise channel ids once, and fix favourites across clients** — `routes/favorites.js:21-48`, `routes/library.js:157-160, 175-190`, `services/syncService.js:591`.
Strip the `m3u_<src>_` / `xtream_<src>_` prefix in `favorites.add/remove/check` (same regex as `playback.js:50`) and run a one-off `UPDATE favorites SET item_id = ...` migration. Then decide on a stable identity: keep `pos_N` as the *row key* if you must, but add a derived `stable_id` column (hash of `tvg-id|name|group|url`, disambiguated by ordinal among duplicates) and key favourites, history and schedules on that, so a provider inserting one line does not re-point every reference. Rationale: right now favourites made on the phone do not appear on the TV and vice versa, and a playlist reorder can make a scheduled recording capture the wrong channel.
 
**P1-4. Stop leaking provider credentials in responses and logs** — `services/playbackStrategy.js:91, 115`, `routes/transcode.js:207-219`, `routes/proxy.js:98-115, 245-279, 525-542`, `services/streamProbe.js:69`, `routes/playback.js:165`, all `console.log` of ffmpeg command lines.
Have `resolve` return an opaque stream handle (e.g. `/api/proxy/stream/<channelKey>` or the existing session id) rather than `?url=<credentialed upstream>`; redact `username/password` and `?token=` in a small `redactUrl()` used by every log line and by `GET /sessions`; return generic error text to clients and keep ffprobe stderr server-side. Rationale: with `requireStreamAuth` off, the provider password is one unauthenticated GET away on the LAN and is written to the container log on every play; both matter as soon as the port is reachable through Tailscale.
 
**P1-5. Make the EPG swap atomic and cheaper** — `services/syncService.js:472-558`, `db/sqlite.js:95-108`.
Insert into `epg_programs_new` (same schema), then in one transaction `DELETE FROM epg_programs WHERE source_id=?` + `INSERT ... SELECT` (or use a `generation` column and delete the old generation after). Stop storing the full JSON in `data` — the guide reads only `title`/`description`; keep `category` and `episodeNum` as columns if wanted. Drop `AUTOINCREMENT`. Add `(source_id)` to the cleanup index. Rationale: removes the minutes-long empty guide on every daily sync and roughly halves the database rewrite.
 
**P1-6. Remove the `ffmpeg-static` require and the other dead imports** — `routes/proxy.js:8-14`, `package.json:27-29`.
Rationale: a failed optional download during an image build turns into a server that will not start, and system ffmpeg is what the Dockerfile provides anyway.
 
**P1-7. Cache `db.json` in memory and drop express-session** — `server/db.js:14-54`, `index.js:21-28`.
Load once, write-through on save, and keep the write queue. Delete the session middleware (and OIDC) or set `saveUninitialized:false` if OIDC is kept. Rationale: one file read + parse per HLS segment is on the hottest path in the server, and the MemoryStore grows for every cookie-less request.
 
### P2
 
**P2-1. Delete dead code and unused features** — see §6.1: `routes/users.js`, `services/m3uXtreamAdapter.js`, JSON `hiddenItems`/`favorites` in `db.js`, `getOrCreateSession`/`persist`/`restore`, non-streaming parsers, `services/cache.js` with the upstream Xtream/EPG proxy routes, `plugins/hello.js`, non-VAAPI encoder branches, OIDC, VOD/series sync and pages, unread settings. Rationale: roughly a third of the server is unreachable or irrelevant to the deployment, and the handover already lists two incidents caused by editing a dead path.
 
**P2-2. Extract shared helpers** — `channelUrl.js` (used by `playback.js:40-69` and `recordingEngine.js:94-132`), `ffmpegProcess.js` (spawn + stderr tail + timeout, replacing five copies), `probe.js` (one ffprobe wrapper), `ids.js` (composite-id strip). Rationale: the two URL resolvers have already had to be patched in lockstep once (the `id = ?` fallback exists in both).
 
**P2-3. Guide query bounds and indexes** — `routes/library.js:252-257`, `db/sqlite.js:75-77, 106-107`.
Add `AND start_time > ? - 12h` to the programme query; add `idx_items_source_item(source_id, item_id)` and `idx_items_order(source_id, type, sort_order)`; consider keyset pagination (`after=<sort_order>`) instead of `OFFSET` for the 18 k-channel scroll. Rationale: cheap today, but each is an O(N) that a TV scrolling the full list multiplies by hundreds.
 
**P2-4. Segment route hardening and MIME** — `routes/transcode.js:154-176`, `services/transcodeSession.js:836-845`.
Reject `segment` unless it matches `/^(seg\d{4}\.(ts|m4s)|init\.mp4)$/` and assert `path.resolve(dir, name).startsWith(dir + path.sep)`; serve `video/mp4`/`video/iso.segment` for fMP4. Rationale: closes the encoded-slash traversal verified in §2.12 and stops lying about the content type to AVPlayer.
 
**P2-5. Propagate `?token=` in the HLS proxy rewriter** — `routes/proxy.js:756-784`.
Append the incoming `req.query.token` to every rewritten `/api/proxy/stream?url=` URI, as `withStreamToken()` does for sessions. Rationale: with `requireStreamAuth` on, `direct` HLS playback breaks on the first segment.
 
**P2-6. Configurable time zone and honoured user agent for recordings** — `services/recordingEngine.js:668-671, 701`, `Dockerfile`, `docker-compose.yml`.
Set `TZ` in compose (or document it), and use `db.getUserAgent(settings)` for the recording ffmpeg. Rationale: file names are documented as local time but the image defaults to UTC; and a provider that fingerprints the UA sees a different client for recordings than for playback.
 
**P2-7. Rate-limit `POST /api/auth/login` and `GET /api/devices/pair/poll`, cap `express.json` at 1 MB, add `USER node` to the Dockerfile.** Rationale: none of these are exploitable on the LAN today; all are table stakes before exposing the port.
 
**P2-8. Tests for the paths that matter to the Apple client** — `test/access.test.js` covers auth and M3U order well; nothing exercises `parseStreaming` under bursty input, `withStreamToken` on an fMP4 playlist, `/api/recordings/:id/playback` + `media.mp4` Range behaviour, `requestForViewer` when a viewer already holds the slot, or the favourites id mismatch. Each is a 20-line `node:test` case with a stubbed `spawn`. Rationale: the handover's own list of "things that already went wrong" is dominated by changes that passed the suite because the suite did not look there.
 
---
 
### Appendix: things that looked wrong but are fine
 
- `favorites.user_id INTEGER` queried with a string (`library.js:159`): SQLite affinity converts, verified by the passing test at `test/access.test.js:175-205`.
- `express.Router` param ordering in `routes/recordings.js`: `/:id/stream` cannot swallow `/scheduled/:id` (different segment counts), and the three anonymous routes are all `GET`.
- `pollPairing` hands the token over exactly once and clears it (`deviceAuth.js:67-80`); `approvePairing` refuses re-approval (`92`); revocation is checked per request (`auth.js:104-110`, `auth.js:270-277`). This part is solid.
- `authSecret.js`: exclusive create, mode 0600, refuses to rotate on corruption, refuses the historical default. Also solid and tested.
- `stop()`/`cleanup()` idempotency in `transcodeSession.js:717-754, 889-908`: correct, and the comments explain a real earlier bug.
- Recording free-space policy (`recordingEngine.js:57-78, 652-662, 870-890`) is sensible and defensive.
