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
last 7 days the channel failed to start ≥2 times, or failed more than 30% of the time, or (0142) stalled ≥3 times per
hour watched over at least 20 minutes watched. Stalls and watched time come from the client's `play-end` (`stalls`,
`watchedSec`), matched to the owner's last resolve like the other client events. The Apple guide shows a small
warning dot on flaky channels.

## C-H. Sport categories for the Home screen (25 Sept). Flag: `sportCategories`

Mark picks which categories count as sport (web admin). The Apple Home screen's "Sport on now" row shows only channels
from those categories.
- `library/categories` rows gain `sport: bool`.
- Admin: `PUT /api/library/categories/sport` body `{ sourceId, categoryId, sport: bool }` → `{ success }` (admin only;
  bumps `library_rev`). Stored per category (source_id + category_id); survives syncs.
- Web: Settings → Sources' category list (or a small "Home screen" panel) gets a Sport toggle per category.
- Apple: with the flag, "Sport on now" = guide channels whose category is marked sport, showing what's on now, live
  programmes first. Without the flag, or with none marked, the row is hidden.

## C-I. Sport events (25 Sept, replaces the C-H Home row). Flag: `sportsEvents`

Sport is recognised per **programme**, not per channel: about 100 channels carry NFL only some of the time.
- **Server:** EPG programme categories are stored at ingest (XMLTV `<category>`). A programme is **sport** when any of these hold:
  (a) one of its EPG categories matches the sport vocabulary (Sport(s), Football, American Football, Soccer, Basketball, Baseball,
  Ice Hockey, Cricket, Rugby League/Union, Tennis, Golf, Motor Sport/Racing, Boxing, MMA, Cycling, Athletics, and similar,
  case-insensitive); (b) its title or categories contain a **followed keyword** (admin list, e.g. "NFL", "AFL", "F1", "Chiefs");
  (c) it's on a channel whose category is marked sport (C-H) **and** its title reads like a live event ("Live", "vs", "v ").
  Common non-events are excluded unless a followed keyword matches: News, Highlights, Preview, Replay, Classic, Magazine.
  (Since 0150 they are classified by `kind` below instead of dropped.)
- **Events:** sport programmes airing at overlapping times with the same **normalised title** (lower-case; "live"/"(live)",
  channel tags, HD/UHD/4K markers and punctuation removed; whitespace collapsed) are **one event** with several channels.
- `GET /api/sports/events?hours=N` (default 6, max 24; auth as /library) →
  `{ now, events: [ { id, title, league, start, end, live, channels: [ { sourceId, id, stableId, name, number, logo, quality } ] } ] }`.
  - `league`: the followed keyword that matched, else the most specific EPG category, else "Sport". (Since 0150 a keyword's
    league is the canonical league the title names: "Formula 1" titles show "F1", "Women's AFL" titles "AFLW".)
  - `live`: on now (start ≤ now < end).
  - `quality`: "UHD" | "HD" | "SD" | null, from the channel name (4K/UHD, HD/FHD).
  - Channels are ordered best first: quality, then `health` ok, then favourite, then guide order.
  - Events are ordered live first (by start), then upcoming (by start).
  - **Additive (0150, 25 Sept, Mark's export):** each item also carries
    - `kind`: `"event"` | `"replay"` | `"show"` | `"placeholder"`. **`kind` (default "event" when absent)**: a client treats an
      item without it (an older server) as an event.
    - `aliases`: `[string]`, the raw guide titles merged into this item. `title` is now the cleanest form ("Carlton Blues v
      Richmond Tigers", "Azerbaijan GP · Practice 3"), no longer the first raw title.
  - **Replays included by default.** `GET /api/sports/events` returns `kind` `"event"` **and** `"replay"` items (a replay = an
    identifiable game or session re-aired: "NFL Game Re-Airs - 2026: Packers vs. Jets", "AFL: Grand Final 2025"). Order: live
    events, then upcoming events, then replays (on-now replays first, then by start). `?include=all` also returns `"show"`
    (magazines, highlights, pre/post shows) and `"placeholder"` (empty PPV slots, stale listings, 24/7 replay loops) items, after
    those. An older client that ignores `kind` shows replays mixed in; the Apple client puts `kind == "replay"` in its own
    "Replays" section.
  - **Classification:** placeholder > highlights (show) > replay of a game > show words > a replay channel with no game named
    (placeholder) > event (a match-up "A v/vs/at/@/x B", or a session: practice, qualifying, sprint, race, finals). Programmes
    are one item when they are the same kind, the same **canonical league** and overlap in time and name the same game (the same
    teams in either order, by name, short name or abbreviation; or the same session and grand prix). League aliases: F1 = Formula
    1 = Formula One = FIA F1 (shown "F1"); AFL and AFLW are separate leagues. A followed keyword that names a league follows that
    league in all its spellings.
- **Admin:** `GET /api/sports/follow` → `{ keywords: [string] }`; `PUT /api/sports/follow` `{ keywords }` (admin; trims and
  de-duplicates; max 100). `GET /api/sports/preview` (admin) → today's recognised events, each with the rule that matched, to tune
  the list; since 0150 every kind, each also with `kindRule` (why it is that kind, e.g. `"placeholder: ends in a bare \":\""`). Web: Settings → **Sports** panel with the follow list and the preview.
- `GET /api/sports/categories` (admin) → EPG categories seen with programme counts (also shown on the Status page).
- **Apple:** a **Sport** tab (Home · TV Guide · Sport · Recordings · Settings):
  - "On now" events first, then "Starting soon", with filter chips per league.
  - Event card: title, league, time and progress, a LIVE badge, "3 channels".
  - Select plays the best channel; a secondary action (long-press or a "Channels" button) picks another.
  - Home: a "Sport now & next" row (live events, then those within 60 min), linking to the tab. It replaces the C-H row.
  - Refresh every 60 s while visible.
