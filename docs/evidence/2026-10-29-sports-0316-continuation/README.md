# Sports continuation, 29 October 2026

Baseline: server `6bc3592` (docs after 0315 `8953d12`), Apple 58 `2f0df26`; both clean and pulled/current at pickup.
Last recorded server gates: 1,305 pass/build checks, flag off by default; sports mandatory review 0 of 2.
Mark subsequently reports **no visible issues observed on web/server and iPad**. Tested builds, flag, scenarios and
review results were not supplied. No deployment, pilot performance, score-clock accuracy or device acceptance inferred.
No deployed server, public score feed or provider-consuming test was contacted in this continuation.

## Server 0316

Guide-only C-I events survive catalog gaps, with ON TV NOW/UPCOMING rather than inferred LIVE. Safe channel fields,
airing bounds and event references retain existing actions. Replays/shows/placeholders/ended listings stay excluded.
Catalog candidates suppress fallback, including ambiguous games and expired finals: fallback cannot bypass conservative
matching. Unknown-format cricket retains a possible-duplicate guide listing, explicitly unmatched with no channels, to avoid
hiding a real rematch. This does not widen its playback join or hot polling. Canonical followed
leagues remain named with no data. Hidden guide-only titles become neutral league/event labels because guide prose can
contain results; neutral catalog team names remain available. This is an explicit guide-only field limitation.

Three missing-guide/hidden-guide runtime regressions fail on 0315; the empty-follow league regression also fails before
its response-field addition. The ambiguity/final/cricket controls already pass before and remain guards for the new path.
[Before](guide-before.txt), [empty follows before](empty-sports-before.txt), [focused after](guide-focused-after.txt).
Own inspection additionally reproduced an unknown-format same-team rematch being hidden by the first deduplication
draft ([before](cricket-rematch-before.txt)); corrected to retain an unmatched guide listing without channels.
[Final focused checks](guide-final-focused.txt). Final full gate **1,316 pass, zero failures/skips**, build verification passes: [gate summary](server-gates.txt).

SD-0313-L2 remains deferred: unknown-format multi-day cricket is unmatched after 12h. SD-0313-L3 remains pilot-only;
no parse/HLS latency acceptance. F1 remains session-only, AFL basic points are sufficient, NFL/MLB extras stay optional.

## Review gate

Mandatory sports review remains **0 of 2**; own inspection and tests do not consume a round. AGENTS.md assigns the
slash command to Mark; it cannot be invoked as an available tool in this chat. Run in PigTV:

```
/codex:adversarial-review --background --base a6e86e1 Review sports dashboard 0309/0313/0315/0316 only: worker isolation/timeouts, per-user auth/spoilers, whole delayed state and retention, bounded collector/cooldown fairness, cricket and broadcast matching, guide-only fallback/deduplication (including ambiguous and expired-final candidates), empty followed leagues, cross-midnight buffering, later guide windows after delayed finals, current airing-boundary eligibility and C-O. Exclude separate recording/relay/media changes except concrete interactions. Check failing-before evidence. Retain SD-0313-L2/L3 limitations; no pilot/deployment/device acceptance. Round 0 of 2.
```

Use at most two Codex rounds for the sports batch; after round two only high findings block, and medium/low findings
remain in FINDINGS with reproduction/disposition. Every review finding is answered or fixed with failing-before proof.

## Mark's live/device checks (not run here)

1. Record server `/api/version`, Apple Settings version and `/api/info` → `features.sportsDashboard`. The server flag is
   `PIGTV_SPORTS_DASHBOARD=1`; absent/off retains ordinary Sports. Keep it off for normal use pending review/pilot.
2. On an explicitly authorized isolated pilot, inspect all ten follows, a guide-only game, unmatched cricket, an ambiguous
   same-team game, future 72h events, cross-midnight play and a delayed recent final. Final/expired cards must not tune TV.
3. On two devices paired to the same account, change spoilers/delay (0/90/300); check visible-online sync within 30s,
   resume hiding until revalidation, conflict reload, offline hiding and separate-user isolation. Record actual results.
4. Authorize/measure SD-0313-L3 flag-off/on parse/normalize/ingest time and bytes, event-loop delay, HLS p95/p99/max,
   CPU/heap and request/429 counts. Synthetic parser samples do not establish live delivery latency.

## Apple 59 implementation (local gates pass; review/device acceptance pending)

The Sports landing view negotiates C-O and otherwise keeps ordinary Sports. Sport shelves retain seven card families,
canonical league filters use the server's rolling 72h scope (configured team follows remain server-selected), and empty
follows remain named. Logos use existing cached artwork with name fallback. Cards distinguish LIVE/UPCOMING/ON TV NOW,
breaks/stale/buffering/final and availability/recording labels. No render/focus provider probe or warming was added.

Per-client ephemeral state renders preferences and whole delayed data atomically; generation checks, background/resume
hiding, failed-load clearing and revision-conflict reload prevent stale reveal. Visible online refresh is 20s; physical
<=30s two-device sync remains an acceptance target. Long-press projected details/channels/recording actions never use raw
C-I aliases; touch adds a visible options button. Every action re-fetches the projection. Existing preferred-channel
resolve, recording/rule APIs, stable channel identity and explicit takeover remain intact. Upcoming watch revalidates on
wake and cancels on background. No playback-engine, relay or recording-writer change belongs to this slice.

[Capability regression](apple-capability-before.txt) fails at runtime against an exact build-58 archive. The new
account/contract tests include gate-off and unknown-account no-request checks, delayed whole-state decoding, same-account
revision conflicts/sync and separate-user isolation, background late-response rejection and final/expired select refusal.
The real-playback harness selects a revalidated dashboard airing through ordinary resolve, plays bundled HLS and releases.

Own inspection reproduced an airing expiring during response transit: the draft trusted `response.now` after receipt.
A standalone API/model replay of the same synthetic regression fails [before](apple-expiry-before.txt) and passes
[after](apple-expiry-after.txt). Selection now ages airing eligibility with a monotonic round-trip bound; no game clock
or displayed delayed state is extrapolated. `testAiringThatExpiresInTransitCannotTune` is the lasting simulator regression.

First local pass (before final preview/expiry changes): 244 contracts, 239 unit/playback, 17 regression UI pass; iOS build
passes. Xcode's optional simctl diagnostic collector stalled after assertions passed; stopping only that collector let
the command finish successfully. Final snapshot gates use supported `-collect-test-diagnostics never`, preserving all
assertions. **Do not treat the first pass as final-tree validation.**

### Offline edge preview (DEBUG only; invented data, actions disabled)

Set `PIGTV_UI_TEST_SCREEN=sport-dashboard`, `PIGTV_UI_TEST_APPEARANCE=light|dark`, and optionally
`PIGTV_UI_TEST_SPOILERS=hidden`. The existing fixture host supplies no real server. Preview settings change only invented
in-memory data. Select/watch/record cannot resolve or acquire a provider. The new tvOS UI tests attach light/revealed and
dark/hidden screenshots and check accessible score hiding plus long-press options. No simulator or device acceptance
is inferred from simply supplying fixtures.

| Shelf/family | Variants supplied | Still needs Mark's acceptance |
|---|---|---|
| AFL | Basic total points, long names/no logos, no channel, unavailable, buffering, stale, final, guide-only | Focus/layout, explicit indicators, all edge-state rendering |
| NBA | Overtime/clock/points | In-play source clock and TV readability |
| Football (four follows) | Stoppage, extra time, penalties, postponed | Live transitions; aggregates/penalty shootout totals are not promised by current source projection |
| NFL | Overtime, optional down/distance/yard-line | Live availability of richer situation fields; missing extras omitted |
| MLB | Extra innings/count/outs/base occupancy, suspended | Live structured fields; missing extras omitted |
| Cricket | Stumps, rain, innings break, unknown format/unmatched, two days ahead | Multi-day live sessions; L2 identity/format limitation, possible duplicate guide listing |
| F1 | Practice 1/2, qualifying, sprint, race, circuit | GP/session joins; session-only, no driver positions/timing |

All ten follows are essential. This preview does not establish ESPN availability or graphic licensing. Team graphics
come from ESPN team-logo fields via the server logo cache; source/attribution/permitted use still need release assessment.
AFL goals/behinds enrichment, richer NFL/MLB fields and new football aggregate/shootout fields remain optional additions.

### Required Apple review (Mark, round 0 of 2)

Run in PigTV-Swift (separate from media/player-exit build 58):

```
/codex:adversarial-review --background --base 2f0df26 Review Apple 59 sports dashboard only: capability/404 fallback, per-account whole delayed projection, first render/resume/offline score hiding, 20s visible sync, preference revisions/conflicts, spoiler-safe accessibility/details/menus/record sheets, server timezone, stable remote focus/order, cached logos, seven card families and explicit availability/recording labels. Audit every select/channel/record/rule/upcoming-watch action for fresh airing eligibility including response-transit expiry, terminal/final refusal, stable channel identity, account replacement, selected-channel C-I airing association for recording/rules, visible recording-mark refresh/cancellation and close-before-present behavior. Confirm no render provider probes and preserve ordinary C-I/72h schedules. Check fixtures and failing-before evidence; no device acceptance or pilot claim. Round 0 of 2.
```

AGENTS.md assigns this slash command to Mark; no available tool can invoke it here. Keep the two-round stopping rule,
register every remaining finding, and do not claim release readiness until the required reviews/pilot/device evidence.


### Additional own inspection / gate evidence

- A league/time-only duplicate heuristic hid generic C-I coverage beside a different, unidentified catalog game.
  [Failing before](generic-guide-before.txt); fixed by requiring identity candidates for suppression. Generic C-I
  listings remain separate and their channel is never assigned silently to a named catalog card.
- One server full run hit a separate recording master-playlist 404 at test line 959. Its isolated rerun and subsequent
  full 1,312-test run pass. Cause/production impact remain unconfirmed; [complete observation](recording-gate-observation.txt)
  is retained as GATE-20261029-REC1. No recording/media production code belongs to the sports change.
- The Apple recording sheet captures a projected guide title. Dismissal alone could leave that old prose in the
  transition after preferences became unavailable/changed. A policy replay of that unconditional presentation fails
  [before](apple-sheet-before.txt), then passes [after](apple-sheet-after.txt). The sheet now masks its content before
  dismissal whenever its stored preference revision no longer matches a validated response. A lasting unit regression
  covers both nil preferences and a newer spoiler/delay revision.
- Screenshot inspection prompted square team-logo tiles, two-line team names, and primary-color availability text
  beside yellow/red icons for light-mode contrast. Mark additionally requested equal card sizes within each sport
  and no repeated sport name under a labelled shelf. The [before UI regression](apple-layout-before.json) fails:
  normal/missing-data cards measured 389/354pt, and the status repeated AFL. With fixed scaled card dimensions and
  shelf-only sport headings, [all three focused UI checks pass](apple-layout-focused-after.json). Expired-focus
  placeholders reserve the same size. Details retain sport context. [Light/revealed](#files-kept-outside-the-repository) and
  [dark/hidden](#files-kept-outside-the-repository) screenshots are invented offline fixtures, not device acceptance.


### Compact-card feedback (Mark)

The next preview iteration reduces the reserved size, removes “Total points,” shows current game progress OR scheduled
start, and uses top-corner yellow/red availability icons. Their VoiceOver meanings remain explicit; details still name
the reason. [Before](apple-compact-before.json) fails the redundant-label/timing regression; [all three focused UI checks
pass after](apple-compact-focused-after.json). The linked light/dark screenshots above show the compact layout.
An obsolete full UI run was intentionally interrupted when this feedback arrived; it is not a failed assertion or a
final gate. Later full UI/contract/unit/iOS runs pass before the final recording-integration follow-ups, which remain
under validation. No device acceptance is inferred.


### Final integration follow-ups

Server cross-midnight buffering: [two regressions fail before](midnight-before.txt); [50 focused tests pass after](midnight-focused-after.txt).
Neutral pending/unknown cards stay visible through initial delay or missing scores within conservative bounds, even
without a broadcast. Current matched guide airings also retain cards. Eligible historic finals still disappear without
invented retention. Unknown-format cricket stays at 12h; only an existing reliable format uses its normal window.
Final server gate: **1,316 pass**, zero failures/skips, build checks pass.

Apple recording integration: [both new regressions fail before](apple-recording-before.json); [all 11 model tests pass
after](apple-recording-model-after.json). A selected alternate channel now records its own matched C-I airing times,
with the projected spoiler-safe title, and a separate visible activity task refreshes recording marks without delaying
score/preference polling. Both existing endpoints are already covered by Apple route tests. No recording writer changed.
The first attempted before-run stalled before app launch; a local simulator reset allowed actual assertions to run.
That startup interruption is not failing-before evidence; the linked two actual assertion failures are the evidence.

Mandatory review remains 0/2 per repo; include cross-midnight neutral retention, selected-channel airing association and
activity-task cancellation/identity in the focus of the commands above. Device and authorized collector/HLS pilot gates
are still outstanding. The optional-field/unknown-format limits and separate recording gate observation are retained.


## Final local gates and handoff

- Server **0316: 1,316 tests pass**, zero failures/skips; build verification passes. [Summary](server-gates.txt).
- Apple **59: 244 contract checks, 243 unit/playback tests and 20 UI tests pass**, zero failures/skips;
  generic iOS Simulator build passes. [Summary](apple-final-gates.txt), [unit results](apple-final-unit.json),
  [UI results](apple-final-ui.json). Final sources include the compact cards and recording integration repairs.
- Implemented/local-tested is separate from device-accepted: **no device acceptance, deployment, mandatory review or
  authorized collector/HLS pilot is established**. Mark's initial no-visible-issues report has no supplied versions/flag.
- A final partial-catalog reproduction found a later same-team game swallowed behind a completed previous game:
  [observed final before](final-rematch-before.txt), [historic final before](historic-rematch-before.txt). Later guide
  windows remain explicitly unmatched without Watch until the new catalog game arrives. Possible duplicates are safer
  than dropping the game or tuning the old final. Eligibility uses delayed selected completion, not raw current final.
- A cached C-I false live bit refused a just-started airing: [before](airing-boundary-before.txt). Current start/end
  bounds now control airing eligibility, including before-start/after-end refusal. [All 52 focused tests pass](final-focused.txt).
- Remaining: mandatory review 0/2 per repo, SD-0313-L2 unknown-format cricket matching/cadence, SD-0313-L3 authorized
  parse/HLS pilot, the separate recording gate observation GATE-20261029-REC1, graphic attribution/permitted-use review,
  and physical acceptance of every sport/edge state. NFL possession is not displayed; optional NFL down/distance/yard-line
  and MLB count/outs/bases may be absent. AFL goals/behinds remain optional. F1 remains session-only.
- iPhone/iPad share the initial native layout and visible options, but touch/accessibility/device adaptation is not
  accepted. Web dashboard remains unimplemented. Noncanonical guide categories have Today shelves, with no canonical
  league-filter chip; current ten follows are canonical. Their broader future-schedule navigation remains an adaptation
  edge to review before extending category-only usage (Mark's inspected configuration had no marked categories).

Review commands above remain **Mark-run**, under AGENTS.md; no available tool invokes the required slash command.
Include C5/C6 (partial catalogs, later guide windows, cached airing boundaries) and C-I recording association/activity
refresh in the focus. At most two Codex rounds per batch; after round two only high findings block, with every remaining
medium/low reproduction retained in FINDINGS. No finding or gate observation is silently dropped.


A spoiler/delay revision masks captured recording-sheet text but preserves an approved future-watch intent, whose
neutral label has no result prose. The timer revalidates again on wake; backgrounding still cancels it. Include that
combination in device check 3. Native future-watch lifecycle and actual remote focus remain device acceptance gates.

## Files kept outside the repository

Raw or oversized files from this folder are kept off GitHub (decision D-30): on Mark's disk, then the Unraid test
share. Each is still in git history at `665e02e` under its old path. Identify a copy by its SHA-256.

| File (old path under `docs/reviews/`) | Bytes | SHA-256 |
|---|---|---|
| `2026-10-29/sports-dashboard-continuation/dashboard-hidden-dark.png` | 1,287,946 | `95818d1c3a7c629515308490f8ef0754fb44f467c81fdd92f2f38c79db2c3948` |
| `2026-10-29/sports-dashboard-continuation/dashboard-revealed-light.png` | 2,811,532 | `869da634068e87a9ec91e9b3d7f3b5e87c6afa7aab51ebeb1a8836aea745d53c` |
