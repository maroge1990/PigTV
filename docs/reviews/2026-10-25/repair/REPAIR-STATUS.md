# Repair status after the 25 Oct round-5 review

Local work on 25 Oct from server 0259 (`230118c`) and Apple 54 (`79b67f9`), answering [REVIEW.md](../REVIEW.md) with
[F4.md](../F4.md), [DVR.md](../DVR.md), [APPLE.md](../APPLE.md), [SERVICE-TESTS.md](../SERVICE-TESTS.md) and
[CHECKS.md](../CHECKS.md). Nothing pushed or deployed; no deployed server or provider contacted; no playback flag changed.

"Fixed locally" means implemented, with a test that fails on the code before it (shown below), and the repository checks
passing. It is not device or real-feed acceptance; nothing here is *Verified*.

## Findings

| ID | Commit / build | Disposition |
|---|---|---|
| R5-F1 | server 0260 `b8801ef` | Fixed locally. `pairInstances` returns, per candidate, the cancelled schedules it declined as unsure; a hit naming one of those no longer suppresses the candidate. Hits name the schedule that last acted for an identity (upsert), so the recorded programme is not made twice. |
| R5-F2 | server 0260 | Fixed locally (a 0259 regression). Before airings without episode data are paired, the schedules of the episodes in the guide are reserved: the one present beside an episode and the one its hit names. Found while checking C-M's "that episode wherever it moves": a pending episode schedule stayed at the old time when the guide moved it (also on 0258); it now follows, unless an airing of the episode is still at the schedule (a repeat never takes it). |
| R5-F3 | server 0260 | Fixed locally. Series pairing and `alreadyScheduled` compare `channel_stable_id` when the schedule has one; a stored position is used only for a schedule without one. |
| R5-D1 | server 0261 `2adc84b` | Fixed locally. Retirement moved into `recordingOwners`, shared by segment delivery/move (0257), the native remux (shared by a viewer's playback and preparation), preparation/adoption, compression and post-recording break detection. Each checks after its awaits and before publishing; a retired one removes only its own `.partial` / a `.native.mp4` made during the check. A viewer waiting on the shared remux gets `file-missing`. |
| R5-A1 | Apple 55 | Fixed locally. `ArtworkDiskStore.size` stats the file (`attributesOfItem`) instead of a listed URL's prefetched `fileSizeKey`; used by the write, the removal and the recount. The listing's size still only decides what to remove. |
| Validation: stream-relay | server 0262 `6b9f37d` | Fixed in the test, with a small observable seam: the relay keeps its leg-folder removal promise (`filesRemoved()`), and the three tests that slept await it. |
| C1 (Codex) | server 0263 `f83b3ed` | Fixed locally (see Adversarial review). |
| C2 (Codex) | server 0264 `ab5a51f` | Fixed locally (see Adversarial review). |
| Validation: provider-failover | server 0262 | Not reproduced; cause not established. Budget unchanged; the assertions now print a timestamped timeline so a recurrence names the cause. |
| Validation: Apple tab-switch | — | Failed in push run 1 (853 ms, load 25+), passed in run 3. Not attributed to build 55; not reliably clean under load. |
| Validation: Apple ChannelWarmer | Apple test commit `8d50735` | One unit failure in push run 2: the cancellation check counted 30 yields; the four cancellation tests now wait for the cancellation (bounded at 5 s). |

C-M (`docs/CLIENT-CONTRACT.md`) is updated in 0260 and 0261 to match: stable channel identity, episode schedules
following their episode and never taken by an unidentified airing, the per-candidate ambiguity rule re-decided at every
evaluation (with its consequence for a rematch inside 72 h), "heuristics, not provider identity", and deletion during
preparation/remux/compression.

**Behaviour change to note for Mark (within the accepted policy):** a cancelled Sport game that the guide moved alone is
held; if another same-title game then appears that the cancel could also be (inside the 72 h horizon, measured from the
cancelled schedule's stored time), both are recorded. The older DVR-3 test asserting the opposite was updated, not
dropped.

## Before/after proof

All "before" runs use current tests over an archived older server in a disposable copy
([`old-code.cjs`](old-code.cjs): `git archive`, `--test-timeout=25000`, 60 s process limit). Logs are local
(`*.log` is git-ignored) beside the scripts.

| ID | Tests | Before | After |
|---|---|---|---|
| R5-F1–F3 | 7 `R5-` tests, recording-rules-events | 0259: 0/7 pass (all behavioural); 0258: 3/7 (both F2 mixed-episode cases and the position-only control pass there - F2 is the 0259 regression) | 7/7 |
| R5-F1 | DVR-3 rematch (recording-rules), updated | 0259: fails (the cancelled game is not recorded) | passes |
| R5-D1 | 5 `R5-D1` tests, recording-prepare | 2/5: fallback-.ts preparation, a viewer's remux and compression each leave a late `.mp4`/`.compressed.mp4`; the check-in-progress ordering and the coalescing control already pass (coverage, not proof) | 5/5 |
| R5-A1 | `CacheTests.testAFileThatShrankAfter…`, `…Grew…` | both fail: shrink counts −1500 then disk 2000 / count 500 over a 1500 cap; growth counts 1400 with an empty folder | pass |
| relay | stream-relay with removal delayed 200 ms ([`relay-slow-rm.cjs`](relay-slow-rm.cjs)) | 0261 test file 13/15 (both 50 ms sleeps fail) | 15/15 |

## Checks

Node 24, local MacBook (not CI's 2-vCPU Linux runner; no CI run here). Load averages are the 1-minute figure, from
other work on this Mac (another project's Swift builds), noted because the gates are timing-sensitive.

| Check | Result |
|---|---|
| `PIGTV_SKIP_PERF=1 npm test` at 0260 | 1110 tests, 1105 pass, 5 skipped, 0 fail |
| … at 0261 | 1115 tests, 1110 pass, 5 skipped, 0 fail |
| … with 0262, three consecutive runs (load 15–34) | each 1115 tests, 1110 pass, 5 skipped, 0 fail |
| `bash scripts/verify-build.sh .` at 0260, 0261, 0262 | all checks passed |
| Apple push run 1 (build 55, load 25+) | 243 contracts; unit 229/229; UI 15/16 - tab-switch worst stall 853 ms > 500 ms |
| Apple push run 2 (load ~8) | 243 contracts; unit 228/229 - `ChannelWarmerTests.testANewTargetCancelsTheRequestInFlight`; UI not run (the tier stops) |
| Apple push run 3 (warmer test fixed, load 3.5–4.7) | 243 contracts; unit 229/229; UI 16/16; exit 0 |
| Apple push run 4 (committed state) | contracts 243 pass; the unit-tier `xcodebuild` then hung with no CPU activity for 56 min and was stopped (load average 44–56 when stopped). No unit/UI result; cause not established. |
| iOS simulator build (build 55) | succeeded |

So: one fully clean Apple push run (3) and one with no result (4). That is not a repeatably clean Apple gate.

## Adversarial review (Codex, 25 Oct)

Run after Mark's `codex login`, through the plugin's `adversarial-review` (Codex 0.164.0), read-only.

| Repo / range | Verdict | Findings | Disposition |
|---|---|---|---|
| Apple `79b67f9..3f0574b` | approve | none ("fresh artwork sizes are read under the file owner's lock, and the bounded cancellation wait preserves the failure assertions") | - |
| Server `230118c..4d16c4a` | needs-attention | **C1** (medium): an episode and an unidentified airing shifting together leave a stranded third schedule (`resolveEpisodes` reservation by time) | Fixed: **0263** `f83b3ed`. An episode's hit schedule is resolved before any time match; only resolved schedules are reserved. Before: C1 test fails on 0262 (third schedule); after: passes, plus a repeat control that passes both. |
| | | **C2** (medium): a deletion did not stop or await writers, so a late `.partial` could survive a restart | Fixed: **0264** `ab5a51f`. `recordingOwners.write/stopWriters`: every writer (native remux, compression, segment remux + check, `.ts` joins, share move) runs with an abort signal; deletion aborts and awaits them before removing files and the row. Before (0263): four C2 tests fail, and two runner tests time out at 25 s because the process is never killed; after: all pass. |
| Server `4d16c4a..ab5a51f` (re-review of 0263-0264) | **not run** | Codex usage limit ("try again at 11:44 PM") | Pending: Mark to rerun (command in the handoff). |

Gates after 0264: `PIGTV_SKIP_PERF=1 npm test` twice, each 1123 tests, 1118 pass, 5 skipped, 0 fail; verify-build passes.
Fakes changed by 0264: the held R4-D2/R5-D1 ffmpeg fakes now exit when killed (as a real one does), and the move test
releases the copy after the deletion has started; assertions unchanged.

## Still open

Physical device and real-feed acceptance; bug 5 (AUS v SA grouping) and bug 8 (iPhone tuning) without root-cause
evidence; the deferred, unmeasured efficiency register; the provider-failover deadline flake's cause; the Apple
tab-switch budget; CI's 2-vCPU timing reliability (no CI run here). The F4 policy is a heuristic, not durable identity.
