# Independent validation — 25 October2026

Server HEAD230118c, baseline93583f6; Apple HEAD79b67f9, baseline4585b14. Node24 and local Xcode/tvOS27; no provider/deployed-server access.

## Required server checks

| Run | Tests | Passed | Failed | Skipped | Result |
|---|---:|---:|---:|---:|---|
| Full1 |1103|1098|0|5|Pass,46.392s |
| Full2 |1103|1096|2|5|Fail |
| Failed files together, focused rerun |40|40|0|0|Pass,26.197s |

Full2 failures:

- `provider-failover.test.js:284`: hanging candidate deadline case expected backupB start count1, got0. Test runtime3.673s.
- `stream-relay.test.js:312`: expected the relay's directory removed after50ms, but it still existed. Test runtime0.156s. Its50ms background-cleanup assumption has no1second margin/polling and is vulnerable under load.

The two specifically repaired tests (clock-bucket and startup retry extension) passed in both full runs. Their analysis/before proofs are in SERVICE-TESTS.md. The gate is better specified, but overall timing stability is **not established**: one clean run and one failing repeat, plus isolated passes, do not certify CI's2-vCPU Linux runner. No actual CI execution is claimed, and no test/application fixes were made in this review.

`bash scripts/verify-build.sh .`: ALL CHECKS PASSED, exit0.

Logs: `/tmp/pigtv-r5-full1.log`, `/tmp/pigtv-r5-full2.log`, `/tmp/pigtv-r5-focused-failures.log`, `/tmp/pigtv-r5-verify.log`.

## Independent direct before proofs

- F4 current supplied file19/19pass. Seven changed-policy/control tests on0258:4fail/3pass (controls intentionally pass). Additional current expected-correct probes0/3pass; parent1/3pass. Mixed episode/no-metadata case is a new regression. See F4.md.
- DVR current9/9pass,0257 parent5/5fail,0256 parent selected1/1fail behaviorally. New native-preparation/delete probe fails expected-correct output cleanup. See DVR.md.
- Cricket current4/4pass,0257 parent4/4fail; extra boundary test covering five shapes passes. Clock mismatch reproduced1fail→1pass. Retry current1pass, zero-allowance mutation1expectedfail. See SERVICE-TESTS.md.

All old-code runs used disposable archived server copies with current tests; no working source substitution. Per-test/process timeouts and synthetic fixtures; expected failures are labelled rather than counted as current gate failures.

## Apple

Push run:243contracts pass;227unit tests pass;16regression UI tests run,15pass/1fail. Failed500ms tab-switch budget observed577ms. Later diagnostic collection timed out600s; that timeout does not explain away the assertion failure. Result summaries preserved beside this report. iOS simulator build exit0.

Current growth-race test0.003637s, locked-folder guard0.006752s. Native extracted-production before/after proof shows repaired growth behavior and fast termination of a real locked folder on both versions. The92s mutated XCTest outlier is not thereby root-caused. Additional cache resource-value reproduction confirms negative/undercounted bytes despite shared lock. See APPLE.md.

Extra isolated Apple mutation XCTest:2run,1expectedfail (2000>1500 cap),1guardpass; exit65. Growth0.241896s, locked-folder guard0.010394s. Current equivalents pass0.003637s/0.006752s. The92s guard outlier was not reproduced. Separate native guard timings current0.000237s, mutant0.000587s. Xcode spent several minutes collecting simulator diagnostics after these tests; stopped only that run's diagnostic collector to finalize its bundle. No test result was inferred from the collection interruption. Final simulator cleanup and focused UI rerun below.


## Focused UI retry and cleanup

The failed tab-switch test rerun alone **passed1/1**, exit0 (`apple-tab-retry-summary.json`). Only its own simulator diagnostic collector was stopped after execution to finalize the bundle; the result reports Passed. This is a focused recovery, not a clean rerun of the whole push tier. Initial15/16 remains the full-run result. The exact source of timing variation is not established. Simulators shut down successfully with `xcrun simctl shutdown all` after all runs.
