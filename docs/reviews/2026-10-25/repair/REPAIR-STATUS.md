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
| C1-K (Codex, 15 findings) | server 0263-0275 | 14 fixed locally, 1 answered (see Adversarial review). |
| Validation: provider-failover | server 0262 | Not reproduced; cause not established. Budget unchanged; the assertions now print a timestamped timeline so a recurrence names the cause. |
| Validation: Apple tab-switch | Apple test commit `63809e4` | Failed in push run 1 and in CI; build 46 fails equally under load (see CI). The gate now ignores a one-lap spike; a stall on both laps still fails. |
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
| Server `4d16c4a..ab5a51f` (26 Oct, after the limit reset) | needs-attention | **D1** (high): a repeat in another episode's slot took that schedule and then the episode's hit | Fixed: **0265** `232c3fe` - one schedule per identity; repeats never matched by time. Before: fails on 0264; after: passes. |
| | | **D2** (high): a deletion could wait for good on the segment writer's audio/probe check | Fixed: **0266** `b6f1836` - `checkPrepared` passes the writer's signal; ffprobe and the decode check are killed. Before: D2 still waiting after 5 s, three real-process tests time out; after: pass. |
| Server `d659a48..b6f1836` | needs-attention | **E1** (high): an episode in another's slot took its schedule while that one was out of the guide | Fixed: **0268** `bf048d1` - schedules named by another episode's hit are never matched by time; a hit on a schedule another episode holds does not suppress. |
| | | **E2** (medium): the MP4 move used `copyFile`, which cannot be stopped | Fixed: **0267** `778bf12` - abortable stream pipeline. |
| Server `b6f1836..bf048d1` | needs-attention | **F1** (high): `scheduleFromProgram`'s same-slot lookup handed an episode another's schedule | Fixed: **0269** `fa8c536` - `exclude` set; a shared hit no longer holds an episode back. |
| | | **F2** (high): an `fs.WriteStream` waits for a write stuck on the share, so abort cannot end it | First answered (the deletion's own unlinks on that share would block anyway); Codex showed that is wrong while the recording waits in appdata. Fixed: **0270** `5d321f1` - the deletion waits at most 30 s; a stuck writer is abandoned and its files removed when it ends or at the next start. |
| Server `bf048d1..fa8c536` | needs-attention | **G1** (medium): an older shared hit made the owner's repeat be recorded | Fixed: **0271** `9078852` - the owner resolved now decides. |
| Server `fa8c536..9078852` | needs-attention | **I1** (high): a failed cleanup unlink dropped its durable record; **I2** (high): cleanup paths were reusable fixed names; **I3** (medium): owner precedence lapsed once the schedule had run | I3 fixed: **0272** `c7fa932` (other episodes' hits on an owned schedule are removed). I1 + I2 fixed: **0273** `74c2a4f` (unique partial names, every file journalled in `recording_cleanup` from before it exists until it is gone). |
| Server `9078852..74c2a4f` | needs-attention | **J1** (medium): a row was dropped on any `access()` error; **J2** (medium): a failed journal INSERT was ignored | Fixed: **0274** `7507851` (only ENOENT drops a row; a failed INSERT stops the writer before it creates anything). |
| Server `c7fa932..7507851` | needs-attention | **K** (medium): journal ownership ends at publication - a failed `withdraw()` unlink, and a crash between publishing a final file and recording its path, leave it untracked | Failed withdrawal fixed: **0275** `296060a` (journalled for the sweep; before: fails on 0274, after: passes). Crash window: first answered (a sweep that could misjudge committed recordings is Mark's decision); **Mark chose "fix it, carefully" (26 Oct): fixed in 0276** - see below. |
| Server `7507851..296060a` | not run | - | The loop was stopped here; the next review command is in the handoff. |

**0276 (Mark's decision, 26 Oct): the publish-to-record crash window.** A finished file published under its final name
(`publishNoReplace`, a hard link from its journalled partial) is journalled as `published` before the partial name goes,
and committed (unlisted) once the database points at it - `finishOne`, `deliverTs`, `keepOriginal`, `moveOne`. At start
the sweep removes a `published` file only if no recording points at it (`file_path` or `segment_original`); a partial
still there with a second name (a stop right after the link) has that name - the same inode, so this code's file -
checked the same way. Nothing else is ever touched. Before (0275): P1 (stop right after the link) and P2 (database write
fails after publication) fail - the MP4 is left untracked; the control P3 (a recorded MP4 is kept, no rows left) passes.
After: all three pass. Gates: `npm test` twice, each 1145 / 1140 pass / 5 skipped / 0 fail; verify-build passes.

Every fix above has a test that fails on the build before it (isolated copies, `old-code.cjs`; logs beside it) and
passes after, with the full suite and verify-build passing at each commit. The recurring pattern was each fix of the
episode-identity heuristic and of writer ownership opening a narrower edge; the designs were simplified along the way
(one schedule per episode identity with ownership on record; one journal of in-progress files with unique names) rather
than patched further.

## CI on the 25 Oct push

Server CI (tests and image): passed. Apple CI run 40186551471 failed one test, `TabSwitchUITests`: worst stall 585 ms
(the first Home->TV Guide; its second lap 285 ms) against 500 ms; 229 unit and the other 15 UI tests passed. Builds 46
(the last green CI) and 55 were then built side by side and the test alternated between them, three rounds each, with
test-diagnostics collection off: build 46 worst 1767 / 2284 / 578 ms, build 55 worst 1036 / 873 / 1992 ms (load 8-19
from other work on this Mac). No regression is shown; both spike on one lap of a switch. Apple test commit `63809e4`
makes the gate the worst over switches of each switch's lesser lap (a switch slow on both laps still fails at 500 ms);
push tier afterwards 243 / 229 / 17, exit 0. It is Mark's to accept or revert.

Push run 4's earlier "hang" coincided with Xcode's post-test `simctl diagnose --timeout=600` collection, seen running
after a later test finished; that is an observation, not a proven cause.

Gates after 0264: `PIGTV_SKIP_PERF=1 npm test` twice, each 1123 tests, 1118 pass, 5 skipped, 0 fail; verify-build passes.
Fakes changed by 0264: the held R4-D2/R5-D1 ffmpeg fakes now exit when killed (as a real one does), and the move test
releases the copy after the deletion has started; assertions unchanged.

## Still open

Physical device and real-feed acceptance; bug 5 (AUS v SA grouping) and bug 8 (iPhone tuning) without root-cause
evidence; the deferred, unmeasured efficiency register; the provider-failover deadline flake's cause; the Apple
tab-switch budget; CI's 2-vCPU timing reliability (no CI run here). The F4 policy is a heuristic, not durable identity.
