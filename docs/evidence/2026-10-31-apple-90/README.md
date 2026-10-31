# Apple 90: the Cricket page, and the sport pages fail closed on spoiler-free

**Change.** The Cricket page on C-S (d093691), from the front page's Cricket tile and the Sport pages list when the
server has `sportPageCricket`. Every sport page and the front page now hide scores while the household's spoiler choice is
unknown (reopening, a failed read), and drop a preference answer older than the latest read (#192).

**Tests (T1, failing before).** `CricketPageTests` (decoding, innings text, spoilers, day chips, Watch on a channel's own
end including an overrun), `CricketPageSpoilerTests`, `SportPageSpoilerTests` (NFL, F1), `SportSpoilerFailClosedTests`
(front page, stale reads), `CricketPageUITests`. Mac push tier on 2e51b90; CI.

**Codex adversarial review, two rounds (D-19, round 1 left a high).**

| Round | Severity | Finding | Fixed |
|---|---|---|---|
| 1 | high | Cricket published a refresh before re-reading the spoiler choice; a failed read kept "scores shown" | 23fc55d (NFL and F1 had it too: c328046) |
| 2 | high | The front page kept a stale choice on reopening and after a failed read | 2e51b90 |
| 2 | high | An older preference answer could overwrite a newer one | 2e51b90 |

All three are in #192 (`finding`). There is no third round: the round-2 fixes were checked by the lead, plus failing-before tests.

**Not covered.** T3 screenshot comparison with the "Cricket · Apple TV" mock-up; T5 on Mark's devices via TestFlight.
