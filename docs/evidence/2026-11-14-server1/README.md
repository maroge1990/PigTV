# Server 1 (server 0580 to 0595): recording follow-ups; reviews, gates and the rig

Issues: #302, #286, #305, #303, #306, #288, #304. Mark's decisions: D-59 (#288, with the back-off), D-60 (#304),
D-61 (#286's notice).

## Commits

| build | issue | change |
|---|---|---|
| 0580 | #305 | a schedule that starts recording clears its waiting reason |
| 0581 | #303 | one schedule that throws no longer skips the others due in the tick |
| 0582 | #306 | the reclaim log says "a shared feed with no viewer", not "Infinitys silent" |
| 0583 | #286 | a low-disk stop says "Stopped early: free space in appdata ran low" and sends a `disk-low` notice |
| 0584 | #304 | a stall on a channel's only provider stays out of its breaker |
| 0585 | #302 | a gap counts from the part's last growth |
| 0586 | #288 | no resume cap; a recording's route lists every held-back provider, so retries rotate |
| 0587 | #302 | the gap includes the shared-ingest connection wait (Codex medium) |
| 0588 | #304 | a channel with no backup link counts as one provider (Opus M1) |
| 0589 | #288 | a failed try rotates whatever its reason; held providers ordered by last failure (Opus M2) |
| 0590 | — | the watch playlist skips an epoch that recorded nothing (Opus M3) |
| 0591 | #302 | one outage is one gap; a restart's gap starts where the last part wrote (Opus L2, L3) |
| 0592 | #286 | the low-disk pass also ends a recording waiting between parts; the notice counts those stopped (Opus L6, L7) |
| 0593 | #288 | back-off: after 10 minutes of outage, at most one try a minute (Opus L4, Mark) |
| 0594 | #286 | the Settings hint and PRODUCT list the disk-low notice (Opus L1, L8) |
| 0595 | #304 | a refused connection on a one-provider channel counts again (Codex sign-off) |

Each has a test that failed on the code before it.

## Reviews

- Codex round 1 (0580 to 0586): 1 medium (the gap missed the shared-ingest connection wait). Fixed in 0587.
- Opus (0580 to 0586): no high, 3 medium, 8 low. M1 to M3 fixed in 0588 to 0590; L1 to L3 and L6 to L8 in 0591, 0592
  and 0594; L4 became Mark's back-off (0593); L5 (a first start with everything held back may prompt a viewer on a
  backup provider, not the primary) left as it is: it follows from the rotation.
- Codex sign-off of 0587 to 0594: 1 medium (0588 also kept refused connections out of the breaker). Fixed in 0595;
  Codex's sign-off of 0595: approve, no findings.

## Gates

`npm test` on 0595: 2302 tests, 2290 pass, 4 fail (the four AAC-LC tests in `recording-segments-media` that fail only on
the WSL machine). `scripts/verify-build.sh`: all checks passed (size warnings only).

## The rig (fake providers only, 0595)

Raw log: [`rig.txt`](rig.txt).

| check | result |
|---|---|
| #288: both providers refuse for 147 s, B back first | retries alternate A, B every 15 s; resumed on B one round after it came back; never ended early |
| #302: gap note against the time really missing | 155 s against 155.7 s; the outage counted as one gap (batch C: 6) |
| #304: a 99 s stall on a channel with one provider | provider "up" in all 71 Status samples, no "is down" line; note 100 s against 97.9 s |
| #305: a recording that waited, then started | no waiting reason from its first poll as recording |
| #306: a recording reclaims idle shared-feed streams | "Reclaiming idle stream … (a shared feed with no viewer)" ×4 |
| Back-off: every provider down for over 10 minutes | 4 starts a minute, then one every 75 s (the 15 s tick); resumed 65 s after B returned; note 815 s against 815.2 s |
| Connections after each check | 0 |

Not run on the rig: #286 (a low disk; T1 only). #305's briefed path (a recording queued behind a clash) ends missed by
design (D-42); the check used a recording that waited for a viewer. Seen on the way: that waiting reason said "Viewer
declined" although no viewer was asked (filed).
