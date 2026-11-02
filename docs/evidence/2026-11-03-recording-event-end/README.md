# Sport recordings end with the game: 0439–0443 (#207, #217)

3 Nov 2026. The recording-path batch of the D-44 implementation. No real provider, no capture: the change is when a
recording stops, not how it is captured (no ffmpeg flag, segment or media change). Tests use fixed clocks and stored
score answers; the recording path never asks ESPN.

| Build | Issue | Change | Failing-before test |
|---|---|---|---|
| 0439 | #207 | A keyword sport rule records the channel whose own airing is still to come, at its times | `recording-rules-events` #207 |
| 0440 | #217 | A recording linked to its game (team rule, `gameId`, else the join) rolls on while the game is in play, stops at max(floor, final + post-padding), floor = guide end + post-padding, cap floor + 4 h; C-M `endsWith`, `overrun`, `stopsAt` | `recording-event-end` (5) |
| 0441 | #217 | A part waiting for a provider, or restored after a restart, checks its game first (Codex round 1, high) | `recording-failover`, `recording-segments` |
| 0442 | #217 | One capped stop (`stopOf`) for the timer, the checks and `stopsAt` (Codex round 1, medium) | `recording-guide-end` |
| 0443 | #217 | The join links only to a game of the schedule's own league (Codex round 2, medium) | `recording-event-end` AFL/AFLW |

**Gates:** `npm test` 1672 pass, 4 fail (the known HE-AAC tests: this machine's ffmpeg 8), `verify-build.sh` passes.

**Codex:** round 1 one high and one medium, round 2 one medium; all fixed above. No finding left open.

**Not run:** T3 on the rig (a fake-provider recording past a guide end needs a staged live game); T5 is Mark's (a real
overrun: extra time, a long innings).
