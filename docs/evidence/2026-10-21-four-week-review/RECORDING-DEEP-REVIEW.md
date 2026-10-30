# DVR/recording deep review — 22 October continuation

Snapshot: server `a104726` (0226). Review window remains 23 September–21 October 2026, newest first. Application code is unchanged. This report covers recording service/route/schema changes plus directly related settings, coordination and media changes. It separates newly introduced defects from inherited defects and retired implementations. No deployed server, real provider, or real recording was accessed.

## Reproduced findings

### DVR-1 · P1 · Segmented finalization deletes media the verification result says to retain

Introduced by `1e479d6` (0218), current `server/services/recordingSegments.js`, `finishOne()`. `media.checkPrepared()` can return `{ok:true, keepOriginal:true}` if the source duration cannot be read or either audio decode check cannot run. Ordinary preparation explicitly honors this result. Segmented finalization checks only `!check.ok`, publishes the MP4, then `removeWork(rec)` deletes every original segment. If the share is unavailable, the same originals disappear when `moveOne()` later removes the work folder.

This defeats the safeguards added in 0193/0203: a playable output is not necessarily an adequately verified replacement for the original. On these degraded checks, the recording may be shorter or have damaged audio that was never verified, and no recovery source remains.

**Reproduction:** `recording-deep-reproduction.cjs` uses actual SQLite/segmented finalization with synthetic ffmpeg results. Source duration is unreadable, output duration is positive and codecs exist. `checkPrepared.keepOriginal === true`, but after finalization the archive work directory no longer exists. No media process or network runs.

**Required fix/test:** carry verification retention through both immediate publication and deferred move. Preserve/locate the archive when checks are inconclusive, expose that retained state, and make later deletion explicit and safe. Test unknown original duration and failed audio-check execution separately, with both share available and share-down/move paths. Keep ordinary and segmented preparation aligned.

### DVR-2 · P1 · Missing stable channel identity falls back to another channel's playlist position

Two manifestations:

- `recordingEngine.resolveStreamUrl()` falls through from a failed stable-ID lookup to the old `pos_N` lookup. This core defect predates the window (`5e33b82`, 21 September); 0177 routing still relies on it and `currentItemId()` repeats the fallback.
- `recordingGuideEnd.tvgIdFor()` introduced in `d110f79` (0214) queries `(item_id = oldPosition OR stable_id = savedIdentity)`, merely preferring the stable match if present. If absent, the unrelated replacement channel supplies its EPG.

The first can record the wrong channel after a channel disappears and its position is reused. The second can extend a schedule from an unrelated channel's programme; the same-start renamed-programme allowance makes a matching title unnecessary. Both violate the repository rule that an existing stable identity must never fall back to stored position.

**Reproduction:** the script inserts only a replacement channel at `pos_1`, while the schedule retains a different, missing stable identity. Resolution returns the replacement stream and guide-follow extends the schedule by one hour from the replacement channel's unrelated programme.

**Required fix/test:** when stable ID is present, resolve exclusively by it; fail/skip safely when absent. Positional compatibility applies only to legacy rows lacking stable identity. Apply the same policy in `currentItemId`, guide-end lookup and all schedule-derived channel queries. Extend tests beyond moved-but-still-present identities to disappearance, exclusion and reused positions.

### DVR-3 · P2 · A cancelled sport rule recording returns after a guide move over 15 minutes

Introduced by `5d5b449` (0219), `recordingRules.alreadyScheduled()` and `evaluate()`. The cancellation memory records the previous event identity, while Sport's event ID changes with its time. The secondary cancelled-schedule match searches only ±15 minutes around the new time. A 20-minute correction therefore evades both protections and creates a fresh schedule.

**Reproduction:** create a Collingwood sport rule, evaluate, cancel the schedule, shift the synthetic event 20 minutes and change its identity, evaluate again. One new scheduled recording appears. Existing regression coverage moves by only 10 minutes. The contract says a viewer cancellation is never remade even when guide time moves; implementation currently guarantees only a small nudge.

**Required fix/test:** persist cancellation against a stable event/episode identity, with a deliberate policy for rescheduled events and separate later matches. Add >15-minute movement tests and ensure an unrelated subsequent meeting of the same teams is not suppressed. Do not simply widen the title/time window without considering that distinction.

## Additional source-confirmed gaps needing targeted regression tests

### DVR-4 · P2 · Cancellation can be overtaken by asynchronous recording startup

`startPartLeased()` validates a lease before awaiting storage/settings and `feedFor()`, then creates the recording and unconditionally writes schedule status `recording` without re-reading cancellation state or checking the lease again. `startSegmented()` has the same await-before-spawn shape. `cancelScheduled()` sees `scheduled`/`waiting` during that interval and marks it cancelled; later start code can overwrite it. The new ingest await in 0223 broadens this interval substantially, including the first-pass ingest hang case.

Segmented continuation also removes its continuation entry before awaiting `feedFor()`; cancellation during that wait sees neither an active process nor a continuation. A complete fix needs a start generation/cancellation owner and post-await checks, not only a UI action change. Source-confirmed interleaving, not yet dynamically reproduced here. Add controlled deferred-feed tests for initial start, continuation, viewer lease takeover and shutdown; ensure no ffmpeg starts and any obtained subscription is released after cancellation.

### DVR-5 · P2 · Segmented TS fallback has no output-stream error listener

`recordingSegments.deliverTs()` creates a destination write stream but attaches no `error` listener to it. Its per-file promise handles only input `error`/`end`, and `out.end(callback)` does not substitute for an EventEmitter error handler. If the share disconnects or fills while this last-resort write runs, an emitted output error can become an uncaught exception instead of entering the surrounding catch and retaining the segments. The path is reached after three failed MP4 attempts. Use a stream pipeline/finished owner that handles both sides and backpressure across the whole concatenation. Inject output open/write failure and verify no process-level uncaught exception, no completed row, and originals retained. Source-confirmed; no deliberate full-disk test performed.

## Verification performed in this continuation

`PATH=/opt/homebrew/opt/node@24/bin:$PATH node docs/reviews/2026-10-21/recording-deep-reproduction.cjs` passed all four defect assertions (DVR-1, both DVR-2 manifestations, DVR-3). The script intentionally asserts current faulty behaviour; convert these into normal expected-correct regressions during fixes. It creates and removes an isolated temporary server/database, mocks media tools, and contacts no network.

The full server suite/build-check results in the main review are prior review results, not independently rerun by this worker. No device or production ffmpeg acceptance is claimed.

## Exact source locations for handoff

All line numbers below refer to snapshot `a104726`, not the introducing revision.

| Finding | Repair locations | Existing tests to extend |
|---|---|---|
| DVR-1 | `server/services/recordingSegments.js:422` (verification), `:448` and `:476` (archive removal); compare `server/services/recordingMedia.js:565` | `test/recording-segments.test.js`, `test/recording-prepare.test.js` |
| DVR-2 | `server/services/recordingEngine.js:162` and `:200`; `server/services/recordingGuideEnd.js:51` | `test/recording-stable-channel.test.js`, `test/recording-guide-end.test.js` |
| DVR-3 | `server/services/recordingRules.js:180` and `:216` | `test/recording-rules.test.js` |
| DVR-4 | `server/services/recordingEngine.js:653`, `:757`, `:1095`; cancellation at `:537` | `test/ingest-recordings.test.js`, `test/recording-failover.test.js`, `test/recording-segments.test.js` |
| DVR-5 | `server/services/recordingSegments.js:374` | `test/recording-segments.test.js` |

## Newest-first commit coverage and intent/outcome ledger

Selection uses explicit midnight/timezone boundaries, not a date-only `--since` (which can inherit the current time). Command: `git log --since='2026-09-23T00:00:00+10:00' --until='2026-10-21T23:59:59+11:00' -- <recording service, route and database paths>`. Entries below track recording-related intent; a multi-feature commit's unrelated changes belong to the other review workers. “Present” means the intended code path survives at HEAD and was inspected, not production/device verification. Relevant diffs and current paths were examined; historical tuner implementation is assessed through its deletion and replacement rather than treated as a delivered current feature.

| Commit | Recording-related intent | Outcome at reviewed HEAD |
|---|---|---|
| `bb53f28` 0225 | Join existing shared ingest when choosing recording provider | Current selection uses the existing ingest and the newer admission path. Supersedes the phase-5a approximation; aggregate connection correctness must be assessed against 0225, not 0223 alone. DVR-4 remains. |
| `14597ae` 0224 | Drain all queued ingest bytes and start opener at its first PAT | Recording consumer updated to the revised feed flow. Earlier feed behaviour cannot be counted as final. Integration still needs cancellation during pending subscription (DVR-4); core ingest review belongs to playback worker. |
| `dd942a1` 0223 | Put recording captures onto shared Node HTTP ingest, preserve output args and provider failover | Present behind setting; both ordinary and segmented captures consume pipe input, release subscriptions on close and classify provider feed loss. Adds asynchronous startup gap in DVR-4. Parent also records ingest readiness failure. |
| `9236a60` 0220 | Snapshot guide artwork for scheduled and saved recordings; return opaque logo URLs | Present: image copied to both capture types; list response uses logo registry, active list strips raw image URL. No additional proven DVR defect identified. Real guide image and Apple/web fallback appearance remain acceptance. |
| `5d5b449` 0219 | Team/league/series rules with duplicate prevention and cancellation memory | Present, but cancelled sport event can return after >15-minute movement (DVR-3). Existing short-nudge test is insufficient. |
| `1e479d6` 0218 | New segmented recordings, from-start viewing, restart/failover continuity and verified MP4 publication | Present behind setting; this is a new implementation, not resurrection of old tuner architecture. DVR-1 and DVR-5 undermine safe finalization; cancellation ownership remains incomplete. Device continuous timeline/seek and real feed changes remain acceptance. |
| `ba93756` 0215 | Notify on recording failure | Hook present on an actual transition to failed; notifier is best-effort. It does not claim notifications for every partial/completed-with-warning outcome. No additional recording hook defect identified. |
| `d110f79` 0214 | Follow guide changes to programme end | Present with bounded matching/extension, but channel lookup can use unrelated replacement identity (DVR-2). |
| `03a585b` (0207 implementation) | Recording delete cleanup, per-login resume, live comskip and recordings UI updates | Server changes survive split: recordingPositions keyed by user; delete clears derivatives/jobs; live detection processes capture with shutdown/abort handling. No new confirmed defect in reviewed ordinary path; deletion while async jobs publish needs explicit race acceptance. `ff5780e` is the version/wrap commit, not the implementation to review. |
| `7d00647` | Split capture, media, postprocess and jobs modules | Structural split survives. Current behaviours traced across modules; do not classify as an independent playback fix. |
| `a641db0` | Remove abandoned tuner model and rollback switches | Old T2/T4 recording implementation removed. Ordinary capture/preparation retained; 0218 later supplies current segmented feature. Historical tuner success tests are not evidence for 0218. |
| `c3a7b07` 0203 | Capture MPEG-TS; prepare with AAC encoding and verify audio before deleting source | Ordinary path implements retention when checks cannot complete. Corrective follow-up to 0193, so 0193 alone is not final evidence. New segmented path fails to honor the retention result (DVR-1). |
| `8580524` 0200 | Expose recording background work in Status | Queue state survives module split; primarily observability. Does not establish background jobs have deadlines or cancellation coverage. |
| `205db98` 0198 | Reserve provider lease before probe/start | Lease ownership integrated with recording start and release. New awaited feed creates later stale-owner risk; see DVR-4 rather than assuming admission lease guarantees cancellation. |
| `b52ec54` 0196 | Require signed-in media and session access | Recordings media guard retained; no identified DVR-specific authentication bypass. Broader auth review is separate. |
| `c684be0` 0194 | Make recording route file access asynchronous | Route stat/read operations converted, preserving range behaviour. Scope is routes: synchronous archive scans and folder checks elsewhere still block the event loop. |
| `4f49f2f` 0193 | Prepare before Play and verify compression before deletion | Queue and checks present, subsequently corrected by 0203. Must evaluate final 0203 checks and 0218 consumer together: original-retention result is lost in segmented finishing. |
| `29f4adf` 0192 | Parse ffprobe codec output by JSON fields | Present in recordingMedia; addresses field-order problem. Codec probe fix does not imply every media subprocess has a deadline. |
| `63dd48d` 0177 | Provider failover and partial recordings | Present in current capture/continuation paths; segmented implementation extends it. Missing stable identity can route to replacement slot (DVR-2 inherited resolver; new currentItemId fallback). Awaited continuation cancellation requires DVR-4 test. |
| `7651fd0` 0173 | Per-provider connection budgets | Provider identity propagated through records/active entries; later leases and ingest modify accounting, so inspect 0198/0225 for final behaviour. |
| `e8e7dd0` 0167 | Reject relative recording paths | Current validator explicitly rejects nonabsolute paths. Follow-up closes an actual gap left by 0157/0160. |
| `3c2326a` 0160 | Avoid creating recording folders under disconnected tiny mounts | Parent and tiny-filesystem checks survive. Heuristic detects the documented tiny mount; it is not a universal network-share liveness proof. |
| `3c91e86` 0157 | Diagnose missing, unwritable, tiny and low-space recording destinations | Current checks distinguish cases and are used before starting/publishing. Later 0160/0167 address missing parent-volume and relative-path cases. Live unmount during write still requires DVR-5. |
| `349276f` 0156 | Keep missed/failed schedules visible and log status transitions | Present, seven-day opt-in recent list and transition logger; later 0207 handles deletion from history. No additional confirmed defect. |
| `c8cb4e1` 0138 | Support suffix and overlong byte ranges | Current range route retains suffix/clamping behaviour after async refactor. No additional confirmed recording-range defect. |
| `32da410` 0137 | Express 5 route syntax | Recording routes survive subsequent auth/async modifications; version migration itself is not a DVR feature. |
| `be14f17` 0136 | Auth migration | Recording route wiring subsequently tightened by 0196. No independent final DVR feature claim. |
| `d0a98ee` 0131 | Release dead tuner and reacquire for recordings | Superseded: tuner model deleted by `a641db0`. Current reconnection/failover is 0177/0218/0223; cannot claim the old implementation is still active. |
| `120c640` 0129 | Watch tuner-backed recordings while capturing | Superseded by tuner removal. Current counterpart is 0218 with separate storage/timeline design and acceptance requirements. |
| `bd7e77a` 0127 | Capture tuner segments into recordings | Superseded by tuner removal. 0218 archives independent epochs in appdata and finalizes separately; old tests do not prove this implementation. |
| `1c7ceec` 0119 | Opaque playback handles/redaction | Recording-route related migration retained through later auth revisions; broad proxy/handle validation belongs to security/playback audit. |

Related history explicitly considered: tuner foundation `9ff958f` (0126), timeshift directory `761724f` (0128), capability default `f996769` (0130), tuner directory handling `8ec1091` (0132), compatible join `555a21f` (0155) and prompt expiry `3d2216f` (0158). These are dependencies or coordinator changes rather than additional recording implementation delivery. Tuner-specific paths were removed, while provider admission/prompt handling continues through later coordinator code. Test-only follow-ups such as `bee5ff4` (segmented capture exit/watch) and `2467ff7` (failover isolation from preparation) improve test isolation/coverage but do not resolve findings above. This ledger is not a claim that every nonrecording line of those commits received this worker's review.

## Efficiency opportunities and remaining acceptance

1. **Bound archive work per tick/request.** `recordingSegments.captureBytes()` (`:134`) synchronously readdir/stats every segment in the current epoch for every growth check. `isWatchable()` (`:320`) counts archive segments on list requests. Work increases with recording length and concurrent captures. Cache completed-segment totals and a first-segment-ready flag, then inspect only the active tail; measure event-loop lag with long recordings and slow storage before/after. This is a source-based opportunity, not a measured throughput claim.
2. **Give media jobs explicit lifetimes.** `recordingMedia.probeDuration()` (`:47`) and `countAudioDecodeErrors()` (`:259`) wait for child close with no deadline. Full audio decoding intentionally protects against corrupt replacements, so do not remove it for speed. Add cancellation/watchdog ownership and bounded failure handling, retaining originals if the validation cannot finish. A stuck child/storage read can otherwise occupy the single preparation/finalization worker. No hung real filesystem was induced here.
3. **Avoid repeating expensive checks while preserving safety.** Cache successful media verification against file identity/size/mtime and verification version; invalidate on capture completion or replacement. Preserve 0203's audio check and DVR-1 retention semantics. Measure before choosing any weaker check.
4. **Acceptance still needed:** watch a long segmented recording from its first seconds on iOS/tvOS while capture continues; seek across epoch/failover/restart discontinuities; verify audio after source configuration changes; stop/delete while view preparation is awaiting probe; cancellation while ingest readiness waits; share disconnect during MP4 publish and TS fallback; restart with finishing and pending-move jobs; remove a stable channel before scheduled start; real guide corrections beyond 15 minutes. Use controlled local fixtures first, then user-authorized live/device tests. These are unclosed acceptance cases, not claims that each already fails.

## Handoff order

Fix and prove DVR-1 original preservation first, then DVR-2 durable identity. Reproduce DVR-4 with controlled promises and repair startup ownership, close DVR-5 output-stream failure handling, and correct DVR-3 cancellation identity. Convert the isolated defect assertions into expected-correct tests that fail on `a104726`; rerun relevant targeted tests, then the required full suite/build verification before a functional commit. No application edit or commit was made by this review worker.
