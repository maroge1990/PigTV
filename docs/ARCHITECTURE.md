# PigTV architecture

How the server, the web app and the Apple client fit together, and what to know before touching each area. Areas with
more than about a hundred lines of detail have their own page:

| Area | Page |
|---|---|
| Playback: HLS sessions, the media toolchain, the web player, diagnosing playback, in-stream recovery | [`architecture/playback.md`](architecture/playback.md) |
| Recordings: states, segmented recordings, rules, artwork, ownership and cleanup | [`architecture/recording.md`](architecture/recording.md) |
| The shared ingest: one provider connection per stream | [`architecture/ingest.md`](architecture/ingest.md) |
| Sport: recognition, ESPN fixtures, the Live now dashboard | [`architecture/sports.md`](architecture/sports.md) |
| The API the Apple client relies on | [`CLIENT-CONTRACT.md`](CLIENT-CONTRACT.md) |
| The Apple client's own structure | [`PigTV-Swift/docs/ARCHITECTURE.md`](https://github.com/maroge1990/PigTV-Swift/blob/main/docs/ARCHITECTURE.md) |

Decisions behind the shape are numbered in [`DECISIONS.md`](DECISIONS.md); what the product does is in
[`PRODUCT.md`](PRODUCT.md).

## Components

- **Server** (Node 24, Express 5, SQLite via `better-sqlite3`, ffmpeg): M3U/Xtream + XMLTV sources, a primary provider and
  ordered backups with failover, the guide and library APIs, one playback path (resolve → HLS session), recordings (DVR
  with Comskip ad detection), channel numbers, channel health, EPG matching, sport events, a logo cache, device pairing.
- **Web app** (`public/`, no build step): Home, Live TV, Guide, Recordings, Status (admin) and Settings (Providers,
  Channels, Playback, Recording, Sports, System). It talks to the same API as the Apple client.
- **Apple client** (tvOS first, iPad, iPhone; [PigTV-Swift](https://github.com/maroge1990/PigTV-Swift)): SwiftUI with a
  UIKit guide grid, AVFoundation playback and a Top Shelf extension. Everything it may rely on is in
  [`CLIENT-CONTRACT.md`](CLIENT-CONTRACT.md); `/api/info` flags gate each contract.

How they talk: clients sign in (web login or paired device, bearer tokens), read the library and guide
(`/api/library/*`, paged, with `library_rev`), and play by asking the server to resolve a channel; media is served only
through the server (opaque handles, never a provider URL). The server alone talks to providers, ESPN and the recordings
share.

## Storage and background jobs

- **SQLite** (`data/`): sources, settings and users (since 0135), the playlist and guide (`playlist_items`, `epg_programs`
  behind the `epg_live` view), identities, favourites, numbers, channel health, channel profiles, recordings and rules,
  sport follows and fixtures, feed lag, the cleanup journal. The data folder is the bind mount
  (`/app/data`); back it up before a risky deploy ([`OPERATIONS.md`](OPERATIONS.md)).
- **Transcode tmpfs** (2 GB, `/app/transcode-cache`): live HLS sessions. **Recordings**: the share mounted at
  `/app/recordings`, plus `data/recordings-work/` for segmented recordings in progress.
- **Background jobs**: source sync (playlist and guide, on a timer and on "Sync now"), provider account checks (startup,
  every 6 h, after a sync), recording scheduler and rules (every 15 min and after each EPG sync), recordings folder health
  (startup and every 15 min), sport events rebuild (worker thread, every 5-minute bucket and after sync/follow changes),
  ESPN fixtures (every 30 min and after a sync), nightly database backup, the idle and stall sweeps of live sessions.

## The playback path

**Every client, every live channel: `POST /api/playback/resolve` → an HLS session** (0102–0103). The server probes
the channel once (ffprobe, cached 5 min in memory per URL + caps; since 0114 also kept in SQLite as a **channel profile** for 7 days, so a
repeat play skips ffprobe - see below), then returns either `direct` (a source that is already browser-ready,
through `/api/proxy/stream?h=<opaque handle>` since 0119, never the provider URL) or `transcode`: an HLS session that **copies** whatever the client can decode and re-encodes only what
it cannot. There is no remux, no legacy pipe and no browser-side strategy any more; `/api/remux` answers the JSON 404.

The full detail, and the lessons from each fault, are in [`architecture/playback.md`](architecture/playback.md).

## Ownership, admission and accounting

**Provider slot** (`streamCoordinator.js`)
- The provider allows **one stream** (`maxProviderStreams`, 1; a recording holds its own slot). To admit a viewer, streams are freed
  in this order: anything idle ≥60 s (`viewerIdleTimeoutSec`), silently → the caller's own earlier stream, silently → another
  owner's live stream, only after a **409** `{conflict:{type:"viewer-in-progress",…}}` that `force:true` overrides (same shape as
  `recording-in-progress`). Owners are `device:<id>` or `user:<id>`. A device watches one thing: its new play ends its earlier
  session on that provider even when a connection is free or the play joins the ingest that session reads (FR-11, 0286); a
  `user:` owner (a browser login, maybe in several tabs) keeps it while there is room. (The `soft` mode for the movie/series page's
  `POST /api/transcode/session` went with that route in 0122.)
- Idle sweep: live sessions after **5 min** (`PIGTV_LIVE_IDLE_TIMEOUT_SEC`), seekable ones after 30 min. That's deliberately not
  ~2 min: the 60 s rule already reclaims on demand.
- **Takeover vs failure** (0094): a displaced client sees only a 404. `admitViewer` leaves an owner-only record (~15 min, in memory),
  read with `GET /api/playback/:id/terminal-status` → `taken-over` | `none`. **Only `admitViewer` writes one**; a DELETE, the idle
  sweep, the stall watchdog and a recording reclaiming a stale stream write nothing, so ordinary recovery keeps working.

Since the shared ingest, the coordinator counts **one connection per ingest**: see
[`architecture/ingest.md`](architecture/ingest.md) › Admission. Starts that wait re-check ownership:

- Starts that await (ingest, settings, feeds, failover) re-check ownership after each await and release late feeds
  (0231, 0232, 0244); cancel, delete (0252) and shutdown all retire an immediate failover's owner. A forced takeover stops
  every reader of a shared connection (0233).

The connection rule (one provider connection carries exactly one stream; a recording's connection is not used for anything
else, except watching what is being recorded) is decision D-28 in [`DECISIONS.md`](DECISIONS.md).

## Channel identity

**Channel identity** (0096–0098). `item_id` is `pos_N`, the M3U line, and **the provider moves it**. `stable_id`
(`stableIds.js`) is the provider stream id from the URL (`s441360`), otherwise a hash of the credential-stripped URL. Favourites,
scheduled recordings and history key on it; 845 channels are listed twice, sharing one identity. **The trap:** a row that *has*
an identity must never fall back to its stored `pos_N`. Joins use
`(x.stable_id IS NOT NULL AND p.stable_id = x.stable_id) OR (x.stable_id IS NULL AND p.item_id = x.item_id)` plus a `GROUP BY` on
the identity. Only *pending* schedules were backfilled. The provider's stream id and URL live in the row's `data` JSON, not
`stream_url`.

**Hidden channels** (0347, #10). Every reader filters on `playlist_items.is_hidden`, which sits on the row and so on the
position. `hiddenChannels.js` keeps the truth in `hidden_channels` (source, group, identity; a second copy of a channel in
the same group is told apart by its order), refreshed by every hide/show route (`capture`) and re-applied to wherever the
channels sit after each playlist sync (`after`, about 0.1 s on production's 19,000 rows). A source synced for the first time
on 0347 is captured before its rows move. A group added by the provider after a source's first sync arrives hidden and is
listed in `new_channel_groups` (`GET /api/channels/new-groups`, `POST …/new-groups/dismiss`; showing the group also takes it
off), unless one of its channels was shown before (a renamed group).

## Channel numbers

**Channel numbers** (0117, `channelNumbers.js`, contract C-A). Table `channel_numbers`, keyed on the favourites' identity
(`source_id` + `COALESCE(stable_id, item_id)`), `number` unique server-wide. Assigned after a playlist sync, after every
hide/show, and lazily by the first `/api/library` request when the table is empty; a channel no longer visible keeps its
number 30 days. **Numbers are labels only (0139, Mark's test 1.4):** `/library/guide` and `/channels` keep the provider's
order, which groups channels under the provider's placeholder channels; dead code for number ordering was removed in 0164.
Admin: `GET /api/lineup`, `PUT /api/lineup/numbers` (a reserved number yields to the admin; a visible holder is a 400).
The `channelNumbers` flag is always sent (its off switch went in 0204).

## Guide and EPG

**Guide and library.**
- Query **`epg_live`**, never `epg_programs`. A sync loads generation active+1, flips it in one statement, then deletes the old
  one in slices; a failed feed leaves the guide untouched.
- **A shrunken answer is held** (0348, #42): a playlist with fewer than 70% of the last good sync's lines (kept in `meta`
  `playlist_lines:<id>`; the whole M3U is parsed before any row is written), or a guide with under half the programmes or
  reaching under half as far ahead, is not applied. The sync row says `held` with the counts (Status, Providers); the next
  sync at the usual size applies, or **Accept the smaller list…** (`POST /api/sources/:id/sync {acceptSmaller: true}`).
- Queries bound `start_time > from − 24 h`.
- `/api/library/*` fill a missing logo from the EPG (by tvg-id, then by name).
- **Ingest-time changes only show after a sync:** a redeploy skips any source synced in the last 24 h (`syncIfStale`), so use
  Settings → Sources → the source's refresh button (⟳, "Refresh Data"), which these docs call **Sync now**.
- Favourites store the bare channel id (`channelIds.js`); `GET /api/favorites` re-presents the composite form (the web no
  longer reads it since 0121).
- Channel numbers are edited in Settings → Channel numbers (0123), which saves only changed rows and shows the server's error.

**EPG categories** (0147): `epg_programs.categories` = the programme's XMLTV `<category>` values as a JSON array (trimmed,
de-duplicated, ≤12; NULL if none), filled by `syncEpgFromUrl` (EPG sources and Xtream `xmltv.php` alike). An older database
gains the column and its `epg_live` view is **dropped and recreated** (a view keeps its column list). Only data synced since
0147 has categories: **Sync now** after deploying. `GET /api/sports/categories` (admin, top 200, cached per EPG generation) =
the Status page's "EPG categories" panel (loaded once per visit, not on the 5 s refresh).

**EPG matching** (0134, `epgMapping.js`, table `epg_mappings`, Settings → EPG matching): an admin's tvg-id per identity,
applied **at query time** over `playlist_items.tvg_id` (guide programmes, now/next, logo fallback), because every sync
rewrites that column. `GET /api/epg/unmatched` = visible channels with no programmes in the next 24 h + 5 name-scored
candidates that do have programmes. **R10 (0222):** a candidate whose id's country suffix (`.au`, `.uk`, …) matches the
channel's country (name prefix, else its own id, else its category) scores +0.15, another country −0.15. **Auto-map**
(`GET/POST /api/epg/auto-map`, `DELETE /api/epg/auto-map/:batch`) maps every unmapped channel whose best candidate is
≥ 0.90 and 0.05 ahead of the next, as one undoable batch (`epg_mappings.batch`); a hand mapping is never touched, and one
changed by hand later leaves the batch.

**Event-slot names** (R9, 0221, `eventChannels.js`, pure): a slot whose guide shows nothing real at the time (only
placeholders, or no guide id) gets a guide row from its **name**, in the four forms the providers use (`NEXT | TITLE | Sun 04
Oct 01:50 EDT (US) | …`, `TITLE @ Sep 30 7:30 PM :Sportsnet+ 12`, `CA (TSN+ 019) | TITLE (2026-10-01 21:00:00)`,
`… start:… stop:…`). A named zone is used as given; an unnamed one is North American Eastern (America/Toronto, DST worked
out per date). 3 h unless the name gives an end. Names with a time but no date are left alone. Sport lists them like any
event.

## Logo cache

**Logo cache** (0112, fixed 0141): `/api/logo/<key>`, key = hash of the cache version + URL. Downscaled through `format=rgba`
to an RGBA PNG only when wider than 320 px (a palette PNG with transparency otherwise came out opaque: ABC, 7mate, 7two);
SVG, small and unconvertible logos are kept as fetched. Bumping `LOGO_CACHE_VERSION` (`logoCache.js`) changes every path and
drops the stored files once (`meta.logo_cache_version`) - needed because the Apple client caches artwork on disk by URL forever.
**Sizes (0154, Top Shelf):** the fetched original is kept beside the resized copy (`data/logos/<key>.orig`; `logo_cache.original_type`,
`original_bytes`); `?size=full` serves it, `?size=640` a ≤640 px copy made once from it (`<key>.640`, same rgba conversion), no size
the ≤320 px copy as before, any other size 400. Same allow-list, max-age and version drop; each size has its own ETag. A logo stored
before 0154 is fetched again on its first `size=full`/`640` request.

Logo downloads have one deadline to the last byte (0249).

## Status page and channel health

**Status page** (0124): the admin page "Status" = `GET /api/status` (admin): live sessions with channel names, active
and next 5 recordings, the last 50 plays (first-picture time, cold/warm/profile, failure text; in memory, `playbackEvents.js`),
sync per source, free disk (transcode tmpfs, recordings), build. Never a URL: fields are whitelisted and the document is
scrubbed. Look here before `docker logs`. Since 0288 it opens on providers, what is playing and recording, the last 7 days
(problems only when there are some) and a "Needs attention" box (a failed sync, recordings stuck in appdata); everything else
(recent plays, stream internals, interruptions, feed lag, server load, fixtures, sync, catch-up, backups, disk, EPG
categories) is behind "Show details", remembered per browser (`pigtv.statusDetails`). Since 0133 it also lists the **least reliable channels** (7 days; since 0142 also
channels that only stall, ranked by failed starts + stalls per hour watched, hours floored at 30 min; stalls and minutes shown).

**Channel health** (0133, C-G, `channelHealth.js`, table `channel_health`): one row per start attempt per identity, kept 30 days
(pruned daily). A failed resolve is a failed start (a 409 is not an attempt); a client `media-error`/`start-timeout` before
that owner's `play-start` turns its last resolve into a failed start (`player`); `play-start` gives the first-picture time.
Client events carry no session id, so the mapping is owner → last resolve (as 0124). Since 0142 `play-end` stores
`watched_sec`/`stalls` on that attempt (once, within 24 h). `health` on guide/channels rows: flaky = ≥2 failed starts or >30% of
≥3 in 7 days, or ≥3 stalls per hour over ≥20 min watched. `library_rev` moves only when a channel's class changes.

**Limits**
- Stalls per hour depend on clients sending `play-end`; a play whose end is never reported adds nothing, so stalls are
  under-counted rather than over-counted.
- The Status page's last 50 plays and the terminal-status records are in memory: a restart empties them.

## Auth, limits and routes

- Stateless bearer tokens (web login + paired devices); no sessions or cookies. Media routes (`/api/proxy`, `/api/transcode`, recordings' media) always need a token (0196; `requireStreamAuth` is gone).
  Stream URLs carry `?token=`.
- Limits: JSON body 2 MB; failed logins 10 per 15 min per (socket, username); pairing 60 starts / 1 500 polls per 10 min.
- HLS file names are allow-listed (`seg\d{4,}.(ts|m4s)`, `init.mp4`). fMP4 segments are served as `video/MP2T` on purpose
  (revisit with a device).
- Unknown `/api/*` → `404 {"error":"No such API endpoint"}`. **A new Apple-client endpoint goes into `APPLE_CLIENT_ROUTES` in
  `test/api-404.test.js`.**
- Sources, settings and users live in SQLite since 0135 (`app_sources`, `app_users`, `app_settings`, `meta.next_id`; objects
  kept as JSON). The first start on 0135 migrates `data/db.json` once and renames it **`db.json.migrated`** (the backup; a
  `db.json` that reappears later is ignored and logged). **Rolling back past 0135:** rename `db.json.migrated` to `db.json`
  (anything changed since is not in it). `settings.get()` returns one deep-frozen object, rebuilt only after a write: copy
  it before adding to it. A failed write is one rolled-back transaction and a plain "could not save its data" error.
- Auth is `jsonwebtoken` + `bcryptjs` directly (0136; passport removed): `requireAuth` (bearer, 401 "Unauthorized"),
  `optionalAuth`, `streamAuth` (bearer or `?token=`), role always from the user store, revoked devices refused.
- Express 5 (0137): wildcards are `/{*splat}`; `req.body` is forced to `{}` when absent; query parser `extended`;
  `res.sendFile` needs `dotfiles: 'allow'` for anything under a dot-folder.

## Providers, backups and failover

**Providers, backup links and failover** (0168–0181, 0198; `providerAccounts.js`, `channelLinks.js`, `providerRouting.js`,
`streamCoordinator.js`; the original design and its decisions D1–D9 are in `docs/archive/MULTI-PROVIDER-BRIEF-2026-09-30.md`)
- A provider is a source with `role` `primary` (exactly one with streams) or `backup` (ordered by `priority`), shown as
  cards in Settings → Providers. Account info (`player_api.php`: expiry, connection limit) is read at startup, every 6 h,
  after a sync and on "Check now"; **a failed read keeps the last good values** and never makes a provider look expired.
  Effective limit = the card's override, else the account's `max_connections`, else 1. Providers that are the same account
  (same origin + login, `accountKey.js`) share one pool at the lowest limit (0181).
- **Backups never write `playlist_items` or `categories`**, so the library, guide, numbers, sport and favourites can't see
  them. They sync into `backup_channels` (plus `provider_raw_channels`, 0178), and the linker maps each listed primary
  channel to up to 3 ranked backup streams in `channel_links`: raw-name/raw-epg, exact tvg-id, the Fox 50x number,
  same-region name, and the primary's own "(Backup)" **siblings**; quality pairs with quality and event/PPV slots are never
  linked. A relink keeps `approved`/`rejected`/`manual` rows. **Only `auto`, `approved` and `manual` links are used.** The
  linker reads `LISTED_SQL` (it must see linked siblings); the guide reads `VISIBLE_SQL`, which hides them (0204/0205).
- **Resolve** walks candidates: the primary (unless down, expired or this channel is quarantined there), its sibling, then
  each backup in order. Admission is per provider (free, idle reclaim, own replacement); with none admitted the 409 is the
  first candidate's. A start that fails for a provider reason goes to the next candidate; anything else is returned. The
  0143 refusal retries (1.5 s + 3 s) apply only to the last candidate, earlier ones get one after 1 s; the whole resolve
  stays under 30 s and no candidate starts with less than 8 s left. **Breaker:** provider-reason failures on ≥2 channels in
  5 min → down; half-open after 3 min (doubling to 15). **Quarantine:** 10 min per provider + channel, also set when a
  session ends unrequested, so a player's single re-resolve lands elsewhere. Connections are **leased before the probe**
  (0198), so two starts can't double-book one.
- **Recordings** take the first candidate with a free connection (else the prompt flow on the first), fail over at start,
  and continue as part N+1 on a mid-recording death or a 30 s stall (at most 3 parts).

- A sibling-link decision that changes what is listed bumps the guide version (0250).
