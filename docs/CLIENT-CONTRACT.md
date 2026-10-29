# Server ↔ Apple client contract

The one place that says what the Apple client (`../PigTV-Swift`) may rely on. It replaced `ROADMAP-CONTRACTS.md` and the
live parts of `SWIFT-CLIENT-HANDOFF.md` on 13 October 2026; their history (the C1–C9 requests and the per-build change log
0055–0206) is in `docs/archive/SWIFT-CLIENT-HANDOFF-2026-10-13.md`.

**Rules**
- Ask the server, don't guess. `GET /api/info` (no token) returns `build`, `display`, `apiVersion` and `features`. New
  behaviour is announced with a flag; an older server lacks it, so **gate on the flag** and treat a missing flag as off.
  `/api/info` still answers if a feature check throws (that flag is then absent).
- Every change is **additive** unless both sides change together. Anything in §2 changes only with a matching client change.
- A change the client can see (including anything in `transcodeSession.js` / `playbackStrategy.js`) is written into this
  file in the same commit.
- A new endpoint the client calls goes into `APPLE_CLIENT_ROUTES` in `test/api-404.test.js`.
- When the client needs something, describe what the screen needs, not the endpoint, and raise it in the server repo.

---

## 1. `/api/info` flags (`server/routes/info.js`)

| Flag | Since | Means | Apple client |
|---|---|---|---|
| `playbackResolve`, `library` | early | Resolve and `/api/library` exist | **Required** (with `apiVersion` 1), else the server is refused |
| `guide`, `devicePairing`, `recordings`, `recordingCompression`, `channelHistory`, `adDetection`, `streamCoordination`, `streamTokenAuth` | early | Base features (`comskipAvailable` says whether ad detection can run) | `devicePairing` gates pairing; the rest are not read |
| `viewerConflict` | 0083 | Resolve may answer 409 `viewer-in-progress` | The 409 is handled by `conflict.type` either way |
| `epgLogoFallback` | 0083 | Library rows fill a missing `logo` from the EPG | Skips its own artwork index |
| `clientEvents` | 0083 | `POST /api/playback/client-event` | Sends `media-error`, `play-start`, `play-end` (`watchedSec`, `stalls`, …) |
| `scheduledWaiting` | 0083 | `recordings/scheduled` lists cancellable `waiting` rows | Shown and cancellable |
| `recordingPlaybackPolling` | 0083 | `recordings/:id/playback?async=1` may answer 202 `preparing` | Sends `?async=1` and polls |
| `playbackTerminalStatus` | 0094 | `GET /api/playback/:id/terminal-status` → `taken-over` \| `none`. From 0286 a paired device's new play also ends that device's earlier session on the same provider (FR-11), even when a connection is free; that session then answers `taken-over` | Asked once before its one recovery |
| `guideCursor` | 0111 | Cursor paging, `limit` ≤ 500 on `library/guide` | Pages 500 by cursor |
| `guideVersion` | 0111 | `GET /api/library/guide/version` (includes the build, so a deploy reloads once) | Skips a reload when unchanged |
| `logoCache` | 0112 | `logo` fields are `/api/logo/<key>`; `?size=full` / `?size=640` | Top Shelf asks `size=full` |
| `channelNumbers` | 0117 | Rows carry `number` (labels only, C-A) | Muted number after the name; iOS "Go to number" |
| `playbackHandles` | 0119 | `direct` resolves use `/api/proxy/stream?h=<handle>` (always, since 0196) | Not read; a 404 leads to a re-resolve |
| `channelHealth` | 0133 | Rows carry `health` `ok`/`flaky`/null (C-G) | Amber dot on flaky channels |
| `sportCategories` | 0146 | `library/categories` rows carry `sport` (C-H) | Not read any more (decoded) |
| `sportsDashboard` | 0309 | Opt-in dashboard/catalog and per-user preferences (C-O); false unless `PIGTV_SPORTS_DASHBOARD=1` | Not yet consumed; existing Sport UI still uses C-I |
| `sportsEvents` | 0148 | `GET /api/sports/events` (C-I) | Sport tab, Home "Sport now & next", `hours=72` |
| `scheduleHistory` | 0156 | `recordings/scheduled?include=recent` adds missed/failed of the last 7 days | Asks `include=recent` |
| `providerReminders` | 0168 | `GET /api/providers/reminders` (C-K) | Daily reminder popup |
| `providers` | 0174 | Resolve carries `provider` (C-J) | Shown in Stream info |
| `warming` | R12 (0198) | `POST /api/playback/warm`; `warmingEnabled` beside `features` says whether the admin switched it on | Warms the likely next channel when both are true |
| `recordingPositions` | 0207 | `GET/PUT /api/recordings/:id/position`; recording rows carry `position_sec`, `watched` | Per-login resume |
| `recordingWatchLive` | 0218 | `GET /api/recordings/:id/watch`; recording rows carry `watch_live` (C-L) | "Watch from start" on a recording in progress |
| `recordingRules` | 0219 | `/api/recordings/rules` (C-M); `recordings/scheduled` rows carry `rule_id` | "Record every game" / "Record series", rules in Recordings |
| `recordingArtwork` | 0220 | `recordings` and `recordings/scheduled` rows carry `image` (C-N) | Programme artwork on recording tiles |

Never sent since 0204 (the tuner model was removed): `timeshift`, `recordingHls`. The client still decodes them as absent.

Sent by the client, not flags: `capabilities.segmentedDelivery = true` and `capabilities.heaac = true` (always, since app
build 27), and `audioEncode: true` on the one fallback after a `'fmt?'` decode failure.

---

## 2. Frozen (change only together with a client change)

- `library/guide` rows: `id, sourceId, name, logo, category, tvgId, programmes[]` with `startTime`/`endTime` in **ms**;
  additive `stableId`, `number`, `health`, and `nextCursor` on the page.
- `recordings/{id}/markers`: `startMs`/`endMs`.
- `recordings/{id}/playback` (bearer): `{url: "/api/recordings/{id}/media.mp4", container: "mp4", durationSec}`; `media.mp4`
  takes `?token=`, supports byte ranges (suffix and past-the-end too) and `+faststart`; `?async=1` is additive.
- Favourites: `POST/DELETE /api/favorites` with the **bare** id; listed via `library/favourites`.
- `POST /api/playback/resolve` → `strategy` `"direct"` | `"transcode"`. `playbackURL` is under exactly one of
  `/api/proxy/stream` (`?h=<opaque handle>`, never a provider URL), `/api/transcode/…` or `/api/recordings/…`; the token is
  attached as `?token=`; bearer on `DELETE /api/playback/{id}`.
- **Every HLS session with a usable frame rate is handed out as `master.m3u8`**: one variant with `BANDWIDTH`, `RESOLUTION`
  (copy only), `FRAME-RATE`, `VIDEO-RANGE` (`SDR`, or `PQ`/`HLG` for an HDR copy into fMP4), **no `CODECS`**. No usable rate,
  or an HDR feed copied into MPEG-TS, gets `stream.m3u8`. The client sets display criteria from resolve `info` (`fps`,
  `videoRange`) and, on AVFoundation -11868 (a non-HDR TV), plays the same session's `stream.m3u8`.
- **Shared ingest defaults on since 0290**; an explicitly stored opt-out wins. This changes no endpoint shape.
- **A live session's playlist is held 30 s behind its newest segment** (Apple 56: `configuredTimeOffsetFromLive`, and "go to
  live" returns there): providers that deliver in bursts pause for up to ~16 s (`docs/FINDINGS.md` FR-8). So a live media
  playlist keeps well over 30 s of segments (90 × 4 s), and the server calls a measured shared feed lost at its per-channel/provider limit: 24 s by default
  (`PIGTV_INGEST_BEHIND_SEC`), up 2 s on a lag reconnect, capped at 28 s (0292). After 3 measured reading hours
  ≥4 s under the level it drops 2 s. Levels persist across redeploys; no-PCR feeds keep the default silence rule.
  Since 0298, concurrent ingests of one provider/channel share their learned level and count overlapping reading
  time once. The Apple hold stays 30 s; no ffmpeg flags change.
- **0307 experimental setting** `ingestReconnectRenewal` (web Settings → Playback, off by default) opts a relay viewer into
  renewing its ffmpeg timeline after a successful shared-ingest reconnect. It requires both relay and shared ingest to be
  enabled. The same provider and playback URL are retained; the new timeline follows `EXT-X-DISCONTINUITY` (and a fresh
  `EXT-X-MAP` for fMP4). The relay settles for 6 live seconds, forces a renewal attempt after 8 s and caps the full wait
  at 20 s. Since 0311, three renewals within a rolling minute exhaust the play’s renewal budget: renewal is then
  disabled for that play and ordinary provider failover runs, recorded as `renewal-budget`. Follow-on renewals after
  short startup epochs count toward that same budget. Since 0314, budget exhaustion quarantines only this channel,
  without contributing to the provider-wide breaker; its interruption has `providerReason:false`. If no backup can be
  admitted/started, the relay tries its still-pinned primary once with renewal disabled under normal admission checks.
  It ends if neither backup nor primary can start; successful primary fallback records `renewal-primary-fallback`. Ordinary cold failover opts into renewal only once its first playlist is ready. Startup epochs closed for renewal end with EOF and are not treated as provider failures or hardware-decode
  failures. The planned renewal does not promote standby, quarantine the provider or count as a lost/recovered play;
  Status uses relay reason `reconnected`. Recordings, probes, warm/standby readers, sessions without a relay, the 0191
  direct-read guard, ffmpeg flags and Apple 30 s live hold are unchanged. A promoted standby becomes a viewer. This has
  synthetic/local tests only and is **not approved as a production sync fix**; Mark's iPhone acceptance is pending.
- **0307** prepares a container upgrade to a pinned FFmpeg/ffprobe **9.0.2** pair, matching Linux CI's release/feature
  recipe. The final image is capability-checked, checks actual session-builder encoder options and runs the suite as UID
  99 before publication. `GET /api/status` reports only each media tool's numeric version, origin and mismatch state;
  tool output and paths are not returned. Linux image and device acceptance are pending; see `docs/MEDIA-TOOLCHAIN.md`.
  This does not establish an FR-22 A/V fix. No Apple-side shape or playback command-line flag changes.
- Resolve failure `error` texts start with a C-B prefix and never contain a URL; the client shows only those.
- A start stopped on request answers **499** `{error, superseded: true}` (0180); the client ignores it.
- `recordings/scheduled` rows: `program_end` can **move later** after scheduling (0214, R4: it follows the guide after a
  sync, never earlier than first scheduled, at most +3 h); a client re-reads it rather than caching it. The additive
  `program_end_original` is the end it was made with (null until it moves).
- Additive and safe: `/api/version` and `/api/info` fields; `waiting` rows; `finite`/`durationSec`/`videoRange`/`fps` in
  resolve `info`; unknown `/api/*` answers `404 {"error":"No such API endpoint"}`.

---

## 3. Contracts

| Contract | Flag | Server | Apple |
|---|---|---|---|
| C-A Channel numbers | `channelNumbers` | 0117, 0139 labels only | 19, 29 |
| C-B Resolve errors | none (text match) | 0113, 0118 | 19 |
| C-C HE-AAC passthrough | none (capability) | 0116 | 27 always on |
| C-D Opaque playback handle | `playbackHandles` | 0119, 0196 always | none needed |
| C-E Tuner model | `timeshift`, `recordingHls` | **removed in 0204** | removed |
| C-F Labs | Apple only | none | Stream info is the only switch left |
| C-G Channel health | `channelHealth` | 0133, 0142 | 19 |
| C-H Sport categories | `sportCategories` | 0146 | superseded by C-I |
| C-I Sport events | `sportsEvents` | 0147–0153, 0161 | 30–32 |
| C-J Provider on resolve | `providers` | 0174 | 36 |
| C-K Licence reminders | `providerReminders` | 0168 | 36 |
| C-L Watch a recording from the start while it records | `recordingWatchLive` | 0218 (R3) | 44 |
| C-M Recording rules | `recordingRules` | 0219 (R5) | 45 |
| C-N Recording artwork | `recordingArtwork` | 0220 (R6) | 45 |
| C-O Sport dashboard foundation | `sportsDashboard` | 0309 (opt-in) | pending |

C-A to C-K are implemented on both sides and verified on devices (results in `docs/archive/TEST-BLOCK-2026-10-13.md`). C-L
onwards are not verified yet.

### C-A. Channel numbers. Flag: `channelNumbers`

- Every visible live channel has a **number**: a positive integer, unique across the server, keyed by identity
  (`source_id` + `COALESCE(stable_id, item_id)`). First assignment follows guide order; later channels get the next free
  number; a channel that disappears keeps its number for 30 days. The admin can renumber.
- `library/guide`, `/channels`, `/favourites`, `/recent` rows carry `number` (int or null).
- **Labels only**: `library/guide` and `/channels` keep the provider's order, which groups channels under its
  placeholder channels (Mark, 24 Sept; 0139).
- Admin (web only): `GET /api/lineup` → `[{sourceId, id, stableId, name, number, category}]`; `PUT /api/lineup/numbers`
  `{numbers: [{sourceId, id, number}]}` → `{success}`; a duplicate is a 400.
- Apple: small muted text after the name, never over a logo, not in the Top Shelf title; channel up/down follows guide
  order; no number entry on tvOS; iOS has "Go to number".

### C-B. Resolve errors. No flag (text match)

The resolve `error` is shown **only** if it starts with one of:
- `The provider refused this channel`
- `The provider did not respond`
- `This channel is not available`

Texts live in `playbackErrors.js` and never contain a URL. Any other text maps to the client's generic message.

### C-C. HE-AAC passthrough. No flag (a capability)

The client always sends `capabilities.heaac = true` (app 27). HE-AAC is then copied into fMP4 instead of re-encoded; a
`'fmt?'` decode failure falls back once to `audioEncode: true` for that channel. The web never sends it. Since 0302 (FR-9) the
server never copies AAC whose ADTS label is not AAC-LC (Strong8K's FOX feeds label HE-AAC as AAC Main, which Apple refuses as a
copy): it is re-encoded to AAC-LC for every client, so those channels no longer fail their first start. The label is read, for the audio
track the session maps, only when the probe goes through the shared ingest; a direct probe or an older stored channel profile copies as before, and the
`fmt?` fallback still covers it. Request and response shapes are unchanged.

### C-D. Opaque playback handle. Flag: `playbackHandles`

A `direct` resolve returns `/api/proxy/stream?h=<32 hex>` (in memory, 12 h, LRU 10,000; a restart forgets them, unknown → 404;
a manifest fetched by handle hands out handles for its URIs). `?url=` is refused (400) since 0196. No provider URL appears in
any response or log line.

### C-E. Tuner model. Removed in 0204

Shared tuners, timeshift and HLS recordings were never run on a device and are gone. `timeshift` and `recordingHls` are never
sent; the client keeps behaving as if they were absent.

### C-F. Labs (Apple only)

Settings → Labs keeps one switch, **Stream info overlay**: codec, resolution, fps, bitrate, dropped frames and the provider.

### C-G. Channel health. Flag: `channelHealth`

`library/guide` and `/channels` rows carry `health`: `"ok" | "flaky" | null`. `flaky` = in the last 7 days ≥2 failed starts,
or >30% of ≥3, or ≥3 stalls per hour over ≥20 min watched. Stalls and watched time come from the client's `play-end`
(`stalls`, `watchedSec`), matched to that owner's last resolve. Apple: a small warning dot.

### C-H. Sport categories. Flag: `sportCategories`

`library/categories` rows carry `sport: bool`; admin `PUT /api/library/categories/sport` `{sourceId, categoryId, sport}`
(bumps `library_rev`). Since C-I it is one signal of sport recognition; the Apple Home row it fed is gone.

### C-I. Sport events. Flag: `sportsEvents`

Sport is recognised per **programme**, not per channel. How recognition, kinds, merging, live-or-replay and ESPN fixtures
work is in `blueprint.md` §3 "Sport events"; the shape the client relies on:

- `GET /api/sports/events?hours=N[&include=all]` (any user; default 6, max 72) →
  `{ now, events: [ { id, title, league, start, end, live, kind, aliases, channels: [ { sourceId, id, stableId, name, number, logo, quality } ] } ] }`
  - `kind`: `"event"` | `"replay"` | `"show"` | `"placeholder"`; absent means `"event"` (an older server).
  - Default: events and replays; `include=all` adds shows and placeholders after them.
  - Order: live events, upcoming events (by start), then replays (on-now first, then by start).
  - `league`: the canonical league ("F1", "AFLW", …), else the most specific EPG category, else "Sport".
  - `live`: on now. `quality`: `"UHD"` | `"HD"` | `"SD"` | null from the channel name.
  - `channels`: best first (quality, health ok, favourite, guide order). `channels[0]` plays through the ordinary resolve.
  - `title` is the cleanest form ("Carlton Blues v Richmond Tigers", "Azerbaijan GP · Practice 3"); `aliases` are the raw
    guide titles merged into it.
  - Since 0294, match-ups of two distinct teams in a followed league's stored ESPN roster name that league even
    without its keyword. Since 0295, inference requires informative full names, nicknames or stored abbreviations,
    unique within and across followed rosters; location-only/subset matches do not infer a league. Since 0297, generic broadcasts join only exactly one overlapping event of their league/kind; otherwise they
    stay shows. Since 0301, with no overlapping named event, generic titles recognised by an EPG sport category
    or sport-marked channel retain event status; keyword-only titles still become shows. Multiple overlapping
    candidates still make a show. Recaps stay shows. Shape unchanged.
  - Since 0293, Cricket format titles and match-ups on Cricket channels are recognised when Cricket is followed.
    Since 0296, day-one and later-day Test blocks are live when overlapping the inferred daily playing window
    (first ball minus 30 min pre-play grace through first ball +8 h), or with the guide's live flag during the
    fixture span. Wholly overnight blocks are replays. Response shapes are unchanged.
  - Since 0221 (R9) an event can also come from an event slot's own **name** ("NHL: Pittsburgh vs Philadelphia @ Sep 30
    7:30 PM :Sportsnet+ 12") where the slot's guide shows nothing real; same shape, nothing for the client to change.
- Admin (web only): `GET/PUT /api/sports/follow` (`{keywords}`, ≤100), `GET /api/sports/preview` (72 h, every kind, with
  the rule and `kindRule`), `GET /api/sports/categories`.
- Apple: a Sport tab (On now, Starting soon, Later today, Tomorrow, one section per later weekday, Replays) with league
  chips; select plays the best channel, a secondary action picks another; upcoming events open an event page (Watch when it
  starts, Record, channels); Home has "Sport now & next" (never replays); refresh every 60 s while visible.

### C-J. Provider on resolve. Flag: `providers`

A channel resolve (`sourceId` + `channelId`) carries
`provider: { id, name, role: "primary"|"backup", via: "primary"|"sibling"|"backup", failover: Bool }`.
- A sibling is the primary's own "(Backup)" feed: `role: "primary"`, `via: "sibling"`.
- `failover` is true when an earlier candidate failed or the primary was skipped (down, expired, or this channel failed
  there in the last 10 min). Being full is not a failover.
- 409 shapes are unchanged; when every provider that carries the channel is full, the 409 is for the first one (`force` acts
  on it) and its `conflict.message` starts "Every provider that carries this channel is in use."
- A stream that dies mid-play for a provider reason is quarantined there, so the client's single re-resolve lands on the
  next provider. The whole resolve stays under 30 s (the client's request timeout is 35 s).

### C-K. Licence reminders. Flag: `providerReminders`

- `GET /api/providers/reminders` (any signed-in user or paired device) → `[ { id, name, expiresAt, daysLeft } ]`, soonest first;
  `[]` when nothing is due. Enabled providers (backups included) whose expiry is ≤ 7 days away or past. `expiresAt` in ms;
  `daysLeft` rounded up, ≤ 0 once ended. Nothing else: no role, login or URL. An unknown expiry is never listed; a failed
  account check keeps the last good values.
- Apple: on launch and foreground, at most once per local day per device, a popup naming the provider and date, closing after
  15 s or on any button. Never during playback.

### C-L. Watch a recording from the start while it records. Flag: `recordingWatchLive`

Only for recordings made with Settings → Recording → **Segmented recordings** on (off by default; R3). Everything else is
unchanged, including every recording made before or with the switch off.
- `/api/recordings` rows carry `watch_live: Bool` (always present): true while the recording is still in progress
  (`status` `"recording"`) and can be played from its start. A segmented recording stays `"recording"` for a few minutes
  after its programme ends, while its MP4 is made; it is still watchable then. It becomes `"completed"` with the MP4, and
  plays through `/:id/playback` as before.
- `GET /api/recordings/:id/watch` (bearer) →
  - 200 `{url: "/api/recordings/{id}/live/master.m3u8", container: "hls", recording: Bool, videoRange: "SDR"|"PQ"|"HLG", fps: String|null, durationSec}`
    (`recording` false = the programme has ended and the MP4 is being made; `durationSec` = recorded so far);
  - 202 `{status: "preparing", retryAfterSec: 2}` while the first piece is made (ask again);
  - 409 `{error, finished: Bool}`: not watchable this way (`finished: true` = play it with `/:id/playback` instead).
- `url` is a one-variant master playlist like a live session's (`FRAME-RATE`, `VIDEO-RANGE`, no `CODECS`); its media
  playlist is an **EVENT** playlist of fMP4 pieces with `#EXT-X-START:TIME-OFFSET=0` (a player starts at the beginning),
  growing while recording; `#EXT-X-ENDLIST` once the programme has ended. A provider failover or a server restart during
  the recording appears as `#EXT-X-DISCONTINUITY` with a new `EXT-X-MAP`. Every URI carries `?token=`.
- Since 0308, copied AAC in the watch copy explicitly converts its MPEG-TS ADTS headers to MP4 Audio Specific Config.
  This prevents AAC-LC recordings producing an aborted, sub-second watch playlist. Response shapes are unchanged.
- Since 0310, watch audio is encoded to AAC-LC unless it is known AC-3/E-AC-3. This includes unknown probe results
  and AAC with a non-LC ADTS label; video and archives remain copied. Finished MP4s already encode known AAC; unknown
  audio now also uses that safe fallback. Shapes are unchanged.
- Once the recording is finished its playlists answer 404: the client then plays the finished recording (`/:id/playback`),
  at the same position.

### C-M. Recording rules. Flag: `recordingRules`

A rule makes ordinary schedules; one-off recordings are unchanged. Any signed-in user or paired device.
- `GET /api/recordings/rules` → `[ {id, kind: "sport"|"series", match, sourceId, channelId, stableId, channelName,
  preBufferMin, postBufferMin, newOnly, enabled, createdAt, upcoming} ]` (`upcoming`: its schedules not yet finished;
  null buffers = the server's defaults).
- `POST /api/recordings/rules` `{kind, match, sourceId?, channelId?, channelName?, preBufferMin?, postBufferMin?, newOnly?}`
  → 201 the rule plus `scheduled` (how many it scheduled at once); 200 with the existing rule when the same one exists;
  400 `{error}` when invalid.
  - `sport`: `match` is a follow keyword (a team, `"NFL: Kansas City Chiefs"`; a league, `"AFL"`; any word). Every Sport
    event (C-I) it follows in the next 72 h, never a replay, on the event's best channel.
  - `series`: `match` is the programme title, on the channel `sourceId` + `channelId` (bare or composite id). Every airing
    in the guide (7 days); `newOnly` skips airings the guide flags as previously shown. Episodes are told apart by the
    guide's episode number or subtitle.
- `PUT /api/recordings/rules/:id` `{enabled?, newOnly?, preBufferMin?, postBufferMin?}` → the rule; 404 unknown.
- `DELETE /api/recordings/rules/:id` → `{success, cancelled}`: its schedules that have not started are cancelled; one
  recording now, and everything recorded, stays.
- `recordings/scheduled` rows carry `rule_id` (null for a one-off). Two rules never record the same programme twice.
- **What a cancel holds against (0245, 0253, 0254, 0259; not durable identity).** The guide gives no lasting id, so a
  rule decides per evaluation whether a programme is one it has already scheduled (policy accepted by Mark, 25 Oct):
  - *Present:* a schedule of the same title within 15 minutes is that programme (for a series, on its channel: the
    channel's stable identity when the schedule has one, so a playlist reorder does not change it; 0260).
  - *Moved:* a schedule that has not begun (`scheduled`, `waiting`, or `cancelled` by the viewer) and is no longer
    present is the same programme as the nearest same-title one that has no schedule, one to one. A pending one moves
    with it (`program_start`/`program_end` change), also back again (A → B → A). Sport: any channel, within the next
    **72 h** (nothing beyond is paired), a move of any size. Series airings without the guide's episode number or
    subtitle: on the rule's channel, a move of at most **3 h**; further is a new airing. Airings with episode data are
    that episode wherever they move: an episode's schedule is decided by its episode before anything is matched by time
    (0263), and a pending one follows it (0260), unless an airing of it is still at the schedule's time (a repeat is not
    recorded). A schedule belongs to one episode: a repeat or another episode never takes it by time, even while its
    episode is out of the guide (0265, 0268, 0269) - another episode in its slot is then recorded as well. An airing without
    episode data never takes a schedule of an episode that is still in the guide (0260).
  - *Unclear:* a cancel holds only when its pairing is unambiguous: the cancelled schedule has exactly one candidate it
    could be (same title, on its channel for a series, within the move limit and horizon), and that candidate exactly
    one such schedule. Otherwise the ones the cancel might be are **recorded** (the viewer can cancel again); pending
    ones still follow the nearest. This is decided again at every evaluation: a programme an earlier evaluation clearly
    took for the cancelled one is recorded once another same-title programme it might be appears (0260), e.g. a
    rematch within the 72 h, measured from the cancelled schedule's stored time.
  - A schedule already recording (its pre-buffer started) never takes a later programme. Another match of the same
    title beside a scheduled one is recorded too.
  These are heuristics over the guide, not provider identity. A client must not promise more than this.
- Deleting a recording (`DELETE /api/recordings/:id`) while its start is moving to a backup provider (the seconds after
  the first provider refused it) ends that schedule as `cancelled` (0252); nothing is recorded for it afterwards. A
  recording deleted while it is being finished (0257), prepared or remuxed for native playback, or compressed (0261)
  leaves nothing of it on the share once the deletion has completed: the deletion stops what is writing for it and waits
  for it before it answers (0264), so it can take a few seconds longer - at most 30 s: a writer stuck on a share that
  stopped answering is left, and what it made is removed when it ends or at the next start (0270). A native-playback request waiting for it then
  fails (`playback?async=1`: 500 `{status: "failed", reason: "file-missing"}`); the recording is 404 from then on.

### C-N. Recording artwork. Flag: `recordingArtwork`

`/api/recordings` and `/api/recordings/scheduled` rows carry `image`: the programme's own image from the guide
(XMLTV `<icon>`), as a logo-cache path `/api/logo/<key>` (fetch it like a `logo`, `?size=640` or `?size=full` for a
larger copy), or null when the guide has none. Found when the schedule is made, so it appears for schedules made after
a guide sync on 0220 or later. The image's own address is never listed. Apple: shown on recording tiles in place of
the channel logo, filling the tile; the channel logo stays the fallback.

---

## 4. Testing client-visible changes

- Client side: contract fixtures in `PigTVTests/ContractChecks.swift` (`sh Tools/test-contracts.sh`, no server), and new
  playback code gets a test in `PigTVTests/RealPlaybackTests.swift` (a fake PigTV API and a real HLS fixture). See the
  client's `AGENTS.md`.
- Server side: `test/api-404.test.js` boots the server and asserts every route in `APPLE_CLIENT_ROUTES` still resolves.
- Server log lines while testing a device (`docker logs PigTV 2>&1 | grep -E "viewer|conflict|\[Player\]|\[HLS\]|resolve timing|from=device"`):
  `[HLS] 404 for seg0012.m4s in session …` means the file was gone (session removed, or rotated out); lines ending
  `from=device:<id>` are the client's own.
- Feeds worth knowing: stream **1803789** is a finite ~30-minute file (paced since 0144; a good survival test);
  **1239048** logs harmless `[mp4] Packet duration … out of range` warnings.


### C-O. Sport dashboard foundation. Flag: `sportsDashboard` (0309, experimental; 0313/0315 own-review repairs)

**Server foundation only; Apple/web presentation has not changed.** The flag is false unless the server explicitly sets
`PIGTV_SPORTS_DASHBOARD=1`. All routes below require a signed-in user or valid paired device and answer 404 while disabled.
They answer `Cache-Control: private, no-store`; no shared response cache or client-supplied profile ID is used.

- `GET /api/sports/preferences` → `{avoidSpoilers: boolean, scoreDelaySeconds: integer, revision: integer}`. Defaults:
  false, 90, 0. One row per authenticated user; a paired device uses its approving account. Shared-TV profile switching
  is not implemented. These values persist across server restart/redeploy in the mounted SQLite database.
- `PUT /api/sports/preferences` accepts `revision` and one/both of `avoidSpoilers` (strict boolean), `scoreDelaySeconds`
  (integer 0–300). Success returns the updated object and increments revision. Unknown fields, invalid types or missing
  revision are 400. An outdated revision is 409; re-read before offering to retry. This is self-service for viewers too.
- `GET /api/sports/dashboard[?league=NFL]` reads stored data without contacting ESPN. It consumes the per-minute cached
  C-I event response and performs parsing, bulk catalog/history reads and projection on a read-only worker, with no
  main-thread reference-path fallback. Each worker job has a 10-second deadline: expiry fails that job, terminates the
  worker and continues queued work on a replacement; success/failure/close clear its timer. Whole-league/category selection is a union: a sport-marked category or a
  whole-league follow includes all games of that league; a team follow narrows it only without a broad selection. Without a league: today in the
  server `TZ` (valid IANA zone; default/fallback Australia/Melbourne), plus ongoing cross-midnight games and retained
  results. With a canonical league: rolling 72 hours, plus ongoing/recent games. Invalid league is 400.
- Response: `{now, timezone, scope: "today"|"league", hours: null|72, preferences, games:[...]}`. All absolute times are
  epoch milliseconds. A game has `{id, league, title, start, end, session, circuit, format, competitors, status, freshness,
  observedAt, progress, availability, broadcastStatus, channels, events, canWatch}`. `end`, `session`, `circuit`, `format`
  and `observedAt` may be null. `competitors` are `{id,name,logo}`; logos use the existing cached `/api/logo/<key>` route.
  F1 competitors are empty: its title/session/circuit identify the event; it never carries positions, scores or timing.
- Source-qualified game IDs remain stable across score updates; they are not playback handles. `events` contains
  matched C-I `{id,start,end}` references for the existing details/record workflow. `channels` uses C-I's channel shape,
  with current broadcasts first and otherwise future choices. Preserve `stableId`; never fall back to stored `pos_N`.
  `canWatch` is true only for a current eligible airing. It does not reserve a provider slot; use the normal resolve
  flow, which can refuse admission or a vanished channel. No new recording endpoint or playback strategy exists.
- `status`: `scheduled`, `live` (confirmed by the delayed source state), `break`, `suspended`, `postponed`, `cancelled`,
  `finished`, `unknown`. A break may include an allowlisted `breakLabel`. `broadcastStatus`: `on-tv`, `scheduled`,
  `unavailable`; **on TV does not establish live play**. `availability`: `matched`, `unmatched` (no unambiguous join),
  `unavailable` (a known airing is not currently eligible). No provider probing is performed to populate a card.
- `freshness`: `buffering` until an old-enough snapshot exists, `fresh` when eligible, `stale` after the configured
  delay plus two minutes of observation age. Stale/unknown progress is `{}`; never animate a clock locally. A known
  future scheduled event retains its scheduled label between the slower catalog polls. Observation age is receipt
  age, not proof of upstream freshness or video alignment.
- A complete observed snapshot becomes eligible at `observedAt + scoreDelaySeconds * 1000`. Scores, clock, period,
  breaks and final status come from that snapshot together. `progress` contains available clock/period, MLB half-inning,
  or cricket day/overs. No missing clock, base situation, innings score or 0–0 is fabricated.
- With scores enabled, `scores` is a two-element display-string array when available; optional `situation` carries
  validated sport-specific fields. **Both fields are absent when `avoidSpoilers` is true, or data is unavailable/stale.**
  No winner/leader, raw status prose, source headlines or raw aliases are returned. Clients must also keep event details,
  accessibility and any old cached content spoiler-safe; those UI changes are still pending.
- A result is retained for one hour after its observed final transition becomes eligible. Initially discovered historic
  finals have no observed transition and are excluded once final data is eligible. Repeated final polls do not restart
  the hour. Completion changes every score-derived broadcast/action field only when that same delayed snapshot is eligible;
  an undelayed final must not reveal itself through channels, availability or Watch. Current guide airing bounds still
  apply independently, and clients revalidate the airing at selection. Final-transition retention is carried in each
  snapshot, including after a newer correction; existing 0309 history is upgraded before the worker reads it.
  Last-known state survives pruning. A first-seen historic final intentionally buffers as unknown until eligibility,
  then disappears because no trustworthy completion transition was observed; no recent-result hour is fabricated.

Collection is separate from C-I's 30-minute fixtures: at most 12 public ESPN network attempts per 30-second tick across
all dashboard sources/dates, with two in flight, including dated cricket discovery. Known in-play/near-start source
dates poll at 30 seconds; other catalog dates use 15 minutes and budget-deferred work rotates through later ticks.
Three request slots are reserved for eligible least-recent non-hot work, including dated discovery, so busy sources
cannot indefinitely starve future catalogs; unused capacity can serve either lane. With the dashboard enabled, a shared
429/5xx cooldown also pauses fixture requests. Deferred leagues are not marked as failed and a coalesced pass retries
after the cooldown (cancelled if another successful pass already completed). With the dashboard off, the legacy fixture
client neither observes nor consults dashboard cooldown state; its normal sequential/30-minute behavior is retained.
Catalog/history writes are batched once per tick, retaining each response's observation timestamp. Cricket endDate
hints are not treated as actual match ends; joins use format-bounded windows and retain ambiguous ties as unmatched. Failure leaves catalog/history
intact and does not label old cached data as newly observed. History keeps a 15-minute window plus the last-known
snapshot per game; catalog entries expire after eight days without a recent observation. New tables are
`sports_dashboard_catalog`, `sports_score_history`, `sports_user_preferences`. F1 is session-only; AFL goals/behinds
summary enrichment and richer optional situations are not promised by this first server slice. Guide-only fallback
cards, the Apple/web UI, real-feed matching/clock acceptance and adversarial review remain delivery work.
