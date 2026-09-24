# Roadmap contracts: server ↔ Apple client (Phases 2–4)

Written by the lead on 24 Sept 2026 so the server and Swift work can proceed in parallel. **Both sides build exactly to
this.** Anything that needs to change comes back to the lead and is changed here first. Every item is additive and gated
by an `/api/info` `features` flag; an older server without the flag keeps today's client behaviour.

Mark waived the per-phase device gates (24 Sept): everything is built, then tested in one block. Risky behaviour is
therefore **off by default** behind a switch (server env var, or an Apple Settings "Labs" toggle) so he can turn it on
during testing.

---

## C-A. Channel numbers and the lineup (roadmap X2.1). Flag: `channelNumbers`

- Every visible live channel has a **number** (a positive integer, unique across the server). Numbers persist, keyed by
  the channel's identity (`source_id` + `stable_id`, else `item_id`). The first assignment follows the current guide
  order (1, 2, 3…); a channel that appears later gets the next free number; a channel that disappears keeps its number
  reserved for 30 days. The admin can renumber in the web app.
- `library/guide`, `library/channels`, `library/favourites`, `library/recent` rows gain `number` (int or null).
- Numbers are **labels only**: `library/guide` and `library/channels` keep the provider's order, which groups channels
  under their placeholder channels (Mark, 24 Sept; 0117 ordered by number, and 0139 reverted that).
- Admin API (web only): `GET /api/lineup` → `[{sourceId, id, stableId, name, number, category}]`;
  `PUT /api/lineup/numbers` body `{numbers: [{sourceId, id, number}]}` → `{success}`. Duplicate numbers → 400.
- Apple: show the number on the guide's channel tile and in the player's channel list; channel up/down follows
  guide order (the provider's order). No number entry on tvOS (the remote has no digits); iOS may offer "Go to number".

## C-B. Resolve errors the client may show (roadmap A1.3). No flag (text match)

The resolve error `error` string is shown to the user **only** if it starts with one of these prefixes (an allow-list; any
other text still maps to the existing generic message):
- `The provider refused this channel`
- `The provider did not respond`
- `This channel is not available`

The server only ever produces these for playback failures (0113 wording, extended as needed); they never contain a URL.

## C-C. HE-AAC passthrough (0116). Flag: none (a capability the client sends)

The client sends `capabilities.heaac = true` **only** when Settings → Labs → "HE-AAC passthrough" is on (default off).

## C-D. Opaque playback handle (roadmap S2.1 / P1-4). Flag: `playbackHandles`

- A `direct` resolve returns `url: "/api/proxy/stream?h=<handle>"` (the handle is 32 hex characters, an in-memory map to the
  real URL, 12 h TTL) instead of `?url=<provider URL>`. The path stays `/api/proxy/stream`, which the Apple allow-list
  already accepts. HLS sessions are unchanged (already opaque).
- No provider URL appears in any `/api/playback`, `/api/library` or `/api/transcode` response, or in any log line (logs use
  redact()). `/api/proxy/stream?url=` keeps working for the web's legacy callers until W2.1 removes them.

## C-E. Tuner model (roadmap Phase 3). Server env `PIGTV_TUNER=1` (default off). Flags: `timeshift`, `recordingHls`

With the env var off, nothing below changes and the flags are absent.

- **Live:** resolve returns the same shape. The playlist is served by the server, not written by ffmpeg, and adds
  `#EXT-X-PROGRAM-DATE-TIME` on segments. The window is up to **3 h** (env `PIGTV_TIMESHIFT_HOURS`, default 3), trimmed if
  free disk falls below a floor. The server supports **delta playlist updates** (`EXT-X-SERVER-CONTROL:CAN-SKIP-UNTIL`,
  answering `_HLS_skip=YES`), and playlists may be gzip-compressed, so a 3 h window stays cheap to poll. Two devices on
  the same channel share one tuner, invisibly to the client.
- `features.timeshift = true` means: the seekable range may be hours long, and `AVPlayerItem.currentDate()` is
  meaningful. The client offers **Start over** (seek to the current programme's start via `seek(to: Date)`) when that
  start is inside the seekable range, and the scrub bar and ±15 s seek use the whole window.
- **Recordings** with `features.recordingHls = true`: `GET /api/recordings/{id}/playback` may answer
  `{ "url": "/api/recordings/{id}/index.m3u8", "container": "hls", "durationSec": n, "inProgress": bool }`. An in-progress
  recording is an EVENT playlist (it grows). The client must play `container == "hls"` directly (no preparation polling),
  and may offer Play on a recording whose status is `recording`. An `mp4` answer (older recordings) keeps working as today.
  Token handling is as for other media URLs (`?token=` on the playlist; the server carries it onto every URI it references).

## C-F. Apple client Settings → "Labs" (Apple-only)

A Labs section in Settings with persistent toggles, all off by default:
- **New guide (UIKit)** (roadmap A2.1).
- **HE-AAC passthrough** (C-C).
- **Stream info overlay** (roadmap A4.2): when on, the player's info overlay shows codec, resolution, fps, bitrate and
  dropped frames.

## C-G. Channel health (roadmap S4.1). Flag: `channelHealth`

`library/guide` and `library/channels` rows gain optional `health`: `"ok" | "flaky" | null`. `flaky` means that in the
last 7 days the channel failed to start ≥2 times, or failed more than 30% of the time. The Apple guide shows a small
warning dot on flaky channels.
