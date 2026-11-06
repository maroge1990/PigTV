# Server idle work (#237, #238), builds 0477–0480, 7 Nov 2026

**What changed:** a scheduled or start-up sync downloads each M3U playlist and guide once, fingerprints it (ETag /
Last-Modified as a conditional request, else SHA-256) and skips the rewrite when it matches the last good sync; a global
sync relinks once; heap and progress lines only with `PIGTV_DEBUG_SYNC=1` (0477, 0479, 0480). The sport score collector
fetches every 30 s only while a score page was asked for in the last 5 min or a recording runs, else every 5 min (0478).

**T1:** `test/sync-unchanged.test.js` (8) and `test/sport-collector-demand.test.js` (4); each fails on the build before
its fix. Full suite: 1,738 pass; 4 fail only on WSL's ffmpeg 8 (HE-AAC fixture), as on 0476; CI has the pinned build.

**T3, the rig (fake providers; Xtream primary, M3U backup; 24 guide channels, 3,204 programmes):** the same sync twice
within an hour (the fake guide's bytes change on the hour), run in the staging container (`measure-sync.js`, counts only).

| | 0476 | 0478 |
|---|---|---|
| Time | 575–677 ms | 213–230 ms |
| Guide | 3,204 programmes written, 3,204 removed | "Guide unchanged", nothing written |
| `[Links] Relinked` | 2 | 1 |
| `[Sync]` lines (heap lines) | 26 (2) | 20 (0) |
| Process RSS after | 141–149 MB | 89 MB |

The rig's primary is Xtream, whose API lists are not fingerprinted; production's M3U playlist and 495,000-programme
guide are. Backup lists are always rewritten (now with one relink).

**T3, the collector:** fake ESPN (`PIGTV_RIG_SCORES=fake`), EPL followed, its scripted game live throughout, no client
looking. Ticks (Status `sportCollector.ticks`): 0476 **6 in 3 min** (every 30 s); 0480 **1 in 6 min**, Status saying
"every 300 s, nobody looking". Scoreboard requests in 10 min: 0476 10, 0478 6 (a tick only re-asks expired answers;
production follows many leagues, up to 12 answers a tick, so its saving is closer to the tick ratio).

**Codex:** round 1, one high (guide fingerprint stored before the import's last writes): fixed in 0479. Round 2, one
high (a failed import kept the previous fingerprint; A, failed B, A was skipped): fixed in 0480. A check of 0480 alone:
approve, no findings.

**T4 after release:** `docker logs PigTV | grep -c "\[Sync\]"` over a day (was ~1,050), the run time of a sync with an
unchanged guide (was ~2 min 15 s), and NET I/O per idle hour (was ~80 MB).
