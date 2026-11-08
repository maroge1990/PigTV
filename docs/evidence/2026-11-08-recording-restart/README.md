# Batch 0489–0492: appdata slimming, recording across a container stop, F1 channels (8 Nov 2026)

Issues: #246 (restart), #247 (appdata), #248 (F1 channels).

## What happened (production, T4, read-only)

- The 7 Nov Sao Paulo GP qualifying recording on Sky Sports F1 (schedule 21, recording 205) kept 381 s of a 3 h slot,
  marked `completed`.
- Unraid's Appdata Backup (Stop/Backup/Start, Sundays 04:00 AEDT) stopped the container at 17:05:07 UTC and restarted it
  at 17:12:37. Its log: `[PigTV] Stopping PigTV... done`, backup 5 min 04 s, verify 2 min 25 s.
- PigTV's appdata was 6.9 GB:
  - `samples/` 4.3 GB of September–October captures, deleted on Mark's go-ahead 8 Nov, leaving 2.7 GB.
  - `backups/` 2.1 GB: nightly copies 441 MB, pre-migration copies 210 MB.
  - `content.db` 421 MB, of which 187 MB is free pages.
- The race's guide titles (8 Nov, 16:55 UTC) are listed in #248. ESPN calls it `MSC Cruises São Paulo Grand Prix`.

## Fixes and tests (T1; each test fails on the code before it)

| Build | Change | Test |
|---|---|---|
| 0489 | Nightly copy is `VACUUM INTO` in a worker; stale `.partial-shm/-wal` are pruned | `test/db-backup.test.js` 0489 × 2 |
| 0490 | SIGTERM leaves an in-window segmented recording to resume at the next start | `test/recording-segments.test.js` 0490 (stop, resume; after its time) |
| 0491 | F1 places compared accent-folded, with country/circuit names (`F1_PLACES`) | `test/sport-feeds.test.js` 0491: 7/7 real listings join (1/7 before) |
| 0492 | A cancel during a shutdown wins (Codex round 1, medium) | `test/recording-segments.test.js` 0490 cancel × 2 |

## Gates

- `npm test`: 1767/1771 pass. The 4 failures are `test/recording-segments-media.test.js`, which needs ffmpeg 9.0.2 for its
  HE-AAC labels. WSL has 8.0.1 (a known local gap); CI uses 9.0.2.
- `verify-build.sh`: all checks pass. Its backup check now looks for `VACUUM INTO`.

## Codex adversarial review

Round 1, against 2feb68a: one medium finding, no high. A shutdown/cancel race could strand a recording in `capturing`.
Fixed in 0492. No round 2 (D-38).

## Still to check

- T4 after release: the next nightly copy is about 210 MB, and no new `.partial-shm` files appear.
- T5: stop the container mid-recording and start it; the same recording continues, with the gap noted.
- T4: the next F1 weekend lists all its channels.
