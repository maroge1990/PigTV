# #217 T3: a sport recording follows its game past the guide end (rig, staging 0446)

4 Nov 2026 (3 Nov UTC). Server 0446 (`83f493f` plus this commit's rig tooling) on the Unraid rig, `PIGTV_RIG_SCORES=fake`:
staging read its scores from `scripts/fake-scores.js` under ESPN's host names (HTTPS, a rig-only CA), and its guide from
the fake providers. No real provider or real sport feed was touched.

**Steps** (`docs/FAKE-PROVIDER.md` › Test rig): `PIGTV_RIG_SCORES=fake scripts/unraid-rig.sh up`, then
`scripts/unraid-rig.sh overrun-t3`. The driver follows the EPL and schedules ITV1's "Premier League: Everton v Fulham"
from the guide as a client does (`POST /api/recordings/schedule`, post-padding 2 min, no `gameId`, so the title join
links it). It then reads `GET /api/recordings/scheduled` every 30 s and checks the recording at the end.

**Scripted game:** kick-off K, guide slot K to K+8, final at K+20. Floor (guide end + padding) K+10; target stop K+22.

| Minutes from K | ESPN (fake) | Row | `endsWith` | `overrun` | `stopsAt` |
|---|---|---|---|---|---|
| −7.8 (scheduled) | pre | scheduled | event | – | +10 |
| +0.3 | in | recording | event | – | +10 |
| +9.3 (floor − 1 min) | in | recording | event | true | +20 |
| +11.8 … +19.8 | in | recording | event | true | rolls: +21.6 … +29.6 |
| +20.3 | post | recording | event | true | +30.1 (final not yet polled) |
| +21.8 | post | recording | event | true | +22.59 (final seen + 2 min) |
| +22.8 | post | gone from the list (completed) | | | |

**Result:** recording #2 `completed`, K+0.12 to K+22.59, 1348 s, 83 MB, against a guide slot plus padding of 10 min.
It stopped 35 s after final + padding: the collector polls a hot game every 30 s and the stop is the moment it first
read the final, plus padding. **T3 passed.** Full driver output: [`overrun-t3.log`](overrun-t3.log) (timings and API
fields only).

Run 1 (schedule #1, the same setup 30 min earlier) recorded K+0.13 to K+22.6, 1348 s, stopping 35.7 s after final +
padding. Its driver was stopped by hand after the stop, because it did not know that a completed schedule leaves the
list (`?include=recent` keeps only failed and missed rows). The driver now ends there; run 2 is that fixed driver.

**Not covered:** a `gameId` schedule (the card path: same stop rule, C-M), ESPN unreachable (T1 covers it), suspended
or break states. T5, a real overrun on Mark's server, is still his.

**Gates:** on the rig (production image, Node 24), `npm test` (`PIGTV_SKIP_PERF=1`): 1700 tests, 0 fail;
`verify-build.sh` passes. The new `test/fake-scores.test.js` runs the fake's answers through the server's own readers.
Locally (WSL), the same 4 `recording-segments-media` HE-AAC failures as before (that machine's ffmpeg 8).
**Codex:** not run. This is rig and test tooling only, with no server, client or contract change (as with the earlier rig commits).
