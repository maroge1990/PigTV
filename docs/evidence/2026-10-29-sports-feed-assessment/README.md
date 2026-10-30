# Sports dashboard: feed assessment, 29 October 2026

Design-stage public-source inspection only. No playback, IPTV provider request, deployment, application change or
live reliability acceptance. Deployed follows were separately read with Mark's permission: AFL, F1, EPL, Cricket,
MLB, NFL, FA Cup, UEFA, Championship and NBA. No sport-marked categories were configured.

## What is established

All ten followed leagues have responding public ESPN fixture/result feeds. Scoreboards are usable as the first free
source, with per-sport interpretation and explicit unavailable fields. Existing PigTV user accounts will serve as
profiles initially (Mark approved); shared TVs use the paired account. Today is the dashboard front page, while sport/
team views retain their existing rolling ~72-hour horizon, including cricket matches two/three days ahead.

Mark accepted keeping every sport visible when data is missing, provided the affected sports/fields are identified.
He then removed the requirement for F1 live scores/timing: redesign it as a session card, and show it before build.
**Update after visual review:** Mark authorized implementation. Local 0309 adds the opt-in server foundation;
Apple/web UI and real-feed/device acceptance remain next. Local gates pass: 1,273 tests and build verification. Adversarial review is pending.
The feed assessment below records the pre-build investigation; it is not proof of live behavior.

## Source/field matrix

Paths below follow `https://site.api.espn.com/apis/site/v2/sports/`. Queried individual-day dates are in UTC.
Evidence in [test/fixtures/sports-feed-evidence.json](../../../test/fixtures/sports-feed-evidence.json) contains request URLs, HTTP/parse outcomes and reduced response
fields. It omits most unrelated data, truncates competitor lists to three and innings/period samples to four entries.

| Follow | Feed path / examined sample | Established fields | Remaining limitations / initial behavior |
|---|---|---|---|
| AFL | `australian-football/afl/scoreboard?dates=20260926`; summary event `1133711` | Teams/logos, total points, displayClock, quarter; summary has goals/behinds | Clock semantics/freshness need in-play acceptance; goals/behinds optional enrichment |
| F1 | `racing/f1/scoreboard?dates=20261025` and `20261031`; public core detail | GP/circuit, per-session ID/type/date/status; historical driver order and statistics | Session-only card: no live laps, gaps, positions, winner or countdown promised |
| EPL | `soccer/eng.1/scoreboard?dates=20261025` (5 events) | Teams/logos, score, period/displayClock, final status | In-play cadence and special transitions not observed |
| Cricket | `cricket/scorepanel` and dated `scorepanel?dates=20261030` / `20261031`; series `8043`, `24203` scoreboards | Series discovery, teams/logos, runs/wickets, innings/overs, day, stumps, upcoming matches and ongoing multi-day events | Sport-specific state and placeholder handling essential; no live delivery lag measured |
| MLB | `baseball/mlb/scoreboard?dates=20261027`, summary event `401908045` | Runs, inning, final/12; historical plays have half-inning, count, outs, base state | Live count/outs/bases delivery unobserved; omit absent extras |
| NFL | `football/nfl/scoreboard?dates=20261026`, summary event `401873009` | Points, quarter/clock; historical drives/plays have possession/down/field position data | Live situation delivery unobserved; omit absent extras |
| FA Cup | `soccer/eng.fa/scoreboard?dates=20260516` (1 event) | Teams/logos, goals, period and clock including stoppage text, final status | Earlier-round completeness and penalty/aggregate transitions still need targeted captures |
| UEFA | `soccer/uefa.champions/scoreboard?dates=20261021` (9); `soccer/uefa.europa/scoreboard?dates=20261022` (18) | Teams/logos, goals, period/clock, final status | Existing mapping is Champions + Europa; Conference endpoint also answered with 18 fixtures, but adding it is a separate scope decision |
| Championship | `soccer/eng.2/scoreboard?dates=20261024` (11 events) | Teams/logos, goals, period/clock, final status | Live cadence and exceptional states remain acceptance work |
| NBA | `basketball/nba/scoreboard?dates=20261026` (9 finals); `20261028` (12 scheduled) | Teams/logos, points, quarter/displayClock, final/scheduled status | Current pre-game values are not proof of in-play freshness; one historical request returned non-JSON before a different day succeeded |

These counts are returned observations, **not assertions of whole-league completeness**. Pagination, date boundaries
and competing endpoint interpretations must be covered by the implementation's fixtures and live acceptance.

## Important discoveries for the design

1. **Use individual days.** Most tested date ranges (`dates=20261026-20261101`) returned HTTP 400. A smaller NBA range
   also returned 400, while the same single day with `limit=1000` answered 200. F1's range answered 200, so adapter
   behavior differs. Use one bounded request per UTC day, cache across users and filter local time precisely.
2. **Discover cricket beyond today.** Today's scorepanel contained 14 series; the `20261031` panel contained 15,
   including series absent today (for example CWC Challenge League Group A and India A in New Zealand). Their sets
   differ, so today's discovery cannot serve a 72-hour view. The generic `cricket/scoreboard` returned 404. Dated
   scorepanel plus per-series fetches/retained series are required. A future-day Shield scoreboard includes an ongoing
   game and a second scheduled game, proving that start-before-day and new-game cases need different inclusion rules.
3. **Cricket status requires interpretation.** `state: in` is present for Stumps, and for an event whose summary says
   it starts later. The generic clock is `0'` and is not a meaningful cricket clock. Use day/session and verified
   current innings/overs, with explicit scheduled/break/in-play/unknown state handling. An opposing team's line row
   can contain the current overs while its `isBatting` is false; never sum all rows or turn placeholder 0 into a score.
   Cricket overs use balls notation (e.g. 71.3), not decimal arithmetic. Keep raw display/string plus normalized balls
   only where legal-ball semantics can be validated.
4. **F1 sessions need their own identity.** One queried day can return the whole weekend, with FP1/FP2/FP3/Qual/Race
   competitions. Filter by competition start, not parent GP start; preserve individual session IDs. `status.period`
   is not generically a lap count: final practice/qualifying samples also have nonzero period values. No countdown
   should be derived from `displayClock: 0:00` or inferred session duration.
5. **F1 detail is not live proof.** Public core competition/status/competitor/statistics routes answered 200, with
   historical lapsCompleted, place, race time and vehicle/constructor metadata. Their observed cache header was
   `max-age=600, stale-while-revalidate=7200` on completed sessions; this says nothing about in-play cache policy.
   Ordinary F1 summary routes returned 404. Those historical stats do not justify a live lap/gap/countdown promise.
6. **AFL can be enriched safely.** The scoreboard supplies points; the event summary has per-team goals, behinds and
   score. A second API should be bounded and optional. Do not invent the goal/behind split from a total.
7. **Freshness has two layers.** A successful new HTTP response can contain unchanged or stale sports data. Observed
   cache headers ranged from 1s to several minutes depending on endpoint/date; fast polling does not establish upstream
   freshness. Keep observation time separate from source update/play time, never label receipt time as live accuracy.
8. **Basic and optional fields differ.** NFL/MLB historical play details demonstrate optional situation shapes, but
   they are not live-scoreboard captures. Avoid adding heavy play-by-play polling just to make every decorative field
   in the mockup nonempty. Start with basic fields and fill extras only from validated, economical live snapshots.

## Revised F1 card contract for the proposal

- Grand Prix name, session name (Practice 1/2/3, Qualifying, Sprint Qualifying, Sprint, Race), circuit/location.
- Scheduled start in the dashboard timezone, with date when outside today.
- An on-now TV label only from a confident current airing; use actual session progress only if explicitly confirmed
  by a fresh source. No inferred stopwatch, race duration, progress bar, lap total or leader.
- Preferred channel, other-channel count, select/long-press actions and labelled unmatched/unavailable state.
- Upcoming opens existing scheduled-event actions. Finished has no tune action. No result data is loaded/displayed,
  so Avoid spoilers does not remove useful F1 session information.
- Current preview's Australian on-now scenario and channel matches are illustrative. Its Mexico Practice 1 date
  comes from the queried schedule: `2026-10-30T18:30Z` = **Sat 31 Oct 05:30 Australia/Melbourne**.

## Other free sources considered

- [TheSportsDB pricing](https://www.thesportsdb.com/pricing): two-minute live scores are in the paid developer tier.
- [OpenF1 docs](https://openf1.org/docs/): historical data free, real-time data requires a paid subscription.
- [T1API authentication](https://docs.t1f1.com/docs/getting-started/authentication): data endpoints require a key; its
  public access covers health/root only. No no-key production fallback was established.
- [FastF1 live-client source](https://github.com/theOehrly/Fast-F1/blob/main/fastf1/livetiming/client.py): live recording
  support exists, but a new timing-stream collector is unnecessary for Mark's chosen F1 scope. No account created,
  paid service enabled, stream subscribed, or restricted endpoint accessed.

## Ready for initial build, not release acceptance

Build the pure sport adapters against these public-response samples, then isolated catalog, delayed snapshot history,
per-user preferences and conservative game-to-broadcast matching. Keep the feature gated until client contract/tests
and Apple implementation are ready. Existing future sport views remain ~72 hours. No playback/timestamp/ffmpeg change.

Product decisions now resolved: existing accounts as profiles; missing-data cards retained; F1 session-only; 72-hour
sport views. Proposed reversible defaults: sport shelves, Melbourne/server timezone, 90s whole-snapshot delay,
1h ended-card retention. The revised F1 visual was shown and Mark authorized build after confirming live/on-TV/scheduled labels.

Still required before release: real live observations of clock/score updates and upstream lag, exceptional states,
source completeness/pagination, matching against real guide rows, sync on multiple devices, remote focus/long press,
all test/build gates and mandated adversarial review. Historical samples and UI previews are not that acceptance.

To reproduce the core checks without touching PigTV or an IPTV provider, issue GETs to the full public ESPN URLs in
`feed-evidence.json` (individual-day `scoreboard?dates=YYYYMMDD`; dated `cricket/scorepanel`; event summaries). Preserve
HTTP failure/malformed JSON as failure, never authoritative empty events. Compare only allowlisted fields and keep
all provider URLs/credentials out of any production diagnostic export.

## Files kept outside the repository

Raw or oversized files from this folder are kept off GitHub (decision D-30): on Mark's disk, then the Unraid test
share. Each is still in git history at `665e02e` under its old path. Identify a copy by its SHA-256.

| File (old path under `docs/reviews/`) | Bytes | SHA-256 |
|---|---|---|
| `2026-10-29/sports-dashboard/build-verification.txt` | 26,026 | `92efc277e65f40143a020758427be1cf734a65252827ee10a0a5532638b82d3d` |

`feed-evidence.json` (the reduced ESPN samples) is a test fixture: it moved to `test/fixtures/sports-feed-evidence.json`,
which `test/sports-dashboard.test.js` reads.
