# 0427–0429: the front page's order and the sport pages' event data (#197, D-43)

Server, 1 Nov 2026. Base `c3e5411`.

**0427:** C-R `follows[]` and `sports[]` put anything playing now (live, break, suspended, on air) first, stable,
otherwise the account's order (D-43 points 3 and 5). **0428:** C-V `GET /api/sports/pages/events?league=` (flag
`sportPageEvents`): tennis matches and draws with set scores, golf leaderboards with round strokes, UFC bouts (main
card / prelims), IndyCar and NASCAR entry lists, last winner and next race. **0429:** the Codex fix below.

**Live check (D-43), 1 Nov ~09:00 UTC:** tennis set scores are ESPN's `competitors[].linescores[].value` (WTA
Guangzhou final live at 5–4; Paris Masters tiebreaks 7–6); golf round strokes `linescores[period].value` (Mexico Open
after round 3, Novak 67-61-62, -23). Positions and cuts come from ESPN's golf leaderboard (the scoreboard has none);
seeds from `curatedRank` (seeded players only); racing feeds give no car number, team or venue.

**Tests (T1):** sport-front › 0427; sport-page-events (11, from trimmed samples in `test/fixtures/espn-events/`, 64 KB);
api-404 lists the route. Each fails on the build before it. `npm test`: 1649 pass, 4 fail (the HE-AAC tests: this box).

**Codex adversarial review, round 1:** one *medium*, fixed in 0429 with a failing-before test: a quiet answer fetched
just before a start was kept an hour into play. No high, so no round 2.
