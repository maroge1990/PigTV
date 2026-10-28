# Live sport dashboard — design proposal, 29 October 2026

Status: Mark authorized implementation after the revised F1/session-status discussion. Server foundation is in local
build 0309, opt-in only; Apple/web dashboard interfaces are not yet implemented. Local gates pass (1,273 tests and build verification); adversarial review is pending.
The proposal below describes the complete feature, not a claim that all delivery slices are finished.
Mark requested an Apple TV-first interactive mockup before implementation, with iPhone/iPad and web adaptations.
Recording repairs in progress are a separate batch. Mark accepted the overall mockup, retained the 72-hour sport views, approved existing user accounts as profiles, and
approved explicit missing-data states. The revised session-only F1 preview was shown before authorization to build.

## Requirements established with Mark

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

## Proposed screen and card behavior

Explore two layouts: sport shelves (live, upcoming, recently finished) and a match grid. The inline mockup uses invented
match situations and monogram badges, not current results. Its league chips exercise each card type; future schedules,
real logos, actual playback, recording, sync and authoritative score delay are not implemented in the mockup. The
updated league views include illustrative future cards across the next ~72 hours. A focused revised F1 preview
shows a session-only card: GP, session, circuit/location, scheduled start and channels; no positions or live timing.

Default ordering: live first, upcoming by start, recently finished last. Within live, keep order stable across score
updates; do not sort by who is winning. Keep focused cards stationary; defer removal/reflow of a focused finished card
until focus moves. For long lists use lazy shelves/grids. No automatic audio/video preview.

Use one configured dashboard timezone (proposed: server setting, Australia/Melbourne), with the zone visible, so devices
agree on today's slate. Query the actual local-midnight interval including DST, not a fixed 24-hour offset or ESPN's
unqualified default day. Include a game still live across midnight even if it began yesterday. Multi-day cricket uses
its current day's playing session: stumps/overnight is a break, not a completed match. Include today's remaining
sessions of a longer event rather than only events whose overall start is today.

| Card type | Applies to current follows | Visible situation | Hidden with Avoid spoilers |
|---|---|---|---|
| Australian football | AFL | Teams, quarter, clock, total points plus goals.behinds | All score fields, winner emphasis |
| Basketball | NBA | Teams, quarter/overtime, clock, points | Points and score-derived markers |
| Football | EPL, FA Cup, UEFA, Championship | Teams, half, elapsed time incl. stoppage/extra time, goals | Goals, aggregate/penalties, winner emphasis; no goal/red-card ticker |
| American football | NFL | Teams, quarter/overtime, clock, points, possession/down-distance/field position | Points and possession/down-distance/field position to avoid play-result leaks |
| Baseball | MLB | Teams, top/bottom inning, runs, outs, count, occupied bases | Runs, outs, count and bases; retain inning/half as game progress |
| Cricket | Cricket | Teams, format/day/session, runs/wickets, innings, overs, target/lead when available | Runs, wickets, targets, lead, required rate and outcome text; retain neutral innings/overs/day/session |
| Motorsport | F1 | GP, session, circuit/location, scheduled start, broadcast availability and channels | No results/timing/positions are included in this card, so its content is unchanged |

Data absence is normal: never invent a ticking clock, leader, possession, base state, overs or a 0–0 score.
F1 uses one card per practice, qualifying, sprint qualifying, sprint or race session. No Q1/Q2/Q3 countdown, live lap,
leader, position, gap, fastest lap, winner or result is required for the initial build (Mark, 29 Oct). Use an on-now
broadcast label only when a current match exists; retain scheduled start wording rather than inferring actual start.
Cricket needs Test, ODI/T20, innings break, stumps, rain delay and completed variants. Football needs penalties/aggregate
and postponed fixtures; MLB needs extra innings/suspended games; NFL/NBA/AFL need overtime/breaks as applicable.
The initial mockup samples the families and some edge states; remaining edge variants require acceptance before the dashboard is enabled for normal use.

Proposed availability markers reuse existing visual vocabulary but need explicit labels:
- No dot: a confident currently usable broadcast match exists. The label still names the preferred channel.
- Yellow dot + "No channel found": no confident match, or ambiguous candidate set. Details remain accessible;
  watch/record are disabled until a real match exists. Never silently pick a generic sports slot.
- Red dot + "Channel unavailable": a known match is blocked/unavailable according to existing channel state.
- Recording retains its existing red recording indicator **with a recording label/icon**. Color alone cannot distinguish
  recording from an unavailable feed. Do not probe/tune channels just to populate these markers.

On iPhone/iPad: touch-and-hold plus a visible more-options action; web: a visible options action and keyboard access.
Apple TV: remote select/long press, native focus, readable team names and distinct focused card styling. Screen readers
must receive the same spoiler-safe fields as sighted users. Real graphics should use cached source team/league or driver/
constructor assets with name/initial fallback; validate availability, attribution and permitted use before shipping.

## Data feasibility and free-only release gate

Existing code: `sportsFixturesEspn.js` fetches ESPN scoreboard JSON, but `competitionRecord()` keeps fixture ID,
start/end, state and team name aliases only. `teamFields()` discards IDs and artwork; scores, displayClock, period,
sport situation and most racing data are discarded. `sportsFixtures.js` refreshes every 30 minutes.
`GET /api/sports/events` remains guide-first, refreshed to Apple clients every minute. Current fixtures help classify
live versus replay; they are not a live-score store. Keep that purpose and its failure semantics intact.

External checks on 29 October: **all ten follows have responding public ESPN sources and real fixture/result samples**.
A 53-request investigation checked scoreboards, cricket dated discovery, AFL detail and F1 detail routes. Evidence and
field limitations are in [the feed assessment](reviews/2026-10-29/sports-dashboard/README.md) and its reduced JSON samples.
This proves response fields, not uninterrupted service or live delivery latency. No moving in-play clock was observed;
current cricket samples are at stumps/break and NBA samples were still pre-game. Live-event acceptance remains open.

ESPN is the initial free source. Its existing adapter documents it as unofficial and undocumented. Most tested date-range
queries returned 400, while individual-day requests worked. Fetch/cache individual UTC days touching the rolling local
72-hour interval, filter by actual competition/session times, and deduplicate. F1 can return a whole weekend for one day;
cricket can return an ongoing multi-day game whose original start predates the query date.

Cricket discovery must be queried **for each requested date**, not only today: the future scorepanel returned series absent
from today's response. The global cricket scoreboard returned 404, while per-series scoreboards worked. Dated discovery
plus per-series requests and retained known series are the basis of 72-hour cricket coverage. Missing/partial discovery
must not erase retained games; a successful empty result is different from a failed or truncated response.

Mark's missing-data decision: **keep every sport visible, but identify which sports/fields are affected**. Known limits:
- **F1:** session-only by explicit design; live laps/gaps/qualifying countdown are excluded, not a release blocker.
- **AFL:** points/quarter/displayClock are in the scoreboard; goals/behinds require a separate summary request. Show
  total points if enrichment fails, never calculate goals/behinds from points alone.
- **NFL:** scores/quarter/clock exist; down/possession/field-position live presence remains unobserved. Historic plays
  prove the structured fields exist, not that every live scoreboard delivers them. Omit missing situation fields.
- **MLB:** runs/inning and extra-innings results exist; count/outs/bases are present in historical play records but
  their live scoreboard delivery still needs observation. Keep the basic card and omit missing extras.
- **Cricket:** innings/overs/runs/wickets/day and break states exist, but status `in` can mean stumps or not yet started;
  some opposing-team innings rows contain placeholders. Use sport-specific current batting/innings flags and never
  turn empty score into 0. Unknown break/resumption timing gets an honest unavailable state.
- **NBA and the four football follows:** basic fields are present. Live clock freshness, football penalties/aggregate
  and overtime transitions still need live/edge-state acceptance. No current structural blocker found.

TheSportsDB's live scores and OpenF1's real-time data require payment according to their own documentation, so neither
is a free fallback. ESPN's public F1 core detail routes answer with historical positions/laps/statistics, but they do not
establish an accurate live countdown. No new live-timing service is needed for the agreed F1 card.

**Readiness:** sufficient evidence to scope an initial feature-gated server data build, with sport/field-level unavailable
states; no claim of production readiness. **Mark has now authorized build; 0309 implements the server foundation only.**

## Proposed server design

1. A game catalog from followed league schedules, with source-qualified stable competition/session IDs and team/
   competitor IDs. Join canonical football aliases and cricket series; preserve session/day identity. Category/keyword
   matches not resolvable to a feed still produce guide-backed cards, clearly marked scores unavailable.
2. A broadcast join against the existing sports event/airing model. Require league, both team identities (home/away
   order independent), event date/time overlap, and session/format where relevant. Reuse existing aliases, replay
   exclusions and stable channel identity. A single matching side, city-only name, generic listing, wrong cricket
   day, wrong F1 session or replay cannot authorize playback. Keep ambiguous matches visible as unmatched.
3. Allow one game to join many broadcasts and one long cricket broadcast to cover appropriate daily sessions;
   deduplicate guide-backed and catalog-backed cards without merging unrelated doubleheaders/legs/sessions. Changes
   to guide matching must preserve existing classification tests and future league/team view behavior.
4. Reuse existing channel ranking, user favorites, health, manual preference if supported, and opaque playback resolve;
   revalidate broadcast/event eligibility at select time. A fixture saying "live" does not prove its old TV slot still
   carries the game. An unconfirmed or ended airing must not launch unrelated content. Recording options use actual
   matched schedules; no unmatched-game recording promise or new playback/timestamp mechanism.
5. A separate normalized live-state collector, shared by all clients, with per-league adapters and bounded history.
   Proposed initial policy: one fetch per active league/date every 30 seconds while live, slower pre-game, with
   timeouts/backoff/jitter and deduplicated work. Tune cadence after source observation, not an assumed rate allowance.
   No network request on a card render and no per-device ESPN polling. Schedule acquisition must also cover leagues
   that have no watchable channels. Collector must maintain enough history before first dashboard visit.
6. Outage behavior: keep catalog and watch/actions; use safe stored game snapshots, report age, then hide stale
   score/clock fields after a proposed 2-minute excess-age budget **beyond the chosen delay**. Never reset to zero or
   extrapolate a stopped clock. Collector failure cannot block provider admission, guide or playback.

New API shapes remain proposals; the existing client contract is unchanged. Prefer a capability-gated dashboard
endpoint plus authenticated self-service preference reads/updates, with old clients continuing their existing route.
A normalized game has catalog identity/start/day/session, competitors/artwork, structured sport-specific state,
match availability/event reference, observed/effective timestamps and freshness; score output is profile-filtered.
History is bounded by time/count, persisted through server restart for the delay horizon, and never stores credentials.
ETags/caches must incorporate authenticated profile, preference revision, delayed snapshot identity and visibility.
No shared response can expose another person's revealed scores.

## Spoiler preference and sync

The server already has user IDs; pairing embeds the approving user's ID and device identity. Proposal: each existing
PigTV user is a profile for the first implementation. Store `avoidSpoilers`, `scoreDelaySeconds` and preference revision
in server-backed per-user preferences, not global settings, device defaults or iCloud. A new self-service update route
must only edit the authenticated user's allowed fields; avoid reopening the admin user-update route.

Devices paired to the same person read the same values on sign-in, foreground/resume and profile switch, then poll/
revalidate while sport is visible. Use a revision/conditional update to prevent stale offline devices overwriting
newer choices. Show save failure; don't claim sync before server acknowledgement. A stricter local hide choice can
apply immediately and remain as a safe pending preference; a cached reveal choice must not flash scores before a fresh
profile read. On unknown identity/preference or after switching profiles, hide scores until resolved. Never replay an
old reveal write automatically after reconnect without conflict handling.

A shared Apple TV currently represents the pairing user, not whoever is on the sofa. Mark approved existing PigTV user accounts as profiles for the first build. The TV therefore uses the paired
account's preference; choosing another household member on the TV is deferred. Devices must authenticate as the same
user to share a preference; no client-supplied arbitrary profile ID is trusted. The mockup labels Mark but does not
implement profile switching. Sync cannot instantly reach a disconnected device; define a target (proposed ≤30s for a visible
online dashboard, immediate revalidation on resume) and test this instead of promising instant universal state.

Spoiler projection must cover visible text, accessibility, image alt text, details, menus, Home sports cards and any
future notifications. Never fetch/render raw score-bearing source descriptions as safe text. Suppress winner styling,
red-card/goal incidents, aggregate, series result, leaders/fastest lap and clock-status prose containing outcomes.
A hidden score should be absent from the response/DOM/accessibility tree, not merely covered visually. Keep intentional
neutral progress (quarter, inning/half, lap, overs) as requested; such progress and a game's disappearance can still
suggest how far play has advanced. Avoid claiming absolute spoiler protection.

## Delayed snapshots: score, clock and lifecycle together

Proposed default: **90 seconds**, adjustable initially from 0 to 300 seconds; mockup previews 60/90/120/180. This is a
starting hypothesis based on Mark's ~60s broadcast lag, not a measured alignment. Store it with the person so all their
devices agree. A temporary per-device/session adjustment may be needed later because channels and playback buffers
have different lag; it is not in the initial persistence scope.

At server time T with delay D, return the newest complete observed snapshot whose observation time is <= T-D. Keep
score, clock, phase/period, incidents, leaders and final/break status from that one snapshot. Do not pair delayed scores
with a fresh clock, final badge, winner logo or live-game count. If source timestamps are trustworthy, preserve them
alongside server observation time; do not pretend receipt time is the play's true occurrence time. Quantize/cache
against the snapshot boundary, not the caller's device clock. Delayed clocks are displayed as reported, never locally
counted down/inferred across pauses.

On startup or after an increased delay, show "Scores buffering"/neutral scheduled information until a sufficiently old
snapshot exists. Never substitute the current score. Retain snapshots for the maximum allowed delay plus outage and
restart margin. Corrections appear when their new observation becomes eligible; don't retroactively expose a newer
corrected value in an earlier snapshot. Out-of-order responses cannot overwrite newer observed state.

Finished cards become final only once their final snapshot is eligible; then keep for a proposed hour. Playback
eligibility is independently revalidated against current broadcasts, so a delayed-looking-live card may no longer be
watchable; explain that it has ended without tuning unrelated content. Postponed/cancelled/suspended are distinct from
final and need explicit retention behavior. At midnight, recently ended cards from yesterday may remain until their
hour expires; otherwise today's filter would hide them early.

A uniform fixed delay **reduces** spoilers; it cannot synchronize heterogeneous channel encodes, upstream score lag,
client buffering, stalls or timeshifted recordings. Automatic broadcast alignment and scoring a recording from its
playhead would require additional evidence/data and are out of scope. Recommend increasing delay or Avoid spoilers
when watching further behind. Do not change the current playback holdback to solve scoreboard timing.

## Delivery slices and acceptance

1. **Data spike, no playback changes:** ten-league coverage matrix, captured sanitized live payloads, observed update
   age/completeness, cricket coverage, artwork sources. Mark approved explicit missing-data states and session-only F1 cards.
2. **Design acceptance:** seven card families plus edge states; shelves as the starting layout, with grid retained for comparison; remote focus, long press, light/
   dark, phone/tablet/web, unavailable broadcasts, spoiler projection, timezone and shared-TV identity.
3. **Initial server slice (0309):** pure adapters with these captured fixtures as parser regressions;
   isolated feature-gated catalog/history/preferences, with no client-visible route enabled until its contract/tests
   are agreed. No playback-engine changes. Then **server catalog and preferences:** stable IDs and game-to-broadcast join, delayed history/freshness, self-service
   preferences and access control, capability-gated API. Publish CLIENT-CONTRACT and Apple route test changes together.
4. **Apple TV first**, then iPhone/iPad and web using the same server contract; preserve existing future sport/team
   views and ordinary playback, channel choice and recording workflows.
5. **Adversarial review and real-device acceptance:** follow the repo's two-round limit. No deployed/feed playback
   without Mark's separate authorization. Record what is locally tested versus accepted on devices.

Every functional slice needs tests that fail on its prior implementation. Required coverage includes:
- All seven parsers; missing/malformed fields and extra sessions; Test multi-day breaks; F1 qualifying/race distinction;
  football stoppage/penalties, extra innings, overtime, postponed/cancelled/suspended and source correction cases.
- Unmatched games still visible; ambiguous same-city teams, swapped home/away, two games same day, wrong session/day,
  replay aliases, changing/ended airings, no accidental provider access. Missing channel does not remove a game.
- Delay boundary ±1 ms with a fake clock, process restart, no old snapshot, increased delay, out-of-order responses,
  stale data and final-state delay. Entire snapshot coherent; scores never leap forward on refresh or error.
- Two users/devices, shared TV switch, stale preference conflict, reconnect, safe first render, no raw hidden fields or
  accessibility leaks, correct private cache separation. No requirement for users to change an admin-wide setting.
- Server timezone, both DST transitions and UTC date boundaries, cross-midnight games, multi-day cricket and final TTL.
- Existing future event navigation and watch/record options, large slate focus stability and card expiry under focus.

Initial source selection, profile identity and session-only F1 design are settled; implementation is authorized. This is a
medium-to-large cross-repo feature (data collection/history, matching, preferences/identity, APIs and four client
presentations), not a card-only facelift. Out of scope: paid feeds, odds/statistics dashboard, score alerts, automatic
broadcast synchronization, playback engine changes and unrelated recording repairs.
