# Shipped log 0106–0206 (frozen 13 October 2026)

One line per build, moved out of `blueprint.md` §8. From 0207 on, the commit subject (`NNNN: what`) is the record:
`git log --grep "^[0-9]\{4\}:"`. 0033–0105 are in `blueprint-2026-09-23.md` §4; the long write-ups for 0106–0203 are in
`blueprint-history-0106-0203.md`.

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
| 0205 | The linker sees linked siblings again (0204 dropped and remade their links on alternate relinks) |
| 0206 | Pig family brand 1.6.0: PigTV product pig and lockups, favicons and manifest, corner bloom, loading splash, glass navbar, rounded numerals |
