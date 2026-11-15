# Provider placeholder batch, 16 Nov 2026 (server 0773 to 0779)

**Issue:** #332. **Captures first:** the channel audit (#331, 15-16 Nov) kept the provider's placeholder: 249 of 254 blank
captures share one first frame, 1920x1080@30, ~193 kbps, median connection 1 s; real channels start at 448 kbps.

**What changed:** two short low-rate connections in a row (or the 20 s blank verdict with the placeholder shape) end the
shared feed as `placeholder` (3 min hold, no breaker count); a play moves to the next candidate or gets C-B's "This
channel is not available right now: nothing is on this stream at the moment."; a recording keeps trying (D-59) and drops
a part only when it was the slate on a measured rate under 250 kbps; a slate probe is never a profile or relay
fingerprint; same-provider copies (same normalised name, different stream, no conflicting guide id) are candidates after
siblings and before backups. Checked against production's playlist (read only): every copy of Sky Sports Main Event,
TNT Sports 1 and Sky Sports F1 shares one guide id; ESPN US and AU differ and stay apart.

**T1:** `PIGTV_SKIP_PERF=1 npm test`: 2775 pass, 4 fail (the known WSL-only AAC failures); `verify-build.sh` passed.
New: feed-placeholder (ingest and recording) and channel-copies tests, each failing on the code before it.

**T3:** rig smoke check on 0779 (a normal channel plays to HLS). Not run: the placeholder itself end to end (the fake
provider has no slow-rate slate mode). The audit window (16-17 Nov) measures how often a copy rescues a blank channel.

**Codex (full rule):** round 1: one high (recordings, which subscribe without a height, used the 500 kbps HD threshold, so
a real SD feed with two drops could be deleted as the slate), fixed in 0778. Sign-off: one high (an unmeasurable part
could still be deleted); Mark chose to fix it first: 0779 keeps anything unmeasured. Sign-off: approve.
