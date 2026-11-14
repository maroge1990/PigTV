# Server 4: key-frame join edge cases, 0602 to 0611 (#309)

The four cases the reviews of 0578 and 0579 left, each with a test that fails on 0601:

- 0602: a repeated table packet no longer completes a PMT without its last packet (continuity counters).
- 0603: a joiner's key frame is read with the PMT in force where it lies, never with a part-sent new one.
- 0604: the fallback join has a byte budget; over it, the reader starts at the next PAT.
- 0605: a joiner's backlog is not counted as lag, so high-bitrate feeds keep the key-frame join (T2: a synthetic 30 Mb/s feed with a key frame every 4 s; on 0601 sound started 0.576 s before the picture, now within 0.1 s). A joiner may briefly hold up to twice the slow-reader limit while it reads its backlog (accepted).

## Reviews

- Opus: no high, 2 mediums, 5 lows. Codex: 1 high (a PAT split across chunks was missed while waiting for one). Playback keeps the full rule, so all were fixed: 0606 (split PAT, packet boundary), 0607 (`no-pat` after the look-back), 0608 (the backlog is copied, so it doesn't keep the whole window alive), 0609 (filled packets, discontinuities, announced PMTs), 0610 (the opener's start-of-connection budget), plus a test-only commit for timing margins of at least 1 s.
- Codex sign-off: one high (0609 left a filled packet out of the replayed PMT). Mark chose to fix it: 0611. The second sign-off approved it.
- Left as before: a packet that ends one table and starts the next (pointer_field > 0) is still dropped. This predates #309 and ends in the fallback join.

## Gates

`npm test`: 2,322 tests; the only 4 failures are the WSL-only AAC-LC ones. `verify-build.sh` passed. Rig (staging, fake providers): up on 0611, and the smoke check played BBC One over HLS.
