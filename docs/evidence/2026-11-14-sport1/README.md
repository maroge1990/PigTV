# Sport 1: a game listed only in another language, 0626 to 0632 (#296)

When the exact team names don't match, a guide title now joins a game if it names both teams by names that no other team in that league's catalogue has, and names none of those other teams. Matching ignores accents and case and uses whole words. It never joins a replay, highlights, one team alone or cricket. The Sport front page, the league pages, "Record every game" rules and a recording's game link all use this join. The NFL page's own matcher is unchanged (Mark, 11 Nov).

- The fixture comparison is pinned in `test/sport-join-nickname.test.js`: 28 NFL games × 15 title forms. The four French and dash forms went from 0 to 28 joins, with no airing joined to another game. The remaining differences from the NFL page (abbreviations, city-only titles, one team alone, early coverage) are named in the test.
- Reviews: Codex had 1 high (a rule or a recording saw only its own team's games, so other teams couldn't veto a join). Opus had 2 mediums (one was that same high; the other, the league pages never used the join) and 4 lows. All were fixed (0627 to 0632), with a test that fails before each.
- Codex's sign-off had 1 high: the squad guard tells "a squad" from "no squad", not which squad. Mark chose to ship and file it as #319.
- Gates: `npm test` 2,340 pass (only the 4 WSL-only AAC-LC failures); `verify-build.sh` passed.
- Rig (staging on 0625 + #296, fake scores, `--game-lang fr`): ITV1 listed only "Premier League : Everton de Merseyside c. Fulham de Londres", and a "Record every game" rule for Everton scheduled it on ITV1. (The scripted game had finished before the front-page check, so that check did not apply.)
