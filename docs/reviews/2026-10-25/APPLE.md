# Apple 54 independent review

Reviewed `24d76e1` and docs `79b67f9` against supplied build 53 baseline `4585b14`. No application-source changes. No provider/server, manual simulator UI, deployment or commits.

## A5-R2 disposition

The reported end-of-empty-pass race is **fixed locally**: `grewDuringPass` is set by a positive byte delta while a prune owns the claim, cleared per pass, and combined with `removedAny` in the completion decision. Writes before/after that decision either cause a repeat or claim their own prune. An undeletable pass with no concurrent growth still stops. Overall A5 remains **partial** because file-removal accounting can use a cached size (below).

Independent current push run includes227 passing unit tests. The two specific current tests passed in0.003637s (growth) and0.006752s (locked folder), read from retained xcresult. The saved mutation script was independently run in an isolated build 54 copy: two tests ran, the growth case failed as expected (2000>1500), the locked-folder guard passed. Exit65; per-test durations0.241896s and0.010394s respectively. See apple-mutant-summary.json.

A standalone deterministic proof extracts actual production ArtworkBudget/ArtworkDiskStore and uses the existing afterPass seam. Current: `growth disk=1000 counted=1000 cap=1500; idle`; build 53 condition restored: `growth disk=2000 counted=2000 cap=1500; idle`. In both, a real0555 folder containing3000 bytes against cap1500 returns after one pass, with the correct count. The locked-folder guard took0.000237s on current code and0.000587s with the old condition. This native proof avoids simulator/XCTest diagnostic collection, demonstrates the algorithm's before/after, and does not explain the author's92-second XCTest outlier by itself. The isolated XCTest mutation also did not reproduce that duration (guard0.010394s). Xcode entered a separate long simulator-diagnostic collection; its own collector was stopped so the result bundle could finalize. This identifies an observed source of wall-clock delay, but does not prove the cause of the author's92s per-test report.

Reproduce: run `apple-prune-proof.py <PrivateCaches.swift> [mutant]`; compile generated `/tmp/pigtv-r5-prune-proof.swift` with `DEVELOPER_DIR=... xcrun swiftc -parse-as-library`, then run. Source extraction and deterministic semaphore scheduling only; the app checkout is untouched. Native harness uses Swift5 mode and emits a harness concurrency warning; actual app builds use their configured mode.

## R5-A1 — P2: cached URL size makes prune subtract the wrong bytes

`PrivateCaches.swift:306–311` calls `Self.size(url)` under the file lock before removing the file. But these URLs originate from `contentsOfDirectory(...includingPropertiesForKeys: [.fileSizeKey,...])` at320–330 and have prefetched/cached resource values. Locking does not invalidate those values after another writer replaces the file.

Independent deterministic reproduction (`apple-cached-size-repro.py`): extract current production cache classes, place a barrier just before `remove` acquires its file owner. Seed2000-byte fileA, start prune, pause after listing it, replaceA with500 bytes using real `store.write`, resume removal. The counter was correctly reduced to500 by replacement but removal reads cached2000 and subtracts it, leaving **-1500** while disk is empty. Write2000-byte B: count500, actual disk2000, cap1500, prune idle. Successfully compiled and rerun locally; no failed filesystem call or provider data required.

Observed:

```
after removal: counted=-1500
REPRODUCED: disk=2000 counted=500 limit=1500; prune idle
```

This persists through build 54 and is distinct from the repaired pass-completion condition. Read fresh filesystem attributes under the owner (or invalidate resource cache explicitly), and test replacement between listing and removal in both shrinking/growing directions. Do not clamp negative counters as a substitute for correct accounting. Verify actual disk size and count converge under cap.

## Required checks

- `sh Tools/test.sh push`: contracts243pass; unit227pass; regression UI16run,15pass,1fail. Failure is `TabSwitchUITests.testSwitchingTabsOnAThousandChannelsIsQuick`, Home→Guide stall577ms vs500ms budget. This is a real recorded assertion failure, not inferred from the later600second diagnostic collection timeout. No attribution to build 54 is established.
- iOS simulator build: exit0, `/tmp/pigtv-r5-ios.log`.
- Exact durable xcresult summaries: `apple-unit-summary.json`, `apple-ui-summary.json`. Initial sandbox access could not bind simulator services; permitted push run is the reported one. A read-only result extraction also needed report-cache access and was rerun successfully.
- Current unit two-test durations were independently extracted before Xcode retention could remove their result bundles.

Physical-device/feed acceptance, bugs5/8 and deferred efficiency work remain open. No performance improvement is claimed; the UI budget failure must remain visible.


Focused tab-switch retry: **1/1passed**, exit0, preserved in `apple-tab-retry-summary.json`. Its separate diagnostic collector was stopped after execution to finalize the result. This does not change the earlier full push tier's failed disposition. Simulators shut down after all runs.
