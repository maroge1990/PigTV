# 0404–0408: MotoGP sessions, Super Netball badges, tennis/golf/UFC/IndyCar/NASCAR (#206, #196, #197)

Server, 1 Nov 2026. Base `f49e423`.

**0404 (#206):** MotoGP's guide join keeps Qualifying 1 and 2 apart (also "Q1"/"Q2") and recognises Warm Up; F1 unchanged.
**0405 (#196):** Super Netball's eight clubs carry Champion Data's badges by squad id (checked by eye 1 Nov).
**0406 (#197):** `sportIndividual.js`: one card per tennis or golf tournament, UFC night, IndyCar or NASCAR race from
ESPN; majors only under Grand Slams / Majors; followed names matched against server-side draws, fields and entry
lists (F1 too: a MotoGP rider no longer marks every F1 session). Samples captured 1 Nov in
`test/fixtures/espn-individual/` (trimmed). A Grand Slam's ESPN answer is ~1.9 MB (ATP and WTA both); cap 6 MB.

**Tests (T1):** `test/sport-feeds.test.js` (0404, 0405), `test/sport-individual.test.js` (0406–0408), each failing on
the code before it. Full suite 1,599: 1,595 pass, the usual 4 fail only on the WSL box (ffmpeg without HE-AAC).
`verify-build.sh` passes.

**Codex adversarial review, round 1** (`--base f49e423`): needs-attention, fixed in 0407 with failing-before tests:

1. *High: a UFC airing joined by the city alone* ("Las Vegas"). UFC nights and races join by title only; a fight naming
   other fighters, a replay or highlights never joins.
2. *Medium: a tournament's break went stale* between 15-minute polls. Asked again every 5 minutes, fresh that long.

**Round 2:** the fixes hold, no high. One medium, fixed in 0408: a qualifying airing overlapping the race joined it.

**Not covered:** T3 on the rig; the league pages for the new sports (rest of #197); #29's collector cost measurement
(tennis adds up to ~2 MB parses on the main thread while play is live).
