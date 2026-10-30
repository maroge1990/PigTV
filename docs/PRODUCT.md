# PigTV: the product

What PigTV does, feature by feature, where each feature is (web, tvOS, iOS/iPadOS) and its status. How it works is in
[`ARCHITECTURE.md`](ARCHITECTURE.md); open work is in the [issues](https://github.com/maroge1990/PigTV/issues) and
[`../ROADMAP.md`](../ROADMAP.md).

## Principles

**Core requirements.** An IPTV server with a web app (this repo) and Swift clients (Apple TV first, then iPad and iPhone).
**Picture quality and stream stability come first**, then less overhead and complexity. **Stability and quality outrank
channel-change speed** (Mark, 20 Sept; reaffirmed 23 Sept: "quality of image should be the priority").

PigTV is for one household on a private network (reached over Tailscale only, decision D-23) with providers that allow
one stream at a time. Scale: about **1,000 channels** in the categories Mark selects in the web app (the Apple TV honours
the selection); the provider's whole playlist is about 18,000.

## What PigTV does

Status: **shipped** (in production), **gated** (built, behind a switch that is off by default), **planned** (an issue
exists, not built).

| Feature | What it does | Web | tvOS | iOS / iPadOS | Status |
|---|---|---|---|---|---|
| Live TV | One playback path: the server probes a channel and starts an HLS session that copies what the client can decode and re-encodes only what it cannot; HDR and frame rate declared so an Apple TV switches mode | ✓ | ✓ | ✓ | shipped |
| Guide | XMLTV guide in the provider's channel order, with channel numbers as labels, logos, channel health and EPG matching | ✓ | ✓ (UIKit grid) | ✓ (grid on iPad, On now list on iPhone) | shipped |
| Home | Continue watching, favourites on now, starting soon, sport now and next | ✓ | ✓ (opens first) | ✓ | shipped |
| Providers and failover | A primary provider with ordered backups, cross-provider channel links, failover at start | admin | — | — | shipped |
| Shared provider connection | One connection per stream, shared by viewers, recordings, the probe, relay legs and standbys | — | — | — | shipped (on by default) |
| In-stream recovery and hot standby | A relay that splices a new leg or a ready standby into a play when the feed stops | — | ✓ | ✓ | gated (Settings → Playback) |
| Relay timeline renewal | A fresh leg after a shared-connection reconnect | — | — | — | gated, off in production (D-25) |
| Recordings | Scheduled from the guide, made on the server, ad-break detection (Comskip), playback with break skipping | ✓ | ✓ | ✓ | shipped |
| Segmented recordings | Watch a recording from the start while it records; survives restarts and failover | — | ✓ | ✓ | gated (Settings → Recording) |
| Recording rules | Sport follow and series rules, de-duplicated | ✓ | ✓ | ✓ | shipped |
| Sport events (C-I) | Sport recognised per programme across every channel, with a follow list, replays and a 72-hour horizon, checked against ESPN's free fixtures | ✓ | ✓ | ✓ | shipped |
| Live now dashboard (C-O) | Live and upcoming games with scores, spoiler and delay settings | ✓ | ✓ | ✓ | gated (`sportsDashboard`) |
| Sport pages | A page per sport (see Sport below) | later | first | then | F1: server data built (0340, C-P); Apple page next (#21) |
| Status page | What is playing and recording, providers, the last 7 days, "Needs attention", details on demand | admin | — | — | shipped |
| Top Shelf | Favourites as rendered cards with play links | — | ✓ | — | shipped |
| Device pairing | Pair an Apple device by approving a code in the web app | admin | ✓ | ✓ | shipped |
| Backups and webhook | Nightly database backup; one webhook URL for provider down, recording failed, licence expiring, guide running out | admin | — | — | shipped |

## Sport

Agreed with Mark on 30 Oct 2026 (decision D-33). It supersedes the per-sport "next 72 hours" views and the team-follow
logic of the old dashboard design ([`archive/SPORTS-DASHBOARD-DESIGN.md`](archive/SPORTS-DASHBOARD-DESIGN.md)). The
rebuild is #21.

### Why

Sport is the reason PigTV is opened about 90% of the time. The TV guide already serves everything else well. A list of
"what is on and what is next" is not engaging; a page shaped like the sport (the race weekend, the round, the ladder)
is. Reference that prompted this: sportset.app (an idea to learn from, not a design to copy). We already do better on
recording, provider failover and the "Live now" dashboard; we will not copy its generic "channels about this sport"
lists, which the guide covers.

### Shape

- **Sport has two levels.** A front page, **Live now** (the existing dashboard, reassessed), and **a page per sport**
  with its own design, chosen from inside the Sport area.
- **Each sport page covers:** what is live (with live scores and one press to join the coverage), what is next, the
  last round or last session's results, standings, and the upcoming schedule. No fixed 72-hour window: the schedule
  comes from the sport's data, and a session or game is linked to a broadcast once the guide carries it (~24–48 h out).
- **Event sport (F1):** the next race weekend leads: circuit, every session (FP1–3, Sprint Qualifying, Sprint,
  Qualifying, Race) with dates and times, live indicator and join, results filling in as sessions finish, both
  championships.
- **Fixture sport (NFL, AFL, NBA, MLB, league football):** the next round with times, live scores, last round's results,
  standings, and whatever else the data makes obvious.
- **Football is one Sport entry with chosen competitions inside it.** A banner "Football"; the user picks which leagues
  and one-off tournaments (EPL, Championship, FA Cup, UEFA, a World Cup) appear within it. To be mocked up, including
  how a tournament differs from a league and how it stays uncluttered.
- **Following a team or driver** replaces the current team logic: following a team gives the whole sport page, with that
  team highlighted (and its next game surfaced on Live now).
- **Spoiler-free is one global switch in Settings,** covering every page: scores, results, standings, finishing orders,
  championship points and form.
- **Live scores are essential.** The pages degrade honestly when the data feed is missing; Live now, the guide and
  playback never depend on it.
- **Reminders (the bell):** a reminder on a future session or game. On iPhone and iPad it is a real system notification
  (scheduled on the device from the known start time, refreshed when the schedule changes), with Watch opening the app
  on the coverage. On Apple TV, which has no notification banners for apps, it is an in-app banner over whatever is on
  screen, playback included. Recording is a separate action.
- **Recording from sport pages:** record a session or game, and rules such as "every race session" or "every game for
  team X".
- **Preferred channels per sport:** a sport (F1 alone is on 15–20 channels) has an ordered channel preference, set from
  the record sheet or a channel's options ("use this channel for Formula 1"). Default order: UHD before FHD before HD,
  then favourites. Watch and recording both use it; a recording falls back to the next channel if the first is
  unavailable at the start.
- **Circuit maps:** the ESPN feed supplies its own circuit maps (light and dark: sectors, start line, speed trap and
  highlighted straights). It has no corner numbers or labelled DRS zones; those would need a second, unofficial source
  and are not planned. Official F1 logos and fonts are not used.
- **Built from shared parts:** a few page templates (race weekend, rounds, knockout competition, cricket) plus
  sport-specific modules, so each page feels bespoke without ten hand-built screens per platform.

Design notes for the build are in [`DESIGN.md`](DESIGN.md) › Sport pages.

### Scope and order

- **Apple TV first,** then iPad/iPhone. The web app may lag; its version stays on the roadmap as a future feature.
- **History:** the last round and last session only.
- **First mock-ups:** F1 (event), AFL or NFL (fixtures), Cricket (hardest), and Live now reassessed; then Football's
  competition picker.
- **Parked:** scores, tables or timing over the picture while watching (with the planned rework of the player overlay).
- **First step:** a data survey of the free ESPN feeds for every followed sport (AFL, F1, EPL, Cricket, MLB, NFL, FA Cup,
  UEFA, Championship, NBA, plus a World Cup-style tournament) to decide what each page can honestly show.

The first step, the data survey of the free ESPN feeds, ran on 30 Oct.

### Live now: requirements (29 Oct)

These were set for the Live now dashboard (C-O) and still hold where the vision above does not replace them. Superseded
by the vision: the rolling ~72-hour sport/team views (sport pages take their place) and per-account spoiler settings (one
global switch, D-30).

- Sports opens on a game-first dashboard: discover games, then find their TV broadcasts. Show all games matching
  existing follows/categories, including games without a matching channel. Preserve the current sport/team views for
  future events, explicitly retaining their existing rolling ~72-hour window (including Cricket games two/three days
  ahead). This is a new front page, not a replacement for those views.
- Today contains upcoming and live events. A finished game may remain for an hour, visibly ended and **not selectable**;
  never tune its former channel, which could now show something unrelated. The hour is a proposed default.
- A live card selects the preferred currently valid channel using the existing playback flow. Long press retains
  other-channel and event/recording options. Upcoming cards retain the existing event page and scheduled actions.
- Spoiler avoidance belongs to a person/profile and follows them across devices. Hide scores, keep teams and game
  progress, retain every otherwise valid action. Mark accepted using existing user accounts initially; a shared TV
  uses its pairing account. A household profile chooser is deferred.
- Free data only; ESPN is the first candidate. Adjustable score delay with a sensible default.
- Every league in the current sports feed is essential; design sport-specific cards rather than one generic score box.

Read-only configuration inspection authorized by Mark on 29 October found these exact followed keywords:
**AFL, F1, EPL, Cricket, MLB, NFL, FA Cup, UEFA, Championship, NBA**. No sport-marked categories were configured.
Only names were read; no playback, provider connection, recording or server mutation was made.

Use sport shelves as the starting layout (selected mockup); keep the grid as comparison material. Apple TV first,
then iPhone/iPad and web. Today shows matching upcoming/live games, ongoing games across midnight and one-hour delayed
recent finals; finals cannot launch playback. Existing sport/team navigation keeps its rolling ~72-hour schedules,
including cricket two/three days ahead. Do not replace those views with today's slate.

All existing feed follows are essential: AFL, F1, EPL, Cricket, MLB, NFL, FA Cup, UEFA, Championship, NBA. Keep unmatched
games and sports with missing score fields visible; tell Mark exactly which sports/fields are affected. Free feeds
only. F1 is session-only (GP/session/circuit/start/broadcasts); no laps, positions, scores or live timing required.

Select a currently watchable card through existing preferred-channel resolution; long press offers existing event,
other-channel and recording actions. No match must not silently choose a generic sports slot. Revalidate the airing
at selection. Distinguish confirmed LIVE, UPCOMING, break and ON TV NOW; an airing alone never establishes live play.
Reuse yellow/red availability indicators with explicit text/icons; distinguish recording from unavailable channels.

Existing accounts are profiles; a paired TV uses its approving account. Avoid spoilers and score delay sync per user;
default delay 90s, configurable 0–300s. Neutral teams/progress remain visible while scores and result-derived details
are absent. Server timezone defines today (fallback Australia/Melbourne). Household profile switching, paid feeds,
automatic score/video alignment, alerts and playback-engine changes are outside this feature's initial scope.

## Non-goals

**Not planned:** AV1, more users, reviving VOD, access from outside the VPN, AirPlay/PiP, a session keep-alive. **Kept on
purpose:** the non-VAAPI encoders.

The Apple client's deferred choices (no session keep-alive, no AirPlay, no VOD; release policy later) are decision D-12.

## Known limitations

Problems a user would notice. Technical limits are on each area's page under ARCHITECTURE.

### Live TV

- **The provider cuts the connection about 38 s into a play on some channels and resends ~19 s of old content** (§2). ffmpeg
  rebases the timestamps, so the player neither freezes nor rewinds, but the viewer sees a short repeat and the stream sits
  ~19 s further behind live. When the rebase goes wrong instead (a timestamp loop, Fox Footy 3 Oct) the session is ended and
  restarted cleanly (0191). B3's ingest is the structural fix.
- A channel can still fail to start during a provider outage when no backup carries it; the viewer sees the C-B message and
  a Retry button.
- In-stream recovery and the standby: the limits in §3.

- **TNT Sports 4 on Strong8K: sound 2–3 s out of step with the picture.** The offset is in the feed's content, not its
  timestamps (the server copies both streams and keeps them within 0.03 s), and no other carrier can stand by for it.
  Mark lives with it (27 Oct, D-20); kept here so it is not investigated again. Finding FR-14 in
  [`archive/FINDINGS-2026-10-30.md`](archive/FINDINGS-2026-10-30.md).

### Recordings

- Segmented recordings (R3) need room in appdata for the longest recording (twice that while someone watches an HEVC one
  from the start). Live break detection does not follow them; they are analysed from the MP4.
- Rules (R5) see as far as the guide does (sport 72 h, series 7 days); a series rule is per channel.
- The recordings folder must be on a volume Docker sees live (§1 Deployment). The server checks it at startup and every
  15 min and warns on Status, but it can't fix a Docker mapping.
- A viewer who chose "Keep watching" blocks a due recording for the whole programme (an unanswered prompt hands over after
  3 min).
