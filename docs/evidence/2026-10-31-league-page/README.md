# 0388–0389: a general sport page for every ESPN team league (C-T)

**Change.** `GET /api/sports/pages/league/:league` for the ESPN team leagues without a page of their own; `/api/info`
`sportPageLeagues` lists them. No client uses it yet: the Apple page design follows Mark's device check of NFL, Cricket
and F1.

**What ESPN gave (31 Oct 2026).** Only AFL and NRL report rounds (`week.number`); every other league is grouped by local
day. ESPN answers 400 to `dates=A-B` ranges, so the previous round is fetched by `seasontype/week` and day leagues by one
scoreboard per overlapping ESPN day (up to 4); standings hourly.

**Tests (T1, failing before).** `test/sport-page-league.test.js` (parsing for AFL, NRL, EPL, NBA and A-League fixtures, id
collisions, cache isolation, the standings cache), `test/sports-events.test.js` (route).

**Codex adversarial review, one round (D-38).** Verdict needs-attention, no high.

| Severity | Finding | Fixed |
|---|---|---|
| medium | Standings reused from cache named teams missing from `teams` | 0389 |

**Not covered.** T3: no client renders it yet.
