# Server 3: the rest of the share, 0612 to 0625 (#289, #290)

No file call on the recordings share is made synchronously by the server, nor on its own thread pool, except for reading a recording's bytes while it plays (#318). Each fix has a test that fails on the build before it.

- 0612: the start-up clean-up sweep. 0613: stream, media.mp4 and download answer 503 when the folder doesn't respond. 0614: ad detection. 0615 (#290 item 1): stale write probes are removed. 0616 (#290 item 2): the work folders of deleted recordings are removed.
- 0617: a capture asked to stop after its ffmpeg exited no longer crashes the server. This was found as CI's EPIPE flake while Server 4 was pushed.
- 0618 and 0619: the copies to the share and the byte-for-byte check run on a helper process of their own, watched for progress, not for their whole length.

## Reviews

- Codex: 1 medium. Opus: 4 mediums and 4 lows. Recording keeps the full rule. Fixed: 0620 (a timed-out copy keeps its writer until its helper exits), 0621 (a flush every 32 MiB), 0622 (a helper that never started is not counted as stuck), 0623, 0624 (probe age from the name, not the share's clock) and 0625 (a missing file gives 404, not 500; the contract covers the three routes). There are also two test-only commits that give margins of at least 1 s.
- Not fixed here: reading the bytes of a recording as it plays is still on the thread pool. Filed as #318 and named in `docs/architecture/recording.md`.
- Codex sign-off: approve.

## Gates and rig

- `npm test`: 2,340 tests; the only 4 failures are the WSL-only AAC-LC ones. `verify-build.sh` passed.
- Rig (staging on 0625, fake providers): the smoke check passed, and a 3-minute recording finished as one MP4. media.mp4 answered 206 to a range, download 200, a missing recording 404.
- The stalled-share cases are proven by T1 (`test/share-hang.test.js`), not on the rig: its share is a local folder.
