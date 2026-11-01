# 0402–0403: fixtures from each sport's own feed (#196, D-41)

Server, 1 Nov 2026. Base `aac8a94`.

**0402:** `sportFeeds.js` reads AFL's API (AFLW), Champion Data (NRLW, Super Netball), MotoGP's results API and
supercars.com's calendar page into the collector's games. Samples captured on 1 Nov are in `test/fixtures/feeds/`
(trimmed): AFLW 117 matches (one live), NRLW 66, Super Netball 56, MotoGP's Qatar weekend (8 sessions), the 14 events of
the 2026 Supercars calendar.

**Tests (T1):** `test/sport-feeds.test.js`; the collector and guide-join tests fail on the old code. Full suite 1,574
pass; the usual 4 fail only on the WSL box (ffmpeg without HE-AAC).

**Codex adversarial review, round 1** (`--base aac8a94`): needs-attention, two high and one medium, all fixed in 0403
with failing-before tests (`test/sport-feeds.test.js` › 0403):

1. *High: redirects bypassed the host allowlist.* Redirects are refused (`redirect: 'manual'`, any 3xx an error).
2. *High: no size limit on answers.* Bodies are read through the stream up to 5 MB, aborted past it.
3. *Medium: any airing in a Supercars weekend joined it.* It must name the event's track or town.

Round 2: the fixes hold, no high. One medium left open as an issue (MotoGP Q1/Q2 share one join identity; Warm Up never joins).

**Not covered:** Super Netball's eight badges (by hand, still to add); T3 on the rig; live-score freshness of the
new feeds (fixtures and results only, as Mark asked).
