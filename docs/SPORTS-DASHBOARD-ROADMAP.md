# Sports dashboard: remaining delivery roadmap

Updated 29 October 2026 during local **0317 / Apple 60** cross-platform work (starting from server 0316 `cba8019` / Apple 59 `b91e4de`). This is the current delivery checklist; the
[design](SPORTS-DASHBOARD-DESIGN.md) describes the full intended experience and
[C-O](CLIENT-CONTRACT.md#c-o-sport-dashboard-foundation-flag-sportsdashboard-0309-experimental-03130315-own-review-repairs)
is authoritative for implemented API behavior. Mark reports no visible issues on web/server/iPad; tested versions/flag were not supplied. No dashboard-specific
live results, pilot measurements or device acceptance have been established. Update this record from evidence as each slice lands.

## Current baseline

- **Done locally:** 0309/0313/0315 feature-gated server catalog, score adapters, persisted observation history,
  delayed coherent projection, per-account preferences/revisions, conservative game-to-broadcast matching,
  authenticated API, bounded collector and worker projection with timeout/replacement.
- **Local checks:** 0316: 1,316 tests pass, zero failures/skips; build verification passes. Guide-only fallback, cross-midnight buffering retention,
  conservative deduplication and empty followed-sport names are implemented with failing-before tests. Own-review H1/M1–M3/L1/L3/L4
  repaired, original L2 answer accepted; follow-up N1/N2 and worker timeout repaired with failing-before evidence.
  [0315 evidence and review command](reviews/2026-10-29/sports-dashboard-followups/README.md).
- **Not shipped/verified:** dashboard flag remains off by default. Apple 59 UI slice is implemented with passing local gates (244 contracts, 243 unit/playback, 20 UI and iOS build); web 0317 is implemented and locally validated. No real-feed delivery
  latency/performance acceptance, no cross-device UI acceptance. Mandatory Codex server review remains **0 of 2**.
- **Open low findings:** SD-0313-L2 unknown-format multi-day cricket and SD-0313-L3 collector main-loop parse cost,
  with reproductions in [FINDINGS](FINDINGS.md#sports-dashboard-0313-own-review-follow-ups-29-oct).

## Settled product scope

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

## Ordered work and completion evidence

| Stage | Remaining activity | Exit evidence |
|---|---|---|
| 1. Foundation review | Mark runs mandatory Codex command from 0315 handoff. Resolve/answer findings with failing-before regressions; use at most two Codex rounds for this batch. Keep separate media/relay findings separate. | Review report and every disposition recorded; after round two only highs block, remaining medium/low findings registered. Own review does not consume a Codex round. |
| 2. Initial test/pilot | Record tested build/flags/environment and Mark's actual results. Confirm flag-off fixture behavior, enabled cooldown retry, cold/future progress, preference persistence/isolation, API authorization, restart/delay behavior and unchanged legacy Sports. On separately authorized real-feed/HLS pilot, measure SD-0313-L3 before normal enablement. | Sanitized test record: pass/fail/not observed, ten-follow coverage matrix, request/429 counts, bytes and parse/normalize/ingest timing, event-loop and HLS latency p95/p99/max, CPU/heap, flag-off/on comparison. Never substitute parser samples for live-clock proof. |
| 3. Coverage and matching gaps | Implement guide-only fallback for unresolved category/keyword/feed coverage; deduplicate against catalog cards without dropping games. Prove real guide joins, replays, doubleheaders, football legs, F1 sessions and multi-day cricket. Resolve SD-0313-L2 with reliable format/day evidence or retain explicit limitation and Mark's priority. | Failing-before tests for repairs; real-feed matching samples without credentials; no wrong-channel selection. Every affected sport/field reported. Do not infer five-day cricket from unreliable endDate alone. |
| 4. Card/edge acceptance | Complete seven family variants and edge-state fixtures: scheduled/live/break/stale/buffering/final, no channel/unavailable/recording; overtime, football stoppage/extra time/penalties, MLB extra innings/suspension, cricket innings/stumps/rain and F1 separate sessions. Confirm which optional fields actually exist. | Reviewable sport-shelf mockups/fixtures with spoiler-on/off, long names/missing graphics, light/dark and Apple TV focus. AFL goals/behinds enrichment and richer NFL/MLB situations remain explicit optional follow-ups; show basic data honestly. |
| 5. Apple TV vertical slice | Capability-gated models/API client; today shelves and seven card families, cached logos/name fallback, distinct status/availability, stable focus/order. Reuse preferred playback, long-press channel/details/recording flows and preserve existing ~72h sport/team views. Add settings and safe preference lifecycle. | Apple tests and required build checks; no score flash or raw/accessibility leaks, no automatic tune/probe, unavailable/final cards cannot launch unrelated content. If capability absent/404, retain ordinary Sports. Update client contract for any actual API changes. |
| 6. Cross-device safety and resilience | Same-account sync on visible dashboards/resume/sign-in; revision conflict and save failure UX; hide while identity/preferences unknown. Test another user isolation, offline/reconnect, stale reveal cache, increased delay, final correction/expiry and timezone/DST. | Two-device account tests plus Mark's device checks. Target <=30s visible-online sync and immediate resume revalidation is a design acceptance target to validate, not a current client guarantee. Keep focused cards stable on update/expiry. |
| 7. iPhone/iPad and web | Adapt the shared contract/design: responsive cards, visible more-options action plus touch-and-hold; web keyboard/focus support, accessibility and safe foreground refresh. Preserve future sport/team navigation and all existing event actions. | Phone/tablet/web UI tests and device/browser acceptance, including settings conflicts, spoiler-safe details/menus/alt text and capability fallback. |
| 8. Release acceptance | Review each functional client/server batch under its repo rules; complete pilot and real-device checks, document remaining limitations, obtain Mark's release decision. Keep flag reversible and separate from unrelated recording repairs. | Mark reports acceptance for all ten follows/basic cards and available live transitions; no normal enablement/performance claim without pilot evidence. Mark controls push/deploy/provider-consuming playback. Record rollback flag behavior and deployed versions. |

**0316 coverage evidence:** guide-only listings now survive catalog gaps with explicit data-source/score-unavailable
labels. C-I replay/show/placeholder/expired listings stay excluded. Catalog identities suppress guide duplicates even
when ambiguous or finished; unknown-format cricket retains an unmatched possible duplicate guide listing without channels so rematches are not
hidden and the join is not widened. Hidden guide-only titles
are neutral league/event labels because guide prose is not trusted team metadata. SD-0313-L2 remains open; L3 requires
a separately authorized pilot. [Evidence](reviews/2026-10-29/sports-dashboard-continuation/README.md).

**Apple 59 slice (local, local gates pass; review/device acceptance pending):** capability/404 fallback, sport shelves and canonical-league 72h
filters, seven neutral progress families, cached logos/name fallback, explicit availability/recording labels, preference
save/conflict and foreground/offline hiding, and revalidated event/channel/recording actions are implemented. Shared iOS
layout includes visible options; iPhone/iPad adaptation is provisional until device/accessibility acceptance. Web 0317 is now implemented; Apple 60 adds mobile viewport/large-text adaptation. Local gates and
remaining consolidated cross-platform acceptance are recorded in the new evidence below. DEBUG `sport-dashboard` fixtures show invented edge variants with actions disabled. No stage is device
accepted. Same-account and separate-user behavior has synthetic API/model tests; physical two-device sync is outstanding.

Stages 3–4 can proceed offline after initial findings are triaged. Do not silently turn optional enrichment into a
requirement for basic cards, or declare a stage complete because its tests alone pass. A new failing feed must retain
honest missing-data UI and be added to the coverage matrix. Read-only deployment access and provider-consuming tests
need Mark's authorization for that activity; no new access is implied by this roadmap.

## Next agent

Use [the continuation prompt](SPORTS-DASHBOARD-CONTINUE.md) after initial testing. Bring forward actual review/test
results and current HEAD; do not assume 0315 is still latest or that outstanding gates have passed.

**0317 / Apple 60 cross-platform work:** Mark requested mobile and web implementation before a consolidated manual
pass across Apple TV/iPhone/iPad/web. Web has C-O seven-family shelves, current airing/stable-channel actions,
record/series/sport rules, synced settings, keyboard and visible/context options, lifecycle/privacy hiding and C-I
72h fallback. Apple 60 adapts card width, controls, large text and labelled touch options. Apple required push gate and
iOS build pass; server 0317 passes all 1,339 tests/build checks. Final iPhone/iPad UI checks pass (2 each). SD-A60-L1 maximum-text fallback initials remains cosmetic/open. No platform is device accepted; no review or pilot
is assumed. [Current evidence, review commands and eight numbered consolidated checks](reviews/2026-10-29/sports-cross-platform/README.md).

**Additional Apple 61 build:** Mark authorized strict badge identity, smaller family-specific tvOS cards, direct
long-press actions and delay presets/stable save focus before consolidated device testing. No additional device pass
is requested in between. Implementation/evidence and the updated review focus are in the
[Apple 61 handoff](reviews/2026-10-29/sports-tvos-refinements/README.md); local Apple gates pass (244 contracts, 247 unit/playback, 23 tvOS UI, iOS build and 2 UI tests each on iPhone/iPad). Server remains
0317; this server batch changes documentation only. Prior cricket/pilot/category/logo limitations remain explicit.
