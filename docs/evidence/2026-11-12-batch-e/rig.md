# T3 for batch E (#273, server hot paths): the rig's account, builds 0558 (before) and 0565 (after)

All on the test rig's staging server (fake providers A primary and B backup, sport fixtures off, defaults), driven by scripts that run inside the staging container
against localhost, with the throwaway staging admin login (never printed). No production container, no real provider, no tracked file changed by this run.
Addresses are written [rig], secrets [redacted]. The scripts and raw logs named below were scratch files and are not kept in the repo.
Timings are server-side from inside the container (no network), through the API the web app uses.

| build | what | `check` |
|---|---|---|
| 0558 | already running on the rig when the run began (status said build 0558, rig-019733c) | passed |
| 0565 | `scripts/unraid-rig.sh up` from this worktree (rig-ed93a95); `up` re-seeded both fakes and ended with its own `check` | passed |

## A and B. Timings, 0558 vs 0565

Play start = POST /api/playback/resolve (channel "UK| BBC ONE HD" on Fake A, strategy transcode) then the HLS playlist polled every 100 ms until it lists a segment, then
the first segment downloaded in full. Each run: stop the session (DELETE /api/playback/:id), wait until the status page lists no session, 1 s, next run.
Guide = GET /api/library/guide?limit=200 (30 channels, 29 with a logo), 1 warm-up then 10. Status = GET /api/status?details=0, 20 requests. (Channels list added as a second logo-bearing page.)

| measure | 0558 median (range) | 0565 median (range) |
|---|---|---|
| play start, 5 runs (ms) | 5432 (5034-6037) | 5431 (4866-6082) |
| of which resolve (ms), run by run | 5023, 5619, 5425, 6030, 5226 | 4856, 5621, 5423, 6075, 5216 |
| guide page with logos, 10 requests (ms) | 4.2 (3.9-4.9) | 4.0 (3.7-4.9) |
| channels page, 10 requests (ms) | 4.0 (3.5-4.5) | 3.8 (3.5-5.4) |
| GET /api/status?details=0, 20 requests (ms) | 3.8 (3.2-4.6) | 3.1 (2.8-4.0) |

Reading: play start is dominated by the resolve call (the probe and the transcode start), which this batch does not touch; equal within noise. The guide, channels and status
pages answer in about 4 ms already on this small catalogue (30 channels), so the rig cannot show the logo-write or status-memo gains: the differences are within run-to-run spread.
Raw: `measure-0558.txt`, `measure-0565.txt`, `check-0558.txt`, `up-0565.txt` (its "broken pipe" line is `docker run | cmp` on the lockfile test and the lockfile warning also appears on every `up`; neither is new).

## C. Device revoke (0565)

Paired the way the Apple app does: POST /api/devices/pair/start (no auth, X-PigTV-Client: `PigTV/565 (tvOS 26.1; AppleTV14,1)`), GET pair/pending and POST pair/approve as the
admin, GET pair/poll for the token. The pending answer parsed the client header (build 565, tvOS 26.1, AppleTV14,1, kind Apple TV).
With the device token and the client header: resolve, then playlist + last segment every 2 s for 60 s: 30 iterations, 0 non-200.

| step | result |
|---|---|
| revoke (DELETE /api/devices/:id as admin) | answered in 2 ms |
| playlist 2 ms after the revoke returned | 401 (segment not attempted) |
| playlist again right after | 401 |
| resolve with the device token / devices list with the device token | 401 / 401 |
| loop requests (every 2 s) after the revoke returned | 3 started, all 401 (first at +1.0 s, then +3.0, +5.0 s); 200 after revoke: 0 |
| seconds between revoke and the first 401 | 0.002 s (immediate probe); the loop's own first 401 was 1.0 s (loop spacing) |
| the one loop request that started 1 s before the revoke | 200/200 (it finished before the revoke) |
| devices list afterwards | revoked_at set |

Devices list (GET /api/devices as admin), taken right after the 60 s loop with the device's latest request made just before: name "T3 rig test device", platform tvOS,
app `PigTV/565 (tvOS 26.1; AppleTV14,1)` (build 565, os tvOS 26.1, model AppleTV14,1, kind Apple TV), `last_seen_at` 0.00 s before that latest request, although the device row had been
written only twice in the minute (see D): the list flushes the pending last-seen first. Raw: `device-0565.txt`.

## D. Writes (0565): the database's write-ahead log, read only

`stat` of staging's `content.db-wal` (mtime and size) every second through the rig's ssh alias, on the box, nothing opened or changed. A WAL file's mtime moves on every write transaction.
Idle control first (no client, 60 s): mtime unchanged for all 60 s (`wal-control-idle.txt`). Then the device test (`wal-device-loop.txt`, epoch seconds; loop ran from 1794431645.7 to 1794431705.9):

| epoch (s) | event | WAL mtime moved |
|---|---|---|
| ...638 | pairing start / approve / poll (device row written) | yes |
| ...643 | first device request (resolve), last-seen touched | yes |
| ...644 - ...697 | 26 loop iterations = 52 device media requests | **no write for 54 s** |
| ...698 | 60 s after the first touch: the once-a-minute last-seen write | yes |
| ...699 - ...705 | rest of the loop | no |
| ...706 - ...707 | the devices list's flush, then the revoke | yes |

So a device's media requests made one write a minute, not one each. Size stayed 4758632 bytes throughout (the WAL is reused in place). Not shown on the rig: the same loop on 0558
(the rig was moved to 0565 before this was measured), so there is no side-by-side count; the 0558 write rate is the code's per-request write, not measured here.

## E. Provider behaviour (0565)

| compared | result |
|---|---|
| /api/status providers block, idle, 0558 vs 0565 | same: Fake A (id 2) primary, Fake B (id 3) backup, both enabled, state up, downUntil null, limit 4 each, used 0, account ok, same expiry fields. Differences only in the stored timestamps (expiresAt, accountCheckedAt) after removing timestamps |
| same block with one stream playing, 0558 vs 0565 | same: Fake A used 1 of 4 (uses: viewer, "UK| BBC ONE HD", shared), Fake B 0 of 4; only ageSec differs |
| after the device test and the cleanup | 0 sessions, Fake A 0, Fake B 0 |

"Sync now" on Fake B (the backup), twice, 3 s apart (`sync-0565.txt`, `sync-log-0565.txt`): each time the log printed `Starting sync ... Fetching backup live channels ... Backup Fake B: 25 channels ...
[Links] Relinked 30 channels ... Completed sync`. Both rewrite and relink, because the Sync now route calls `syncSource` without `ifChanged`. The line that would show the new behaviour,
`Backup Fake B unchanged (the same 25 channels as the last good sync): nothing rewritten`, is printed only on the scheduled run (04:30 timer) or the startup sync of a stale source (more than the
refresh interval old), and the rig has no way to trigger either without changing its settings or clock. Not shown on the rig: T1 only (the unit test for the unchanged backup and Xtream list).
Also not shown: the relink that failed being owed and retried, and the nightly copy waiting for a sync (no way to fail a relink or hold a sync on the fake providers; T1 only).

## F. After the review fixes (0566)

The review fixes (0565's sign-off finding, fixed in 0566) changed only the sync's relink bookkeeping, which the rig cannot exercise (section E). The rig was brought up
again on build 0566 (rig-899b991) and `check` passed: 30 channels, the guide on 28 of them, "UK| BBC ONE HD" to HLS in 6,024 ms with a segment listed.

## State left

Rig up on build 0566, fake A and B and staging running, default mode (fake providers, sport fixtures off), no test stream playing, the test device revoked (its row stays
in the Devices list as revoked).

## What the rig could not show

- The logo, status and provider-list gains: every page answers in about 4 ms on a 30-channel catalogue. Their proof is the statement counts in the tests (T1).
- The unchanged-backup skip, the owed relink and the nightly copy waiting for a sync: T1 only.
- The write rate on 0558 side by side: not measured (the code wrote on every request).
