# Roadmap contracts: server ↔ Apple client (Phases 2–4)

Written by the lead on 24 Sept 2026 so the server and Swift work can proceed in parallel. **Both sides build exactly to
this.** Anything that needs to change comes back to the lead and is changed here first. Every item is additive and gated
by an `/api/info` `features` flag; an older server without the flag keeps today's client behaviour.

Mark waived the per-phase device gates (24 Sept): everything is built, then tested in one block. Risky behaviour is
therefore **off by default** behind a switch (server env var, or an Apple Settings "Labs" toggle) so he can turn it on
during testing.

**Status (26 Sept): every contract is implemented on both sides.** Verification is tracked in `blueprint.md` §6 and
`docs/TEST-BLOCK.md`.

| Contract | Server builds | Apple builds | Status |
|---|---|---|---|
| C-A Channel numbers (labels only) | 0117, 0123 (web editor), 0139 (labels only), 0140 | 19, 29 (never over artwork) | Implemented; verified (1.4, 1.20, R3.10) |
| C-B Resolve errors the client may show | 0113, 0118 | 19 | Implemented; verified (1.14) |
| C-C HE-AAC passthrough | 0116 | 19 (Labs), 27 (always on) | Implemented; verified (2.9, R2.9) |
| C-D Opaque playback handle | 0119 | none needed | Implemented |
| C-E Tuner model | 0126–0132 (`PIGTV_TUNER=1`) | 21 (Start over, HLS recordings) | Implemented; **not yet tested live** (TEST-BLOCK Part 3 deferred) |
| C-F Labs | none | 19; 27 (only Stream info left) | Implemented; verified (2.1–2.10) |
| C-G Channel health | 0133, 0142 (stalls) | 19 | Implemented; verified (1.7, R2.6) |
| C-H Sport categories | 0146 | 28 (row), removed in 30 | Implemented; its Home row superseded by C-I; now one sport signal |
| C-I Sport events | 0147–0153 | 30, 31 (Replays), 32 (72 h) | Implemented; verified through 0151/app 31 (R3.x, R4.1–R4.3); 0152, 0153 and app 32 awaiting a check |
| C-K Licence reminders | 0168 | A1 (build 36) | Server implemented; Apple pending |

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
- Apple: show the number as small muted text after the channel's name (guide, player overlay and channel list, detail pages;
  since app build 29 never drawn over a logo, and not in the Top Shelf title); channel up/down follows guide order (the
  provider's order). No number entry on tvOS (the remote has no digits); iOS offers "Go to number".

## C-B. Resolve errors the client may show (roadmap A1.3). No flag (text match)

The resolve error `error` string is shown to the user **only** if it starts with one of these prefixes (an allow-list; any
other text still maps to the existing generic message):
- `The provider refused this channel`
- `The provider did not respond`
- `This channel is not available`

The server only ever produces these for playback failures (0113 wording, extended as needed); they never contain a URL.

## C-C. HE-AAC passthrough (0116). Flag: none (a capability the client sends)

The client sends `capabilities.heaac = true` **only** when Settings → Labs → "HE-AAC passthrough" is on (default off).
**Superseded (app build 27, Mark's decision after test 2.9):** the Apple client always sends `heaac: true`; the Labs switch is
gone, and a `'fmt?'` decode failure falls back once to `audioEncode: true` for that channel.

## C-D. Opaque playback handle (roadmap S2.1 / P1-4). Flag: `playbackHandles`

- A `direct` resolve returns `url: "/api/proxy/stream?h=<handle>"` (the handle is 32 hex characters, an in-memory map to the
  real URL, 12 h TTL) instead of `?url=<provider URL>`. The path stays `/api/proxy/stream`, which the Apple allow-list
  already accepts. HLS sessions are unchanged (already opaque).
- No provider URL appears in any `/api/playback`, `/api/library` or `/api/transcode` response, or in any log line (logs use
  redact()). `/api/proxy/stream?url=` is still accepted, but since W2.1 (0121/0122) nothing hands it out except the
  `PIGTV_PLAYBACK_HANDLES=0` rollback.

## C-E. Tuner model (roadmap Phase 3). Server env `PIGTV_TUNER=1` (default off). Flags: `timeshift`, `recordingHls`

With the env var off, nothing below changes and the flags are absent. `PIGTV_TIMESHIFT_DIR` (0132) moves the timeshift
segments off the recordings share (recommended: `/app/data/timeshift`).

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
- **New guide (UIKit)** (roadmap A2.1). *Removed in app build 27: the UIKit guide is the only guide (Mark).*
- **HE-AAC passthrough** (C-C). *Removed in app build 27: always on.*
- **Stream info overlay** (roadmap A4.2): when on, the player's info overlay shows codec, resolution, fps, bitrate and
  dropped frames. *The only Labs switch left.*

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
- Web: Settings → **Manage Content**: a Sport button at the end of each category's row.
- Apple: with the flag, "Sport on now" = guide channels whose category is marked sport, showing what's on now, live
  programmes first. Without the flag, or with none marked, the row is hidden.

## C-I. Sport events (25 Sept, replaces the C-H Home row). Flag: `sportsEvents`

Implemented: server 0147 (categories), 0148 (events), 0149/0151 (web), 0150 (kinds), 0152 (live or replay), 0153 (72 h);
Apple builds 30 (Sport tab, Home row), 31 (Replays), 32 (72 h in day sections). The heuristics' known misfires are listed in
`blueprint.md` §10.

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
- `GET /api/sports/events?hours=N` (default 6, max **72** since 0153 (was 24): a whole weekend; auth as /library) →
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
  - **Live or replay (0152).** An `"event"` that names a game (a match-up, or a session of a known league) becomes a `"replay"`
    when, in this order: (a) the guide's XMLTV flags say so: `<previously-shown/>` → replay; `<live/>`, `<new/>`, `<premiere/>`
    or a "Live" category → live (flags are stored per programme at ingest, `epg_programs.flags`); (b) the **first airing wins**:
    of airings of the same game (league + teams, or league + session + grand prix) within 36 h, the earliest is live and one
    starting more than 30 min after it is a replay, except one 20 h or more later inside its league's live hours (the next game
    of a series); the server reads the 36 h before now for this; (c) a title marked "Live" → live; (d) the league's **live
    hours** in its home time zone (`sportsClassify.LIVE_HOURS`: MLB, NBA, WNBA, NHL, MLS 11:00–23:30 and NFL 09:00–23:30
    New York; EPL, Championship, UEFA 11:00–22:00 London; AFL, AFLW, NRL, NRLW, A-League, BBL 11:00–21:30 Melbourne; F1 and
    other travelling series none): a start outside them → replay. The admin preview's `kindRule` names the deciding rule
    (`"replay: outside MLB hours (07:00 America/New_York)"`, `"replay: aired first 11 h 55 min earlier (MLB Network)"`,
    `"replay: previously shown, says the guide"`). No shape change.
- **Admin:** `GET /api/sports/follow` → `{ keywords: [string] }`; `PUT /api/sports/follow` `{ keywords }` (admin; trims and
  de-duplicates; max 100). `GET /api/sports/preview` (admin) → the recognised events of the next 72 h (0153; 24 h before), each with the rule that matched, to tune
  the list; since 0150 every kind, each also with `kindRule` (why it is that kind, e.g. `"placeholder: ends in a bare \":\""`). Web: Settings → **Sports** panel with the follow list and the preview.
- `GET /api/sports/categories` (admin) → EPG categories seen with programme counts (also shown on the Status page).
- **Apple:** a **Sport** tab (Home · TV Guide · Sport · Recordings · Settings), asking `hours=72`:
  - "On now" events first, then "Starting soon" (60 min), "Later today", "Tomorrow", one section per later weekday, then
    "Replays" (`kind == "replay"`, grey REPLAY badge), with filter chips per league over the whole window.
  - Event card: title, league, time and progress, a LIVE badge, "3 channels".
  - Select plays the best channel; a secondary action (long-press or a "Channels" button) picks another.
  - Home: a "Sport now & next" row (live events, then those within 60 min; never replays), linking to the tab. It replaces
    the C-H row.
  - Upcoming events open an event page: Watch when it starts (while the app stays open), Record, the channel list.
  - Refresh every 60 s while visible.

## C-J. Provider on resolve (30 Sept, multi-provider failover). Flag: `providers`

Implemented: server 0174. A channel can come from the primary provider, the primary's own "(Backup)" feed of it (a
sibling), or a backup provider; a play that fails on one for a provider reason goes to the next (brief §2.6).
- `POST /api/playback/resolve` success JSON for a channel play (`sourceId` + `channelId`) gains
  `provider: { id: Int, name: String, role: "primary"|"backup", via: "primary"|"sibling"|"backup", failover: Bool }`.
  - `role`: the provider's role; a sibling is on the primary (`role: "primary"`, `via: "sibling"`).
  - `failover`: true when an earlier provider was tried and failed, or the primary was skipped (down, expired, or this
    channel failed there in the last 10 min). Being full is not a failover: another device on the primary sends the play
    to a free backup with `failover: false`.
  - A bare `url` resolve and the tuner path (`PIGTV_TUNER=1`, primary only) have no `provider`.
- Additive: a client that ignores it is unaffected. 409 shapes unchanged; when more than one provider carries the channel
  and all are full, the 409 is for the first one (`force: true` acts on that provider) and its `conflict.message` starts
  "Every provider that carries this channel is in use."
- A stream that dies mid-play for a provider reason is quarantined on that provider, so the player's existing single
  re-resolve (C2) lands on the next provider (a 5-10 s rebuffer, D1). The resolve stays under 30 s in all.
- **Apple (A1):** show `provider.name` in the info overlay; nothing else depends on it.

## C-K. Licence reminders (30 Sept, multi-provider failover). Flag: `providerReminders`

Each provider's subscription end comes from its Xtream `player_api.php` (`exp_date`), overridden by dates Mark types in
(an end date, or a purchase date plus a term in months). The server tells clients which are due, so the Apple TV can warn.
- `GET /api/providers/reminders` → `200 [ { id, name, expiresAt, daysLeft } ]`, soonest first; `[]` when nothing is due.
  Token required: any signed-in user or paired device.
  - Lists **enabled** providers whose effective expiry is **7 days or less** away, or already past. Backups are included.
  - `expiresAt`: milliseconds since 1970. `daysLeft`: whole days, rounded up; 0 or negative once it has ended.
  - Nothing else is returned: no role, login or URL.
  - A provider whose expiry is unknown (its account could not be read and no dates are set) is never listed. A failed
    account check keeps the last good values and never makes a provider look expired.
- **Apple:** on launch and when returning to the foreground, at most once per local day per device, a short popup naming
  the provider and date ("Trex expires Tue 30 Mar. Renew it, then update the dates in PigTV's web settings."), closing
  after 15 s or on any button. Without the flag, or with an empty list, nothing is shown.
- Added to `APPLE_CLIENT_ROUTES` in `test/api-404.test.js`.
