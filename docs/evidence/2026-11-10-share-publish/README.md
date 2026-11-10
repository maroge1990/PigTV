# #287 T3: a publish against a hung share while a channel plays (10 Nov 2026)

**Build:** server 0515 (`3307801`, clean clone synced by `unraid-rig.sh up`; the rig image's base is the box's 4 Nov `:latest`, not re-pulled). Fakes only.
**Share:** the staging container's `/app/recordings` was bind-mounted from a 12 GB sparse ext4 loop image in the box's RAM `/tmp` (2 GB fails the 10 GB free-space check). Only the staging container was recreated. Every freeze (`fsfreeze -f`) had a 240 s safety thaw armed first and was thawed explicitly after 131 s, 132 s and about 90 s.
**Driver:** one process held a BBC ONE HLS transcode open the whole run, fetching every new segment. Health, status, channels, guide and recordings were each called every 1 s while frozen and every 2 s otherwise.

| Step | Result |
|---|---|
| A baseline | PASS: 120 s recording on ITV1 published 10.1 s after capture end (server log), plain name, 6.6 MB, h264/aac 111 s |
| B1 freeze 20 s before capture end | PASS: worst call 29 ms frozen (131 samples, 0 errors); playback no errors, max segment gap 4.0 s frozen; rec3 started into appdata while frozen. The remux went to the work folder, because the write check found the share not responding. |
| C1 thaw | PASS but slow: rec3 published 10 s after its end. rec2 (`moving`) published only at the 15 min move retry, 13.6 min after thaw. One file at the plain name, 8.2 MB, 137 s, no partial |
| B2 freeze when the remux's `.partial` appeared (48 bytes): the real mid-publish stall | PASS: worst call 40 ms frozen (130 samples, 0 errors); playlist max 23 ms, no playback errors, max gap 5.0 s, the same as unfrozen; rec3 started into appdata (5 segments 20 s after start) |
| C2 thaw | PASS: rec2 `done` 14.1 s after thaw (log `#9 is finished` 13 s after), one MP4 at its plain name, 8.6 MB, h264/aac 145 s, no `(2)`, no `.partial`; rec3 published 10 s after its end |
| D delete during the mid-publish stall | PASS with a note: the other calls stayed under 20 ms. The DELETE itself answered after about 30 s (by design: "1 writer(s) did not stop within 30 s ... the deletion goes on"); the row went at once. After thaw "a stopped writer ended; what it made is removed": nothing of it on the share |
| E cleanup | PASS: thaw verified (`touch` ok), test recordings deleted, staging back on its normal recordings path, loop unmounted and detached, image removed, sleepers gone; production `PigTV` same ID and start time (03:35:29Z), up 5 h, before and after |

Worst API latency while frozen, across all runs: 40 ms. With the share healthy: 118 ms.

**Rig findings (low, filed as #290):** a 0-byte `.pigtv-write-test-*` file left at the share root per stall; an empty work folder after a delete during a stall; an MP4 made in appdata moves up to 15 min after the share answers.

**Review findings, all fixed with a failing-before test** (T1: 1820 of 1824 locally, the four known ffmpeg 8 failures; CI green on 0515):
- Opus on the uncommitted fix: high, two queue runs finishing one recording, the take-back removing the other's MP4 (guards, held names; 0511). Mediums: re-remux every tick once the attempts are used; a local job killed while the share hangs; the take-back removing a new writer's partial; a link errno treated as a stall looping forever (all 0511).
- Codex on 0510-0511: high, the start-up sweep or a late unlink removing a republished file (0512, signed off). Medium on 0512: removal marks that never clear (0513, signed off).
- CI red on 0513 (test H): a failed move removed its partial after its writer ended (0514). Codex on 0514: high, the same in finishAttempt (0515, approved).
- Not fixed, filed: #289 (other paths that wait on the share), #290 (lows).

**Not checked:** a real SMB/NFS hang (a frozen ext4 blocks writes in the kernel the same way, but stays local); playback in a real client (HLS was fetched by script); a rig image re-pulled to CI's latest base.

Files: `timeline-run{1,2,3}.txt`, `latency-run{1,2,3}.txt` (every sample), `summary-run*.txt`, `recordings-final.txt` (states, ffprobe, share listings), `server-log.txt`, `cleanup-and-production.txt`.
