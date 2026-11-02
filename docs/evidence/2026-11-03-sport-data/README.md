# Server sport data batch: 0433–0438 (#213, #215, #212, #210, #218)

3 Nov 2026. The first batch of the D-44 implementation: the sport data the redesigned Apple client draws. No real
provider touched; ESPN only through stubbed answers in the tests.

| Build | Issue | Change | Failing-before test |
|---|---|---|---|
| 0433 | #213 | A follow with no card in range keeps its badge (catalogue, else ESPN roster; rosters now keep `logo`) | `sport-front` #213 (AFL roster, cricket catalogue) |
| 0434 | #215 | C-R `follows[]`: playing now first, then by next start, then nothing in range, ties by name | `sport-front` #215, 0427 updated |
| 0435 | #212 | International cricket groups hold only their own class; misfiled cached cards are forgotten | `sports-dashboard` #212 |
| 0436 | #210 | C-S `lead` and `others[]` carry `league` | `sport-page-cricket` #212/#210, golden |
| 0437 | #218 | A weekly league with nothing inside 72 h shows its next round (`nextRound: true`), day-by-day look-ahead | `sports-dashboard` #218 (3 tests), `sport-front` |
| 0438 | #218 | The look-ahead reads every day the round's 96 h reach (Codex round 1, medium) | `sports-dashboard` #218 scan |

**Gates:** `npm test` 1661 pass, 4 fail before 0438 and the same after: all four in `recording-segments-media`
(HE-AAC), this WSL machine's ffmpeg 8 without an HE-AAC encoder; CI runs the pinned 9.0.2. `verify-build.sh` passes.

**ESPN cost of #218:** at most 11 one-day scoreboard requests per ESPN path every 6 h, only for a followed league with
every window day answered and nothing on or due within 72 h, inside the collector's 12-per-tick budget and cooldown.
ESPN's date ranges answer 400 on team leagues, so no range request is made. Left out: the International groups,
cricket groups, own-feed leagues and whole-event sports (tennis, golf, UFC, IndyCar, NASCAR).

**Codex round 1** (base 83c2d67): one medium, fixed in 0438 (the scan stopped a day short of the round's 96 hours).
No high, so no round 2.

**Not run:** T3 on the rig (needs CI's image of this commit); T5 is Mark's (#213 and the cricket page on the Apple TV).
