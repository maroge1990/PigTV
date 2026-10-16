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
| `playbackTerminalStatus` | 0094 | `GET /api/playback/:id/terminal-status` → `taken-over` \| `none` | Asked once before its one recovery |
| `guideCursor` | 0111 | Cursor paging, `limit` ≤ 500 on `library/guide` | Pages 500 by cursor |
| `guideVersion` | 0111 | `GET /api/library/guide/version` (includes the build, so a deploy reloads once) | Skips a reload when unchanged |
| `logoCache` | 0112 | `logo` fields are `/api/logo/<key>`; `?size=full` / `?size=640` | Top Shelf asks `size=full` |
| `channelNumbers` | 0117 | Rows carry `number` (labels only, C-A) | Muted number after the name; iOS "Go to number" |
| `playbackHandles` | 0119 | `direct` resolves use `/api/proxy/stream?h=<handle>` (always, since 0196) | Not read; a 404 leads to a re-resolve |
| `channelHealth` | 0133 | Rows carry `health` `ok`/`flaky`/null (C-G) | Amber dot on flaky channels |
| `sportCategories` | 0146 | `library/categories` rows carry `sport` (C-H) | Not read any more (decoded) |
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
`'fmt?'` decode failure falls back once to `audioEncode: true` for that channel. The web never sends it.

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
- `recordings/scheduled` rows carry `rule_id` (null for a one-off). A schedule the viewer cancels is never made again by a
  rule, even when the guide moves its time. Two rules never record the same programme twice.

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
