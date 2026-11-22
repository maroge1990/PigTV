# TV Guide speed baseline, 22 Nov 2026 (#362)

This is the TV Guide speed baseline taken before any fix, so batch 2 (#360) can show before and after from the same
test on the same machine. The Apple client is build 373: instrumented, Guide code unchanged. It ran 4 times on a
simulated Apple TV 4K (3rd generation), tvOS 27.0, on a MacBook Air (MacBookAir10,1, M1, 8 CPUs, 8 GB, macOS 27.2.1). The
fixture is the production shape: 1,250 channels; the paged test serves 3 pages of 500.

**These are MacBook simulator figures, not Apple TV hardware. The simulator does NOT reproduce the hang Mark sees on
his Apple TV.** The counts (body evaluations and cell configurations per press) do not depend on the machine. The
milliseconds do, so compare them only with runs from this same setup.

## How to rerun

- Apple client: `sh Tools/mac-gate.sh perf --worktree` in the PigTV-Swift repo.
- Server: `node --test test/guide-perf.test.js` in this repo.

## Apple client, per scenario (range over runs 1 to 4)

Focus = time from key press to focus change. "Per press" counts are per focus move. Gaps are frame gaps in the window.

| Scenario | Focus median ms | Focus worst ms | Body evals | Cell configs | Max gap ms | Gaps >100 ms |
|---|---|---|---|---|---|---|
| a-first-screen | none | none | 5 to 7 (total) | 25 to 26 (total) | 213 to 235.8 | 4 to 6 |
| b-down-40 | 15.6 to 16.1 | 30.4 to 37 | 1 per press | 5.4 to 5.5 per press | 119.4 to 121.5 | 1 |
| c-up-40 | 21.7 to 22.9 | 26.6 to 37.9 | 1 per press | 6.5 per press | 111.6 to 119.4 | 1 |
| d-right-10 | 31.9 to 32.9 | 38.3 to 52.5 | 1 per press | 24 to 25 per press | 68.5 to 108.1 | 0 to 1 |
| e-held-down-100 | 10.8 to 11.7 | 41.7 to 57.1 | 96 to 97 for 96 moves | 744 to 764 for 96 moves | 107.3 to 123.9 | 1 |
| f-idle-35s | none | none | 1 per 30 s tick | 20 to 24 per 30 s tick | 73.9 to 530.8 | 0 to 1 |
| g0-paged-first-screen | none | none | 10 to 12 (total) | 25 to 26 (total) | 191.2 to 340.5 | 7 to 13 |
| g-paged-down-20 (runs 1 to 3) | 15.7 to 16.6 | 27.2 to 36.3 | 1 per press | 5.2 to 5.3 per press | 117.1 to 121.2 | 1 |

- First screen: a-first-screen took 372.9 to 511.9 ms; g0-paged-first-screen took 490 to 810.8 ms.
- e-held-down-100: 96 focus moves, 8 holds, 8 superseded moves in every run. Cell configs per move works out at 7.8 to
  8.0 (744/96 to 764/96); runs.txt gives no per-press figure for this scenario.
- f-idle-35s: the 35 s window holds one 30 s tick. Run 1 had 24 cell configs, runs 2 to 4 had 20, each with 1 body
  evaluation. Run 2 had one 530.8 ms frame gap in this scenario: a single occurrence, unexplained.

## Paged scroll, run 4 only (g-paged-down-45)

Runs 1 to 3 ran g-paged-down-20 with no page arriving inside the press window (applies 0), so only run 4 measures a
page landing during a press. Run 4 spaced the pages 7 s apart (runs 1 to 3: 3 s) and started the window right after
the first screen. The JSON for run 4 says:

| Field | Value |
|---|---|
| applies | 2 |
| applyMs | 128.7 |
| focus moves / entry presses | 46 / 2 |
| body evals / cell configs | 50 (1.1 per press) / 249 (5.5 per press) |
| focus median / worst ms | 16.5 / 59.1 |
| max frame gap ms / gaps over 100 ms | 118.6 / 2 |
| rows at start / end | 500 / 1250 |

Ambiguous: runs.txt does not say whether applyMs is a total or a worst single apply. It also records
appliesPerPress as 0 beside applies 2. Treat 128.7 ms as "the figure the probe reports", not a per-page time.

## Tab switches (TABSWITCH) and XCTest signposts

Twelve transitions per run were recorded for runs 1 to 3; run 4 recorded only the summary line.

| Run | Worst stall ms | Worst on every lap ms | Mean ms | Budget ms |
|---|---|---|---|---|
| 1 | 222 | 106 | 111 | 500 |
| 2 | 210 | 108 | 116 | 500 |
| 3 | 169 | 141 | 113 | 500 |
| 4 | 225 | 143 | 120 | 500 |

- Sport to TV Guide: longest stall 97 to 157 ms, lost 334 to 520 ms. Recordings to TV Guide: stall 93 to 146 ms,
  lost 326 to 406 ms.
- Signpost `Duration (GuideFocusMove)`, averages: 0.019, 0.017, 0.015 and 0.017 s (runs 1 to 4). Relative standard
  deviation 12.9%, 24.0%, 6.8% and 24.5%. Each run has 3 values, from 13.3 to 23.4 ms.

## Server (test/guide-perf.test.js)

Production-shaped database: 19,000 playlist rows, 1,250 visible channels, about 600,000 guide rows. Route
`GET /api/library/guide`, limit 500.

| Measure | Measured | Target |
|---|---|---|
| Page 1, raw | 4,132,205 bytes | none |
| Page 1, gzip (on the wire) | 817,564 bytes (818 KB) | under 300 KB |
| Page 1, time | 66 to 78 ms | none |
| All 3 pages, raw | 10,332,146 bytes | none |
| All 3 pages, gzip | about 2,045,215 bytes | none |
| All 3 pages, time | 174 to 187 ms | none |

## What the baseline says about the review's findings

- G1 supported: every vertical and horizontal press costs exactly 1 GuideView body evaluation.
- G3 supported in count: 5.2 to 6.5 cell configurations per vertical press and about 24 to 25 per horizontal press.
- G5 supported: each 30 s idle tick costs 1 body evaluation plus 20 to 24 cell configurations (24 in run 1, 20 in runs
  2 to 4), with nobody touching the remote.
- G2 measured only in run 4 (applies 2, applyMs 128.7, worst focus 59.1 ms, 2 gaps over 100 ms); runs 1 to 3 never had
  a page arrive during a press.
- One frame gap just over 100 ms shows up in nearly every scenario, idle included (all but d-right-10 run 1 and
  f-idle-35s run 3). The cause is unknown, so it is probably not caused by focus moves.

## Run 5: the "before" for batch 2 (Apple 374)

The review of 373 found that the timer stopped at the first chance to draw, before layout and rendering. From 374 a
focus move and the first screen end on the following frame, at the time it is due on screen, so the milliseconds read
about two frames (31 ms at 60 Hz) higher than runs 1 to 4. The counts are unchanged. **Batch 2's before and after
figures compare against this run, not runs 1 to 4.**

| Scenario | Presses | Moves | Focus median ms | Focus worst ms | Body evals per press | Cells per press | Applies | Max gap ms | Gaps over 100 | First screen ms |
|---|---|---|---|---|---|---|---|---|---|---|
| a-first-screen | | | | | | | 1 | 233.3 | 2 | 413.1 |
| b-down-40 | 40 | 40 | 47.0 | 61.0 | 1 | 5.5 | 0 | 120.3 | 1 | |
| c-up-40 | 40 | 40 | 58.4 | 62.0 | 1 | 6.4 | 0 | 112.8 | 1 | |
| d-right-10 | 10 | 10 | 58.2 | 61.4 | 1 | 25.4 | 0 | 63.0 | 0 | |
| e-held-down-100 | held | 88 | 27.0 | 69.9 | | | 0 | 108.8 | 1 | |
| f-idle-35s (one 30 s tick: 1 body eval, 20 cells) | | | | | | | 0 | 110.8 | 1 | |
| g0-paged-first-screen | | | | | | | 2 | 190.9 | 1 | 517.5 |
| g-paged-down-45 | 45 | 46 | 47.2 | **105.1** | 1.1 | 5.5 | 2 (applyMs 134.3) | 120.0 | 2 | |

The one figure over the 100 ms target is the worst focus move while a page of guide data arrives during scrolling
(105.1 ms): the simulator's only reproduction of a hitch tied to a press.

Targets are fixed in docs/DECISIONS.md D-80. Refs #362, #360, #361.
