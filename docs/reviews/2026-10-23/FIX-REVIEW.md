# Review of provided fixes — 23 October 2026

**Verdict: substantial progress, but do not close the original review yet.** Reviewed the 15 functional server commits 0227–0241 (`872517b` through `f026c63`) and Apple47 `ac7f186`, newest available implementations against the original intent and acceptance criteria. Among the 25 original findings: **13 addressed in the reviewed implementation, four partially addressed, eight untouched**. The additional vanished-favourite concern is addressed by 0229. “Addressed” is source/local-test confidence, not physical-device acceptance.

No application code was changed, committed, pushed or deployed. No deployed server or provider was contacted. Temporary browser test files were removed after use; saved evidence here deliberately reproduces defects and is not an expected-correct test suite.

## Remaining problems in supplied fixes

### F1 — P1: original retention can accept a different file and delete the real source

At [recordingSegments.js:489](/Users/markrogers/Documents/GitHub/PigTV/server/services/recordingSegments.js:489), an existing companion TS is accepted solely because its length equals the total segment bytes. The caller then removes the actual segments. Reproduced using a 4096-byte original filled with zeros and an unrelated existing 4096-byte TS filled with 99: finalization reports “Original kept”, retains the unrelated file, and deletes the work directory. The new test covers a different-size collision, missing this case.

This is introduced by the 0227 retention repair. Prove ownership/content of an existing original, or publish to an exclusively reserved companion path. Do not rely on size or check-then-rename for identity/no-overwrite guarantees. Add equal-size/different-content and concurrent-publication cases before deleting source segments.

Evidence: [dvr-retention-fix-repro.cjs](dvr-retention-fix-repro.cjs). DVR-1 remains open.

### F2 — P2: original-copy work is marked done before it can survive a restart

At [recordingSegments.js:461](/Users/markrogers/Documents/GitHub/PigTV/server/services/recordingSegments.js:461), the share-available path persists `segment_state: done` before awaiting the retained-original copy. Restart recovery selects only finishing/moving. A crash while copying therefore leaves source segments in appdata and a partial on the share, but no queued recovery or waiting status. The original survives; this is orphaned recovery work, not immediate loss.

The reproduction inspects durable state immediately before the copy opens and confirms it is absent from `findSegmentWork()`. Persist a pending/moving state until the original is safely published, then mark done. Test restart/reopen while the copy is paused.

Evidence: [dvr-retention-crash-state-repro.cjs](dvr-retention-crash-state-repro.cjs). Second incomplete DVR-1 boundary.

### F3 — P2: immediate recording failover still starts after cancellation/shutdown

At [recordingEngine.js:1006](/Users/markrogers/Documents/GitHub/PigTV/server/services/recordingEngine.js:1006), immediate ordinary recording failover awaits `feedFor()` then unconditionally calls `spawnPart()`. Its old active entry has already been removed; the new initial-start and continuation guards do not own this path. `cancelScheduled()` cannot find it, and `stopAllActive()` returns without cancelling it.

Reproduced with the real engine and synthetic child/feed: primary fails, hold backup subscription pending, cancel then stop all, release the feed, and backup ffmpeg starts. Extend cancellable ownership/generations to this immediate failover and its settings await; release late feeds, update schedule status, and assert no post-cancel spawn.

Evidence: [failover-cancel-reproduction.cjs](failover-cancel-reproduction.cjs). DVR-4 remains open; 0232 fixes other startup paths.

### F4 — P2: six-hour title matching is not durable sport-event identity

At [recordingRules.js:189](/Users/markrogers/Documents/GitHub/PigTV/server/services/recordingRules.js:189), 0237 broadens the old ±15-minute title match to ±6 hours. Two distinct same-title events three hours apart now collapse into one schedule. A cancelled event moved seven hours still returns. Both reproduced against the real rule service with distinct synthetic event IDs.

The changed contract documents the heuristic, but that narrows the original intent instead of satisfying it. Introduce event-instance identity/disambiguation and cancellation continuity, testing both close distinct matches and larger genuine corrections. If product policy deliberately accepts a heuristic, get that decision explicitly; don't label the durable-identity finding closed merely because 20-minute and two-hour examples pass.

Evidence: [dvr-rule-fix-repro.cjs](dvr-rule-fix-repro.cjs). DVR-3 remains partial, with new over-suppression within six hours.

### F5 — P2: channel-list focus is still lost beyond the initial rendered batches

At [ChannelList.js:478](/Users/markrogers/Documents/GitHub/PigTV/public/js/components/ChannelList.js:478), restoreFocus only searches existing DOM. `render()` rebuilds the first two 100-group batches; a previously focused channel/header in a later group has no replacement node yet, so restoration does nothing. The IntersectionObserver eventually adding the group does not retry focus.

Independent browser check: provided harness cases pass, but with 205 synthetic groups, focus on `late204` becomes `BODY` after render. Render the required batch/group before restoration, or retain pending focus ownership until it exists. Include disappeared-group fallback. Existing one-group/c9 harness cannot establish this acceptance case.

Evidence: [focus-large-list-reproduction.html](focus-large-list-reproduction.html). W2 remains partial.

## Original finding dispositions

| Original ID | Provided fix | Verdict |
|---|---|---|
| I1 | 0230 absolute readiness/reconnect deadline and close rejection | Addressed in reviewed source/local regressions |
| PB1 | 0231 transcode startup cancellation | Addressed in reviewed source/local regressions |
| PB2 | 0233 shared upstream takeover membership/release | Addressed in reviewed source/local regressions |
| PB3 | 0234 fresh recording snapshots for admission | Addressed in reviewed source/local regressions |
| PB4 | 0236 safe proxy error text | Addressed in reviewed source/local regressions |
| PB5 | 0235 browser resolve generation/abort/release | Addressed for reported pending resolve and stale-decision cases |
| DVR-1 | 0227 original retention | Partial: F1/F2 |
| DVR-2 | 0228 stable schedule identity | Addressed in reviewed source/local regressions |
| DVR-3 | 0237 sport cancellation window | Partial: F4 |
| DVR-4 | 0232 recording startup ownership | Partial: F3 |
| DVR-5 | 0227 TS output pipeline errors | Addressed in reviewed source/local regressions |
| A1 | Apple47 scoped local resume | Addressed in source; simulator/device evidence limits below |
| A2 | None | Open: Top Shelf can publish after logout |
| A3 | None | Open: recording-rule mutation errors invisible |
| A4 | None | Open: corrected guide data not propagated immediately to visible cells/layout |
| A5 | None | Open: disk cache cap enforced only at launch |
| W1 | 0238 navigation invalidates pending window on cached return | Addressed in reviewed source/local regressions |
| W2 | 0239 focus identity restoration | Partial: F5 |
| S1 | 0240 all-excluded successful sync purges | Addressed in reviewed scope |
| S2 | 0240 blockers rechecked before destructive application | Addressed for reported stale-guard interleaving |
| S3 | 0241 unique partial ownership/no-replace publication | Addressed in reviewed scope; six-hour foreign-partial expiry remains an operational assumption |
| S4 | None | Open: event-slot placeholder IDs cross-link games |
| S5 | None | Open: partial ESPN results falsely count as full coverage |
| S6 | None | Open: artwork body lifetime unbounded after headers |
| S7 | None | Open: sibling status change misses guide-version invalidation |

0229 also fixes unavailable identified favourites: no positional playable ID, with authenticated identity-based deletion. Original iPhone Tuning and AUS v SA reports still require their actual device/feed evidence. Efficiency proposals from the earlier review are not completed by these correctness commits; A5 and S6 include particularly relevant resource bounds.

## Validation and limits

Independent focused Node24 tests: **137 passed** (42 ingest/session/shared-takeover + 25 provider-failover + 40 DVR/identity/import/backup/rules + 8 segmented safety cases + 22 web navigation/player/proxy). Some first sandbox attempts failed to bind localhost; permitted reruns passed and are the results counted here. No full npm suite or verify-build rerun was performed in this review; supplied commits report both passing. Do not treat those author-reported results as fresh independent runs.

Four saved Node scripts reproduce F1–F4, with the two DVR-1 defects in separate scripts. Their passing assertions mean current faulty behavior was reproduced. The browser ran the supplied focus harness and an extended 205-group case; the former passes, the latter reproduces F5. To run the extended HTML with `test/browser/serve.js`, temporarily serve it from public under a test-only filename (scripts use `/js`), then remove it. No production API is needed.

Apple A1: all production readers/writers/authenticated client installation paths were inspected. Existing reviewer log has 243 synthetic contracts passing, which does not mean the new isolation XCTest/UI cases were independently run. The commit reports push-tier/iOS build success and a timing-flake rerun. It explicitly lacks failing-before behavioral proof because new APIs do not compile on the old version. Add a compatible mutation/baseline isolation proof; preserve explicit timeout/two-server/logout/disabled-feature acceptance. No fresh simulator or physical-device acceptance was established here.

Detailed companion notes: [DVR](DVR-FIX-REVIEW.md), [playback](PLAYBACK-FIX-REVIEW.md), [Apple](APPLE-FIX-REVIEW.md). Their temporary log paths are diagnostic references; durable repro sources are saved beside this report.

## Handoff to original agent

Continue from server0241/Apple47. Read this report and fix F1–F5, then complete untouched A2–A5 and S4–S7 from the original review. Keep original IDs open until their full intent is met. Prioritize F1 data preservation and F3 cancellation ownership. Add expected-correct tests that fail on this snapshot, rather than copying defect-asserting scripts unchanged. Preserve current passing corrections, stable identity and original-retention safety. Run required repository checks, update contracts and blueprint state, one logical local commit per fix with build bumps; never push/deploy. Ask Mark before deployed/provider access, follow capture requirements for playback changes, and retain device acceptance as pending until reported.
