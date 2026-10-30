# Apple repairs, round 4 — builds 52–53

Reviewed newest first: build 53 `93d2f7a`, build 52 `5d77666`, against build 51 `a59a6c4`; documentation HEAD `6c552cb`. Review began 24 October and resumed 25 October 2026. The application checkout was not modified. No provider/deployed service, manual simulator UI, commit or push.

## Verdict

| Prior finding | Result | Evidence |
|---|---|---|
| A2-R: delayed sign-out clear removes the next session's snapshot/cards | Fixed locally | `clear()` now queues removal synchronously on the shared publication queue before returning; main-actor session transition cannot publish the new session ahead of that removal. Generation checks still discard retired work. New deterministic test exercises a held old clear and next-session card/snapshot, including `lastWritten`. |
| A5-R: prune/replacement overlap miscounts disk bytes | Original race fixed locally; cap guarantee remains partial | Size read, write, removal and byte deltas now share the file lock; recount uses the same owner. This also prevents same-key writers double-counting. A newly introduced completion condition can nevertheless strand correctly counted bytes over the cap (below). |

## New actionable finding: A5-R2 — P2, write at the end of an empty prune pass leaves the cache over budget

Location: `PigTV/PrivateCaches.swift:191–197`, especially line 194.

`ArtworkBudget.finished` repeats only if the pass removed something **and** the count exceeds the cap. At launch the background prune may inspect an existing cache below the limit and remove nothing. After that inspection and before `finished` runs, an artwork download writes enough data to cross the cap. Its `claimPrune` returns false because the original prune is still marked running. `finished` then observes `removedAny == false`, clears `pruning`, and wakes idle waiters even though the current count is over the cap. With no further write/launch, nothing schedules another pass.

The new shared file lock correctly accounts for this write; it does not close the gap between the completed pass and its final state decision. Thus this is separate from, and survives the repair of, the original undercounting race.

Independent deterministic reproduction: [`artwork-prune-completion.py`](artwork-prune-completion.py) extracts the actual current `ArtworkBudget` and `ArtworkDiskStore`, adding only a scheduling barrier between `pruneOnce` and `finished`. It seeds 1,000 bytes from a previous launch, starts the same `begin`/`pruneLoop` path used by `shared`, holds the pass after it removes zero files, then writes another 1,000 bytes against a 1,500-byte limit. Observed on repeated runs:

```text
disk=2000 counted=2000 limit=1500; prune idle
```

Run from the Swift repo:

```sh
python3 ../PigTV/docs/reviews/2026-10-24/round4/artwork-prune-completion.py PigTV/PrivateCaches.swift
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun swiftc -module-cache-path /tmp/pigtv-round4-modules -parse-as-library /tmp/pigtv-round4-prune.swift -o /tmp/pigtv-round4-prune
/tmp/pigtv-round4-prune
```

Repair should distinguish a pass that cannot remove anything from one made stale by concurrent writes. Preserve the no-progress safeguard for unremovable files, but ensure a write made during the pass triggers a fresh pass if still over budget. Add this interleaving to regression coverage and prove it fails on build 53. A simple unconditional retry can loop indefinitely on filesystem failures, so that is not sufficient by itself.

## Independent checks

- `sh Tools/test.sh push`: exit 0, `== push: passed`; 243 synthetic contract checks; the unit tier completed successfully before the regression tier. Regression xcresult independently read: **16 passed, 0 failed, 0 skipped**. Xcode emitted a 600-second diagnostic-collection timeout after UI execution; the result bundle still reports Passed. Log: `/tmp/pigtv-round4-apple-push.log`. The earlier unit xcresult was removed by Xcode retention before its count could be independently extracted, so no exact unit count is asserted here.
- iOS simulator build: `xcodebuild build -quiet -project PigTV.xcodeproj -scheme PigTV -destination 'generic/platform=iOS Simulator'`, exit 0. Log: `/tmp/pigtv-round4-ios.log`.
- New prune-completion reproduction: succeeds against current source; real local filesystem, no network, no application-source modification.
- Isolated mutation check: **unavailable, not a pass or an assertion failure**. Archived HEAD into `/tmp/pigtv-round4-apple-mutant`, applied the repair author's `apple-repair-mutate.py` (old detached clear plus removal of file-change ownership), and selected the four new A2-R/A5-R tests. Xcode compiled and installed the app/extension but produced no test result or assertion output by the six-minute wall limit. Process inspection showed the simulator extension, without a test-host process. Interrupted the review-owned xcodebuild and shut down all simulators. Log: `/tmp/pigtv-round4-mutant.log`. Compiler warnings/errors reporting command exit 0 do not establish mutation sensitivity. The author's mutation claim therefore remains unconfirmed in this round; current positive push results and the independently reproduced new completion race stand separately.

The push tests retain previously covered local behavior, but simulator/build results do not establish physical-device acceptance. Bugs 5/8, real feed behavior and the separately deferred efficiency work remain outside these two repairs.
