# Placeholder file in a recording, 16 Nov 2026 (server 0784 to 0787)

**Issue:** #333, from Mark's NFL recording on production 0695 (16 Nov): after a drop the provider answered the recording's
direct capture with a 10-minute placeholder file six times (3,600 s of a 71 kbps still slate in the MP4), and the MP4's
audio broke at the two joins (about 850,000 AAC packets under 15 ms), so the iPad's player stalled. The file was
repaired by hand with Mark's go-ahead (audio rebuilt, the slate hour cut).

**What changed:** a direct-capture part read at least 3x real time (and under the deletion threshold or at least 300 s
ahead) is the placeholder file: the part ends as an outage (3 min hold, the recording keeps trying, D-59); only its
trailing segments each measured under 250 kbps are deleted, so programme before the file survives; one fixed 250 kbps
cap for every deletion whatever `PIGTV_BLANK_KBPS` says. The MP4 remux no longer pads audio from 0 at a format change
(`first_pts=0` removed; `setts` keeps each AAC packet after the previous one); video is still copied.

**T1:** `PIGTV_SKIP_PERF=1 npm test`: 2787 pass, 4 fail (the known WSL-only AAC failures); `verify-build.sh` passed.
New: `recording-placeholder-file` (real ffmpeg against the fake's new `file` mode, which reproduces production's
`speed≈2000x`) and `recording-mp4-audio-joins`, each failing on the code before it. CI's ffmpeg (9.0.2) is the first run
of the `setts` filter outside this machine's 8.0.1.

**T3:** rig smoke check on 0787 (a normal channel plays to HLS).

**Codex (full rule):** round 1: one high (a fast read deleted a whole part, programme included), fixed in 0786.
Sign-off: one high (the deletion threshold followed `PIGTV_BLANK_KBPS`); Mark chose to fix it first: 0787. Approve.
