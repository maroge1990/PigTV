# Apple repairs: independent follow-up, 24 October 2026

Scope: build 47 (`ac7f186`) through build 51 and test/doc corrections, current HEAD `64f1258`. No application code changed. Tests use synthetic/local data; no deployed server or provider contacted.

## Verdicts

| Finding | Verdict | Evidence and limit |
|---|---|---|
| A1 resume isolation | Fixed locally | Server/account-scoped keys and legacy key retirement remain present. Independent push suite includes resume tests; isolated unscoped-key mutation described below. Device acceptance remains separate. |
| A2 Top Shelf logout publication | Partial | Generation checks reject retired saves/cards and the file queue serializes mutations. However clear is dispatched asynchronously and unconditionally, allowing it to delete the next session's successful publication. |
| A3 rule action errors | Fixed locally | Rules sheet observes `model.actions`, shows `actions.actionError`, disables controls during mutation; `setRule`/`deleteRule` serialize and clear stale messages. Local action tests and mutation distinguish the behavior. Delete error alone is not a new regression assertion: old code already populated it. |
| A4 guide corrections | Fixed locally | Same-shape branch refreshes corrected visible cells and invalidates layout; changed section counts take the existing reload path. Corrected cells are reconfigured in place. Independent UI-backed unit test passes, and removal of refresh is the mutation. Physical focus/appearance remains device acceptance. |
| A5 artwork disk budget | Partial | Ordinary writes now trigger coalesced pruning, but pruning and replacement writes do not share ownership of the filesystem/accounting operation. A reproducible interleaving undercounts bytes and leaves the cache over cap with no prune running. |

## New remaining defects

### A2-R: delayed clear can erase the next session's Top Shelf (P2)

`PigTV/TopShelfExport.swift:149–156` retires a generation synchronously, then starts a detached task which eventually enqueues `run(ifCurrent: nil)`. New-session publication also uses detached work, so the clear is not guaranteed to enter the serial queue first. The nil gate permits it to run after a new-generation snapshot/card publication. This removes valid current-session content. `save` already set `lastWritten`, so an identical subsequent export is suppressed rather than repairing the erased snapshot.

`apple-topshelf-order.py` extracts the actual `TopShelfPublication` class and controls the schedule of the clear and new save with a semaphore. It produces: `REPRODUCED: delayed unconditional clear deleted current-generation snapshot`. This is a deterministic queue/order proof, with file operations analogous to the actual clear/save, not a device-level Top Shelf reproduction. The scheduling barrier merely selects an ordering permitted by the production detached tasks.

Acceptance: make retiring/clear enqueue an ordered barrier before new-generation publication is allowed (or equivalent ownership scheme), and test clear delayed before enqueue plus immediate new-session publication. Check both snapshot and cards and do not let `lastWritten` claim a deleted/nonpublished snapshot. Merely gating clear on the new generation is insufficient when the new session uses that same generation.

### A5-R: pruning between replacement's size read and write undercounts disk bytes (P2)

`PigTV/PrivateCaches.swift:233–241` reads the old file size, writes atomically, then accounts only the size difference. Pruning can remove that old file between its size read and replacement publication. The replacement then adds zero (for an equal-size file), although it created a new file on disk. Once pruning completes, the count stays below actual usage; future writes may fail to trigger at the true cap.

`apple-artwork-race.py` extracts the actual `ArtworkBudget` and `ArtworkDiskStore` implementation and adds only a scheduling barrier immediately before `data.write`. Scenario: old=1000 bytes; limit=1500; pause replacement after old-size read; write new=1000; prune removes old; resume equal-size replacement. Result independently executed: `REPRODUCED: disk=2000 counted=1000 limit=1500, prune idle`. This is a persistent accounting discrepancy, not just temporary overshoot during a queued prune. No failed filesystem call is required.

Acceptance: serialize file replacement/deletion and byte accounting under one owner, or use a race-safe reconciliation scheme. Add this overlapping prune/replacement case, including same-key writes, alongside the existing distinct-key concurrency tests. Prove eventual actual disk size, not only the counter.

## Independent checks

- `sh Tools/test.sh push` completed successfully. Its log includes **243 API/model contracts**. Independently inspected the xcresult bundles: **221 unit tests passed, 0 failed/skipped; 16 regression UI tests passed, 0 failed/skipped**.
- Regression UI diagnostic collection timed out after 600 seconds, but xcresult itself reports Passed and all 16 tests passed. Two UIKit hierarchy runtime warnings are present; no test failure. Do not mistake the diagnostic timeout for an unrun UI suite.
- `xcodebuild build -quiet -project PigTV.xcodeproj -scheme PigTV -destination 'generic/platform=iOS Simulator'` passed (exit 0). Initial sandbox-only attempt failed because Xcode could not write DerivedData; permitted rerun succeeded. This was not a source/build error.
- Result logs: `/tmp/pigtv-apple-round3-push.log`, `/tmp/pigtv-round3-unit-summary.json`, `/tmp/pigtv-round3-ui-summary.json`, `/tmp/pigtv-apple-round3-ios-permitted.log`.
- Both race scripts compiled with local Xcode Swift and ran successfully. The harness semaphore wait causes a Swift 5-mode concurrency warning, confined to the deterministic scheduling harness.

## Mutation evidence

An isolated copy at `/tmp/pigtv-apple-round3-mutations` preserves current tests but reinstates old behavior via `apple-mutations.py`: A1 unscoped key; A2 publication gates removed; A3 setRule serialization/message reset removed; A4 same-shape refresh removed; A5 write counting disabled. This preserves newer APIs so failures diagnose behavior rather than missing symbols. Selected tests are run together; each mutation is confined to the corresponding subsystem. Results are recorded below after completion.

Completed mutation test run: **7 tests, 6 failed as expected, 1 passed**, exit 65. All the corresponding unmodified tests passed in the independent 221-test unit tier above. `apple-mutation-results.json` records actual failures; build succeeded before execution. The one passing case is A3 delete-error behavior, intentionally not evidence of the repair because it already worked before.

| Item | Expected failure with old behavior restored |
|---|---|
| A1 | `RecordingResumeTests/testLocalKeysAreScopedToServerAndAccount`: identical `pigtv.resume.42` keys across servers |
| A2 | `TopShelfCardTests/testASaveFromARetiredSessionIsDropped`: retired snapshot still written |
| A3 | `RecordingRuleActionTests/testAFailedTurnOffIsShownEvenThoughTheReloadWorks`: stale `Rule deleted.` message survives; `testOneChangeAtATime`: mutationBusy false during change |
| A4 | `GuideGridCorrectionTests/testASameShapeCorrectionShowsAtOnceInTheSameCell`: visible text remains `Match Day` instead of corrected `Match Day - Extra Time` |
| A5 | `CacheTests/testWritesPastTheCapArePrunedWithoutANewStoreAndPrunesAreCoalesced`: actual disk 40,000 > limit 10,000 |

The simulator was shut down after the mutation run. These checks establish the intended repairs improve their direct cases; they do not close the two additional ordering defects above. The mutation tests do not replace physical tvOS/iOS acceptance or prove the rule error is visually readable on a physical screen.
