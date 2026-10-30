# Apple CI observer assertion race — 29 October 2026

Before: Apple 61 `9125628`, [failed CI run 40862302742](https://github.com/maroge1990/PigTV-Swift/actions/runs/40862302742).
Server/web CI for `218ffd6` passed. Apple iOS build passed; its tvOS UI suite had 32 passes / 3 skips / 0 failures.
The single failing test was `RealPlaybackTests.testRecordingReallyPlaysAndTheTimeObserverTicks`, line 343:
`XCTAssertTrue(playback.hasPlayed)`. [Actual before-fix log extract](ci-before.txt).

The test had waited for raw `AVPlayer.timeControlStatus == .playing`, but `RecordingPlayerModel.hasPlayed` is set
by its KVO callback's separate MainActor task. Raw player state can be visible before that published model state.
Waiting for markers adds no guaranteed actor yield when the markers have already arrived. The CI failure happened
after 1.165s, not after the existing 10s wait deadline. This is an assertion ordering race, not evidence of a playback
failure or a reason to alter the player/ffmpeg/recording code.

Test-only repair: require `hasPlayed`, raw playing state and ready item together in the existing bounded wait.
No larger timeout, fixed sleep, skipped assertion, production hook or playback code change. The following assertions
still require break markers, periodic-observer break detection, a valid timeline, no player error and release on stop.
Apple build stays 61; no server/API/route change. The exact CI failure is the failing-before evidence; local Xcode 27
and CI Xcode 26.6/tvOS 26.5 have different callback scheduling, so no claim of an identical local pre-fix reproduction.

Local validation passes on Xcode 27 / tvOS 27: ten focused recording playback repetitions
([summary](repeated-after.json)), 244 contract checks, 247 unit/playback tests ([summary](unit-after.json))
and 23 regression UI tests ([summary](ui-after.json)); no failures or skips. The full `Tools/test.sh push` gate passed;
the simulator was shut down afterward. Only optional diagnostic collection was disabled.
All local HLS/server data is synthetic; no deployed/provider access. Replacement CI is pending at repair commit;
[Replacement Apple CI 40867834373](https://github.com/maroge1990/PigTV-Swift/actions/runs/40867834373)
provides its authoritative result after push. Server documentation gates also pass: 1,339 tests and
`bash scripts/verify-build.sh .`. Apple repair commit: `e8c9d31`. Prior dashboard
reviews/device/pilot gates and separate media investigation work remain unchanged. Test/docs-only repair is exempt
from a new adversarial round under AGENTS.md; it does not approve the pending functional sports batch.

Server follow-up: the evidence commit's [CI 40867960015, attempt 1](https://github.com/maroge1990/PigTV/actions/runs/40867960015/attempts/1)
passed Node 22/24/perf but failed the candidate-container watch-from-start test at line 965 (JSON instead of HLS).
[Preserved failure](server-candidate-before.txt). This is a recurrence of open GATE-20261029-REC1; no production
impact or root cause is claimed. Attempt 2 reran only the failed job and passed, including runtime tests and image
publication. No code changed between attempts; the finding stays open, separately from this Apple test repair.

Final Apple result: replacement CI **passed** for `e8c9d31` on Xcode 26.6 / tvOS 26.5. iOS build passed;
247 unit/playback tests passed, including the formerly failing recording test (1.177s); full tvOS UI suite
had 32 passes / 3 optional-media skips / 0 failures. [Successful CI extract](ci-after.txt). No device acceptance,
review approval, dashboard flag/deployment or provider/pilot result is inferred from these synthetic tests.
