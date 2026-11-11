# #273, batch E (server 0559 to 0566): server hot paths; reviews, gates and the rig

Nothing here is meant to be seen: the same answers for less work. Six fixes from the 10 Nov audit, then two commits for review findings.

## What the batch did

- 0559: a logo the server already knows is a memory lookup; a guide page no longer opens a write transaction with up to 500 inserts.
- 0560: the Status page's 5-second poll reads its slow parts (least reliable channels, interruptions, free space) once a minute, owner names every 10 s.
- 0561: a scheduled sync leaves an unchanged backup provider or Xtream list alone (no rewrite, no relink); backups get the shrunken-list hold. "Sync now" always writes.
- 0562: the nightly database copy waits while any sync runs and retries at the next hourly check.
- 0563: a paired device's media requests stop writing "last seen" each time (once a minute). The user and the revocation are still read on every request: nothing about the auth answer is cached.
- 0564: the provider list is parsed once and dropped on any provider write, instead of about a dozen reads per play. No pool, limit or failover decision changes.

## Statement counts (each test fails on the build before it)

| fix | before | after |
|---|---|---|
| 0559: second read of a 500-logo page | 500 inserts, 1 write transaction | 0, 0 |
| 0560: 20 Status polls | 20 of each slow read | 1 of each |
| 0561: scheduled sync, nothing changed, two backups | 200 channel-row writes, 1 relink | 0, 0 |
| 0563: 50 media requests from one device | 50 writes, 147 statements compiled again | at most 1, 0 |
| 0564: 50 rounds of pool and failover questions | 450 provider-table reads | 0 |

## Reviews and findings

- **Opus on 0559 to 0564:** no high, 1 medium, 3 low, all in 0561. Sound: device auth (revocation by route and by raw SQL, user delete, role change all take effect on the next request), the provider list (the directory matches the old builder line by line; only the five `db.sources` writers touch the table), logos, the Status memo, the nightly copy, rollback to 0558.
- **Codex round one:** the same medium. A backup's list was remembered as good before its relink had run, so a relink that failed, or a restart before a global sync's deferred relink, was never retried: 20 new channels stayed without failover links in the proof script. Fixed in 0565 with a durable `relink_owed` row in `meta`, set around each channel write and cleared only by a relink that ran to the end. The three lows were fixed with it: the Xtream excluded-group set is worked out once; a source that stops being a backup forgets its size; a version number goes into the result fingerprints.
- **Codex sign-off on 0565: 1 high.** Paying the last debt deleted the row, so its sequence restarted and an older queued relink could clear a newer debt. Taken to Mark, who chose fix and re-check. Fixed in 0566: the row is kept, the sequence only grows, and a channel write that throws part-way still records its debt.
- **Codex sign-off on 0565 and 0566:** approve, no material findings.
- **Left:** after a rollback to 0558 and forward again, a stale fingerprint or backup size can skip or hold one scheduled sync ("Sync now" clears it). Status's `providerName()` has returned nothing since 0175 (it selects a column the table lacks): left as found, for Mark.

## Gates and the rig

`npm test` on 0566: 2,198 tests, 2,186 pass, 8 skipped, 4 fail in `recording-segments-media` on the build machine only (its ffmpeg writes AAC-LC). `verify-build.sh` passes. The rig: [`rig.md`](rig.md). In short: a device revoked mid-stream had no request accepted afterwards (first refusal 2 ms after the revoke returned); 52 media requests over 54 s made no database write, then the one a minute; play start 5,432 ms on 0558 and 5,431 ms on 0565; the provider block identical on both.

Still to do after a release (T4, read only): production's write-ahead log size and write rate before and after.
