# PigTV server → Apple client hand-off

**Written 20 September 2026 (server session, build 0083); kept current in §5 — last entry: build 0086.** Audience: whoever works on the Swift client next, and Mark.
The server-side source of truth is `blueprint.md` (this repo); the client's current state and roadmap are in `blueprint.md` in the client project (replacing its old handovers).
Everything below was checked against the client source in `PigTV-Swift-Client` (read-only) and the server code.

**The short version.** The server has moved on since the client was last aligned with it. Nothing the client does today
is broken by that — every route it calls still exists (a server test now guarantees it) — but there are **two things a
person will hit** (a second device taking over the stream; a stream that dies while paused) and **three server
improvements the client isn't using yet** (recording playback polling, EPG logo fallback, waiting recordings).

## 0. Before you start: which server, and what it advertises

Ask the server, don't guess. `GET /api/info` (no token) returns `build`, `display` (e.g. `"v3.7.0 · build 0083"`) and
`features`. New behaviour is announced with a flag; an older server simply lacks the flag, so **gate on the flag**:

| Flag in `features` | Means | Server patch | Present on servers with build ≥ |
|---|---|---|---|
| `viewerConflict` | `resolve` may answer 409 `viewer-in-progress` | 0055 (behaviour), flag 0083 | 0083 (behaviour since 0055) |
| `epgLogoFallback` | `logo` is filled from the EPG icon by the server | 0067 (behaviour), flag 0083 | 0083 (behaviour since 0067) |
| `clientEvents` | `POST /api/playback/client-event` accepts player diagnostics | 0065 (behaviour), flag 0083 | 0083 |
| `scheduledWaiting` | `recordings/scheduled` lists `waiting` rows and they can be cancelled | 0082 | 0083 |
| `recordingPlaybackPolling` | `recordings/:id/playback?async=1` may answer 202 | 0083 | 0083 |

Everything in this document is on `main` (server build 0086 as of 20 September 2026). **Check which build is actually
running before you start:** `GET /api/info` (no token) → `build`. **Develop against whatever is
deployed; the flags let each feature switch on by itself as the server catches up.** C1 and C2 below need no flag — the
server behaviour they handle already exists.

## 1. What to change in the client, in priority order

### C1 — Handle "another device is watching" (HIGH; behaviour live since server 0055)

**What happens today.** When a second device (the web app, another Apple TV) starts a stream while yours holds the
provider's only connection, the server answers `POST playback/resolve` with **409**:

```json
{ "error": "Provider stream is in use",
  "conflict": { "type": "viewer-in-progress", "streamId": "abc123", "lastActiveSec": 4,
                "message": "Another device is watching. Your provider allows one stream at a time, so watching here will stop it." },
  "resolution": "Repeat this request with \"force\": true to stop the other stream and watch." }
```

The client can't read it: `ServerErrorResponse.conflict` is a `RecordingConflict` whose `scheduleId`, `title`,
`channelName` and `endsAt` are non-optional, so decoding the whole body fails (`try?` → `nil`) and the user sees
"The server returned HTTP 409. Please try again." A recording conflict has the same envelope with
`type: "recording-in-progress"` plus `scheduleId/title/channelName/endsAt` (and a `message` the client ignores).

**Change.**
1. `Models.swift`: replace `RecordingConflict?` in `ServerErrorResponse` with a lenient type — every field optional
   except `type`: `message`, `scheduleId`, `title`, `channelName`, `endsAt`, `streamId`, `lastActiveSec`. Keep
   `RecordingConflict` for the recording path and build it from the lenient one when `type == "recording-in-progress"`
   and its fields are present.
2. `PigTVError`: add `case viewerConflict(message: String)`; `APIClient.send` throws it for a 409 whose
   `conflict.type == "viewer-in-progress"`.
3. `PlaybackModel`: publish it like `recordingConflict`, and show a confirmation using the server's `message`
   ("Stop the other stream and watch here?" / "Keep watching there"). Only a deliberate button press calls
   `start(force: true)` — keep the existing rule that a 409 is **never** retried with `force` automatically.
4. Not affected: changing channel on the same device. The server treats a device's *own* earlier stream as replaceable
   without asking, and `switchPlayback(to:)` already releases the previous stream first.

**Test fixture** (add to `Tools/test-contracts.sh`): the JSON above must decode to `viewerConflict` with the message.

### C2 — A stream that dies while you're watching or paused (HIGH; needs a device test)

**What the server does.** A live stream is an ffmpeg process plus a session; the server ends it when:

| After | Why | What AVPlayer then sees |
|---|---|---|
| **20 s** with no output | provider hiccup: the stall watchdog kills the stalled ffmpeg and removes the session | playlist/segment 404 |
| **60 s** with nobody fetching | the session is *stale*: a recording that is due, or another device that needs the slot, reclaims it silently | 404 |
| **5 min** with nobody fetching | live-session idle sweep removes it | 404 |
| another device confirms "stop the other stream" (C1) | forced takeover | 404 |

Segments are 4 s and the playlist keeps about **90 of them (≈ 6 minutes)**. AVPlayer normally stops fetching once its buffer is full while paused (**confirm on the device** - this is the
assumption the rest of this section rests on), and the server can't tell a pause from a dead client, so a pause of more
than a minute or so can end the session; resuming after 5+ minutes finds it gone.

**What the client does today.** `PlaybackModel` shows one message for any `item.status == .failed`:
"Playback could not start. Route: transcode…" — wrong wording for a stream that had been playing, and no recovery.

**Change.**
1. Track `hasPlayed` (set the first time the item reports `.readyToPlay` / `timeControlStatus == .playing`).
2. On failure **after** `hasPlayed`: show "Reconnecting…", `release` the old session, and **re-resolve once
   automatically**. If that resolve returns 409 `viewer-in-progress`, it means someone took over → show the C1
   prompt. If it fails again, show "The stream ended" with a **Retry** button (a person decides — no retry loop).
3. On resume after a long pause (say > 45 s) and when the app returns from the background: if the item has failed, take
   the same path; if it is alive but far behind, `goToLive()` already exists.
4. Keep failing-before-first-play as it is ("could not start"), including the route/error-code detail — that has been
   useful.

*Not built on the server, on purpose:* a heartbeat to keep a paused stream alive. The 60 s rule exists so that a closed
laptop can't block a recording. If pausing for a few minutes is a real use, say so and we'll add a session keep-alive
to the existing 5 s `playback/conflict` poll — but recovery (above) is needed either way.

### C3 — Recording playback: opt in to polling (MEDIUM; server 0083, flag `recordingPlaybackPolling`)

**Why.** `GET recordings/{id}/playback` used to hold the connection open while the server remuxed the recording into an
Apple-playable MP4. The client's request timeout is 35 s (`APIClient`), a long recording over SMB takes longer, so it
timed out and asked again. `RecordingPlayerModel.start()` also treats anything but 200 as an error.

**New server behaviour** — send `?async=1` (via `query: [URLQueryItem(name: "async", value: "1")]`; `requestURL`
rejects a `?` inside the path):

| Status | Body | Meaning |
|---|---|---|
| 200 | `{ "url": "/api/recordings/12/media.mp4", "container": "mp4", "durationSec": 3600 }` | ready — as before |
| **202** | `{ "status": "preparing", "retryAfterSec": 3 }` + `Retry-After: 3` | still remuxing — ask again after that many seconds |
| 500 | `{ "status": "failed", "reason": "remux-failed" \| "file-missing", "error": "The server could not prepare this recording for playback" }` | failed; reported **once** — asking again starts a fresh attempt |
| 409 / 404 / 401 | as before | unfinished / unknown / no token |

Without `?async=1` nothing changes. A server that ignores `async=1` (older build) just answers 200 after waiting.

**Change.** `client.request` treats every 2xx as a success and decodes it, so a 202 body would fail to decode as
`RecordingPlayback`. Add a variant that returns `(status, data)`, then in `RecordingPlayerModel.start()`:
send `?async=1` only when `info.features.recordingPlaybackPolling == true`; on 202 show "Preparing recording…" with a
Cancel button and poll every `retryAfterSec` (cap the whole wait, e.g. 10 minutes; stop on dismiss); on 500 decode
`reason` and say either "The recording file is missing from the server's storage" or "The server could not prepare
this recording". The first play of a long recording can take minutes; later plays are instant.

**Still needs a device:** an **HEVC** recording actually playing in AVPlayer (the server now tags it `hvc1`; only the tag
was verified). `durationSec` is the wall-clock recording length, not the media duration — keep using the recording
list's own duration for resume bounds, as the client does.

### C4 — Drop the client-side EPG icon download (MEDIUM; flag `epgLogoFallback`)

`BrowseModel.loadArtworkIndex()` downloads `proxy/epg/{sourceId}` — the whole EPG channel list — and matches names on
the device. The server now does it: `library/channels`, `library/favourites` and `library/guide` fill a missing `logo`
from the EPG channel with the same **tvg-id**, else the same **name** (case/spacing ignored). A logo the playlist
supplied is never replaced. When `features.epgLogoFallback` is true, skip `loadArtworkIndex()` and `APIClient.epgArtwork`
entirely; keep them for older servers. This also removes the server's most expensive endpoint from every launch
(the server review estimated `proxy/epg/{id}` at 50–100 MB of JSON per call). Notes: an icon URL can now point at the EPG provider rather than the PigTV
origin, possibly plain `http` — fine, the app's `NSAllowsArbitraryLoads` is on and `artworkRequest` only sends the
bearer to the PigTV origin. Name matching can pair two different channels that share a name; report any oddity.

### C5 — Show recordings that are waiting for a viewer (MEDIUM; server 0082, flag `scheduledWaiting`)

A recording that is due but held back because someone is watching has `status: "waiting"`. Before 0082 it vanished
from `GET recordings/scheduled` and couldn't be cancelled (`DELETE recordings/scheduled/{id}` returned it unchanged,
which the client rightly reports as a failed cancel). Now it is listed, cancellable (the response is the row with
`status: "cancelled"`), and the same programme can't be scheduled twice. The client "already understands `waiting`" —
check that the upcoming list labels it (e.g. "Waiting — someone is watching") and that the guide's red record dot
doesn't treat it as actively recording.

### C6 — Rate limits on sign-in and pairing (MEDIUM)

`POST auth/login`: **10 failed attempts per 15 minutes** per (device address, username) → `429`, header
`Retry-After: <seconds>`, body `{ "error": "Too many failed sign-in attempts. Try again later.", "retryAfterSec": 840 }`.
A correct password is also refused while locked. `devices/pair/start` 60 and `devices/pair/poll` 1 500 requests per 10
minutes (the client's 2 s poll is well inside). Today a 429 becomes "The server returned HTTP 429. Please try again."
Add `PigTVError.rateLimited(retryAfterSec:)` and say "Too many attempts — try again in N minutes." (Read `retryAfterSec`
from the body; the header carries the same number.)

### C7 — Report player failures to the server log (LOW, worthwhile; flag `clientEvents`)

The Apple TV's playback errors currently exist only on the TV screen. `POST /api/playback/client-event` (bearer or
`?token=`, device tokens are accepted) writes one line to the server's `docker logs` (container name: `docker ps`), next to the ffmpeg lines from the same
moment, so "it stopped on the Apple TV" becomes diagnosable. Fire-and-forget; must never affect playback; over the rate
limit it answers 204 and drops. **Never send a URL with a query string** — only the path.

```json
// on AVPlayerItem failure (map failureCodes(): "AVFoundationErrorDomain -11850")
{ "event": "media-error", "codeName": "AVFoundationErrorDomain", "code": -11850,
  "message": "Media codes: 404, 404", "strategy": "transcode",
  "path": "/api/transcode/abc123/stream.m3u8", "currentTime": 312.4, "bufferedEnd": 330.0 }

// once, when the first frame plays
{ "event": "play-start", "strategy": "transcode", "container": "hls", "videoMode": "copy",
  "hlsDelivery": true, "resolveMs": 5000, "totalMs": 5200 }

// when a play of 10 s or more ends
{ "event": "play-end", "strategy": "transcode", "container": "hls", "videoMode": "copy",
  "hlsDelivery": true, "watchedSec": 312, "stalls": 1 }
```

Fields are whitelisted and bounded (strings 20–200 chars, control characters stripped, numbers only if numeric).
`stalls` = count of `AVPlayerItem.playbackStalledNotification`. The log lines carry `from=device:<id>`, and
`scripts/playback-report.js` (this repo) turns saved logs into a table — so Apple plays can be compared with the web's.

### C8 — Show the server build (LOW)

`/api/info` already feeds `ServerInfo`; add optional `display` (and `build`) and show it beside the app's own version
in Settings. It is the fastest way to tell "is the server I'm testing the build I think it is?"

### C9 — Only if you see it: re-encode audio (LOW)

`POST playback/resolve` accepts `"audioEncode": true`, which re-encodes just the audio to AAC-LC stereo 48 kHz (video
still copied). The web player uses it to heal a channel whose audio frames Chrome's decoder rejected. If AVPlayer ever
fails with an audio-decode error on one channel, retry that channel once with it set. Don't add it speculatively.

## 2. What must not change (the frozen contract) and what already works

Unchanged and relied on — **do not change without a coordinated server patch**:
- `library/guide` rows: `id, sourceId, name, logo, category, tvgId, programmes[]` with `startTime`/`endTime` in **ms**.
- `recordings/{id}/markers`: camelCase `startMs`/`endMs`.
- `recordings/{id}/playback`: bearer header required; `{url, container:"mp4", durationSec}`; `media.mp4` takes
  `?token=`, supports byte ranges, `+faststart`.
- Favourites: the client writes `POST/DELETE favorites` with the **bare** id and lists via `library/favourites` (the
  bare id is canonical since 0059, and `favorites/check` normalises).
- `playbackURL` allow-list (`/api/proxy/stream`, `/api/remux`, `/api/transcode/…`, `/api/recordings/…`) and the token
  attached as `?token=`; bearer on `DELETE playback/{id}`; `capabilities.segmentedDelivery = true`.

Server changes that need **no** client change: unknown `/api/*` paths now return `404 {"error":"No such API endpoint",
"endpoint":"GET /api/x"}` instead of the web page (0079) — the client only checks status codes and none of its routes
are affected (`test/api-404.test.js` boots the server and asserts every route the client calls still resolves;
**when the client gains an endpoint, add it to `APPLE_CLIENT_ROUTES` there**); the removed OIDC/SSO routes and the
demo plugin (0076/0077); the failed-`db.json`-write handling (0080) — settings/source saves now answer 500 with a plain
sentence instead of pretending to succeed.

## 3. How to test client changes

- Contract fixtures: add the JSON above (viewer conflict, 429, 202 preparing, 500 failed, `info` with the new flags) to
  `Tools/test-contracts.sh`. They are exactly what the server emits.
- Against the real server, two-device tests need the web app open on another machine: start playback on the TV, then
  on the web ("Another device is watching" appears there), then the reverse to see C1; pause the TV for 6 minutes and
  resume to see C2; schedule a recording, keep watching past its start, and check it appears as `waiting` (C5).
- Server logs to watch while testing (find the container name with `docker ps`):
  `docker logs PigTV 2>&1 | grep -E "viewer|conflict|\[Player\]|\[HLS\]|resolve timing|from=device"`.
  `[HLS] 404 for seg0012.m4s in session …: <why>` means the server had no such file (the session was removed, or the segment
  had rotated out) - that is what a player reports as a failed segment load. Lines ending `from=device:<id>` are this client's.
- Feeds on Mark's provider that exercise server edge cases (stream ids as they appear in the server log): **1803789** serves
  a finite ~30-minute file from the start - before build 0086 a player got a segment 404 a few seconds in; its resolve log now
  ends `source ends (N min) - paced to real time`; it is a good test that the client survives it. **1239048** logs dozens of
  harmless `[mp4] Packet duration … out of range` warnings and plays normally - server-log noise, not a client fault.
- Only a device can settle these, and they are the ones worth recording the result of: whether AVPlayer stops fetching while
  paused (C2 rests on it); whether an HEVC recording plays (`recordings/{id}/playback` promises MP4/`hvc1` but has never been
  checked on an Apple TV); a channel switch on the same device (should never ask for confirmation).

## 4. If the client needs something from the server

Say what the screen needs, not the endpoint. Two ideas already on the list, neither built: a **session keep-alive**
riding on the existing 5 s conflict poll (so a short pause can't lose the stream — see C2), and **codec names on
`recordings/{id}/playback`** so an older Apple TV can say "this recording is HEVC" before AVPlayer fails on it.
Server changes are pushed straight to `main` as numbered builds (see `blueprint.md` §2; the old `format-patch` files are
retired); anything that changes an existing response shape is treated as client-coupled and flagged there.

## 5. Server changes since this document was written

**Standing rule: every server change that alters what the Apple client sees or receives adds an entry here, in the same
commit** (newest last; the first column is the build number). "Client action" says what, if anything, the Swift side must do.

| Build | What changed | Client action |
|---|---|---|
| 0084 | The server's playback report now tells Apple-device plays (`from=device:<id>`) apart from the web player's, so C7 events from the client never count towards the web's HLS trial. | None. Sending C7 events is still worthwhile. |
| 0085 | **Live streams the server passes through without re-encoding (H.264/HEVC copied into HLS segments) now have their video timestamps rebuilt from frame order** (`-fflags +igndts`). Some provider feeds carry repeated or backward DTS; before this, the segments had uneven frame timing (steps of 0 to 3 frames instead of one) — judder, and possibly stop/start. Reproduced and cured on a synthetic stream; **not yet confirmed on a real channel or on a device.** Every Apple live play with compatible codecs takes this path. Segment lengths, the playlist and every URL are unchanged. | **None to code. Please retest on the Apple TV:** the channels that looked juddery or stalled before (motion should be smooth), and one that was fine (must still be, with lip-sync intact). If a channel gets worse — audio drifting from picture, a frozen picture — note the channel and send the `docker logs` lines; the change is the single `+igndts` in `server/services/transcodeSession.js`, so it can be backed out on its own. |
| 0086 | **A live URL that turns out to be a finite file (some providers serve one from the start) is now read at real time.** Before, the server read such a file at full speed, the 90-segment playlist window slid half an hour ahead of the player within seconds, and the player's next segment request returned **404** — in the web player a black screen; AVPlayer would see the same 404 on a segment. Found on a real channel (provider URL ending `1803789.ts`). The log line for such a play now ends `source ends (N min) - paced to real time`. The `info` object in the `playback/resolve` response gains two additive fields, **`finite`** (bool) and **`durationSec`** (int or null) — ignore them or use them (e.g. to show a duration; a live channel has `finite: false`). Playlist and segment URLs are unchanged. | **None to code.** If you see the client fail with a 404 on a segment a few seconds into a play, it is a session that was removed (the server log now says why: `[HLS] 404 for …`); that is what C2's one automatic re-resolve is for. Retest the same channel on the Apple TV once the server has 0086. |
| 0088 | **Correction to 0085.** That patch had the server rebuild video timestamps on every stream-copy live play (`-fflags +igndts`). Measured against four captured channels, that was right for one kind of feed and wrong for the other: a feed whose own frame timing is already uneven needs the rebuild, and a feed with a correct clock is made *worse* by it (zero-length frames followed by double-length ones - the judder 0085 was trying to remove). The server now measures the source at probe time and decides per channel. The resolve log line ends `source timing even - DTS kept` / `uneven - DTS rebuilt` / `unknown - DTS kept`. No response shape changes; playlist and segment URLs are unchanged. | **None to code.** The 0085 row asked you to retest channels that looked juddery - please do that retest against **this** build instead, since 0085 alone is not what ships any more. Channels that were fine under 0085 and become juddery here are the interesting case: note the channel and send the `docker logs` line beginning `[Playback] resolve timing`, which now says which way that channel was classified. Rollback is `PIGTV_DTS_AUTO=0` on the container (restores 0085 behaviour without a rebuild). |
| 0094 | **`GET /api/playback/{sessionId}/terminal-status`** (bearer required; flag `playbackTerminalStatus`). Answers `{"status":"taken-over"}` only when that session was removed to admit another viewer **and** the caller owns it; every other case — someone else's session, an unknown id, an expired record, a session that merely stalled or expired — is `{"status":"none"}`. Records live ~15 min (`PIGTV_TERMINAL_STATUS_TTL_SEC`), in memory, and reading is non-consuming: asking twice gives the same answer. Nothing about the replacing client, its device, the channel or the new session is exposed; the body has one key. **Two deviations from the written spec, both agreed:** (1) a session released for being *idle* inside `admitViewer` **does** get the marker — a client paused past the 60 s idle timeout is precisely the one that would resume, fail, recover and take the connection back, which is the ping-pong being fixed; removals outside `admitViewer` (explicit DELETE, the idle sweep, the stall watchdog, a recording reclaiming a stale stream) still leave nothing. (2) the web app's `soft` admission paths (`/api/remux`, `POST /api/transcode/session`) record markers too, so a web play cannot silently displace an Apple TV. | **Implement C2 as specified:** on a failure *after* first play, call this once before the existing release/re-resolve. `taken-over` → stop, show "Playback moved to another device", do not recover. `none`, 404, or the flag absent → keep the current one-time C2 recovery. Never `force: true` automatically. |
| 0097 | **Favourites now follow the channel, not its position in the playlist.** The provider reorders its M3U, which shifts every `pos_N` after the insertion - a favourite was observed playing a different channel. Favourites are matched on a channel identity derived from the provider stream id in the URL (0096), so they stay put. Two client-visible consequences, both improvements: a channel listed in more than one category (845 of this provider's 18 000) is now **one** favourite - starring it anywhere stars it everywhere and it appears once in `library/favourites` - and `favorites/check` answers for the channel rather than the listing. `library/channels`, `library/favourites` and `library/guide` rows gain an additive **`stableId`** (string or null). | **None to code.** The write API is unchanged: keep sending the bare id. Ignore `stableId` or use it as a stable local key for caching - it is the one id that survives a provider reorder, which `id` does not. If the app caches channel ids across launches, prefer it. |
| 0098 | The same identity now backs **scheduled recordings** and **watch history**. A recording scheduled before a provider reorder resolves to the channel it was scheduled for rather than whatever moved into that position, and `library/recent` lists a channel once even when it is cross-listed. | **None.** No request or response shape changes. If the app shows "recently watched", entries will simply stop occasionally naming the wrong channel. |
| 0099 | **The decorative small-caps "ᴸɪᴠᴇ" / "ɴᴇᴡ" badge is now stripped at ingest** (SR-2 / client R15). Programme titles, sub-titles and channel names no longer carry the trailing modifier-letter badge in any server response (`library/guide`, `library/channels`, `library/favourites`, recordings) — it is removed once when the EPG and M3U are parsed (**so only data synced after the deploy is clean** — a redeploy skips a source synced in the last 24 h; confirmed clean after a manual Sync now, 23 Sept), using the exact same code-point ranges as the client's `String.strippingBadgeSuffix()`. No request or response shape changes; only the string values are cleaner. | **None to code now; the client stripper is now redundant.** Once this build is deployed and confirmed, `String.strippingBadgeSuffix()` in `DVRModels.swift` (titles and channel names) can be removed — it will be stripping an already-clean string. Safe to leave in place indefinitely (double-stripping is a no-op), so remove it whenever convenient, not urgently. |
| 0100 | **HDR channels are now handed out through a master playlist that carries `VIDEO-RANGE`** (SR-1 / client R13). A capture of Sky Sports Main Event UHD (`pos_31`) showed the source is **HDR10 (PQ, `smpte2084`) + BT.2020, HEVC Main 10** — not HLG as SR-1 assumed — and that the copied fMP4 init segment already keeps its `colr`/`nclx` box. What was missing is the range: the server only ever returned a media playlist, which has no `VIDEO-RANGE`, and AVPlayer treats such a stream as SDR. Now, when the resolve probe finds a PQ or HLG transfer **and** the video is copied into fMP4, `playbackURL` is `/api/transcode/{id}/master.m3u8` (one variant: `BANDWIDTH`, `RESOLUTION`, `FRAME-RATE`, `VIDEO-RANGE=PQ|HLG`, → `stream.m3u8`; **no `CODECS`** on purpose, since a wrong one makes AVPlayer refuse the variant). The variant URI carries `?token=` like segments do. SDR channels, and any HDR channel that is re-encoded, still get `stream.m3u8`, byte-for-byte as before. `info.videoRange` (`"PQ"`/`"HLG"`/`null`) is added to the resolve `info` (additive). Log: the `resolve timing` line ends `, HDR PQ - master playlist`. | **Required in the custom player** (the classic AVKit player, which switches automatically, is deprecated). The URL is still under `/api/transcode/` (inside the `playbackURL` allow-list) and AVPlayer follows the master playlist itself, but a bare `AVPlayerLayer` never asks tvOS for a display mode: load `item.asset.load(.preferredDisplayCriteria)` (built from `VIDEO-RANGE`/`FRAME-RATE`; SDR/nil on an SDR channel) and set `window.avDisplayManager.preferredDisplayCriteria` on every item change; set it to `nil` when playback ends so the guide returns to SDR. Recordings use `AVPlayerViewController` and need nothing. **Test** (Match Content → Match Dynamic Range on): Sky Sports Main Event → panel HDR; an SDR channel → SDR; back to the guide → SDR. |
| 0103 | **The piped `/api/remux` route and the legacy `GET /api/transcode?url=` pipe are gone** (§C Phases 3–4, with 0102 moving the webapp onto resolve + HLS). Every client now gets HLS segments: `/api/playback/resolve` returns `strategy` `"direct"` or `"transcode"` only, **whether or not** `segmentedDelivery` is sent (still accepted; nothing changes for a client that sends it, as this one does). `/api/info` `playback.strategies` is now `["direct","transcode"]` (was also `"remux"`). `DELETE /api/playback/{id}` no longer special-cases `remux_` ids. `/api/remux` answers the standard JSON 404. | **None required.** The Apple client never received a remux URL (it always sent `segmentedDelivery`). Optional tidy-up: drop `/api/remux` from the `playbackURL` allow-list (`APIClient.swift`) and `"remux"` from the strategy lists in `PlaybackModel.swift` (they map an unknown strategy to `"unknown"` already, so leaving them is harmless). |
| 0104 | Session hardening, no shape change. **A resolve `url` (or session/probe/subtitle URL) that is not a network URL is refused with 400** `{error:"Only network stream URLs … can be played"}` — the client resolves by `sourceId`/`channelId`, so it never sends one. A session whose ffmpeg dies without being asked to stop is marked failed instead of staying "running" (it no longer counts as someone watching until the idle sweep). A live copy session that fails in its first 10 s is **no longer restarted with its folder cleared** (that only helps a GPU-decoding encode), so a client that already has the playlist sees ordinary 404s it can recover from rather than a playlist that vanishes and reappears. `/api/proxy/stream` (the `direct` strategy's URL) streams segments instead of buffering them. | None. |
| 0106 | **Correction to 0097: `stableId` is now actually present on `library/guide` and `library/favourites` rows**, not just `library/channels`. 0097 said all three carried it; `favourites`' SQL never selected `stable_id` (so it decorated as `null`) and `guide` built its channel objects without the field at all. Both now carry it. | **None to code.** Same field, same meaning as 0097 - nothing to change, this just makes the other two endpoints honest. |
| 0108 | **JSON (and the server's own HTML/CSS/JS) responses may now come back gzip-encoded** (`Content-Encoding: gzip`) when the request sends `Accept-Encoding: gzip`. HLS playlists, segments, recording media and any response to a request carrying a `Range` header are explicitly never compressed - those stay byte-identical, uncompressed, exactly as before. No response shape changes; only the wire encoding of JSON bodies. | **None.** `URLSession` decodes `Content-Encoding: gzip` transparently; nothing to change in the client. |
| 0110 | **Bug fix: `GET /api/favorites` now resolves a channel favourite to its CURRENT playlist position(s) instead of the position it was stored at.** After a provider reorder, the stored `pos_N` could name a different channel entirely (Mark's live test: the Apple TV showed "Fox Footy 504", the web app - which reads `/library/favourites` and already joined on `stable_id` - showed "Fox Footy 502"; `/api/favorites` was the one still returning the stale position). A favourite with an identity (`stable_id`) now returns one entry per CURRENT listing sharing that identity (a channel cross-listed in two categories shows a star in both, same as `/library/favourites`). A favourite with no identity is unaffected. No shape change - still the bare or composite `item_id` depending on `?format=`. | **None to code.** If the app reads `/api/favorites` directly rather than `/library/favourites`, this simply makes the ids it gets back match what the guide/library endpoints show. |
| 0111 | **Guide API for scale (roadmap S1.3), all additive.** `/api/info` `features` gains `guideCursor: true` and `guideVersion: true`. `GET /api/library/guide` now accepts `limit` up to **500** (was 100; default is still 25) and an optional opaque `&cursor=` string for keyset paging - cheaper than `offset` on a large table, and immune to a row shifting between pages while paging. The response gains **`nextCursor`** (a string to pass as the next `cursor`, or `null` on the last page); `total`, `offset` and plain `offset`-paging all keep working exactly as before for a client that ignores the new field. New: **`GET /api/library/guide/version`** → `{"version":"<opaque string>"}`, which changes whenever a playlist/EPG sync completes or a channel/category is hidden or shown (and only then - not with the clock or the requested window), so a client holding a cached guide can ask "did anything change?" instead of re-fetching or diffing it. | **Optional, worth adopting for a large lineup.** Prefer `cursor`+`nextCursor` over `offset` for guide paging once built against a server advertising `guideCursor`. Poll `/library/guide/version` (or check it before a scheduled refresh) and skip the re-fetch when it matches the last one seen; treat it as opaque (do not parse it). Nothing breaks if the client keeps using `offset` and never calls `/guide/version`. |
| 0112 | **Logo cache (roadmap S1.4), additive.** `/api/info` `features` gains `logoCache: true`. `library/channels`, `library/favourites`, `library/guide` and `library/recent` now return `logo` as a relative path, `/api/logo/<key>`, instead of the provider's own URL. New route **`GET /api/logo/:key`** (unauthenticated - an `<img>`/image loader cannot send a bearer header, and the key has to already be one of our own known logo URLs, so it is not an open proxy): fetches the logo once, downscales it to at most 320 px wide if the server has ffmpeg, and serves it from disk after that with `Cache-Control: public, max-age=604800` and an `ETag` (a matching `If-None-Match` gets 304). An unknown key is a plain 404. `/api/proxy/image` is unchanged - the web app also sends it movie/series poster URLs, not just logos, so it was left as a general (if now redundant for channel logos) image proxy rather than being restricted. | **Required, low risk:** the client already resolves a relative `logo` path against the server host (per the frozen contract), so this should need no code change - just point the image loader at whatever `logo` says, as before. Worth doing regardless: it is materially faster and more reliable than the provider URLs. |
| 0113 | **A channel that fails to start now fails fast and says why.** When ffmpeg cannot open the provider's stream, `POST /api/playback/resolve` answers as soon as ffmpeg has exited (typically under 2 s) instead of after its 15 s timeout, and the error body - still `{error, info}`, still HTTP 500 - carries a short sentence instead of "Transcode failed to produce a playlist in time". The texts: **HTTP 4xx (other than 404):** "The provider refused this channel (HTTP 403). It may be offline, or still releasing the previous stream; try again in a few seconds." (the status is the number ffmpeg reports, or `4xx` when it only says "4XX"); **404:** "The provider could not find this channel (HTTP 404). It may be offline or have moved; a playlist sync may help."; **5xx:** "The provider had a problem serving this channel (HTTP 5xx). Try again in a few seconds."; **connection refused:** "The provider's server refused the connection. It may be down; try again shortly." Anything else keeps the old text. Never a URL or ffmpeg output. Also: when the provider refuses ffmpeg with a 4xx (not 404) or 5xx within its first ~3 s - the provider allows one connection and may not yet have released the resolve probe's - the server waits 1.5 s and tries once more before failing, so such a resolve can take ~2 s longer and then succeed. | **None required.** Optional: show `error` from a failed resolve to the viewer (it is written to be shown). The client's one automatic re-resolve (C2) still applies. |
| 0114 | **Channel profiles (roadmap S1.1): a repeat play of a channel skips the server's ffprobe.** Once a channel has played, the probe's analysis (codecs, frame rate, timing class, HDR range) is kept for up to 7 days per channel URL + client capability set, so the next resolve of that channel starts ffmpeg straight away instead of first probing for 3.3-4.7 s: a repeat channel change should be about that much quicker to first picture (measure with `play-start … first-picture=`), and it opens one fewer provider connection. If a start from a stored profile fails, the profile is dropped and the next attempt probes afresh. ffmpeg's own probe is unchanged. No request or response shape changes: `info` in the resolve response is the same object, just possibly from the stored analysis. Log: `resolve timing: HLS session, probe profile (age Nd), …`. Rollback: `PIGTV_PROBE_PROFILES=0` on the container. | **None to code.** Worth a timing check on the TV: change to a channel watched earlier today (more than 5 minutes ago), and compare the first-picture time with a channel not watched for a week. A channel whose sound or HDR changes after the provider changes its feed should come right after one failed start. |
| 0115 | **Every HLS session with a usable frame rate is now handed out through `master.m3u8`** (roadmap S1.2), not just HDR copy sessions. `playbackURL` is `/api/transcode/{id}/master.m3u8` whenever the probe gives a frame rate (`avg_frame_rate`, else `r_frame_rate`; 0/0 and values outside 1-240 ignored): one variant, `BANDWIDTH`, `RESOLUTION` (only when the video is copied), `FRAME-RATE` (e.g. `25.000`), `VIDEO-RANGE` = `SDR` for every non-HDR session and every encode, `PQ`/`HLG` for HDR copy sessions exactly as in 0100; still **no `CODECS`**; the variant is `stream.m3u8?token=…`. A session with no usable rate, and an HDR feed copied into MPEG-TS, still get `stream.m3u8`. Why: Match Frame Rate can only switch the TV to 50 Hz for 25/50 fps content when a master playlist declares `FRAME-RATE` - until now every SDR channel (most of this provider's, at 25 fps) played on a 60 Hz mode. The URL stays under `/api/transcode/` (inside the `playbackURL` allow-list). Log: `resolve timing … , master playlist (SDR, 25.000 fps)`. | **None to code:** the custom player already loads `preferredDisplayCriteria` from the asset and sets it on every item change (0100), and it now gets a frame rate for SDR channels too. **Device check:** Settings → Video and Audio → Match Content → **Match Frame Rate ON**; play a 25 fps channel (e.g. 7 Mate Melbourne) → the TV's info should report 50 Hz (a 1-2 s HDMI mode switch is expected and accepted); back to the guide → the TV's default mode. An HDR channel must still switch to HDR. |
| 0116 | **New optional capability `heaac` (default `false`) in the resolve request's `capabilities`.** A client that sends `"heaac": true` gets HE-AAC audio **copied** instead of re-encoded to AAC-LC: for an H.264/HEVC + HE-AAC channel (e.g. 7 Mate Melbourne 441367, 7 Flix Sydney 441372) that is the codecs-fine path, fMP4 segments with `-c:a copy -bsf:a aac_adtstoasc` (today such channels go out as MPEG-TS with the audio re-encoded). Measured on the pos_1164/pos_1165 captures (ffmpeg 9.0 locally; production runs 6.x): no warnings, the output decodes cleanly, and the A/V offset is exactly the source's (the re-encode shifts audio ~21 ms). **What the player will see:** the fMP4 init segment signals the audio as **AAC-LC 24 kHz with implicit SBR** (AudioSpecificConfig `13 10`, i.e. `mp4a.40.2`), not explicit HE-AAC - the ADTS source carries no more than that. ffmpeg's decoder finds the SBR and plays it at 48 kHz; Chrome does not (which is why the web never sends `heaac`). Without the capability nothing changes. | **Do not send `heaac: true` yet.** Only in a future build, after a device check: send `heaac: true` from the Apple TV build, then play 441367 and 441372 for a few minutes each. Pass = correct sound with full treble (a decoder that ignored the implicit SBR would play a dull, band-limited 24 kHz core, at the right speed), and lip-sync as good as before. Also play a normal AAC-LC channel and an E-AC-3 one to confirm nothing else changed. |
| 0117 | **Channel numbers (roadmap X2.1, contract C-A), additive.** `/api/info` `features` gains `channelNumbers: true`. `library/guide`, `library/channels`, `library/favourites` and `library/recent` rows gain **`number`** (a positive integer unique across the server, or `null`). A number is keyed on the channel's identity (`stableId`, else `id`), so a provider reorder does not change it; a cross-listed channel has one number in every category it appears in. The first assignment follows the guide order (1, 2, 3...), a new channel gets the next number after the highest held, and a channel that disappears (or is hidden) keeps its number reserved for 30 days. With the flag, **`library/guide` and `library/channels` are ordered by `number`** (nulls last, then the old order); a cross-listed channel's rows are now adjacent. The guide's `cursor` now encodes the number, and a cursor issued by an older build (or with the flag off) is refused with **400 `Invalid cursor`**: restart paging from the first page on a 400. Numbers change only when a sync completes, a channel is hidden or shown, or the admin renumbers in the web (`GET /api/lineup`, `PUT /api/lineup/numbers`, admin only, web only); each bumps `library/guide/version`. Rollback: `PIGTV_CHANNEL_NUMBERS=0` (flag absent, old order; `number` still returned). | **Planned (C-A):** show `number` on the guide's channel tile and in the player's channel list; channel up/down follows the guide order (now number order). No number entry on tvOS. On a 400 for a `cursor`, re-page from the start. |
