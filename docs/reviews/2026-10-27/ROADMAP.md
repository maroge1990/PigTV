# Roadmap, 27 Oct 2026

Where things stand after the R7 week, what to do next in order, and what only Mark can answer. It replaces nothing:
`blueprint.md` §4 stays the record of each roadmap item's status, `docs/FINDINGS.md` the register of open findings.

## Where things stand

| | Server | Apple client |
|---|---|---|
| Live (deployed) | **0284** | **57** (pushed; on the Apple TV) |
| Pushed, not deployed | 0285 (retired settings dropped) | — |
| Committed locally, waiting for Mark to push | 0286 FR-11 · 0287 `feed_lag` · 0288 smaller Status page · 0289 feed names on profile plays | — |

- **R7 works on the device.** Since 0282–0284 (a feed judged by how far it is behind real time, by its own clock) and
  Apple 56–57 (live plays held 30 s back): NBC Sports Boston 35 min and Chicago Sports Network Plus 65 min, 0 stalls, no
  switches. Before: a stall every ~7 min and a provider switch every ~11 min, with the sound out of step afterwards.
- **Shared ingest is on** on Mark's server (off by default in code). **Segmented recordings is on** since 27 Oct.
- **Codex review of 0286–0289:** round 1 found one medium (feed names lost on profile plays), fixed in 0289; round 2
  approved. The batch has had its two rounds.
- **Tests:** server 1186/1186 and `verify-build.sh` passed at 0289. Apple CI green at 57.

## Prioritised work

### P0: ship and confirm what is waiting (Mark, then a short session)

1. **Push and deploy 0286–0289** (Force Update; `curl -s http://192.168.1.235:3000/api/version` reads 0289).
2. **Live checks after the deploy** (Mark):
   1. Status opens on Providers / Playing now / Recordings / Last 7 days; Show details opens the rest and is remembered
      after a reload.
   2. Watch any channel over a minute and close it: Status, Show details, "Feed lag (30 days)" lists it **by name**.
   3. A short segmented recording, watched from the start on the Apple TV while it records, then the finished MP4.
3. **FR-11** needs no test unless the app freezes again (FR-10); then a fresh play should end the stuck stream at once.

### P1: finish R7 from real data (after about a week of normal viewing on 0287+)

4. **FR-12, the 24 s limit.** Read `feed_lag` (Status details, or `SELECT … FROM feed_lag`). Chicago reached 24.1 s
   healthy on 27 Oct. Options: a per-channel limit from each channel's worst (bounded under the Apple client's 30 s hold),
   or raise the limit and the hold together (30 s / 36 s). Needs Q2. `PIGTV_INGEST_BEHIND_SEC` is the stop-gap.
5. **Reconnect or switch.** Today a feed past the limit is reconnected on the same provider, and while it reconnects
   the relay may switch to a ready standby (FR-12). With `feed_lag`'s lag reconnects per provider, decide whether repeated lag on one provider should
   move the channel to the next. Avoid switching between Strong8K and Trex for the same pause: they share an upstream
   and paused together (FR-8).
6. **Channels with no usable standby** (TNT Sports 4: Dream 4K is HEVC/50 fps/5.1, Trex 720p; FR-14). A standby must
   match to be spliced; a cold restart on another provider is the only failover. Measure how many channels are like
   this (the relay logs "cannot join this stream") before designing anything.

### P2: correctness

7. **FR-14, TNT Sports 4's sound 2-3 s behind on Strong8K** (in the feed itself; same on the web player). Needs Q3.
8. **FR-9, HE-AAC copied on a fresh probe**: one failed start (~6 s) the first time an HE-AAC channel is played after
   its cache expires. Find why the fresh probe's capability check says "copy"; the cached path already re-encodes.
   Small, has a reproduction in FINDINGS.
9. **FR-10, Apple player frozen after a long live play** (no play-end or DELETE reached the server). Not reproducible
   on demand. If it recurs: note the time and channel; the server log around it and whether the app answered at all
   are what to look at. Consider an Apple-side watchdog log line only once there is a second occurrence.
10. **Bugs 5 (AUS v SA grouping) and 8 (iPhone tuning)**: still without a root cause (blueprint).

### P3: housekeeping and design debts

11. **B4 (retire relay stitching, standby, the 0143 retries, warm leases)** was planned "after shared ingest has run a
    week". The standby is still the only seamless failover and now reads through the ingest, so B4 should be
    re-scoped before anything is removed. Needs Q4.
12. **Settings → Recording has two Save buttons** (the section's and Notifications'); Mark used the wrong one on
    27 Oct. Left as is by Mark's choice; if touched, save each switch on change, as the hardware-decode switches do.
13. **FR-1** recording cleanup simplification (design), **FR-2** a Codex round on 0280 if wanted.
14. **Flaky tests** FR-3, FR-4, FR-13 (keep the log if they recur); Apple test-run hangs FR-5, the tab-switch gate FR-6.
15. Waiting on Mark from earlier rounds: R8's before/after sync measurement, the E3 samples' location, E2 ffmpeg parity,
    live ffmpeg speed on Status (deferred), the efficiency register (deferred, unmeasured).

## Questions for Mark

| # | Question | Why it matters | Suggested answer |
|---|---|---|---|
| Q1 | When can 0286–0289 be pushed and deployed? | `feed_lag` only collects from the deploy on; the week of data for P1 starts then | As soon as convenient |
| Q2 | After a week of `feed_lag`: per-channel limits, or one higher limit for every channel (30 s, with the Apple hold at 36 s: 6 s further behind live)? | FR-12: a healthy Chicago pause reached 24.1 s; just above it means a needless reconnect | Per-channel, if a few channels stand out; one higher limit if most channels sit near 20 s |
| Q3 | TNT Sports 4: put Dream 4K first for it, add a per-channel audio delay, or live with it? | FR-14: the offset is in Strong8K's feed | Try Dream 4K on the Apple TV first (HEVC 50 fps 5.1); if it plays well, prefer it for that channel |
| Q4 | Keep the hot standby (re-scope B4) rather than retire it? | It is the only seamless failover; B4 assumed the ingest would replace it | Keep it; retire only the parts the ingest made redundant |
| Q5 | Make shared ingest the default in code? | It is on on your server and R7 depends on it; a fresh install gets the old path | Yes, once 0289 has run a week without trouble |
| Q6 | Is there a channel you watch that still stutters or loses sync after a stall? | The next capture (`scripts/stream-doctor.js`) should be on a real problem channel | Name it when you see it |
| Q7 | R8 sync measurement and the E3 samples' location (open since 16-18 Oct): still wanted? | They gate R8's future and the audio-track check | Close them if no longer of interest |

## How to pick this up

The handover prompt for the next agent is [`HANDOVER.md`](HANDOVER.md).
