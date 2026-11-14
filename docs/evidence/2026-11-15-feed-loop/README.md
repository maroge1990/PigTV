# Feed loop (server 0677 to 0695): a provider feed that repeats the same clip is caught and switched (#324)

## The capture (14 Nov, Mark's OK, production idle)

stream-doctor `capture` of FOX Footy on Strong8K, 120 s, in the production container; the sample is kept off the repo.
Video and audio repeat every 36.22 s (1811 video and 1129 audio packets), every packet equal to the one a period
earlier while the timestamps keep rising; `classify` said EVEN. Our pipeline was ruled out on the rig beforehand.

## What ships

`server/services/feedLoop.js` hashes the provider's own bytes in `Ingest.onData` (payload only, sampled per access unit).
A feed is looping when a run longer than one period plus max(10 s, 0.25 period) equals the run one period earlier
(period 5 to 120 s), one period is at least 80 % distinct with 3 or more key frames (a slate never matches), the clock
is even, and the **sound is known and repeats or is silent** (Mark's choice after the sign-offs: a feed without a known
sound track is not checked). The sound comes from a PMT read whole with a valid CRC; any PMT change not yet validated, or
sound not arriving within 1 s, gives no verdict. Then, only if every viewer and recording on the feed can be admitted on
another provider the relay or recording would really use, the feed ends as `repeating` and the existing dead-feed path
fails over: channel-only quarantine (never the provider's breaker), a 60-minute skip of that provider for that channel.
With nowhere to go it plays on and Status says so. `PIGTV_INGEST_LOOP_CHECK=0` turns it off. Cost on the capture:
0.36 ms of CPU per second of media, under 1.5 MB per feed. Detection on the capture: 82.5 s in.

| build | change |
|---|---|
| 0677 | the detector, ending the feed as lost so it fails over |
| 0678 | channel-only quarantine (Mark's call: a loop is one channel's) |
| 0679 | only when another provider can take over; otherwise plays on (Mark's call) |
| 0680 | Codex high: a sustained loop only, never one clip aired twice |
| 0681 | Codex high: audio assembly bounded |
| 0682 | Codex high: only a provider the readers would really switch to |
| 0683 to 0690 | Opus: long loops at 60 fps, sound from the PMT not subtitles, no ping-pong, every viewer admitted, a failing start held against the channel only, down or expired providers skipped, Status note cleared and shown on the web, the play's channel reaching its feed when the probe is skipped (a real bug) |
| 0691 to 0695 | sign-off highs (Mark chose to fix each): a split PMT, a damaged PMT, the pointer_field prefix, no 'no sound' verdict, a changing PMT or stale sound never confirming |

Each has a test that failed before it.

## Reviews

Codex round one: 3 highs; Opus: 4 mediums, 4 lows; all fixed. Codex sign-offs found four more highs in the sound
handling; Mark chose to fix each, then to remove the "no sound" verdict, then one broad fix and ship.

## Gates

`npm test`: only the four AAC-LC tests that fail on the WSL machine fail. `verify-build.sh`: all checks passed. T2 on the
capture: loop found, 36.22 s, sound repeating. Not run: the real feed on production (after a Force Update).
