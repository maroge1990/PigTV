# 0313: sports dashboard 0309 own-review repairs

Reviewed implementation: **4d95f10**, compared with **a6e86e1**. Review author: Claude (own review supplied by Mark).
This is not the mandatory Codex adversarial review. Codex round count remains **0 of 2**.

All production behavior changes have regressions exercised against an unchanged `git archive 4d95f10`, before the
corrected source was copied into the validation snapshot. [Baseline proof](baseline-before.txt): 14 of 16 review cases
fail there. The intentional L2 behavior and the broad performance-budget guard already pass. H1 has separate failing
route and statement-preparation regressions; a performance guard need not fail for the route defect to exist.
[Route proof](route-before.txt): the new reference-path/worker guard fails on 0309's 500 response, as expected.

## Finding dispositions

| Finding | Disposition | Evidence / behavior |
|---|---|---|
| H1 | Fixed | Route uses cached `sportsEvents.eventsResponse`, never the reference `eventsFor`. JSON parsing, catalog reads and projection/join run on one read-only worker, with an eight-job queue and no main-thread fallback. Statements are prepared once; snapshots are read in bulk. Titles/aliases are parsed once and games indexed by league; date formatters are reused. Route tests make either main-thread reference/projection call throw. A 300-game/1,200-airing performance guard uses the standard `PIGTV_SKIP_PERF` helper. |
| M1 | Fixed | Status, channels, availability, broadcastStatus, canWatch and final retention use the eligible delayed snapshot, not `store.latest()`. A 300-second/spoiler-on final-transition probe preserves all broadcast fields while delayed state is live, then disables Watch when the final becomes eligible. A later correction also cannot remove an earlier delayed final through current catalog metadata. Final-transition timestamps are persisted with snapshots; 0309 history is upgraded before the read-only worker opens it. |
| M2 | Fixed, bounded; live-service acceptance still pending | Measured original collector with all configured league paths + 40 cricket series: cold **319**, next tick **126** calls (mock network, actual collector). Repair: **12 maximum network attempts per tick**, including discovery; two in flight at most. Only known live/playing-break/near-start source dates get 30-second cadence; inactive/catalog dates use 15 minutes. Eligible hot work is prioritized; otherwise least-recent attempts rotate. Shared host cooldown on 429/5xx covers both new score requests and legacy fixture requests, honors bounded Retry-After and preserves last-good data. No assertion that ESPN grants this rate or guarantees service. |
| M3 | Fixed | Parent and competition cricket endDate hints are not trusted as actual match ends. Join windows: T20 4.5h; ODI/List A 9h; Test/first-class 5d; unknown format 12h. Three same-team matches two days apart join individually. Women's T20 labels normalize to T20. If windows still overlap, a start clearly nearer by at least 1h wins; ties/near-ties remain unmatched. |
| L1 | Fixed | Follow selection is a union: a marked EPG category or whole-league follow includes that league; team-only follows narrow it only when neither broad selection applies. C-O documents it and a category-plus-team regression fails on 0309. |
| L2 | Answered, deliberately retained | No trustworthy completion time is available for a first-seen historic final. It may appear buffering/unknown until its delayed snapshot is eligible, then is omitted; no invented one-hour result is created. Restarted history with an observed transition retains its timestamp. This behavior is explicitly tested and documented in C-O and FINDINGS.md. |
| L3 | Fixed by batching | One ingest transaction per collection tick, preserving each payload's actual observation timestamp. Cached/no-new observations are filtered before the batch. Identical newly received snapshots may still be recorded: collapsing them without separate receipt/validity metadata would undermine delay/freshness semantics. |
| L4 | Fixed | Route tests use a nonempty cached airing and exercise actual worker-backed matching, channel whitelisting, stable identity, Watch eligibility and separate users. They reject both `eventsFor` and main-thread projection. The realistic projection perf test is skipped under `PIGTV_SKIP_PERF` like existing budgets. |

## Cricket endDate investigation

[Reduced captured fields](cricket-end-shapes.json) come from the already-downloaded 29 October feasibility captures;
no new source/deployed/provider request was made. Examples:

- ODI `1550286`: starts `2026-10-28T21:30Z`, both end hints say `2026-10-30T23:59Z` (over two days later).
- T20 `1559959`: starts `2026-10-28T14:00Z`, both end hints say `2026-10-29T23:59Z`.
- Women's T20 `1543944`: starts `2026-10-29T04:40Z`, both end hints say that day's `23:59Z`.
- Test and first-class captures also have matching event/competition midnight envelopes.

These values do not establish a real match-end timestamp, and this review does not claim to know the publisher's exact
semantics. Cricket cards therefore keep `end: null` and matching uses the explicit format windows above. Other sports'
competition end handling is unchanged. Windows are join eligibility bounds, not inferred live clocks or completion.

## Operational limits and safety

- Feature remains off unless `PIGTV_SPORTS_DASHBOARD=1`; no new UI, deployment or provider-consuming test.
- The hard network ceiling is global across the dashboard collector's sources/dates. The existing 30-minute fixture
  service keeps its schedule, but shares cooldown state after upstream throttling/errors. Fixtures/history are retained;
  a cooldown is never authoritative evidence that a game vanished.
- Budget-deferred catalog work warms over later ticks. A stopped/overnight cricket match without a verified upcoming
  resumption time uses the slow cadence until a fresh source observation confirms play; do not invent a restart time.
  Cold/partial coverage and live update lag still require acceptance before enabling the feature for normal use.
- Current guide airing bounds still control whether a broadcast is on TV. A future raw score transition cannot change
  the delayed card's eligibility; the normal resolve flow still handles admission/vanished channels. Clients must
  revalidate an airing at selection, and must not interpret the advertised channel as a reserved provider connection.
- Ordinary playback, recording and `/sports/events` response shapes are unchanged. No ffmpeg/timestamp changes.
- Existing fixture unit scenarios reset cooldown between their independent fake timelines; their original behavioral
  assertions remain. A new test proves the real fixture and score clients actually share the cooldown.

## Validation and mandatory review

Final local gates: **1,297/1,297 tests pass**, no skips, and **all build-verification checks pass**. Validation parent:
`507d05d` (committed 0312), with only sports code/tests/docs and the 0313/0314 version metadata overlaid. No uncommitted
recording/relay/toolchain edits were included. Code hashes matched the working sports files after the run. The worker
route and all 16 review cases pass; projection measured **14.5 ms** for 300 games/1,200 airings against a 100 ms budget
(on the worker in production). The mock collector reports **12 cold / 12 next tick** versus **319 / 126** on 0309.
[After evidence](review-after.txt), [full-suite summary](full-suite-summary.txt), [build verification](build-verification.txt).

Tests run in an archive of committed main with only the sports files overlaid, excluding concurrent uncommitted work. Baseline reproduction uses the exact reviewed 4d95f10 source. No tests depend on public network.

The user's own review is answered; the mandatory Codex adversarial review has **not run**. AGENTS.md assigns the slash
command to Mark. Use the final reviewer-return prompt to inspect these fixes, then run Codex against the 0309 feature
and these repairs. Focus on worker/read-only isolation, delay/retention and migration, host-wide cooldown/budgets,
format-bounded joins, selection union, cached event integration and unchanged playback/recording behavior.


## Reviewer-return prompt

Review local build 0313 (the sports own-review repair commit on main) against 4d95f10, for approval of the original
H1/M1–M3/L1–L4 findings. Use this record and FINDINGS.md for the individual dispositions and baseline/after evidence.
Do not assume behavior beyond code/tests; inspect the actual worker and cached-event route, snapshot migration and
retention, delayed action fields, shared-host traffic policy, cricket windows/ties, category/team union and batched
writes. L2 is deliberately answered, with a test of the retained behavior. The baseline archive has 14/16 failing
review cases, while L2 and the broad perf guard already pass; separate H1 route/prepare tests fail on 0309.

The repair validation is 1,297 passing tests plus build verification, feature off by default, no push/deployment or
provider-consuming tests. The intervening 0310–0312 recording/relay/toolchain commits are a separate batch; inspect them
only if a demonstrated interaction affects these sports fixes. Return approval or remaining findings with severity,
code locations and a concrete reproduction. Own-review approval does not replace the mandatory Codex review: it has
not run and remains round 0 of 2.

Mandatory Codex review command for Mark, after own-review repair approval:

```
/codex:adversarial-review --background --base a6e86e1 Review sports dashboard 0309 and 0313 repairs: cached-event/read-only worker isolation, per-user authorization and spoiler projection, delayed eligibility and final-retention migration, global ESPN request ceiling and shared-host cooldown, bounded cricket joins/ties, category/team selection and batched history writes. Check C-O against code; exclude unrelated 0310-0312 media repairs unless a concrete interaction affects sports. Playback, recording and /sports/events shapes must remain unchanged.
```

No real-feed or device acceptance is claimed. Once review/UI are complete, Mark should:
1. Enable the flag on a pilot, inspect a 300-game catalog while another device plays, and check HLS responsiveness.
2. Use two devices for one user plus another user's login; check spoiler/delay sync, live/break/final transitions and
   unchanged delayed Watch fields when the undelayed source first finishes.
3. Check consecutive same-team cricket fixtures, missing channels and 72-hour sport views; inspect cold catalog fill
   and request counts under the cap, and adjust cadence only with observed service evidence.
