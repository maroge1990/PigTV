# Batch C (#271): the part-based recording path retired (D-56)

10 Nov 2026. Server 0504 to 0509, pushed at `01a666f`. Base `de019e4`.

## Checks

- `npm test` at 0509: 1778 of 1791 pass, 8 skipped, 1 todo (#287), 4 fail (the known local `recording-segments-media`
  ones, ffmpeg 8.0.1); `verify-build.sh` passed. CI green, 4 min 16 s (run 42757930655).
- Each fix's test fails on the build before it: #284 on 0503 (9 starts in 4 s without a tick), #285 on 0504, the
  low-disk order on 0508, `captureInput` on 0507. Both exact capture-argument pins (URL form, shared-feed form) pass
  untouched across 0507 and 0508, and each fails in a scratch copy with one token dropped or kept.
- Tests moved off the part path: 8 files. Every moved case was shown to fail with its behaviour broken in a scratch copy.
  Deleted cases pinned the part cap, "no backup: fail" (0499 requires the opposite) or states a segmented recording
  cannot reach. Server code is 662 lines shorter, 92 added.
- T3 on the rig (fake providers, staging on 0509):
  - Past the guide end ([`overrun-t3.txt`](overrun-t3.txt)): stopped 35 s after final + padding (allowed -5 to 120 s),
    one row, 1348 s, MP4 published. The driver printed FAILED from its own check, read while the MP4 was still being
    made; that check now waits for it (`scripts/unraid-rig.sh`), proven against two finished recordings, not a rerun.
  - Across a container restart ([`restart.txt`](restart.txt)): the same row continued 3 s later in a second epoch, gap
    noted, one completed recording of 594 s from a 598 s capture.
  - Failover mid-recording ([`failover.txt`](failover.txt)): Fake A failed, the same row continued on Fake B at once;
    one completed recording, 7 epochs, 502 s of 594 s. With both down: one start per 15 s tick, none back to back, all
    on Fake A (#288).
- Not run: T5 (one real recording end to end, Mark).

## Reviews

- Opus review before Codex: no high, 2 medium, 4 low.
  - Medium, fixed in 0509: the low-disk check returned before checking appdata when the share was down.
  - Medium, fixed in 0509: `architecture/recording.md` still described share work the batch removed.
  - Lows: two stale comments fixed. Left: a failure notice when a waiting recording with nothing recorded is deleted (as
    before); a delete racing the finishing step over one work folder (unverified, as for an active delete); after one
    wait every short failure waits a tick (the #284 rule).
- Codex adversarial review (base `de019e4`, at 0509): approve, no findings. Static; it ran no tests.

## Found on the way

#284 and #285 (fixed here, closed); #286 no reason shown when low disk stops a recording; #287 (P1) the publish to the
share makes synchronous calls on it, a `todo` test holds the case; #288 tries and the cap with every provider down.
