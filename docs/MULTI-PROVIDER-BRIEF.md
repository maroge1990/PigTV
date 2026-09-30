# Multi-provider failover: development brief

**Status:** approved scope (Mark, 30 Sept 2026). Build started 30 Sept from server **0168** and Apple build **36**.
**Orchestration:** the lead Claude session delegates each work package (WP) to one sub-agent, reviews every diff against
`blueprint.md` §7 and this brief, and pushes. One agent per repo at a time. Agents **commit locally and never push**.
(GitHub Actions minutes are exhausted until about 1 Oct, so nothing is pushed until the lead says so.)

---

## 1. What we are building

PigTV today talks to one IPTV provider (Strong8K) with one connection. When that provider has an outage (30 Sept: HTTP 502
on every channel, from `pro.speed8k.top`), nothing plays. This feature adds **backup providers**:

- **An ordered list of providers**: the primary (Strong8K, through EPGenius, with its EPG) and backups 1..N (currently
  Trex and Dream4K). Every provider has its **own connection limit**.
- **Only the primary's channels, guide and categories are ever shown.** A backup is *list-only*: its channels are
  stored separately and **linked** to the primary's channels. Its EPG is never loaded.
- **Failover**: a play that fails on the primary for a provider reason goes to the next provider that has the channel.
- **More streams at once**: with 3 providers of 1 connection each there are 3 streams. A recording takes a free backup
  instead of prompting a viewer; a second device gets a free provider instead of the takeover 409. The prompt/409 only
  happens when every provider that carries the channel is full.
- **Licence tracking**: expiry and connection limit read from each provider's Xtream `player_api.php`, with manual dates
  as an override; a reminder 7 days before expiry (web banner, Apple TV popup).

### Decisions (Mark, 30 Sept)
| # | Decision |
|---|---|
| D1 | Failover is **cold standby**: a backup is only connected when needed. A 5-10 s rebuffer when a stream switches provider is accepted. No hot standby. |
| D2 | Guide, categories, channel list: the **primary's only**. |
| D3 | **Fail back on the next play only.** A stream playing on a backup stays there. |
| D4 | A recording takes a **free backup connection automatically** instead of prompting; that connection leaves the viewing pool until the recording ends. |
| D5 | For a **single failing channel**, the primary's own "(Backup)"/"[Backup]" feed of the same channel is tried first, then the next provider. When the **whole provider is down**, its own backup feeds are skipped. |
| D6 | Expiry and connection limit are **read from `player_api.php`**; manual purchase date + term, or a manual end date, override. |
| D7 | Reminder: **web banner** for admins (closable, back the next day until renewed) + **Apple TV popup** (once a day per device, short). |
| D8 | Bandwidth is not a concern (500 Mbps). |
| D9 | **Default playback path only.** The tuner (`PIGTV_TUNER=1`) stays off and unchanged; with the tuner on, providers behave as today (primary only, global limit). |
| D10 | Backups connect preferably as **raw Xtream** (complete list) with an optional **EPGenius M3U as an id overlay** (matched by stream id). A backup may also be a plain M3U source. |

### What the data showed (30 Sept assessment, fixtures in `test/fixtures/providers/`)
- All three providers are Xtream underneath: stream URLs are `/live/<user>/<pass>/<streamId>.ts`. `stableIds.js` already
  handles this form. An EPGenius M3U names its provider's server and login in an `#EXT-X-CREDENTIALS:[{…}]` header line.
- **EPGenius tvg-ids are shared across providers** (`foxsports505.au`, `skysport1.nz`, `skysportsf1.uk`), except that
  Strong8K adds an `.alt` infix (`FoxSports503.alt.au`) and a region prefix on some AU ids (`nsw-sydneyfoxsports505.au`).
- **Every EPGenius entry for Trex is also in Trex's raw Xtream list, with the same stream id** (8,682 of 8,682). But
  EPGenius's Trex list has **no AU, NZ or CA channels**; the raw list has them (ABC, SBS, 7, 9, 10, Kayo/Fox 501-507, NZ
  Sky Sport). Dream4K (EPGenius) has AU Fox/beIN/ESPN but **no AU free-to-air**.
- **Raw names match the wrong country** unless the region is respected: "ABC" → US ABC, "beIN Sports 1" → French beIN,
  "ESPN" → US ESPN, "Sky Sport Premier League" → German Sky. Region must come from the `XX|` name prefix, the group, or the
  tvg-id suffix (`.au`, `.nz`, `.uk`, `.us`, `.ca`).
- **Channel numbers identify AU Fox channels**: Strong8K "Fox Cricket 501" = Dream4K "Fox Sports 501" = Trex
  "AU| KAYO - FOX SPORTS 501 CRICKET" / "AU| FOX SPORTS 501 HD".
- **Event/PPV slots must never be linked** ("NBA 06 :", "ESPN+ 123", "AFL TV 01 | …", "- NO EVENT STREAMING -"): same
  name, different game per provider.
- **Quality must pair**: Strong8K lists "Sky Sports Main Event ᵁᴴᴰ ᴴᴰᴿ", a plain one and "(Backup)" under one tvg-id.
- Strong8K's `player_api.php` returned 502 all day on 30 Sept, so account info can be unavailable for long periods.

---

## 2. Design

### 2.1 Providers (a provider = one source)
`app_sources` rows (JSON in `data`) gain, all optional, defaults shown:
```
role: 'primary' | 'backup'        // existing sources migrate to 'primary'; EPG sources have no role
priority: <int>                   // failover order among backups, 1 = first; primary is always tried first
maxConnections: null | <int>      // manual override; null = from account info; unknown = 1
subscription: { purchasedAt: 'YYYY-MM-DD'|null, termMonths: <int>|null, endsAt: 'YYYY-MM-DD'|null }
idOverlayUrl: null | '<url>'      // backups only: an EPGenius M3U whose tvg-ids are copied onto the raw list by stream id
```
Exactly one enabled `primary` with streams is supported (a second primary is refused with a 400). EPG sources are unchanged.
Secrets rule (existing): passwords are write-only; nothing here returns a password, an `idOverlayUrl` or a stream URL to a
non-admin, and `idOverlayUrl` is admin-only (it is a capability URL that embeds a login).

### 2.2 Account info (`services/providerAccounts.js`, table `provider_accounts`)
- Xtream login per provider: an `xtream` source's own `url/username/password`; an `m3u` source's from the
  `#EXT-X-CREDENTIALS` header if present, else parsed from its first `/live/<u>/<p>/<id>` stream URL.
- `GET <server>/player_api.php?username&password` (10 s timeout, the configured user agent). Stored per source:
  `status, exp_date (ms), max_connections, active_cons, is_trial, checked_at, ok, error` (error text redacted, never a URL).
- Refreshed at startup (+30 s), every 6 h, after a sync, and by an admin "Check now". **A failed read keeps the last good
  values** and never marks a provider expired.
- **Effective expiry** = manual `endsAt` > `purchasedAt + termMonths` > account `exp_date` > unknown.
  **Effective limit** = `maxConnections` > account `max_connections` > 1.
- **Expired** (effective expiry in the past) → skipped for playback and recording, shown on Status.

### 2.3 Backup channel store (tables `backup_channels`, `channel_links`)
Backups **never write `playlist_items` or `categories`**, so the library, guide, numbers, sport, EPG matching, favourites and
health queries cannot see them. `syncService.syncSource` routes a `role: 'backup'` source to `syncBackup()`:
- xtream: `get_live_categories` + `get_live_streams` only (no VOD, series or XMLTV); m3u: the playlist's live entries.
- `backup_channels(source_id, stream_id, name, category_name, tvg_id, overlay_tvg_id, region, quality, is_event, url_data)`,
  replaced per sync in one transaction. `url_data` = what is needed to build the URL (for m3u, the URL; for xtream nothing:
  the URL is built from the login at resolve time and never stored).
- With `idOverlayUrl`: fetch that M3U, map stream id → tvg-id, set `overlay_tvg_id`. Overlay failure is logged, not fatal.
- Then the linker runs (2.4). ~55,000 raw rows is fine; nothing reads them on a request path except by key.

### 2.4 Linker (`services/channelLinks.js`)
Input: the primary's **visible** live channels (`channelNumbers.VISIBLE_SQL`, keyed like favourites: source +
`COALESCE(stable_id, item_id)`) and each backup's `backup_channels`. `channel_links(primary_source_id, primary_key,
backup_source_id, backup_stream_id, method, status, rank, score, updated_at)`.

Normalisation (pure functions, unit-tested on the fixtures):
- **tvg-id key**: lower case, strip `.alt` before the country suffix, strip a leading `<state>-<city>` prefix
  (`nsw-sydney`), keep the country suffix.
- **Region**: from a name/group prefix `XX|`/`XX:`/`XX |` (AU, NZ, UK, US, CA, …), a flag emoji in the group, else the
  tvg-id's country suffix; unknown if none.
- **Name key**: lower case, strip prefixes, bracketed text, superscript/small-caps tags (`ᴴᴰ ᵁᴴᴰ ᴿᴬᵂ ᴳᴬᴺᴶᴬ`), quality words
  (uhd fhd hd sd 4k 8k 1080p 720p hevc hdr 50fps 60fps raw), `kayo -`, city words for AU (sydney, melbourne, …),
  punctuation; digits kept.
- **Quality class**: `uhd` (UHD/4K/8K/2160/HDR), `hd`, `sd`, `unknown`. "(Backup)"/"[Backup]" is a *sibling* marker.
- **Event slot** (never linked, either side): group or name matches PPV/EVENT/PACKAGE/LEAGUE PASS/SUNDAY TICKET/ESPN+/
  FLO/STAN/DAZN/24/7/REPLAY/"No Event"/"No Game"/"NO EVENT STREAMING"/`^[A-Z0-9 ]+ \d{1,3} ?[:|]`/"NEXT |"/"ENDED |".

Matching, per primary channel and per backup provider:
1. **Exact id** (`overlay_tvg_id` or `tvg_id` key equals the primary's key, and regions agree or are unknown) → `status:
   'auto'`, used at once.
2. **Channel number** (a 3-digit number 500-599 in both names, same region, both "fox"/"kayo") → `pending`.
3. **Name key equal, same region** → `pending`. Different or unknown region → not linked.
4. Ties: same quality class first; then HD over SD; then the shorter name. Keep up to 3 ranked candidates (`rank` 1-3);
   failover uses rank 1 only (rank 2-3 are shown on the review page).
5. **Siblings** (D5): within the primary, a "(Backup)"/"[Backup]" channel with the same tvg-id key (or name key) as a
   visible channel is linked as `backup_source_id = primary`, `method: 'sibling'`, `auto`. Siblings may be hidden channels.
- Re-link after every backup or primary sync: `approved`, `rejected` and `manual` rows are **kept**; `auto`/`pending` are
  recomputed; a kept row whose backup stream disappeared becomes `broken` (shown on the review page, not used).
- **Only `auto`, `approved` and `manual` links are used for playback.**

### 2.5 Per-provider connection pools (`streamCoordinator.js`, default path)
- Every HLS session and every default-path recording carries `providerId` (a source id). `activeStreams()` exposes it.
- `requestForViewer / admitViewer / requestForRecording / announceUpcoming / pendingPrompt` count and release **within one
  provider** (the provider being asked for), using that provider's effective limit.
- A device can only watch one thing: when a viewer is admitted on provider B, **its own earlier stream on any provider**
  is released (silently, as today's `replacement`).
- 409 bodies keep their exact shapes (C-B/C-E); the message text changes to name the situation:
  "Every provider that carries this channel is in use…" when more than one provider was tried.
- The tuner functions (`requestForTuner`, `admitTuner`, `requestForRecordingTuned`, `announceUpcomingTuned`) are **not
  changed** (D9). `test/tuner-off.test.js` and every tuner test must still pass untouched.

### 2.6 Resolve with failover (`routes/playback.js`, new `services/providerRouting.js`)
`candidatesFor(sourceId, channelId)` → ordered list of `{ providerId, url, via }`:
1. the primary channel itself — unless the primary is **down** (breaker) or expired, or this channel is **quarantined** on it;
2. its sibling (D5) — only when the primary is not down;
3. each backup in `priority` order with a usable link, skipping expired/down providers and quarantined links.

For each candidate in order: **admission** without force on that provider (free, idle reclaim, own replacement). The first
candidate admitted is started. If no candidate can be admitted, the answer is the 409 for the **first** candidate (today's
behaviour); `force: true` then acts on that first candidate's provider only.

A started candidate that fails for a **provider reason** (`playbackErrors` categories *refused*, *no response*,
*unavailable*, HTTP 4xx/5xx, connection refused/timeout) → the failure is noted (breaker, quarantine) and the **next
candidate** is tried. Anything else (ffmpeg/GPU/argument errors) is returned as today, without failover.
- **Retries**: the 0143 refused-connection retries (2: 1.5 s + 3 s) apply only to the **last** candidate; earlier
  candidates get **one** retry after 1 s.
- **Deadline**: the whole resolve stays under **30 s** (the Apple client's request timeout is 35 s); a candidate is not
  started with less than 8 s left.
- **Breaker** (per provider, in memory): provider-reason failures on **≥ 2 distinct channels within 5 min** → `down`.
  While down, the provider is skipped. After a cooldown (3 min, doubling to a 15 min cap) it is **half-open**: the next play
  tries it first again once; success → `up` (cooldown resets), failure → `down` again. Logged once per state change.
- **Quarantine** (per provider + channel, 10 min): set when a resolve fails there for a provider reason, and when a session
  on it **ends unrequested** (ffmpeg exit with a provider-reason stderr, or the stall watchdog) after having produced a
  playlist. This is what makes the players' existing single re-resolve land on the next provider (mid-play failover).
- Resolve's JSON gains **`provider`** (contract C-J): `{ id, name, role: 'primary'|'backup', via: 'primary'|'sibling'|'backup',
  failover: true|false }`. Logs, the status page's recent plays and `channel_health` rows (new nullable column
  `provider_id`) carry the provider **name**, never a URL.

### 2.7 Recordings (`recordingEngine.js`, default path)
- **Choosing a provider at start**: the same candidate list. The first candidate with a **free** connection (nothing to
  release; idle reclaim allowed) is used. If none is free, today's prompt flow runs **on the first candidate** (the viewer
  is asked; 0158 timeout applies). A recording on a backup is simply a stream in that backup's pool (D4).
- **Start failover**: ffmpeg exiting within 20 s with a provider-reason error → next candidate, same recording row.
- **Mid-recording failover**: an unrequested exit before the stop time with a provider reason → the recording continues on
  the next candidate as a **new part**: a second `recordings` row for the same schedule (`part` 2, 3…), file
  `<title - date> (part N).mkv`, the earlier part kept and marked partial with the gap. Up to 3 parts per schedule.
- Schedules keep their primary identity; nothing about scheduling changes.

### 2.8 Reminders (contract C-K)
- `GET /api/providers/reminders` (any authenticated user or paired device): `[{ id, name, expiresAt (ms), daysLeft }]` for
  enabled providers whose effective expiry is **≤ 7 days** away (or past). Nothing else (no role, login or URL).
- Web: an admin-only banner at the top of the app, closable; closing hides it until the next local day.
- Apple: on launch/foreground, at most once per local day per device, a short popup ("Trex expires Tue 30 Mar. Renew it,
  then update the dates in PigTV's web settings."), auto-dismissing after 15 s or on any button.

### 2.9 Admin UI (web) and Status
- **Settings → Providers**: list with role, order (up/down), enabled, effective limit (manual override field), account info
  (status, expiry, connections, last check, error), subscription fields, `idOverlayUrl`, "Check now", "Sync now".
- **Settings → Backup links**: one row per visible primary channel (search, category filter, "unlinked", "pending",
  "broken"), a column per backup provider showing the link and its method; approve / reject; **bulk approve pending for a
  category**; manual pick from a search of that backup's channels.
- **Status page**: a Providers panel (role, state up/down/half-open, connections used/limit, expiry, account-check age) and
  the provider name on each live session and recent play.

---

## 3. Contracts (go into `docs/ROADMAP-CONTRACTS.md` with the WP that implements them)

**C-J. Provider on resolve.** Flag: `providers` in `/api/info` `features`. `POST /api/playback/resolve` success JSON gains
`provider: { id: Int, name: String, role: "primary"|"backup", via: "primary"|"sibling"|"backup", failover: Bool }`.
Additive: a client that ignores it is unaffected. 409 shapes unchanged.

**C-K. Licence reminders.** Flag: `providerReminders`. `GET /api/providers/reminders` → `200 [ { id, name, expiresAt, daysLeft } ]`
(empty array when nothing is due). Token required (device or user). Added to `APPLE_CLIENT_ROUTES` in `test/api-404.test.js`.

---

## 4. Work packages

Size: **S** ≤ ~300 changed lines, **M** ~300-800, **L** > 800 (tests included). Complexity: how much judgement and risk.
Model per Mark: **Opus 5.5** for high complexity, **Sonnet 5.5** for medium, **Haiku 4.5** for low.

| WP | Repo | What | Size | Complexity | Model | Depends on |
|---|---|---|---|---|---|---|
| **P1** | server | Provider fields + migration, source API validation, `providerAccounts.js` + table + refresh timer, effective expiry/limit, reminders endpoint (C-K) + flag | M | Medium | Sonnet | - |
| **P2** | server | Backup sync (`syncBackup`, `backup_channels`, overlay by stream id), backups skipped by EPG/numbers/library | M | Medium | Sonnet | P1 |
| **P3** | server | Linker (`channelLinks.js`, `channel_links`), normalisation, siblings, relink rules, admin link API | L | High | Opus | P2 |
| **P4** | server/web | Settings → Providers page + Backup links review page (uses P1-P3 APIs) | M-L | Medium | Sonnet | P3 |
| **P5** | server | Per-provider pools in the coordinator (default path), `providerId` on sessions/recordings | L | High | Opus | P1 |
| **P6** | server | Resolve failover, breaker, quarantine, C-J, health/events provider column | L | High | Opus | P3, P5 |
| **P7** | server | Recordings: provider choice, start failover, mid-recording parts | L | High | Opus | P6 |
| **P8** | server/web | Status page Providers panel + session provider names + admin reminder banner | S-M | Low | Haiku | P6 |
| **A1** | Swift | Build 36: reminder popup (C-K), provider in the info overlay (C-J), recovery allowance resets after 2 min of good playback | S-M | Medium | Sonnet | C-J/C-K text (this brief) |
| **DOC** | both | blueprint §1/§3/§6/§8/§9/§10, SWIFT-CLIENT-HANDOFF §5, TEST-BLOCK round 7 | S | Low | Lead | all |

Order (one server agent at a time): **P1 → P2 → P3 → P4 → P5 → P6 → P8 → P7**, with **A1** in parallel in the Swift repo.
P4 early lets Mark set providers up and review links while the playback work is built.

### Rules every agent follows (in addition to `blueprint.md` §2 and §7)
1. Start clean; **commit locally, never push**. One logical change per commit; a functional commit bumps `build` in
   `server/version.js` and its subject starts with the number (`0168: …`). Next number: read it from `server/version.js`.
2. Run with Node 24: `export PATH="/opt/homebrew/opt/node@24/bin:$PATH"; npm test && bash scripts/verify-build.sh .` Both
   must pass before each commit. Every behaviour change has a test that fails on the old code.
3. **Never log, store in a fixture, or return to a non-admin a URL with credentials, a password or an `idOverlayUrl`.**
   Use `redact()` on anything that may contain a URL.
4. With no backup configured, **everything behaves exactly as today** (a test proves it for your WP).
5. Don't touch the tuner path (D9). Don't reformat unrelated code. Match the surrounding comment style.
6. End with a short report: commits (hash + subject), tests run and their counts, anything left undone or uncertain.
7. Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (not your own model name).
