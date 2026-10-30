# Independent checks — 25 October 2026

Reviewed unchanged HEADs: server `63a022f`, Apple `6c552cb`.

## Server

- Node24 `PIGTV_SKIP_PERF=1 npm test`, first permitted run: **1087 tests,1081 passed,1 failed,5 skipped**. Failure: `start-failure.test.js:259`, retry-adjusted `waitForPlaylist(1500)` returned false. Focused rerun passed (1/1).
- Full permitted repeat: **1087 tests,1081 passed,1 failed,5 skipped**. The startup test passed this time; failure was `sports-worker.test.js:144`, stale-cache rebuild revision actual7 vs expected6. Subsequent full sports-worker file passed **9 tests,1 perf skip**.
- Consequently **no clean full-suite run is claimed**. Different failures and isolated passes suggest timing/order sensitivity, but do not prove the exact cause or exclude a defect. Neither failing test nor its main implementation was changed in0251–0255. Investigate scheduling/state ownership and obtain a clean repeatable gate before shipping.
- Initial sandbox run could not bind localhost (`EPERM`); permitted runs above supersede it. That infrastructure failure is not a product finding.
- `bash scripts/verify-build.sh .`: **ALL CHECKS PASSED**, exit0.
- DVR isolated current14/14 assertions (11 intended-behavior/policy,3 defect confirmations); all6 selected old-server regressions fail on behavior. See DVR.md/log.
- Cricket current5/5 direct tests; parent1pass/4fail. New nested-discovery probe confirms loss1→0 and renewed coverage. See SERVICE.md/logs.

Raw server logs: `/tmp/pigtv-round4-tests-permitted.log`, `/tmp/pigtv-round4-tests-repeat.log`, `/tmp/pigtv-round4-start-retry.log`, `/tmp/pigtv-round4-sports-retry.log`, `/tmp/pigtv-round4-verify.log`. Durable summaries retained here; focused before/after logs beside this file.

## Apple

Push tier exit0 (243 contracts, unit tier successful,16 regression UI tests passed); iOS simulator build exit0. Earlier unit result bundle was removed by Xcode retention before exact count extraction, so no unit-test count is inferred. UI diagnostic collection timed out after execution; independently inspected result still Passed. Extra isolated Apple mutation run did not reach test execution within six minutes; it was terminated and the simulator shut down. Mutation sensitivity was therefore not independently confirmed this round. See APPLE.md for this limit and the independently reproduced deterministic cache-prune race.

These are synthetic/local checks. No deployed server/provider contact or physical-device acceptance. No repeat browser run: no web focus changes in this repair series.
