# DVR/import/backup fix review — 23 October 2026

Reviewed current server f026c63 (0241), actual diffs 0227–0229, 0237, 0240–0241, current owners and added tests. No application edits, provider requests or deployed-server access.

## Actionable remaining/new findings

1. **P1: an unrelated same-size TS is mistaken for the retained original, then the real original is deleted.** `server/services/recordingSegments.js:488–490` accepts an existing companion `.ts` solely by total bytes. A collision with the same length but different bytes is not proof this recording was copied. `finishOne` then deletes the work directory at 469. Synthetic real-module/SQLite proof `/tmp/dvr-retention-fix-repro.cjs`: one original 4096-byte segment of zeros; pre-existing companion TS is 4096 bytes of 99; finalization reports Original kept, preserves the unrelated bytes, deletes the actual segments. Added regression only uses a different-size conflicting file. Require owned publication/provenance or content verification before accepting a pre-existing original; reserve MP4 and companion together and add equal-size/different-content regression. Existing check-before-rename `exclusive` is also not an atomic no-replace publication, so reserve/link exclusively rather than relying on existsSync.

2. **P2: interrupted original-copy work is persisted as done, so restart never resumes it.** `recordingSegments.js:461–467` stores done while keepOriginal's potentially long stream copy has not begun/completed. `recordingsDb.findSegmentWork` (583) selects only finishing/moving. Crash/kill during that copy leaves the real original safely in appdata, but permanently outside recovery and status waiting lists; the partial on the share remains, and the promised move never retries. This is recoverable orphaned work, not immediate data loss. `/tmp/dvr-retention-crash-state-repro.cjs` observes the persisted done row and absence from findSegmentWork just before createWriteStream opens the original copy. Persist moving until original publication completes and regression-test reopening the queue/database during a paused copy.

3. **P2: DVR-3 is only a wider time heuristic, and now suppresses distinct same-title sport events within six hours.** `server/services/recordingRules.js:187–193` replaces ±15 minutes with ±6 hours, without comparing stable event identity. Two distinct scheduled events with the same teams/title three hours apart are treated as the same event, so the second is missed (e.g. a doubleheader). A cancelled real event moved seven hours still returns. `/tmp/dvr-rule-fix-repro.cjs` proves both behaviors against the actual service with synthetic events and SQLite. The new contract documents this limitation, but does not deliver durable cancellation identity requested in the original audit; the regression only proves 20-minute/two-hour corrections and a distant 60-hour rematch. Require a stable event/cancellation identity or explicit match-instance disambiguation, with close distinct-event and >6-hour genuine correction tests. A heuristic-only policy needs deliberate product acceptance; do not mark the original intent fully resolved.

## Verdicts

- DVR-1 / 0227: ordinary and share-down keepOriginal paths now preserve segments, but **partial** due findings 1–2.
- DVR-5 / 0227: **fixed in reviewed scope**. Pipeline owns readable/writable failures, backpressure and partial cleanup; targeted cases pass.
- DVR-2 / 0228: **fixed in reviewed scope**. M3U stable-ID misses do not fall through in resolver/currentItemId/guide-end; no-identity legacy path remains. Xtream stream IDs are native identity, so its separate path is intentional.
- Vanished-favourite residual / 0229: **fixed in reviewed scope**. Missing stable row returns null item_id/unavailable, composite conversion skips it, identity deletion remains per authenticated user. Existing library path unaffected.
- DVR-3 / 0237: **partial**, finding 3.
- S1 / 0240: **fixed in reviewed scope**. Successful nonempty provider input allows intentional empty purge; empty/failed provider response preserves lineup; M3U positional accounting still includes filtered entries.
- S2 / 0240: **fixed for reported stale-guard interleaving**. Recheck before import and immediately before synchronous purge retains newly protected groups; stable-aware blocker joins no longer match reused positions. No additional independently established defect in assigned scope.
- S3 / 0241: **fixed in reviewed scope**. Exclusive unique partial per copy, atomic no-replace hard-link publication, cleanup scoped to owned failed partials, recent foreign partials protected. Six-hour stale-file assumption remains a documented operational bound, not tested against a six-hour-stalled separate-process backup.

## Validation

Node24 permitted targeted suite: **40/40 pass** across db-backup, import-exclusions, recording-stable-channel, recording-guide-end, recording-rules, favorites-current-item-id. Log `/tmp/dvr-fix-targeted-permitted.log`.
Node24 permitted DVR-1/DVR-5 filtered recording-segments: **8/8 pass**. Log `/tmp/dvr-segments-fix-targeted.log`.
All three additional synthetic scripts above reproduce current defects; their exit-zero assertions describe defective behavior and are not fixed-code regression tests. First sandboxed combined test attempt hit localhost restrictions and was terminated; use permitted results, not sandbox failures, to judge product correctness. No fresh media/device acceptance established.
