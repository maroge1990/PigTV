# Cricket repair and test-gate review — 25 October 2026

Scope, newest first: test-only `4e6cb33`, then server0258 `d0ace59`, using current server HEAD `230118c`. Read both AGENTS files, both blueprint state notes, and the round4 repair status. No application changes, network/provider access, deployment or commits. All proof runs used disposable `git archive` copies and mocked fetches/fake local child processes.

## Verdicts

| Item | Verdict | Independent evidence |
|---|---|---|
| sports-worker clock mismatch | Analysis confirmed; test fix appropriate | With request NOW forced one5-minute bucket behind real time, parent test fails revision3 versus2; current test passes under the same offset. |
| start-failure retry margin | Improved and still sensitive to the behavior it tests; original cause remains unproven | Current selected test passes; setting retry allowance to zero in isolated server makes it fail because only2 of3 starts fit the3-second budget. |
| R4-S1 nested cricket discovery | Fixed in reviewed local scope | Current4 direct regressions pass; same tests on0257 all4 fail on fixture loss. Additional nested/mixed/empty-list cases pass. |

## Test-only change analysis

### Clock mismatch

`setFollow()` calls `scheduleRebuild()` with default real `Date.now()`, while the old test's requests supplied a NOW captured at file load. `buildKeyFor` includes a5-minute bucket (`sportsEvents.js:520–521`). The old test therefore asked for two valid keys after a bucket rollover and could observe two revisions. The repair freezes `Date.now()` to the supplied NOW for that test and restores it in `finally`; this makes its one-rebuild assertion consistent without changing product behavior or its stale-result assertions.

Proof in `service-test-proofs.py`: old test from `4e6cb33^` against current server, change only `const NOW = Date.now()` to `Date.now() - 5*60*1000`. It fails `3 !== 2` at old line144. Apply the identical offset to the current test:1/1 pass. Logs `clock-parent.log`, `clock-current.log`. This reproduces the proposed failure mechanism, rather than merely observing a clean retry.

### Startup margin and CI trust

The current test makes two refusal attempts after500ms each, with1500ms retry delays, so the third launch cannot occur before approximately4 seconds. Its3-second unextended wait must fail; with the product's retry allowance the last attempt receives approximately3 seconds. Current targeted test:1/1 pass. Isolated mutation setting the allowance to zero:0/1 pass, failing the new count assertion (`2 !== 3`), so widening the budget has not removed its ability to detect a missing extension. The mutant harness explicitly removes the session before its intentional assertion failure to prevent a late fake child; this cleanup does not alter the observed count/readiness result.

The 1.5-second historical failure was **not independently reproduced**. The author's measured3–9ms overhead is plausible local evidence, not a bound. `transcodeSession.js:435–445` adds elapsed refused-attempt time plus the requested retry delay; cleanup and timer scheduling can cost more under contention. Each refusal must also finish inside the3-second early-retry window. The new500ms refusal provides about2.5 seconds of scheduling headroom, and the final attempt has a larger budget. Those are sensible improvements, not a mathematical guarantee for a saturated runner.

CI workflow `.github/workflows/test.yml` runs all test files via `npm test` on Ubuntu with Node22 and24; performance skips do not remove this correctness test. This review ran Node24 on the local Mac, **not an actual2-vCPU Linux runner**. I consider the gate better specified and still meaningful, but cannot certify its CI timing reliability from local passes alone. Keep the root-cause limitation in the status and inspect the first actual CI runs. If it still flakes, capture retry/start/timeout timestamps and use deterministic scheduling/injection where practical, rather than repeatedly increasing sleeps. The lead's repeated full-suite results are separate evidence and must be reported exactly.

## Cricket paths and extra probes

`discoverCricketSeries` now rejects unreadable-only discovery and marks mixed readable/unreadable discovery `complete:false`. `refreshCricket` carries that flag into `savePartial`; the full replacement/coverage-renewal branch is not reached. A downstream series request failure also keeps the prior snapshot if none succeeds, or remains partial if some succeed. The cap still marks omitted series partial.

Before/after: four R4-S1 tests copied unchanged over `d0ace59^` server fail behaviorally (known match erased); current four pass. Additional `cricket-boundaries.log` contains one test covering five scenarios: null score entry, null league, valid+missing-ID leagues inside one entry, empty leagues plus an unreadable entry, and genuinely empty leagues. The first four preserve the known fixture and previous coverage; valid empty removes it and renews coverage. All assertions pass. No further reproducible defect was found in these examined discovery paths.

This does not prove the original AUS v SA grouping cause or production-feed acceptance. No efficiency measurement was made.

## Reproduction

Run from any directory:

```sh
python3 /Users/markrogers/Documents/GitHub/PigTV/docs/reviews/2026-10-25/service-test-proofs.py
```

The script uses Node24, bounded25-second per-file tests and35-second process limits, preserving the working checkout. Optional arguments select saved run labels (for example `clock-parent clock-current`). Logs beside this report: cricket-parent/current/boundaries, clock-parent/current, retry-current/no-allowance. Direct regression counts: cricket4fail→4pass; clock1fail→1pass; retry current1pass, mutant1expectedfail; extra cricket1pass. The parent tests deliberately fail and are evidence, not failures of current fixes.
