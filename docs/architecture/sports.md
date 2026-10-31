# Sport

How the server recognises sport in the guide, checks it against ESPN's free feeds, and builds the Live now dashboard.
What the sport area should become is the product vision in [`../PRODUCT.md`](../PRODUCT.md) › Sport (the rebuild is
#21); how it looks is [`../DESIGN.md`](../DESIGN.md) › Sport. The contracts are C-H, C-I and C-O in
[`../CLIENT-CONTRACT.md`](../CLIENT-CONTRACT.md). Add a misfire to `test/fixtures/sports-export.json` with its expected
kind before changing a rule.

## Recognition

**Sport categories** (0146, C-H, `sportCategories.js`, table `sport_categories`): Settings → **Manage Content** → the Sport
button at the end of a category's row (saved at once) = `PUT /api/library/categories/sport` (admin); `library/categories` and the Sources catalogue carry
`sport`. No sync writes the table; a change bumps `library_rev`. Since 0148 it is **one signal** of sport recognition (below),
not a row of its own (C-I replaces the C-H Home row).

**Sport events** (0148, C-I, `sportsEvents.js`, `routes/sports.js`, table `sports_follow`): per programme, sport = (a) a category
in the vocabulary, (b) a followed keyword in the title/categories or a match-up of two distinct teams in a followed
league's stored ESPN roster (0295: exact informative full names, nicknames or stored abbreviations; no city-only
or subset inference; unique teams and league across every stored roster, followed or not, and the league followed, 0335; not
when the title names a competition itself, a followed keyword or another competition, 0335, nor for two bare codes in a
numbered round (round, rd or r with its number; 0338, 0339), or when a side is a
nickname football codes share such as Panthers or Lions, 0336; no stored roster, no added recognition), or (c) a C-H sport
category's channel + a live-looking title
("live", "vs", " v "). A keyword that names a league follows its canonical league in every spelling (`sportsClassify.LEAGUES`:
F1 = Formula 1 = Formula One = FIA F1; AFLW = "Women's AFL" = "AFL Women's", apart from AFL; NFL, NBA, NRL(W), …); other
keywords match as whole words. Cricket format prefixes (`Test`, `ODI`, `T20`, `T20I`, optionally `W`, `Mini` or
`Classic`) followed by a colon and a match-up also name Cricket; so does a match-up on a channel containing "Cricket".
The Cricket follow still applies; bare "test" is not a keyword. Test day/session and G1–G5 suffixes are stripped before
reading the teams. **Kinds (0150, `sportsClassify.js`, pure):** each programme is `placeholder` ("no event", "coming
up", a bare trailing ":", only league + channel words, a date more than a day from the airing, the same title in ≥3 back-to-back
identical blocks on its channel, "24/7", "channel guide", a replay word with no game named) > `show` for highlights ("Hls",
"Bitesize", "Plays of") > `replay` (a game or session + replay/re-air/classic/throwback/playback/mini/condensed, or a year before
the season: Jan–Mar count as last year's) > `show` (a word list: tonight, daily, report, gameday, pre/post show, …; "Live" with
no game) > `event` (a match-up "A v/vs/at/@/x B", or a session: practice 1–3, qualifying, sprint, race/GP, finals, PF1/QF2, …)
> EPG news/replay categories (`show`) > a keyword-only title (`show`); category/sport-channel titles stay events. **Merging:**
same kind + canonical league + overlapping times + the same game: teams in either order (one name's words within the other's,
single letters as initials, "FRE"/"BRL" by their letters in order), or the same session and a compatible grand prix location;
a teamless session ("AFL Grand Final 2026") joins the one overlapping match-up of its league; a plain broadcast title ("AFL
Premiership Football") adds its channel only when exactly one event of that league/kind overlaps (not its times);
several candidates make a show (0297). With none, category/sport-channel recognition remains an event, while
keyword-only recognition becomes a show (0301). MLB broadcasts include `World Series`, `Game N`, `Postseason` and bare `MLB` (0294);
"World Series" alone is not a league alias, and recaps such as "World Series in 30" stay shows. French `c.` is also a
match-up separator. Anything else by the
normalised title (lower case; tags, the channel's own name, live/HD words and punctuation removed). The item's title is the
cleanest form ("Carlton Blues v Richmond Tigers", "Azerbaijan GP · Practice 3", "Sydney Swans v Fremantle · Preliminary Final
2"); `aliases` lists the raw titles; each channel carries its own airing's `start`/`end` (0337, #20), as the item's span
merges them. Visible channels only, once per identity; EPG mapping honoured. Built once per (guide
version, follow-list version, 5 minutes; a minute before 0153) for 72 h + 5 min ahead and 36 h back (0152), loop detection
and live/replay included (~0.3 s on 1,000 channels × 30 programmes; ~1.1 s on 1,000 channels × 108 hourly programmes, the
whole 36 h + 72 h, where every programme is a match-up); a request filters and orders (warm ~20 ms, ~50 ms returning 10,000
items). The sync logs `[Sync] EPG covers until …, N h ahead` and says when that is less than 72 h. `GET /api/sports/events?hours=[&include=all]` (any user,
default 6, 1–72 since 0153; Apple route; events + replays, all kinds with `include=all`), admin `GET/PUT /api/sports/follow` (≤100) and
`GET /api/sports/preview` (next 72 h since 0153, every kind, with the rule and `kindRule`); web Settings → **Sports** (0149; grouped by
kind since 0151). **Built off the request path (0159), on a worker thread since 0195 (`sportsEventsWorker.js`, with an automatic inline fallback):** a request is always served the last built result; a stale cache key
triggers a background rebuild (`scheduleRebuild()`, `setImmediate`, never inline in a request) after an EPG sync, on a
follow-list change, and from a timer aligned to the 5-minute bucket (`startBackgroundRebuilds()`, started once at server
startup); a request that lands mid-rebuild gets the previous result rather than racing it. Only the very first request ever
(nothing cached at all) still builds synchronously. Output is unchanged either way. Direct DB
edits don't move the cache key: tests call `sportsEvents.reset()`. The fixture `test/fixtures/sports-export.json` is Mark's
25 Sept export (titles). **Live or replay (0152, `sportsClassify.resolveLive`):** an event naming a game is checked across
its airings (same league + teams, or league + session + GP), first answer wins: (a) XMLTV flags (`epg_programs.flags`, a bitmask
from `epgParser.PROGRAMME_FLAGS`: previously-shown 1 → replay; premiere 2, new 4, live 8 (also a "Live" category) → live);
(b) the first airing within 36 h is live, one > 30 min later a replay, unless ≥ 20 h later and inside league hours (a series'
next game); (c) "Live" in the title → live; (d) `LIVE_HOURS` (per league, home time zone, `Intl`): outside → replay. A build
reads epg_live from **now − 36 h** (the sync trims nothing by time; whatever past the provider's feed carries) and drops items
that ended before now. The 0148 route tests switch `LIVE_HOURS` off (they use the wall clock); `test/sports-live.test.js` has it.

## ESPN fixtures

**A 0-th rule ahead of (a)-(d) (0161, `sportsFixtures.js`, `sportsClassify.fixtureVerdict`):** when ESPN's free scoreboard
(`site.api.espn.com/apis/site/v2/sports/{path}/scoreboard`) covers the airing's league and time, its answer is checked first -
matched to a fixture (the existing fuzzy team matchers, extended with the fixture's own displayName/shortDisplayName/name/
location/abbreviation as aliases, plus a few codes guides use for cricket nations: RSA, NZL, SRI, 0333; F1 by session +
Grand Prix location, reusing `parseTitle`'s own location parsing on the event name; a fixture naming both teams word for word
beats a nearer loose match, 0334): live when the airing starts at/near the fixture's real kickoff (≤ 30 min after, and still running), else replay,
worded with the real kickoff (`ESPN: the game started Sat 1:30 pm; this airing is 19 h later`); not matched, but both teams
are known to the league and no such fixture exists: replay (`ESPN has no such game at this time`), unless the guide flags
the airing live (an absence never outweighs an explicit flag, 0333); anything else (unknown
teams, league not covered, no fixture data, ESPN down) falls through to (a)-(d) unchanged. A multi-day cricket Test (league
`Cricket` only - IPL/BBL are always a single day) is live on day one and later days when an airing overlaps the daily
playing window: inferred first ball minus 30 minutes' pre-play grace until 8 hours after first ball (0296). A guide live
flag during the fixture span also qualifies. Lunch, tea and delayed-start blocks stay live; wholly overnight blocks
are replays. The daily start is inferred from the first day's UTC kickoff; play outside that estimate needs a live flag.
**Coverage, not just presence (0162):** every league's snapshot carries the exact `[from, to]` window its *last successful*
fetch covered and when that was; an airing outside that window gets no ESPN verdict at all, matched or not - stale or
out-of-window data must never decide anything, let alone manufacture a replay for a real live game ESPN simply has not been
asked about recently. The matched-fixture branch may still use an older but in-window fetch (a real kickoff time rarely
moves); the "no such game" branch (an absence, not a presence) additionally needs the fetch to be recent (≤ 6 h,
`NO_GAME_MAX_AGE_MS`) and the window to reach a full 12 h either side of the airing (`NO_GAME_HALF_WINDOW_MS`) - a day of ESPN
being unreachable falls straight back to (a)-(d) instead of quietly turning an unlisted live game into a replay.
Fixtures are fetched only for the leagues that matter (the follow list, or a marked sport category's name), refreshed every
30 min and after an EPG sync, kept in SQLite (`sport_fixtures`, `sport_fixture_teams`, `sport_fixture_status`) so a restart or
an ESPN outage does not lose them, and never block a request - `sportsEvents.buildEvents()` reads the last stored snapshot.
A successful fetch fully replaces that league's stored fixtures (cricket included, since every refresh re-discovers and
re-fetches every active series from scratch), so a postponed or removed game never lingers.
International cricket (Tests/ODIs/T20Is) has no fixed ESPN league id, so its series are found each refresh from ESPN's
cricket "scorepanel" and merged under the canonical league `Cricket` (`sportsClassify.LEAGUES`: IPL and BBL stay their own
leagues). AFLW has no ESPN feed and stays on the heuristics above. `PIGTV_SPORT_FIXTURES=0` turns fixtures off completely
(`.env.example`); the web Status page's "Sport fixtures" panel shows per-league last fetch, fixture count and last error.

- ESPN coverage is renewed only by a complete refresh (0248). Cricket discovery is a failure unless it is a scores list
  (0255), and partial when an entry cannot name its series (0258) or series exceed the 20-series cap (0255). Logo
  downloads have one deadline to the last byte (0249).

## Data sources (ESPN)

What the free feeds carry, from the 29 Oct feed assessment (its evidence is
[`../evidence/2026-10-29-sports-feed-assessment/`](../evidence/2026-10-29-sports-feed-assessment/)) and the dashboard
design's feasibility check.

Paths below follow `https://site.api.espn.com/apis/site/v2/sports/`. Queried individual-day dates are in UTC.
Evidence in [test/fixtures/sports-feed-evidence.json](../../test/fixtures/sports-feed-evidence.json) contains request URLs, HTTP/parse outcomes and reduced response
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

**Discoveries that shaped the design**

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

**Other free sources considered**

- [TheSportsDB pricing](https://www.thesportsdb.com/pricing): two-minute live scores are in the paid developer tier.
- [OpenF1 docs](https://openf1.org/docs/): historical data free, real-time data requires a paid subscription.
- [T1API authentication](https://docs.t1f1.com/docs/getting-started/authentication): data endpoints require a key; its
  public access covers health/root only. No no-key production fallback was established.
- [FastF1 live-client source](https://github.com/theOehrly/Fast-F1/blob/main/fastf1/livetiming/client.py): live recording
  support exists, but a new timing-stream collector is unnecessary for Mark's chosen F1 scope. No account created,
  paid service enabled, stream subscribed, or restricted endpoint accessed.

**Feasibility and the free-only release gate**

Existing code: `sportsFixturesEspn.js` fetches ESPN scoreboard JSON, but `competitionRecord()` keeps fixture ID,
start/end, state and team name aliases only. `teamFields()` discards IDs and artwork; scores, displayClock, period,
sport situation and most racing data are discarded. `sportsFixtures.js` refreshes every 30 minutes.
`GET /api/sports/events` remains guide-first, refreshed to Apple clients every minute. Current fixtures help classify
live versus replay; they are not a live-score store. Keep that purpose and its failure semantics intact.

External checks on 29 October: **all ten follows have responding public ESPN sources and real fixture/result samples**.
A 53-request investigation checked scoreboards, cricket dated discovery, AFL detail and F1 detail routes. Evidence and
field limitations are in [the feed assessment](../evidence/2026-10-29-sports-feed-assessment/README.md) and its reduced JSON samples.
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

## Live now dashboard (C-O)

Gated: the `sportsDashboard` setting is off by default and stays off until the sport rebuild (#21) and the collector
measurement (#29); decision D-29 in [`../DECISIONS.md`](../DECISIONS.md).

**Sports dashboard foundation (0309):** `sportsScoresEspn.js` is a separate defensive adapter; the old fixture classifier
is unchanged. `sportsDashboardStore.js` persists catalog metadata, observed whole-score snapshots and per-login preferences
in SQLite (created on opt-in use). The collector polls current/prior UTC days, caches future days, discovers cricket per
requested date, and does no request-path network access. Delays use server observation time, not an inferred play time.
Cache hits never become new observations. Since 0313, projection runs on a read-only worker from cached C-I events;
statements/date formatters are reused, writes batch per tick, and the entire delayed state controls broadcast fields
and retention. Network attempts are capped at 12/tick; 429/5xx cooldown is shared with fixture fetches. Cricket endDate
hints are not trusted as match ends. Since 0315, legacy fixture cooldown participation is gated on dashboard enablement;
blocked fixture passes defer and retry after cooldown rather than marking unattempted leagues failed. Three request
slots protect least-recent cold work (including discovery); unused capacity is borrowed. Worker jobs have 10s deadlines.
C-O specifies the gated API. Since 0316, guide-only C-I events survive catalog gaps; ambiguous/catalog identities
suppress fallback (including finals). Unknown-format cricket retains a possible duplicate guide listing with playback disabled, preserving rematches
without widening the airing join.
Hidden guide titles use neutral league/event labels because guide prose is not trusted team metadata.
Cross-midnight pending/unknown cards remain visible within conservative sport bounds (12h unless a reliable cricket
format supplies its existing bound), including initial delay buffering without a channel. Matched current guide airings
also retain a card; eligible final/history retention still controls removal. No undelayed completion or endDate widening.
Apple 59 consumes C-O behind its flag; web remains C-I. Apple uses ephemeral whole projections, visible 20s refresh,
per-account revision settings and revalidated actions. Required Apple gates/review/device acceptance are tracked in the
[continuation handoff](../evidence/2026-10-29-sports-0316-continuation/README.md).

**Server design**

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

The initial API is implemented and specified in CLIENT-CONTRACT C-O; proposals below that go beyond C-O remain
future work. The capability-gated dashboard and authenticated preference routes preserve old clients on their existing route.
A normalized game has catalog identity/start/day/session, competitors/artwork, structured sport-specific state,
match availability/event reference, observed/effective timestamps and freshness; score output is profile-filtered.
History is bounded by time/count, persisted through server restart for the delay horizon, and never stores credentials.
ETags/caches must incorporate authenticated profile, preference revision, delayed snapshot identity and visibility.
No shared response can expose another person's revealed scores.

**Delayed snapshots: score, clock and lifecycle together**

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

Finished cards become final only once their final snapshot is eligible; then keep for a proposed hour. Broadcast fields and Watch eligibility use the same delayed source state. An undelayed final must not remove Watch
or reveal completion through availability. Actual guide airing boundaries are independent; revalidate that the airing
is still eligible at selection rather than using a raw score transition as an early result signal. Postponed/cancelled/suspended are distinct from
final and need explicit retention behavior. At midnight, recently ended cards from yesterday may remain until their
hour expires; otherwise today's filter would hide them early.

Overrun (0386, #191; `services/sportOverrun.js`, the one rule for C-O/C-R and the F1, NFL and Cricket pages): while the
status a surface reports is ongoing, a matched channel whose guide airing ended within 4 h is projected to now + 10 min
(`overrun: true`), so Watch survives a game running past its slot and lapses within 10 min of it ending. The event build
keeps a game's airings for 4 h after they end for this alone (`leagueEvents({ ended })`, `endedEvents`); C-I never
answers them.

A uniform fixed delay **reduces** spoilers; it cannot synchronize heterogeneous channel encodes, upstream score lag,
client buffering, stalls or timeshifted recordings. Automatic broadcast alignment and scoring a recording from its
playhead would require additional evidence/data and are out of scope. Recommend increasing delay or Avoid spoilers
when watching further behind. Do not change the current playback holdback to solve scoreboard timing.

## Spoilers and delay

Today the dashboard keeps "hide scores" and a score delay per account. The approved vision replaces them with **one global
spoiler-free switch** covering every sport page (#68; decision D-30). The current behaviour:

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

## Web Sport page

**Web sports (0317):** `SportsPage.js` consumes C-O with ephemeral account-bound state, 20s visible whole-snapshot
refresh, revision-aware settings and lifecycle hiding. Native browser buttons/dialogs retain focus; card identity/order
and neutral expired placeholders survive refresh. Strict stable-channel and current-airing revalidation precedes existing
watch/record/rule actions. Capability/404 fallback uses the C-I 72h schedule. No new endpoint or provider render probe.
Apple 60 shares the contract with viewport/large-text card sizing. [Contract](../CLIENT-CONTRACT.md#web-0317-c-o-consumption-local-devicebrowser-acceptance-pending).

## Known limitations

- Recognition and live/replay are **heuristics** over guide titles, categories and flags (`sportsClassify.js`; rules in §3),
  checked against **ESPN fixtures first** (0161) where ESPN covers the league and time: NFL, AFL, NBA, F1, MLB, IPL/BBL and
  whatever international cricket ESPN's scorepanel lists that day. Elsewhere (AFLW always; other leagues; ESPN down or
  stale) the heuristics decide: an unflagged live game outside its league's hours reads as a replay, an unflagged replay
  inside them with no earlier airing in 36 h reads as live, travelling series without a fixture rely on flags and the
  first-airing rule, and the horizon ends where the provider's guide ends. The later days of a Test use the first day's kickoff time to infer a daily start;
  play outside the inferred eight-hour daily window needs the guide's live flag. Recognition by team names requires both sides to match distinct teams
  in a followed league's stored roster; missing rosters add no new recognition. Add a misfire to
  `test/fixtures/sports-export.json` with its expected kind before changing a rule.
- ESPN is unofficial and undocumented: a schema change degrades to "not matched" (heuristics), never a crash.

- C-I has no per-channel airing times: a merged event carries the earliest start and latest end of all its broadcasts,
  so a client cannot tell one channel's own window (#20, a P1 requirement of the rebuild).

## Sport pages (0340, C-P, #21)

`services/sportPageF1.js` builds the Formula 1 page from ESPN's free F1 feeds when `GET /api/sports/pages/f1` is asked
for (on whenever `PIGTV_SPORT_FIXTURES` is): the season calendar orders the weekends (its dates are hours off, so each
weekend's own scoreboard gives the session times); the core event and circuit give length, laps, turns, lap record and
a raster circuit map (registered in the logo cache, never fetched by the client from ESPN); finished sessions give the
order, and each car's team and colour come from the core competitor, a request per driver once per finished session,
six at a time under a 6 s deadline (what answered is used; a partial map is not kept), and a cold request waits at most
8 s for the first build (0341, #156).
Kept 10 min within a day of a session, 1 h otherwise; a stale page is served while one refresh runs; ESPN down with
nothing kept answers `{ available: false }`. Only ESPN's part is kept; each request attaches its own sessions'
channels from C-I (`channelsForSessions`, the current guide in that user's order, 0342, #157; from
`sportsEvents.leagueEvents`, which orders only F1's events around the sessions, 0345, #160): an F1 event naming the
session whose channel's own airing covers its start. A weekend that cannot be fetched fails the refresh (0344, #161). Names drop the title sponsor (`SPONSOR_RE`).

**Any other team league (0388, C-T).** `services/sportPageLeague.js` answers `GET /api/sports/pages/league/:league` for
every `ESPN_LEAGUE_PATHS` league but F1, NFL, IPL and BBL (one cache entry per league, so leagues never evict each
other), with the NFL page's caching, stale-while-refresh and #191 rule. Where the scoreboard reports a round
(`week.number`: AFL and NRL on 31 Oct 2026) it fetches the previous round by `seasontype`/`week` and, once the current
one is over, the next, from the scoreboard's calendar; everywhere else (soccer, including the cups, basketball, baseball,
hockey, Super Rugby) games are grouped by the server's local day. ESPN's date ranges (`dates=A-B`) answer HTTP 400, so a
day league asks for each US-Eastern scoreboard day overlapping local yesterday, today and tomorrow (three or four
requests from Melbourne, the default scoreboard's day reused). Standings are fetched at most hourly. Channels come from
the dashboard's join (`sportsDashboard.matchBroadcasts`, with `sportsScoresEspn.teamAliases`), so an airing that fits
two games joins neither. UEFA merges the Champions and Europa League paths, tagging each game's `competition`.
