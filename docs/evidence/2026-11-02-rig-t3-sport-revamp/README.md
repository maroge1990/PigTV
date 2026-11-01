# Combined T3 on the rig: server 0432 with Apple 101 (D-42, #200, #193–#203)

2 Nov 2026. Staging on the Unraid rig: the working tree at 0432 on CI's own image (`sha-ed878f9`), the fake providers,
ESPN's free sport feeds on (`PIGTV_RIG_SPORT_FIXTURES=1`). No real provider; production (0387, `:latest`) untouched.

**Server:** `unraid-rig.sh check` passes (30 channels, guide, 15 sport events with 3 live, one channel to HLS). With an
account following AFL, Cricket and WBBL, NFL, F1/NASCAR/IndyCar, ATP/WTA, PGA Tour and UFC: `PUT /api/sports/follows`,
the front page (30 games, live-first sports), and the F1, NFL, Cricket, AFL (C-T) and C-V pages (UFC, NASCAR, IndyCar,
ATP, PGA) all answer 200. F1's circuit maps draw (light and dark, about 240 KB PNG, 0.6 s first, 6 ms cached).

**Rig gotcha:** on the box's older `:latest` image the maps were 404 (`@resvg/resvg-wasm` missing; `up` warned that
package-lock.json differs). The rig must run the image of the commit under test (`PIGTV_RIG_IMAGE=…:sha-<commit>`).

**Apple TV (build 101, tvOS 27 simulator, `StagingSportTVUITests`):** signs in, opens the front page, every sport page
and Settings › Sport. All load. Screenshots: `rig-01-front.jpg`, `rig-03-motorsport.jpg`, `rig-05-…-nfl.jpg`,
`rig-06-…-afl.jpg`, `rig-08-cricket-international.jpg`, `rig-10-tennis.jpg`, `rig-11-golf.jpg`, `rig-12-combat-ufc.jpg`.

**Found (Apple layout, real data only):** the AFL % column wraps ("137." / "200"); NFL cards cut the situation line and
clip a glyph at the right edge; NFL standings cut W-L-T; cricket's lead line is cut and its backdrop is a plain flag
block; tennis cards cut "Not on your channels".

**Checked and correct:** golf shows R1–R3 (Round 4 not scored yet) and no Your players (Adam Scott is not in the field);
UFC shows next Saturday's card as "Up next" (last week's results are in the answer); AFL's "Nothing in the next three
days" (season over).

Not covered: the web app (no login typed into staging from a browser), iOS/iPad, a recording on staging.
